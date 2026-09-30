import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { ROOT } from '../scripts/runtime.mjs'
import { createTurnScope } from '../bridge/turn.mjs'
import { ChromeLink } from '../bridge/chrome.mjs'

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { try { return await check() } catch { await wait(30) } }
  throw new Error('Lifecycle fixture did not become ready')
}

test('backend immutable scope rejects pending camera and discards all old effects', async () => {
  const seen = [], scope = createTurnScope('A', (message) => seen.push(message))
  const pending = scope.request('capture', {})
  assert.equal(scope.pendingCount(), 1)
  scope.reply({ turnId: 'B', id: seen[0].id }); assert.equal(scope.pendingCount(), 1)
  scope.stop(); await assert.rejects(pending)
  for (const type of ['text','tool','ui','panel','blade','capture','done','error']) scope.send({ type })
  assert.equal(scope.pendingCount(), 0); assert.equal(seen.length, 1)
  assert.equal(seen[0].turnId, 'A'); assert.equal(scope.signal.aborted, true)
})

test('browser retries are read-only; cancelled queued effects never execute', async () => {
  const link = new ChromeLink(); let calls = 0
  link.request = async () => { calls++; throw new Error('uncertain dispatch') }
  for (const [name,args] of [['computer',{action:'left_click'}],['computer',{action:'type'}],['navigate',{}],['tabs_context_mcp',{createIfEmpty:true}],['form_input',{}],['tabs_close_mcp',{}]]) {
    calls = 0; await assert.rejects(link.call(name,args), /not retried.*outcome is unknown/); assert.equal(calls,1)
  }
  calls = 0; await assert.rejects(link.call('get_page_text',{})); assert.equal(calls,2)
  let release
  link.request = async () => { calls++; await new Promise(resolve => { release = resolve }); return {} }
  const running = link.call('get_page_text',{}); await wait(0)
  const controller = new AbortController(), queued = link.call('computer',{action:'left_click'}, controller.signal)
  controller.abort(); await assert.rejects(queued)
  release(); await running; await wait(0)
  assert.equal(calls,3); assert.equal(link.queued,0); assert.equal(link.waiting,null)
})

test('late native-socket write errors cannot reset a newer browser request', async () => {
  const callbacks = [], socket = { write(_data, callback) { callbacks.push(callback) }, removeAllListeners() {}, destroy() {} }
  const link = new ChromeLink(); link.socket = socket; link.ensureConnected = async () => {}
  const a = link.request({fixture:'A'}); await wait(0)
  link.waiting.resolve({fixture:'A'}); link.waiting = null; await a
  const controller = new AbortController(), b = link.request({fixture:'B'}, controller.signal); await wait(0)
  const owner = link.waiting
  callbacks[0](new Error('late write error'))
  assert.equal(link.socket, socket); assert.equal(link.waiting, owner)
  controller.abort(); await assert.rejects(b)
  assert.equal(link.waiting, null); assert.equal(link.socket, null)
})

test('camera timeout removes its correlation entry and requests frontend cleanup', async () => {
  const seen = [], scope = createTurnScope('camera', (message) => seen.push(message))
  const first = scope.request('capture', {}, 5), second = scope.request('capture', {}, 5)
  await assert.rejects(scope.request('capture', {}), /limit/)
  await Promise.all([assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)])
  assert.equal(scope.pendingCount(), 0)
  assert.equal(seen.filter(message => message.type === 'capture-cancel' && message.turnId === 'camera').length, 2)
  scope.stop()
})

test('real bridge: cancelled query callbacks cannot relabel B; disconnect closes SDK and camera waits', { timeout: 60000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'jarvis-lifecycle-'))
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve))
  let logs = '', socket, child
  try {
    child = spawn(process.execPath, ['--loader',pathToFileURL(join(ROOT,'tests/sdk-loader.mjs')).href,'scripts/bridge.mjs'], {
      cwd: ROOT, env: { ...process.env, JARVIS_RUNTIME_DIR:sandbox, JARVIS_BRIDGE_PORT:String(port), JARVIS_TEST_LIFECYCLE:'1', JARVIS_FILE_ROOTS:'', JARVIS_ALLOW_WRITES:'0' }, stdio:['ignore','pipe','pipe'],
    })
    child.stdout.on('data',chunk => { logs += chunk }); child.stderr.on('data',chunk => { logs += chunk })
    const state = await until(async () => JSON.parse(await readFile(join(sandbox,`${port}.json`),'utf8')))
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:'http://localhost:5173',headers:{authorization:`Bearer ${state.token}`}})
    const seen = []; socket.on('message',raw => seen.push(JSON.parse(raw))); await once(socket,'open')
    socket.send(JSON.stringify({type:'ask',turnId:'A',text:'late-A'}))
    await until(async () => { assert.ok(seen.find(message => message.type === 'capture' && message.turnId === 'A')) })
    await until(async () => { assert.ok(seen.find(message => message.type === 'ui' && message.turnId === 'A')) })
    socket.send(JSON.stringify({type:'cancel',turnId:'A'}))
    socket.send(JSON.stringify({type:'ask',turnId:'B',text:'B'}))
    await until(async () => { assert.ok(seen.find(message => message.type === 'done' && message.turnId === 'B')) })
    const receipt = seen.findIndex(message => message.type === 'cancelled' && message.turnId === 'A')
    assert.ok(receipt >= 0); assert.equal(seen[receipt].backend,'termination-requested')
    assert.ok(!seen.slice(receipt + 1).some(message => message.turnId === 'A'))
    assert.ok(!seen.filter(message => message.turnId === 'B').some(message => message.delta === 'late-output' || ['ui','panel','blade','capture','error'].includes(message.type)))
    assert.ok(logs.includes('[test] SDK abort invoked') && logs.includes('[test] SDK close invoked') && logs.includes('[test] camera wait cleared'))
    socket.send(JSON.stringify({type:'cancel',turnId:'A'})) // stale cancel cannot stop a newer query
    socket.send(JSON.stringify({type:'ask',turnId:'C',text:'hold-camera'}))
    await until(async () => { assert.ok(seen.find(message => message.type === 'capture' && message.turnId === 'C')) })
    socket.close(); await once(socket,'close')
    await until(async () => { assert.ok(logs.split('[test] camera wait cleared').length >= 3) })
    assert.ok(logs.includes('[test] SDK resume supplied'))
    assert.ok(!logs.includes(state.token)); assert.equal(child.exitCode,null)
  } finally {
    socket?.terminate()
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child,'close'); child.kill(); await ended }
    const target = resolve(sandbox)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('jarvis-lifecycle-'))
    await rm(target,{recursive:true,force:true})
  }
})
