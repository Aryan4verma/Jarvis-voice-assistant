import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPowerOn } from '../src/lib/powerOn.ts'
import { createClapDetector } from '../src/lib/clap.ts'
import { beginStartup, startupStatus, startupSnapshot, finishStartup } from '../src/lib/startup.ts'
import { submitTyped } from '../src/lib/chat.ts'
import { useStore } from '../src/store.ts'
import { ChatInput } from '../src/ui/ChatInput.tsx'

globalThis.window = globalThis
globalThis.__speech = { stt: false, tts: false }
globalThis.fetch = async url => url.endsWith('/session') ? new Response(null, { status: 204 }) : Response.json({ picovoice: false })
let recognizers = [], pipelines = []
const BrowserRecognizer = class {
  constructor() { recognizers.push(this) }
  start() { this.onstart?.() }
  abort() {}
}
globalThis.SpeechRecognition = BrowserRecognizer
const { startVoice } = await import('../src/lib/voice.ts')
const microphone = await import('../src/lib/audio.ts?actual')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function view() {
  // SSR reads Zustand's initial snapshot; supply the current browser fixture phase.
  const snapshot = useStore.getInitialState(), previous = snapshot.phase
  snapshot.phase = useStore.getState().phase
  try { return renderToStaticMarkup(createElement(ChatInput, { respond: async () => {}, onStop() {}, onVoice() {}, onVoiceChanged() {}, onAudio() {} })) }
  finally { snapshot.phase = previous }
}
function startup(initialize) {
  let voice, mode = 'offline', errors = [], wakes = 0
  const power = createPowerOn({
    ready: () => Boolean(voice?.live()),
    begin: source => { beginStartup(source); mode = 'wake'; useStore.getState().setPhase('dormant') },
    initialize: initialize ?? (async () => {
      voice = await startVoice({ mode: () => mode, onWake() { wakes++; mode = 'command' }, onPartial() {}, onUtterance() {}, onSpeechStart() {}, onError: error => errors.push(error),
        onStatus: status => startupStatus('voice', status === 'wake-ready' ? 'WAKE READY' : status === 'blocked' ? 'MIC BLOCKED' : 'VOICE UNAVAILABLE') })
      pipelines.push(voice)
    }),
    failed: error => { errors.push(error); startupStatus('voice', error.name === 'NotAllowedError' ? 'MIC BLOCKED' : 'VOICE UNAVAILABLE') },
  })
  return { power, errors, wakes: () => wakes }
}
afterEach(() => {
  for (const voice of pipelines) voice.stop()
  pipelines = []; recognizers = []; microphone.stopAudio(); finishStartup()
  globalThis.SpeechRecognition = BrowserRecognizer
  useStore.getState().setPhase('offline')
})

