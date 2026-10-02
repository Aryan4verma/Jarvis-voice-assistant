import { useEffect, useRef } from 'react'
import { SceneHost } from './scene/SceneHost'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { ChatInput } from './ui/ChatInput'
import { boundedHistory } from './lib/chat'
import { shouldSpeak } from './lib/voiceSettings'
import { beginListening, beginTiming, markTiming, cancelTiming, timingSnapshot } from './lib/latency'
import { enterCommand } from './lib/interaction'
import { shouldAnimate } from './lib/graphics'
import { beginStartup, startupStatus, startupSnapshot, aiStartupStatus, finishStartup } from './lib/startup'
import { createPowerOn, type StartupSource } from './lib/powerOn'
import { getSettings, watchSettings } from './lib/settings'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool } from './lib/fillers'
import {
  ask,
  warm,
  isConnected,
  cancel,
  shutdown,
  turns,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  configurationIssue,
  type AIMessage,
} from './lib/brain'
import { startAnalyser, micLevel, stopAudio, inputContext } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { TurnCancelled, type Turn } from './lib/turn'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000
const AUDIO_POLICY_MESSAGE = 'Browser audio is paused. Click Allow browser audio to authorize playback and microphone analysis. Typed chat remains available.'

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const history = useRef<AIMessage[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  const interaction = useRef<Turn | null>(null)
  const lookingRequest = useRef<string | null>(null)
  const power = useRef<ReturnType<typeof createPowerOn> | null>(null)
  const channelsReady = useRef(false)
  const lifetime = useRef(new AbortController())
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    cancel('stop')
    cancelTiming()
    voice.current?.reset()
    silence()
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    voice.current?.sync?.()
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string, source: 'voice' | 'typed' = 'voice'): Promise<void> => {
    registerBridgeHandlers()
    const spoken = shouldSpeak(source)
    silence()
    const mine = turns.begin()
    interaction.current = mine
    beginTiming(mine.turnId, source)
    const stale = () => !mine.current()
    voice.current?.reset()
    const cancelled = () => {
      if (interaction.current !== mine) return
      interaction.current = null
      cancelTiming(mine.turnId)
      speaker.current = null // the speaker's own abort listener stops only its audio
      lookingRequest.current = null
      store.getState().setLooking(null)
      store.getState().setActiveTool(null)
      music.working(false); music.duck(false); sfx.duck(false)
      const reason = (mine.signal.reason as TurnCancelled)?.reason
      if (reason === 'timeout' || reason === 'disconnect' || reason === 'error') {
        voice.current?.reset()
        store.getState().setError(reason === 'timeout'
          ? 'Interaction timed out. Backend termination requested; late output is ignored.'
          : reason === 'disconnect' ? 'Bridge disconnected. This interaction was cancelled.' : mine.signal.reason.message)
        if (source === 'voice' && voice.current) listen(FOLLOW_UP_MS)
        else store.getState().setPhase('dormant')
      } else if (reason !== 'replaced') {
        store.getState().setPhase('dormant')
      }
    }
    mine.signal.addEventListener('abort', cancelled, { once: true })

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.setError(null)
    s.pushTurn({ id: `${mine.turnId}:user`, role: 'user', text: said })
    s.setPhase('thinking')

    const spk = spoken ? createSpeaker(mine, () => markTiming('ttsAudio', mine.turnId), () => {
      if (mine.current()) store.getState().setError('System speech could not start. Check browser audio permissions or press T to test. Your text response is still available.')
    }) : null
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = mine.turnId
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onEvent: (event) => {
          if (stale()) return
          if (event.type === 'text') {
            markTiming('firstToken', mine.turnId)
            const delta = event.delta
            if (!started) {
              started = true
              store.getState().setPhase('speaking')
              // The answer arriving is what ends the tool phase — a timer would
              // clear the readout while a slow tool was still running.
              store.getState().setActiveTool(null)
              music.working(false)
              store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
            }
            store.getState().appendToLastTurn(delta)
            spk?.push(delta)
          } else if (event.type === 'tool') {
            const name = event.displayName ?? event.name
            // Only claim the tooling phase while he has nothing to say yet.
            // Setting it unconditionally pinned the machine in 'tooling' for the
            // rest of any answer that called a tool after it started talking,
            // which also broke the reactor's lip-sync for the remainder.
            if (!started) store.getState().setPhase('tooling')
            store.getState().setActiveTool(name)
            if (spoken) sfx.play('tool')
            if (spoken) music.working(true)
            // Say something the moment work starts — a tool can take ten seconds
            // and silence that long reads as a crash. Once per turn only; a
            // chain of five tools shouldn't produce five apologies.
            if (!filled && !started) {
              filled = true
              spk?.say(forTool(name))
            }
          }
        },
      }, mine)

      if (stale()) return

      // Bounded application messages; session adapters ignore this history.
      history.current.push({ role: 'user', content: said })
      history.current.push({ role: 'assistant', content: text || '…' })
      history.current = boundedHistory(history.current)

      await spk?.end()
      if (stale()) return
      if (spoken) sfx.play('done')
    } catch (err) {
      if (stale()) return
      spk?.cancel()
      console.warn('[jarvis] interaction failed')
      if (spoken) sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      mine.signal.removeEventListener('abort', cancelled)
      if (!stale()) {
        markTiming('complete', mine.turnId)
        mine.complete()
        if (interaction.current === mine) interaction.current = null
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        if (source === 'voice' && voice.current) listen(FOLLOW_UP_MS)
        else store.getState().setPhase('dormant')
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const startListening = (wake = false) => {
    beginListening(wake)
    enterCommand({ cancel: () => cancel('replaced'), silence,
      reset: () => voice.current?.reset(), listen: () => listen(AWAIT_SPEECH_MS) })
    store.getState().setError(null)
  }
  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    if (trailing) { beginListening(true); void respond(trailing); return }
    startListening(true)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Cancel now, even if the user never supplies a replacement request.
      cancel('barge-in')
      voice.current?.reset(true)
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    if (timingSnapshot().status !== 'listening') beginListening()
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    if (/^(?:stop|cancel|enough|quiet|never mind|forget it)(?:[,.]?\s+sir)?[.!?]*$/i.test(said)) { goDormant(); return }
    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  const registerBridgeHandlers = () => {
    if (channelsReady.current) return
    channelsReady.current = true
    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      req.signal.throwIfAborted()
      lookingRequest.current = req.id
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera(req.signal)
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9, req.signal)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        if (lookingRequest.current === req.id) { lookingRequest.current = null; store.getState().setLooking(null) }
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui operation')
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        startupStatus('bridge', 'UNAVAILABLE')
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        startupStatus('bridge', 'ONLINE')
        store
          .getState()
          .setError('Bridge reconnected. Agent sessions restart; recent chat text remains available.')
      }
    })
  }

  // -- power on -------------------------------------------------------------

  const powerOn = (source: StartupSource = 'manual') => {
    // Preserve one guarded startup operation across every activation path.
    power.current ??= createPowerOn({
      ready: () => Boolean(voice.current?.live()) && !['MIC BLOCKED', 'VOICE UNAVAILABLE'].includes(startupSnapshot().systems.voice),
      begin: origin => {
        if (store.getState().phase === 'offline') beginStartup(origin)
        store.getState().setPhase('dormant') // retires clap analysis before voice begins
        store.getState().setError(null)
        startupStatus('voice', 'INITIALIZING')
        voice.current?.stop(); voice.current = null
      },
      initialize: ignite,
      failed: err => {
        if (lifetime.current.signal.aborted) return
        const blocked = (err as DOMException)?.name === 'NotAllowedError'
        startupStatus('voice', blocked ? 'MIC BLOCKED' : 'VOICE UNAVAILABLE')
        startupStatus('integrity', 'DEGRADED · TYPED CHAT READY')
        store.getState().setError(blocked
          ? 'Microphone permission denied. Allow microphone access in your browser, then Retry voice. Typed chat remains available.'
          : 'Voice could not initialize. Check your microphone/browser and Retry voice. Typed chat remains available.')
      },
    })
    return power.current.start(source)
  }

  const prepareAudio = () => {
    const signal = lifetime.current.signal
    // Both contexts are existing shared resources. Resume inside the user gesture,
    // before microphone permission/bridge awaits; never wait on autoplay unlock.
    const input = inputContext()
    const report = (confirmed = false) => {
      if (signal.aborted) return
      const blocked = input.state !== 'running' || sfx.audioState() !== 'running'
      startupStatus('audio', blocked ? 'GESTURE NEEDED' : 'READY')
      if (blocked && (confirmed || navigator.userActivation && !navigator.userActivation.hasBeenActive)) store.getState().setError(AUDIO_POLICY_MESSAGE)
      else if (!blocked && store.getState().error === AUDIO_POLICY_MESSAGE) store.getState().setError(null)
    }
    void input.resume().then(() => report(true)).catch(() => report(true))
    void sfx.unlockAudio().then(() => { report(true); if (!signal.aborted) sfx.play('boot') }).catch(() => report(true))
    report()
    return report
  }

  const ignite = async () => {
    const signal = lifetime.current.signal
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    // Clap is not a browser user gesture: suspended output must never block readiness.
    const reportAudio = prepareAudio()
    signal.throwIfAborted()
    // Keep the soundscape opt-in rather than starting a long score over command capture.
    // Ambient music remains available to tools; ECO startup does not start it.

    // The cinematic owns its own bounded presentation clock, never the interaction phase.

    registerBridgeHandlers()
    const warming = warm().then(() => { if (!signal.aborted) startupStatus('bridge', isConnected() ? 'ONLINE' : 'UNAVAILABLE') }).catch((err: Error) => { if (!signal.aborted) { startupStatus('bridge', 'UNAVAILABLE'); s.setError(err.message) } })
    void getSettings(signal).then(value => { if (!signal.aborted) startupStatus('ai', aiStartupStatus(value)) }).catch(() => { if (!signal.aborted) startupStatus('ai', 'UNAVAILABLE') })

    const issue = configurationIssue()
    if (issue) s.setError(issue.message)

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro' && !voicePoll.current && !kokoro.isReady() && !kokoro.isUnavailable()) {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Optional bridge warm-up never owns frontend readiness.
    void warming
    signal.throwIfAborted()
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser and command/wake engines share the same microphone.
    // Optional readiness checks run concurrently with microphone permission.
    const probing = probeCapabilities()
    startupStatus('voice', 'OPENING MICROPHONE')
    try {
      await startAnalyser()
      reportAudio()
      if (!signal.aborted) startupStatus('voice', 'INITIALIZING')
    } catch (error) {
      if (!signal.aborted) startupStatus('audio', 'UNAVAILABLE')
      console.warn('[jarvis] microphone unavailable; typed chat remains available')
      throw error // do not request the denied microphone a second time via startVoice
    }
    signal.throwIfAborted()

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probing
    signal.throwIfAborted()

    // One voice loop, started once, running until the page closes.
    const startedVoice = await startVoice({
      mode,
      onWake: (text) => { if (!signal.aborted) onWake(text) },
      onSpeechStart: () => { if (!signal.aborted) onSpeechStart() },
      onPartial: (text) => { if (!signal.aborted) onPartial(text) },
      onUtterance: (text) => { if (!signal.aborted) onUtterance(text) },
      onError: (message) => { if (!signal.aborted) onVoiceError(message) },
      onStatus: status => {
        if (signal.aborted) return
        startupStatus('voice', status === 'wake-ready' ? 'WAKE READY' : status === 'ready' ? 'VOICE READY' : status === 'blocked' ? 'MIC BLOCKED' : 'VOICE UNAVAILABLE')
        startupStatus('integrity', status === 'ready' || status === 'wake-ready' ? 'LOCAL CHECKS COMPLETE' : 'DEGRADED · TYPED CHAT READY')
      },
    })
    if (signal.aborted) { startedVoice.stop(); return }
    voice.current = startedVoice.live() ? startedVoice : null
    if (!voice.current) startedVoice.stop()
    startedVoice.sync?.()
    if (!voice.current && startupSnapshot().systems.voice !== 'MIC BLOCKED') startupStatus('voice', 'VOICE UNAVAILABLE')
    startupStatus('integrity', !voice.current ? 'DEGRADED · TYPED CHAT READY' : startupSnapshot().systems.voice === 'INITIALIZING' ? 'VOICE INITIALIZING · TYPED CHAT READY' : 'LOCAL CHECKS COMPLETE')
  }

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
    let meterTimer: ReturnType<typeof setTimeout> | null = null
    const pump = () => {
      meterTimer = null
      const st = store.getState()
      if (!shouldAnimate(st.phase, document.hidden)) { if (st.level) st.setLevel(0); return }
      st.setLevel(st.phase === 'speaking' && speaker.current ? speaker.current.level() : micLevel())
      meterTimer = setTimeout(pump, 34)
    }
    const sync = () => {
      voice.current?.sync?.()
      if (meterTimer) clearTimeout(meterTimer)
      pump()
    }
    const settingsUnsubscribe = watchSettings(value => startupStatus('ai', aiStartupStatus(value)))
    const unsubscribe = store.subscribe((next, previous) => { if (next.phase !== previous.phase) sync() })
    document.addEventListener('visibilitychange', sync)
    const preference = (event: Event) => { if ((event as CustomEvent).detail === 'off') silence() }
    window.addEventListener('jarvis-voice-preference', preference)
    pump()

    const onKey = (e: KeyboardEvent) => {
      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        finishStartup()
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        cancel('stop')
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        cancel('stop')
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          if (speaker.current !== t) return
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn() // power-up enters wake standby; the next Space is push-to-talk
      } else if (power.current?.pending()) {
        return
      } else if (!voice.current?.live()) {
        void powerOn().then(() => { if (voice.current && !lifetime.current.signal.aborted) startListening() })
      } else {
        startListening()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      if (meterTimer) clearTimeout(meterTimer)
      unsubscribe(); settingsUnsubscribe(); finishStartup()
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('jarvis-voice-preference', preference)
      window.removeEventListener('keydown', onKey)
      lifetime.current.abort()
      channelsReady.current = false
      clearIdle()
      shutdown()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      voice.current = null
      stopAudio()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <SceneHost />
      <Hud />
      <Boot />
      <Diagnostics />
      <ChatInput onVoiceChanged={() => {
        if (!voice.current) return
        if (power.current?.pending()) return
        goDormant(); voice.current.stop(); voice.current = null
        void powerOn()
      }} respond={respond} onStop={goDormant} onVoice={() => void powerOn()} onAudio={prepareAudio} />
      <Ignition onStart={source => void powerOn(source)} />
    </>
  )
}
