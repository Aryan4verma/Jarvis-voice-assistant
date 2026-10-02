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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const end = Date.now() + 20000
  while (Date.now() < end) { try { return await check() } catch { await wait(50) } }
  throw new Error('Integration fixture did not become ready')
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}

test('real authenticated bridge/broker protects isolated provider keys, streams functions/vision and cancels on settings changes', { timeout: 60000, skip: process.platform !== 'win32' }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'jarvis-router-integration-'))
  const port = await freePort(), facePort = await freePort(), origin = `http://127.0.0.1:${facePort}`
  const env = { ...process.env, LOCALAPPDATA: sandbox, JARVIS_RUNTIME_DIR: sandbox, JARVIS_AI_PROVIDER: 'claude-agent', JARVIS_TEST_OPENROUTER: '1', JARVIS_TEST_NATIVE: '1', JARVIS_BRIDGE_PORT: String(port), JARVIS_ALLOWED_ORIGINS: origin, JARVIS_FILE_ROOTS: '' }
  const children = []; let logs = '', socket
  const launch = args => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { logs += chunk }); child.stderr.on('data', chunk => { logs += chunk })
    children.push(child); return child
  }
  const KEY = 'mock-openrouter-integration-key-not-real'
  try {
    launch(['--loader', pathToFileURL(join(ROOT, 'tests/sdk-loader.mjs')).href, 'scripts/bridge.mjs'])
    const state = await until(async () => JSON.parse(await readFile(join(sandbox, `${port}.json`), 'utf8')))
    launch(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(facePort), '--strictPort'])
    await until(async () => { const res = await fetch(origin + '/'); assert.equal(res.status, 200) })
    const session = await fetch(origin + '/__jarvis/session', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-jarvis-client': '1' } })
    assert.equal(session.status, 204)
    const cookie = session.headers.get('set-cookie').split(';')[0]
    const headers = { origin, cookie, 'sec-fetch-site': 'same-origin', 'x-jarvis-settings': '1', 'content-type': 'application/json' }
    const api = (path, method = 'GET', body) => fetch(origin + '/__jarvis/bridge/ai/' + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal((await fetch(origin + '/__jarvis/bridge/ai/settings')).status, 401)
    assert.equal((await fetch(origin + '/__jarvis/bridge/ai/key', { method: 'POST', headers: { ...headers, 'x-jarvis-settings': '' }, body: JSON.stringify({ key: KEY }) })).status, 403)
    const saved = await api('key', 'POST', { key: KEY }); assert.equal(saved.status, 200)
    const publicBody = await saved.text(); assert.ok(!publicBody.includes(KEY)); assert.equal(JSON.parse(publicBody).keyConfigured, true)
    assert.ok(!(await readFile(join(sandbox, 'JarvisAI/credentials/openrouter.dpapi'))).includes(Buffer.from(KEY)))
    const preferences = { providerId: 'openrouter', mode: 'balanced', models: { fast: '', balanced: 'fixture/model', deep: '' } }
    assert.equal((await api('settings', 'PUT', preferences)).status, 200)
    const check = await api('test', 'POST'); assert.equal(check.status, 200)
    const checked = await check.text(); assert.ok(!checked.includes(KEY) && !checked.includes('private-key-account-fixture')); assert.equal(JSON.parse(checked).readiness, 'ready')
    // Capability discovery is an explicit Settings action, never a generation-time catalog refresh.
    assert.equal((await api('models')).status, 200)
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { authorization: `Bearer ${state.token}` } })
    const seen = []; socket.on('message', raw => seen.push(JSON.parse(raw))); await once(socket, 'open')
    const ask = (turnId, prompt) => socket.send(JSON.stringify({ type: 'ask', turnId, messages: [{ role: 'user', content: prompt }] }))
    ask('UI', 'reset')
    await until(async () => { assert.ok(seen.some(event => event.type === 'done' && event.turnId === 'UI')) })
    assert.ok(seen.some(event => event.type === 'ui' && event.turnId === 'UI' && event.op === 'reset'))
    ask('VISION', 'look')
    const capture = await until(async () => { const value = seen.find(event => event.type === 'capture' && event.turnId === 'VISION'); assert.ok(value); return value })
    socket.send(JSON.stringify({ type: 'reply', turnId: 'VISION', id: capture.id, data: 'eA==', mimeType: 'image/png' }))
    await until(async () => { assert.ok(seen.some(event => event.type === 'done' && event.turnId === 'VISION')) })
    ask('A', 'hold'); await until(async () => { assert.ok(seen.some(event => event.type === 'text' && event.turnId === 'A')) })
    assert.equal((await api('settings', 'PUT', { ...preferences, mode: 'fast' })).status, 200)
    ask('B', 'Next')
    await until(async () => { assert.ok(seen.some(event => event.type === 'done' && event.turnId === 'B')) })
    await wait(300)
    const cancelled = seen.findIndex(event => event.type === 'cancelled' && event.turnId === 'A')
    assert.ok(cancelled >= 0); assert.equal(seen[cancelled].backend, 'request-abort-requested')
    assert.ok(!seen.slice(cancelled + 1).some(event => event.turnId === 'A'))
    assert.ok(seen.some(event => event.type === 'text' && event.turnId === 'B'))
    assert.equal((await api('key', 'DELETE')).status, 200)
    assert.equal((await (await api('settings')).json()).keyConfigured, false)
    for (const provider of ['openai', 'gemini']) {
      const key = KEY + '-' + provider, model = provider === 'openai' ? 'gpt-5-mini' : 'gemini-3-flash-preview'
      const save = await api('key?provider=' + provider, 'POST', { key }); assert.equal(save.status, 200)
      const metadata = await save.text(); assert.ok(!metadata.includes(key)); assert.equal(JSON.parse(metadata).providers[provider].configured, true)
      assert.ok(!(await readFile(join(sandbox, `JarvisAI/credentials/${provider}.dpapi`))).includes(Buffer.from(key)))
      const prefs = { providerId: provider, mode: 'balanced', models: { fast: '', balanced: model, deep: '' } }
      assert.equal((await api('settings', 'PUT', prefs)).status, 200)
      assert.equal((await api('models?provider=' + provider)).status, 200)
      const tested = await (await api('test?provider=' + provider, 'POST')).json(); assert.equal(tested.readiness, 'ready'); assert.ok(!JSON.stringify(tested).includes(key))
      ask(provider + '-UI', 'reset')
      await until(async () => { assert.ok(seen.some(e => e.type === 'done' && e.turnId === provider + '-UI')) })
      assert.ok(seen.some(e => e.type === 'ui' && e.turnId === provider + '-UI'))
      ask(provider + '-VISION', 'look')
      const camera = await until(async () => { const event = seen.find(e => e.type === 'capture' && e.turnId === provider + '-VISION'); assert.ok(event); return event })
      socket.send(JSON.stringify({ type: 'reply', turnId: camera.turnId, id: camera.id, data: 'eA==', mimeType: 'image/png' }))
      await until(async () => { assert.ok(seen.some(e => e.type === 'done' && e.turnId === camera.turnId)) })
      ask(provider + '-A', 'hold'); await until(async () => { assert.ok(seen.some(e => e.type === 'text' && e.turnId === provider + '-A')) })
      assert.equal((await api('settings', 'PUT', { ...prefs, mode: 'fast' })).status, 200)
      ask(provider + '-B', 'Next'); await until(async () => { assert.ok(seen.some(e => e.type === 'done' && e.turnId === provider + '-B')) })
      await wait(300)
      const ended = seen.findIndex(e => e.type === 'cancelled' && e.turnId === provider + '-A'); assert.ok(ended >= 0)
      assert.equal(seen[ended].backend, 'request-abort-requested'); assert.ok(!seen.slice(ended + 1).some(e => e.turnId === provider + '-A'))
      assert.ok(!JSON.stringify(seen).includes(key) && !logs.includes(key))
    }
    const isolated = await (await api('settings')).json(); assert.equal(isolated.providers.openai.configured, true); assert.equal(isolated.providers.gemini.configured, true)
    assert.equal(isolated.profiles.openrouter.models.balanced, 'fixture/model'); assert.equal(isolated.profiles.openai.models.balanced, 'gpt-5-mini')
    assert.equal((await api('key?provider=openai', 'DELETE')).status, 200)
    assert.equal((await (await api('settings')).json()).providers.gemini.configured, true)
    assert.ok(!JSON.stringify(seen).includes(KEY) && !logs.includes(KEY) && !logs.includes('private-key-account-fixture'))
  } finally {
    socket?.terminate()
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([once(child, 'exit').catch(() => {}), wait(3000)]) }
    const actual = resolve(sandbox); assert.ok(actual.startsWith(resolve(tmpdir()) + sep)); await rm(actual, { recursive: true, force: true })
  }
})