for (const path of ['INITIALISE', 'Space', 'double-clap']) test(`${path} automatically initializes voice and accepts Hey Jarvis with no second action`, async () => {
  const f = startup()
  if (path === 'double-clap') {
    const d = createClapDetector(() => void f.power.start('clap'))
    const quiet = (a, b) => { for (let t = a; t < b; t += 10) d.sample(.002, t) }
    quiet(0, 100); d.sample(.2, 100); d.sample(.002, 110)
    assert.equal(recognizers.length, 0)
    quiet(120, 400); d.sample(.2, 400); d.sample(.002, 410)
    await flush()
    assert.equal(startupSnapshot().source, 'clap')
    quiet(420, 700); d.sample(.2, 700); d.sample(.002, 710)
  } else await f.power.start('manual')
  assert.equal(recognizers.length, 1)
  assert.equal(startupSnapshot().systems.voice, 'WAKE READY')
  assert.equal(useStore.getState().phase, 'dormant')
  assert.ok(!view().includes('Enable voice')); assert.ok(view().includes('WAKE READY')); assert.ok(!view().includes('Retry voice'))
  recognizers[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Hey Jarvis' }], { isFinal: true })] })
  assert.equal(f.wakes(), 1)
  await f.power.start(); assert.equal(recognizers.length, 1)
})

test('rapid mixed startup triggers share one operation and one voice pipeline', async () => {
  let release, initializations = 0, ready = false
  const power = createPowerOn({ ready: () => ready, begin() {}, initialize: () => { initializations++; return new Promise(resolve => { release = () => { ready = true; resolve() } }) }, failed() { assert.fail('unexpected failure') } })
  const first = power.start('clap'), second = power.start('manual'), third = power.start('manual')
  assert.equal(first, second); assert.equal(first, third); assert.equal(initializations, 1); assert.equal(power.pending(), true)
  release(); await first; assert.equal(power.pending(), false)
  await power.start(); assert.equal(initializations, 1)
})

for (const failure of [new DOMException('Denied', 'NotAllowedError'), new Error('Engine failed')]) test(`${failure.name}: voice failure leaves typed chat usable and allows contextual retry`, async () => {
  const f = startup(async () => { throw failure })
  await f.power.start(); assert.equal(f.power.pending(), false); assert.equal(f.errors.length, 1)
  assert.equal(useStore.getState().phase, 'dormant'); assert.ok(view().includes('Retry voice')); assert.ok(!view().includes('Enable voice'))
  let submitted
  assert.equal(submitTyped('Still usable', async text => { submitted = text }), true); assert.equal(submitted, 'Still usable')
  await f.power.start(); assert.equal(f.errors.length, 2)
})

test('late browser permission failure changes readiness and exposes Retry voice', async () => {
  const f = startup(); await f.power.start()
  recognizers[0].onerror({ error: 'not-allowed' })
  assert.equal(pipelines[0].live(), false); assert.equal(startupSnapshot().systems.voice, 'MIC BLOCKED')
  assert.ok(view().includes('Retry voice')); assert.equal(f.errors.length, 1)
})

test('shared microphone and analyser are single-flight even during clap-to-voice handoff', async () => {
  let resolve, requests = 0, analysers = 0, contexts = 0
  const track = { readyState: 'live', stop() {} }, stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { requests++; return new Promise(r => { resolve = r }) } } } })
  globalThis.AudioContext = class {
    constructor() { contexts++; this.state = 'running' }
    createMediaStreamSource() { return { connect() {} } }
    createAnalyser() { analysers++; return { frequencyBinCount: 256 } }
    close() { return Promise.resolve() }
  }
  const clapMic = microphone.getMic(), analyserA = microphone.startAnalyser(), analyserB = microphone.startAnalyser()
  assert.equal(requests, 1); resolve(stream)
  await Promise.all([clapMic, analyserA, analyserB]); assert.equal(analysers, 1); assert.equal(contexts, 1)
  assert.equal(await microphone.getMic(), stream); assert.equal(requests, 1)
})

test('audio policy control is contextual and never needed after successful unlock', () => {
  useStore.getState().setPhase('dormant'); startupStatus('voice', 'WAKE READY'); startupStatus('audio', 'GESTURE NEEDED')
  assert.ok(view().includes('Allow browser audio')); startupStatus('audio', 'READY'); assert.ok(!view().includes('Allow browser audio'))
})

test('a recognizer that never starts is stopped at the bounded deadline, with no restart worker/timers retained', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let attempts = 0, aborts = 0
  globalThis.SpeechRecognition = class { start() { attempts++ } abort() { aborts++ } }
  const f = startup(); await f.power.start()
  assert.equal(startupSnapshot().systems.voice, 'INITIALIZING')
  context.mock.timers.tick(4000)
  assert.equal(pipelines[0].live(), false); assert.equal(startupSnapshot().systems.voice, 'VOICE UNAVAILABLE')
  assert.ok(view().includes('Retry voice')); assert.equal(aborts, 1)
  context.mock.timers.tick(60000); assert.equal(attempts, 1)
})

test('denied startup microphone is requested once, without entering a second voice acquisition', async () => {
  let requests = 0, voiceCalls = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { requests++; throw new DOMException('Denied', 'NotAllowedError') } } } })
  const f = startup(async () => { await microphone.startAnalyser(); voiceCalls++; await startVoice({}) })
  await f.power.start(); assert.equal(requests, 1); assert.equal(voiceCalls, 0)
  assert.ok(view().includes('MIC BLOCKED')); assert.ok(view().includes('Retry voice'))
  assert.equal(useStore.getState().phase, 'dormant')
})

test('App wiring preserves common automatic startup, retires clap before awaiting voice, and avoids a second denied-mic request', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'), ignition = await readFile(new URL('../src/ui/Ignition.tsx', import.meta.url), 'utf8')
  assert.match(app, /onStart=\{source => void powerOn\(source\)\}/)
  assert.match(app, /phase === 'offline'[\s\S]*?void powerOn\(\)/)
  assert.match(app, /initialize: ignite/); assert.match(app, /await startVoice\(/)
  assert.match(app, /throw error \/\/ do not request the denied microphone a second time/)
  assert.match(ignition, /state.phase !== 'offline'[\s\S]*?listener.current\?\.stop\(\)/)
})
