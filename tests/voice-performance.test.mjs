import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { enterCommand } from '../src/lib/interaction.ts'
import { shouldAnimate, ECO } from '../src/lib/graphics.ts'
import * as timings from '../src/lib/latency.ts'
import { routerError, routerFailure, retryAfter } from '../bridge/providers/openrouter-client.mjs'
const storage = new Map(), events = new EventTarget()
globalThis.window = globalThis
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
globalThis.__speech = { stt: false, tts: false }
globalThis.dispatchEvent = e => events.dispatchEvent(e)
globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
let utterances = [], cancels = 0, recognizers = []
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
globalThis.speechSynthesis = { getVoices: () => [], addEventListener() {}, pause() {}, resume() {}, cancel() { cancels++ }, speak(u) { utterances.push(u); u.onstart?.() } }
globalThis.SpeechRecognition = class { constructor() { recognizers.push(this) } start() { this.onstart?.() } abort() {} }
globalThis.fetch = async url => url.endsWith('/session') ? new Response(null, {status:204}) : Response.json({picovoice:true})
const { shouldSpeak, setVoiceReplies, voiceReplies } = await import('../src/lib/voiceSettings.ts')
const { startVoice, holdFor, makeAssembler, diag } = await import('../src/lib/voice.ts')
const { createSpeaker } = await import('../src/lib/tts.ts')
const { createTurnOwner } = await import('../src/lib/turn.ts')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { globalThis.__speech = {stt:false,tts:false}; delete globalThis.__wakeDouble; setVoiceReplies('always'); storage.clear(); recognizers=[]; utterances=[] })

