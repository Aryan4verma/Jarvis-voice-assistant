import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'

const realTimeout = globalThis.setTimeout
const flush = () => new Promise((resolve) => realTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
let idle = new Map(), timerId = 0, rafs = new Set(), native = [], nativeCancels = 0, audio = []
globalThis.window = globalThis
globalThis.location = { port: '5173' }
globalThis.__speech = { tts: false, stt: false }
globalThis.localStorage = { getItem: () => null }
globalThis.speechSynthesis = {
  getVoices: () => [], addEventListener() {}, resume() {}, pause() {},
  speak(utterance) { native.push(utterance); utterance.onstart?.() }, cancel() { nativeCancels++ },
}
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
globalThis.requestAnimationFrame = () => { const id = ++timerId; rafs.add(id); return id }
globalThis.cancelAnimationFrame = (id) => rafs.delete(id)
globalThis.Audio = class {
  constructor(url) { this.url = url; this.paused = false; audio.push(this) }
  play() { this.onplaying?.(); return Promise.resolve() }
  pause() { this.paused = true; this.onpause?.() }
}
let fetchWork = null
globalThis.fetch = async (url, init) => {
  if (url === '/__jarvis/session') return new Response(null, { status: 204 })
  if (fetchWork) return fetchWork(url, init)
  throw new Error('Unexpected test request')
}
const sockets = []
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1
  constructor() {
    super(); this.readyState = 0; this.sent = []; sockets.push(this)
    queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(); this.frame({ scope: 'connection', type: 'ready', servers: [] }) })
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  frame(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
  close() { this.readyState = 3; this.onclose?.(); this.dispatchEvent(new Event('close')) }
}
const { turns, TurnCancelled, createTurnOwner } = await import('../src/lib/turn.ts')
const bridge = await import('../src/lib/bridge.ts')
const { createSpeaker, speakingNow } = await import('../src/lib/tts.ts')
const camera = await import('../src/lib/camera.ts')
const direct = await import('../src/lib/anthropic.ts')
const { startVoice } = await import('../src/lib/voice.ts')
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms === 120000) { const id = ++timerId; idle.set(id, fn); return id }
  return realTimeout(fn, ms, ...args)
}
const realClear = globalThis.clearTimeout
globalThis.clearTimeout = (id) => { idle.delete(id); realClear(id) }
afterEach(() => { bridge.shutdown(); turns.cancel('shutdown'); fetchWork = null; globalThis.__speech = { tts: false, stt: false }; idle.clear() })
const ask = async (turn, text, seen) => {
  const result = bridge.ask(text, { onText: (text) => seen.push(text), onTool: (tool) => seen.push(tool) }, turn)
  result.catch(() => {})
  await flush()
  return { result, ws: sockets.at(-1), frame: (data) => sockets.at(-1).frame({ ...data, scope: 'turn', turnId: turn.turnId }) }
}

test('A/B/D: late text, tool/UI effects, done and errors cannot cross turn ownership', async () => {
  const effects = [], seen = []
  bridge.watchPanels((p) => effects.push(p)); bridge.watchBlades((b) => effects.push(b)); bridge.watchUi((op) => effects.push(op))
  const a = turns.begin(), requestA = await ask(a, 'A', seen)
  requestA.frame({ type: 'text', delta: 'A' })
  a.cancel('stop')
  await assert.rejects(requestA.result, TurnCancelled)
  const b = turns.begin(), requestB = await ask(b, 'B', seen)
  for (const event of [{ type: 'text', delta: 'late-A' }, { type: 'tool', name: 'late-A' }, { type: 'panel', panel: {} },
    { type: 'blade', blade: {} }, { type: 'ui', op: 'reset' }, { type: 'done', text: 'late-A' }, { type: 'error', message: 'late-A' }]) requestA.frame(event)
  requestB.ws.frame({ type: 'text', delta: 'untagged' })
  assert.deepEqual(seen, ['A']); assert.deepEqual(effects, []); assert.equal(b.current(), true)
  requestB.frame({ type: 'text', delta: 'B' }); requestB.frame({ type: 'done' })
  assert.equal((await requestB.result).text, 'B')
  assert.equal(idle.size, 0)
})

