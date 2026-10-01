import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createSecretStore, dpapi } from '../bridge/secrets.mjs'
import { voiceHTTP } from '../bridge/voice-settings.mjs'
const KEY='voice-test-fixture-credential-only'
test('voice secrets use Windows CurrentUser encryption outside Git with separate purposes', {skip:process.platform!=='win32'}, async () => {
  const directory=await mkdtemp(join(tmpdir(),'jarvis-voice-test-'))
  try {
    for(const purpose of ['elevenlabs','picovoice']) {
      const store=createSecretStore({directory,purpose});await store.save(KEY)
      assert.equal(await store.read(),KEY);assert.equal(await store.configured(),true)
      const bytes=await readFile(join(directory,`${purpose}.dpapi`));assert.ok(!bytes.includes(Buffer.from(KEY)))
      await assert.rejects(dpapi('Unprotect',bytes,undefined,'openrouter'));await store.delete();assert.equal(await store.configured(),false)
    }
  } finally {assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true})}
})
test('voice settings never return ElevenLabs keys; optional wake credential requires explicit mutation Origin/header', async () => {
  const values={elevenlabs:null,picovoice:null}
  const stores=Object.fromEntries(Object.keys(values).map(purpose=>[purpose,{supported:true,configured:async()=>!!values[purpose],save:async key=>{values[purpose]=key},read:async()=>values[purpose],delete:async()=>{values[purpose]=null}}]))
  const server=createServer(async (req,res)=>{
    // Caller authentication is enforced by the real bridge before this module.
    if(!(await voiceHTTP(req,res,{stores,legacyEleven:()=>null,signal:new AbortController().signal,cors:{},originAllowed:origin=>origin==='http://localhost:5173'}))) {res.writeHead(404);res.end()}
  });server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`http://127.0.0.1:${server.address().port}/voice`,headers={origin:'http://localhost:5173','x-jarvis-settings':'1','content-type':'application/json'}
  try {
    assert.equal((await fetch(url+'/picovoice/key',{method:'POST',body:JSON.stringify({key:KEY})})).status,403)
    for(const purpose of ['elevenlabs','picovoice']) {
      const saved=await fetch(url+`/${purpose}/key`,{method:'POST',headers,body:JSON.stringify({key:KEY})});assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes(KEY))
    }
    const snapshot=await (await fetch(url+'/settings')).json();assert.equal(snapshot.elevenlabs,true);assert.equal(snapshot.picovoice,true);assert.ok(!JSON.stringify(snapshot).includes(KEY))
    assert.equal((await fetch(url+'/wake-session',{method:'POST'})).status,403)
    const wake=await (await fetch(url+'/wake-session',{method:'POST',headers})).json();assert.equal(wake.accessKey,KEY)
    for(const purpose of ['elevenlabs','picovoice']) assert.equal((await fetch(url+`/${purpose}/key`,{method:'DELETE',headers})).status,200)
    assert.deepEqual(values,{elevenlabs:null,picovoice:null})
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('speech secret cache avoids repeated DPAPI work, respects cancellation and clears on replacement/deletion', async () => {
  const directory=await mkdtemp(join(tmpdir(),'jarvis-voice-cache-')); let decrypts=0
  const crypt=async (action,bytes)=>{if(action==='Unprotect') decrypts++;return Buffer.from(bytes)}
  const store=createSecretStore({directory,purpose:'elevenlabs',cache:true,supported:true,crypt})
  try {
    await store.save(KEY);assert.equal(await store.read(),KEY);assert.equal(await store.read(),KEY);assert.equal(decrypts,1)
    const controller=new AbortController();controller.abort();await assert.rejects(store.read(controller.signal))
    await store.save(KEY+'-replaced');assert.equal(await store.read(),KEY+'-replaced');assert.equal(decrypts,2)
    await store.delete();await assert.rejects(store.read());assert.equal(await store.configured(),false)
  } finally {store.clearCache();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true})}
})

test('late credential reads cannot poison a newer speech-key cache', async () => {
  const directory=await mkdtemp(join(tmpdir(),'jarvis-voice-race-'));let release,entered
  const gate=new Promise(resolve=>{entered=resolve});let first=true
  const store=createSecretStore({directory,purpose:'elevenlabs',cache:true,supported:true,crypt:async(action,bytes)=>{
    const copy=Buffer.from(bytes)
    if(action==='Unprotect' && first){first=false;entered();await new Promise(resolve=>{release=resolve})}
    return copy
  }})
  try {
    await store.save(KEY);const old=store.read();await gate
    await store.save(KEY+'-new');release();assert.equal(await old,KEY)
    assert.equal(await store.read(),KEY+'-new');assert.equal(await store.read(),KEY+'-new')
  } finally {store.clearCache();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true})}
})