test('Space/keyword command entry changes to listening synchronously without greeting', () => {
  const trace = []; let phase = 'speaking'
  enterCommand({ cancel: () => trace.push('cancel'), silence: () => trace.push('silence'), reset: () => trace.push('reset'), listen: () => {phase='listening';trace.push('listen')} })
  assert.equal(phase,'listening'); assert.deepEqual(trace,['cancel','silence','reset','listen'])
})
test('Voice Replies defaults Always; Off and voice-only apply to the same typed/voice pipeline', async () => {
  assert.equal(voiceReplies(),'always'); assert.equal(shouldSpeak('typed'),true)
  const turn = createTurnOwner().begin(); let firstAudio = 0
  const speaker = shouldSpeak('typed') ? createSpeaker(turn, () => firstAudio++) : null
  speaker.push('Typed answer. '); await flush()
  assert.equal(utterances.length,1); assert.equal(firstAudio,1)
  const end = speaker.end(); turn.cancel('stop'); await end
  assert.ok(cancels>0)
  setVoiceReplies('off'); assert.equal(shouldSpeak('typed'),false); assert.equal(shouldSpeak('voice'),false)
  setVoiceReplies('voice'); assert.equal(shouldSpeak('typed'),false); assert.equal(shouldSpeak('voice'),true)
})
test('endpointing holds unfinished thoughts, but short complete commands do not wait 1–2 seconds', () => {
  assert.equal(holdFor('Open Chrome'),80); assert.equal(holdFor('What time is it?'),0)
  assert.equal(holdFor('the weather in'),1600); assert.equal(holdFor('please open,'),1600)
  const output=[], assembler=makeAssembler({emit:text=>output.push(text),partial(){}})
  assembler.feed('the weather in',false); assembler.feed('London.',false)
  assert.deepEqual(output,['the weather in London.']); assembler.feed('cancelled fragment',false); assembler.cancel(); assembler.flush()
  assert.equal(output.length,1)
})
test('dedicated wake enters commands; unavailable optional engine falls back and remains cancellable', async () => {
  let mode='wake', detected, errors=[]
  globalThis.__wakeDouble = async (_active, onDetected) => { detected=onDetected; return {stop(){},sync(){}} }
  const voice=await startVoice({mode:()=>mode,onWake:()=>{mode='command'},onSpeechStart(){},onPartial(){},onUtterance(){},onError:error=>errors.push(error)})
  await flush(); await flush(); assert.equal(diag.wakeEngine,'porcupine'); assert.equal(typeof detected,'function')
  detected(); assert.equal(mode,'command'); assert.equal(voice.live(),true); voice.stop()
  globalThis.__wakeDouble = async () => {throw new Error('Optional failure')}; mode='wake'
  const fallback=await startVoice({mode:()=>mode,onWake:()=>{mode='command'},onSpeechStart(){},onPartial(){},onUtterance(){},onError:error=>errors.push(error)})
  await flush(); await flush(); assert.equal(diag.wakeEngine,'browser fallback'); assert.equal(fallback.live(),true)
  const result=Object.assign([{transcript:'Hey Jarvis'}],{isFinal:true})
  recognizers.at(-1).onresult({resultIndex:0,results:[result]}); assert.equal(mode,'command'); assert.deepEqual(errors,[]); fallback.stop()
})
test('cloud STT does not transcribe standby audio and resets cancel late command work', async () => {
  globalThis.__speech.stt=true; let mode='wake', requests=0, finish, output=[]
  globalThis.fetch=async (url,_init)=>{
    if(url.endsWith('/session')) return new Response(null,{status:204})
    if(!url.endsWith('/stt')) return Response.json({picovoice:false})
    requests++; return new Promise(resolve=>{finish=()=>resolve(Response.json({text:'late command.'}))})
  }
  const voice=await startVoice({mode:()=>mode,onWake(){},onSpeechStart(){},onPartial:text=>output.push(text),onUtterance:text=>output.push(text),onError(){}})
  const vad=globalThis.__vad
  vad.onStart();vad.onEnd(new Blob(['idle']));await flush();assert.equal(requests,0)
  mode='command';voice.sync();vad.onStart();vad.onEnd(new Blob(['command']));await flush();assert.equal(requests,1)
  voice.reset();finish();await flush();assert.deepEqual(output,[]);voice.stop()
  globalThis.fetch=async url=>url.endsWith('/session') ? new Response(null,{status:204}) : Response.json({picovoice:true})
})
test('ECO has zero dormant/hidden animation, DPR 1 and active ~30 FPS policy', () => {
  assert.equal(shouldAnimate('dormant',false),false);assert.equal(shouldAnimate('offline',false),false)
  assert.equal(shouldAnimate('speaking',true),false);assert.equal(shouldAnimate('listening',false),true)
  assert.equal(ECO.dpr,1);assert.equal(Math.round(1000/ECO.frameMs),30)
})
test('latest-only event timings calculate latency and reject late events from older turns', () => {
  timings.beginListening(true,100);timings.markTiming('speechEnd',undefined,300);timings.markTiming('stt',undefined,820)
  timings.beginTiming('A','voice',900);timings.markTiming('firstToken','A',1750);timings.markTiming('ttsAudio','A',1930);timings.markTiming('complete','A',2200)
  assert.deepEqual(timings.timingDurations(),{wakeToListen:0,stt:520,firstToken:850,ttsAudio:180,total:1300})
  timings.beginTiming('B','typed',2300);timings.markTiming('firstToken','A',2400);timings.cancelTiming('A')
  assert.equal(timings.timingSnapshot().turnId,'B');assert.equal(timings.timingSnapshot().marks.firstToken,undefined)
  assert.equal(timings.timingSnapshot().status,'active')
})
test('OpenRouter distinguishes credentials, quotas, upstream/free capacity, missing model, network, timeout and credits', async () => {
  for(const [status,category] of [[401,'authentication'],[429,'rate-limit'],[404,'model-unavailable'],[503,'unavailable'],[402,'unavailable'],[504,'timeout']]) assert.equal(routerError({status}).category,category)
  assert.equal(routerError(new TypeError()).category,'network')
  assert.match(routerError({status:402}).message,/Insufficient/)
  assert.match(routerError({status:429,metadata:{provider_name:'fixture'},modelId:'fixture/model:free'}).message,/free model.*upstream/)
  assert.match(routerError({status:503,modelId:'fixture/model:free'}).message,/free model\/provider/)
  assert.equal(retryAfter('15'),15);assert.equal(retryAfter('bad'),undefined)
  assert.equal(retryAfter('Thu, 01 Oct 2026 00:00:15 GMT', Date.parse('2026-10-01T00:00:00Z')),15)
  const failure=await routerFailure(Response.json({error:{metadata:{provider_name:'fixture'},message:'private fixture'}},{status:429,headers:{'retry-after':'30'}}),new AbortController().signal,'fixture/model:free')
  assert.match(failure.message,/Wait 30 seconds/);assert.equal(failure.diagnostics.retryAfterSeconds,30)
  assert.ok(!JSON.stringify(failure).includes('private fixture'))
})
test('first HTML paint is dark; 3D is lazy, opaque and hides incomplete initialization', async () => {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),host=await readFile(new URL('../src/scene/SceneHost.tsx',import.meta.url),'utf8'),scene=await readFile(new URL('../src/scene/Scene.tsx',import.meta.url),'utf8'),app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8')
  assert.ok(html.indexOf('background:#01060c')<html.indexOf('<body>'));assert.match(host,/lazy\(/)
  assert.match(scene,/alpha: false/);assert.match(scene,/frameloop="demand"/);assert.match(scene,/opacity: ready \? 1 : 0/)
  assert.match(scene,/mipmapBlurPass-resolution-scale=\{0.5\}/); assert.ok(!scene.includes('<ChromaticAberration'));assert.ok(!scene.includes('<Noise'));assert.ok(!app.includes('delay(9200'))
})