test('E: idle timeout propagates cancel and quarantines uncancellable late work', async () => {
  const seen = [], a = turns.begin(), request = await ask(a, 'slow', seen)
  assert.equal(idle.size, 1)
  const deadline = [...idle.values()][0]; deadline()
  await assert.rejects(request.result, (err) => err.reason === 'timeout')
  assert.ok(request.ws.sent.some((msg) => msg.type === 'cancel' && msg.turnId === a.turnId))
  request.frame({ type: 'text', delta: 'late' }); request.frame({ type: 'done', text: 'late' })
  assert.deepEqual(seen, []); assert.equal(idle.size, 0)
})

test('F: disconnect clears pending asks/captures; a dead socket cannot affect reconnect', async () => {
  const capture = deferred(), seen = []; let captureSignal
  bridge.watchCapture((request) => { captureSignal = request.signal; return capture.promise })
  const a = turns.begin(), request = await ask(a, 'camera', seen)
  request.frame({ type: 'capture', id: 'q1' }); await flush()
  request.ws.close()
  await assert.rejects(request.result, (err) => err.reason === 'disconnect')
  assert.equal(captureSignal.aborted, true); assert.equal(idle.size, 0)
  const b = turns.begin(), replacement = await ask(b, 'B', seen)
  capture.resolve({ data: 'late-camera' }); await flush()
  request.ws.frame({ scope: 'connection', type: 'ready', servers: ['late'] })
  assert.ok(!request.ws.sent.some((msg) => msg.type === 'reply'))
  assert.deepEqual(bridge.bridgeServers(), [])
  replacement.frame({ type: 'done', text: 'B' }); await replacement.result
})

test('C: cancelled native speech drops its queue and cannot stop or overwrite B speech', async () => {
  native = []; nativeCancels = 0
  const a = turns.begin(), speakerA = createSpeaker(a)
  speakerA.push('First sentence. Second sentence. ')
  const draining = speakerA.end(); await flush()
  assert.equal(native.length, 1)
  const lateStart = native[0].onstart, lateError = native[0].onerror
  a.cancel('stop'); await draining
  assert.equal(nativeCancels, 1); assert.equal(rafs.size, 0)
  const b = turns.begin(), speakerB = createSpeaker(b)
  speakerB.say('First sentence.'); await flush()
  speakerA.push('Late sentence. '); speakerA.cancel(); lateStart?.(); lateError?.({ error: 'late' })
  assert.equal(native.length, 2); assert.equal(nativeCancels, 1)
  assert.ok(speakingNow().includes('First sentence.'))
  speakerB.cancel(); assert.equal(rafs.size, 0)
})

test('cloud speech cancellation aborts prefetched requests and stops owned playback', async () => {
  globalThis.__speech.tts = true
  const signals = []; fetchWork = async (_url, init) => { signals.push(init.signal); return new Response(new Blob(['test-audio'])) }
  audio = []
  const a = turns.begin(), spk = createSpeaker(a)
  spk.push('A first. A second. '); const end = spk.end(); await flush(); await flush()
  assert.equal(audio.length, 1)
  a.cancel('stop'); await end
  assert.equal(audio[0].paused, true); assert.ok(signals.every((signal) => signal.aborted)); assert.equal(rafs.size, 0)
})

test('camera permission arriving after cancellation releases the hold and stops tracks', async () => {
  const permission = deferred(); let stops = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => permission.promise } } })
  globalThis.document = { createElement: () => ({ play: async () => {}, pause() {} }) }
  for (let i = 0; i < 24; i++) {
    const controller = new AbortController(), hold = camera.holdCamera(controller.signal)
    assert.equal(camera.diag.pending, 1)
    controller.abort(new Error('cancel')); await assert.rejects(hold)
    assert.equal(camera.diag.holders, 0); assert.equal(camera.diag.pending, 0)
  }
  permission.resolve({ getTracks: () => [{ stop: () => stops++ }] }); await flush()
  assert.equal(stops, 1); assert.equal(camera.cameraLive(), false)
})

test('disconnect cancels the speech tail even after the backend done frame', async () => {
  const a = turns.begin(), request = await ask(a, 'speaking', [])
  const speaker = createSpeaker(a); speaker.say('Still speaking.'); await flush()
  request.frame({ type: 'done', text: 'Still speaking.' }); await request.result
  assert.equal(a.current(), true)
  request.ws.close()
  assert.equal(a.signal.aborted, true); assert.equal(rafs.size, 0)
})

