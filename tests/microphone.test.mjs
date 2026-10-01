import test from 'node:test'
import assert from 'node:assert/strict'
const { getMic, stopAudio } = await import('../src/lib/audio.ts?actual')
test('concurrent microphone initialization opens exactly one stream, shares it, and stops late permission results', async () => {
  let resolve, requests=0, stops=0
  const track={readyState:'live',stop(){stops++;this.readyState='ended'}}, stream={getAudioTracks:()=>[track],getTracks:()=>[track]}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:options=>{requests++;assert.equal(options.audio.echoCancellation,true);assert.equal(options.audio.noiseSuppression,true);return new Promise(r=>{resolve=r})}}}})
  const a=getMic(),b=getMic();assert.equal(requests,1);resolve(stream)
  assert.equal(await a,stream);assert.equal(await b,stream);assert.equal(await getMic(),stream);assert.equal(requests,1)
  stopAudio();assert.equal(stops,1)
  const late=getMic();stopAudio();resolve(stream);await assert.rejects(late,/cancelled/);assert.equal(stops,2)
})