test('camera cancellation stops acquired tracks even while video playback is pending', async () => {
  const playing = deferred(); let stopped = false
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{mediaDevices:{getUserMedia:async () => ({getTracks:() => [{stop:() => {stopped = true}}]})}} })
  globalThis.document = {createElement:() => ({play:() => playing.promise, pause() {}})}
  const controller = new AbortController(), hold = camera.holdCamera(controller.signal)
  await flush(); controller.abort(); await assert.rejects(hold)
  assert.equal(stopped, true); assert.equal(camera.diag.holders, 0); assert.equal(camera.diag.pending, 0)
  playing.resolve(); await flush(); assert.equal(camera.cameraLive(), false)
})

const voiceHandlers = (seen) => ({ mode: () => 'wake', onWake: (text) => seen.push(text), onSpeechStart() {},
  onPartial: (text) => seen.push(text), onUtterance: (text) => seen.push(text), onError: (text) => seen.push(text) })

test('cancelled STT generations drop queued audio and quarantine a late transcript', async () => {
  globalThis.__speech.stt = true
  const seen = [], requests = [], work = deferred()
  fetchWork = async (url, init) => { if (!url.endsWith('/stt')) return Response.json({picovoice:false}); requests.push(init.signal); return work.promise }
  const voice = await startVoice({ ...voiceHandlers(seen), mode: () => 'command', onPartial() {} }), vad = globalThis.__vad
  try {
    vad.onStart(); vad.onEnd(new Blob(['segment']))
    await flush(); assert.equal(requests.length, 1)
    vad.onStart(); vad.onEnd(new Blob(['queued old segment']))
    voice.reset(); assert.equal(requests[0].aborted, true)
    work.resolve(Response.json({text:'Jarvis stale command'})); await flush()
    assert.deepEqual(seen, []); assert.equal(requests.length, 1)
    fetchWork = async (url, init) => { if (!url.endsWith('/stt')) return Response.json({picovoice:false}); requests.push(init.signal); return Response.json({text:'fresh command.'}) }
    vad.onStart(); vad.onEnd(new Blob(['new segment'])); await flush()
    assert.deepEqual(seen, ['fresh command.']); assert.equal(requests.length, 2)
    voice.stop(); vad.onError('late capture error'); vad.onLevel(1)
    assert.deepEqual(seen, ['fresh command.'])
  } finally { voice.stop() }
})

test('reset browser recognition detaches old results/errors/restart callbacks', async () => {
  const seen = [], recognizers = []
  globalThis.SpeechRecognition = class {
    constructor() { recognizers.push(this) }
    start() { this.onstart?.() }
    abort() { this.aborted = true }
  }
  const voice = await startVoice(voiceHandlers(seen))
  try {
    const old = recognizers[0], result = old.onresult, error = old.onerror, end = old.onend
    voice.reset(); assert.equal(old.aborted, true)
    await new Promise(resolve => realTimeout(resolve, 90))
    const event = (text) => ({ resultIndex:0, results:[Object.assign([{transcript:text}],{isFinal:true})] })
    result(event('Jarvis stale request')); error({error:'not-allowed'}); end()
    assert.deepEqual(seen, []); assert.equal(voice.live(), true); assert.equal(recognizers.length, 2)
    recognizers[1].onresult(event('Jarvis fresh request')); assert.deepEqual(seen, ['fresh request'])
    voice.stop(); await new Promise(resolve => realTimeout(resolve, 90))
    assert.equal(recognizers.length, 2)
  } finally { voice.stop(); delete globalThis.SpeechRecognition }
})

test('retired browser-direct caller cannot emit output or disturb a newer interaction', async () => {
  const seen=[], owner=createTurnOwner(), a=owner.begin()
  globalThis.__directStream=()=>assert.fail('Browser direct requests are disabled')
  await assert.rejects(direct.ask([],{onText:text=>seen.push(text),onTool(){}},a),error=>error.category==='invalid-request')
  a.cancel('stop');const b=owner.begin()
  assert.deepEqual(seen,[]);assert.equal(b.current(),true)
})
