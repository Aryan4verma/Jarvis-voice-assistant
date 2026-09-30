import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { ROOT } from '../scripts/runtime.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function until(check, child) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Local test service exited before readiness')
    try { return await check() } catch { await wait(100) }
  }
  throw new Error('Local test service did not become ready')
}
function dial(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('error', () => reject(new Error('WebSocket failed')))
    socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode) })
    socket.once('open', () => resolve(socket))
  })
}

test('real loopback bridge and Vite broker enforce authenticated routes and limits', { timeout: 90000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'jarvis-security-'))
  const port = await freePort(), facePort = await freePort()
  const origin = `http://127.0.0.1:${facePort}`, base = `http://127.0.0.1:${port}`
  const children = [], sockets = []
  let logs = ''
  const launch = (args) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: {
      ...process.env, LOCALAPPDATA: sandbox, JARVIS_AI_PROVIDER: 'claude-agent', JARVIS_RUNTIME_DIR: sandbox, JARVIS_BRIDGE_PORT: String(port),
      JARVIS_ALLOWED_ORIGINS: origin, JARVIS_ALLOW_WRITES: '0', JARVIS_MAX_STT: '1',
      JARVIS_MAX_SESSIONS: '1', JARVIS_FILE_ROOTS: '', ELEVENLABS_API_KEY: 'test-speech-key-not-real',
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { logs += chunk })
    child.stderr.on('data', (chunk) => { logs += chunk })
    children.push(child)
    return child
  }
  try {
    const bridge = launch(['--loader', pathToFileURL(join(ROOT, 'tests/sdk-loader.mjs')).href, 'scripts/bridge.mjs'])
    const state = await until(async () => JSON.parse(await readFile(join(sandbox, `${port}.json`), 'utf8')), bridge)
    const auth = { authorization: `Bearer ${state.token}` }
    const get = (path, headers = {}) => fetch(base + path, { headers, signal: AbortSignal.timeout(3000) })
    const raw = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
      const req = request(base + path, { headers, method }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode))
      })
      req.on('error', () => reject(new Error('Raw HTTP test failed')))
      req.end(body)
    })
    const health = await get('/health')
    assert.deepEqual(await health.json(), { ok: true })
    if (process.platform === 'win32') {
      const listeners = spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -State Listen -OwningProcess ${bridge.pid}).LocalAddress | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true })
      assert.equal(listeners.status, 0)
      const addresses = JSON.parse(listeners.stdout)
      assert.ok([addresses].flat().every((address) => address === '127.0.0.1'), 'Bridge listener is not loopback-only')
    }
    assert.equal(await raw('/health', { host: `evil.example:${port}` }), 403)
    for (const path of ['/ai/settings', '/ai/models', '/readiness', '/file?path=C%3A%5Cprivate.png', '/img?url=https://example.com', '/media?url=https://example.com', '/page?url=https://example.com']) {
      assert.equal((await get(path)).status, 401)
    }
    for (const path of ['/ai/key', '/ai/test', '/tts', '/stt']) assert.equal((await fetch(base + path, { method: 'POST' })).status, 401)
    const ready = await get('/readiness', auth)
    assert.equal(ready.status, 200)
    assert.equal((await ready.json()).speech.readiness, 'not-validated')
    assert.equal(await raw('/stt', { ...auth, 'content-length': String(26 * 1024 * 1024) }, 'POST'), 413)
    const hold = (path) => {
      const req = request(base + path, { method: 'POST', headers: { ...auth, 'content-length': '4096' } })
      req.on('error', () => {})
      req.write(' ')
      return req
    }
    const heldStt = hold('/stt'); await wait(100)
    assert.equal(await raw('/stt', auth, 'POST'), 429)
    heldStt.destroy(); await wait(50)
    assert.equal(await raw('/stt', auth, 'POST'), 200)
    const heldTts = [hold('/tts'), hold('/tts')]; await wait(100)
    assert.equal(await raw('/tts', auth, 'POST'), 429)
    heldTts.forEach((req) => req.destroy()); await wait(50)
    const image = join(sandbox, 'artifacts', 'generated.png'), privateImage = join(sandbox, 'private.png')
    const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    await writeFile(image, pixels); await writeFile(privateImage, pixels)
    assert.equal((await get('/file?path=' + encodeURIComponent(image), auth)).status, 200)
    for (const path of [privateImage, join(sandbox, 'artifacts', '..', 'private.png'), '\\\\host\\share\\a.png']) {
      assert.equal((await get('/file?path=' + encodeURIComponent(path), auth)).status, 403)
    }
    const outside = join(sandbox, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.png'), pixels)
    await symlink(outside, join(sandbox, 'artifacts', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await get('/file?path=' + encodeURIComponent(join(sandbox, 'artifacts', 'escape', 'private.png')), auth)).status, 403)
    for (const path of ['/img?url=http://127.0.0.1/private?token=do-not-log', '/media?url=http://192.168.1.1', '/page?url=http://[::1]']) {
      assert.equal((await get(path, auth)).status, 403)
    }
    assert.equal(await dial(`ws://127.0.0.1:${port}/ws`, { origin }), 401)
    const ws = await dial(`ws://127.0.0.1:${port}/ws`, { origin, headers: auth }); sockets.push(ws)
    assert.ok(ws instanceof WebSocket)
    ws.send('null'); ws.send('[]'); ws.send('{bad json')
    assert.equal(await dial(`ws://127.0.0.1:${port}/ws`, { origin, headers: auth }), 429)
    ws.close(); await once(ws, 'close'); await wait(50)

    const face = launch(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(facePort), '--strictPort'])
    await until(async () => { const response = await fetch(origin); if (!response.ok) throw new Error(); return response }, face)
    const frontend = (path, init = {}) => fetch(origin + path, { ...init, signal: AbortSignal.timeout(3000) })
    assert.equal((await frontend('/__jarvis/bridge/readiness')).status, 401)
    assert.equal((await frontend('/__jarvis/session', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'x-jarvis-client': '1' } })).status, 403)
    const session = await frontend('/__jarvis/session', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-jarvis-client': '1' } })
    assert.equal(session.status, 204)
    const setCookie = session.headers.get('set-cookie')
    assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'))
    assert.ok(!setCookie.includes(state.token), 'Bridge bearer reached browser cookie')
    const cookie = setCookie.split(';')[0], clientHeaders = { cookie, origin, 'sec-fetch-site': 'same-origin' }
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: clientHeaders })).status, 200)
    assert.equal((await frontend('/__jarvis/bridge/file?path=' + encodeURIComponent(image), { headers: clientHeaders })).status, 200)
    assert.equal((await frontend('/__jarvis/bridge/stt', { method: 'POST', body: '', headers: { ...clientHeaders, 'content-type': 'audio/webm' } })).status, 200)
    const media = await frontend('/__jarvis/bridge/media?url=https://security-fixture.example/video', { headers: { ...clientHeaders, range: 'bytes=0-3' } })
    assert.equal(media.status, 206)
    assert.equal(media.headers.get('content-range'), 'bytes 0-3/8')
    assert.equal(await media.text(), 'test')
    assert.equal((await frontend('/__jarvis/bridge/img?url=https://security-fixture.example/oversized.png', { headers: clientHeaders })).status, 413)
    const article = await frontend('/__jarvis/bridge/page?url=https://security-fixture.example/article', { headers: clientHeaders })
    assert.equal(article.status, 200)
    assert.ok(article.headers.get('content-security-policy').includes(`img-src ${origin}/__jarvis/bridge/`))
    assert.equal(article.headers.get('referrer-policy'), 'no-referrer')
    const html = await article.text()
    assert.ok(!html.includes(state.token), 'Bridge bearer reached article markup')
    const imageUrl = /<img[^>]+src="([^"]+)"/.exec(html)?.[1].replace(/&amp;/g, '&')
    assert.ok(imageUrl, 'Reader image was removed')
    const sandboxHeaders = { origin: 'null', 'sec-fetch-site': 'cross-site' }
    assert.equal((await fetch(imageUrl, { headers: sandboxHeaders })).status, 200)
    const tampered = new URL(imageUrl); tampered.searchParams.set('url', 'http://127.0.0.1/private')
    assert.equal((await fetch(tampered, { headers: sandboxHeaders })).status, 401)
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: { ...clientHeaders, origin: 'https://evil.example' } })).status, 401)
    assert.equal(await dial(`ws://127.0.0.1:${facePort}/__jarvis/bridge/ws`, { origin }), 401)
    const client = await dial(`ws://127.0.0.1:${facePort}/__jarvis/bridge/ws`, { origin, headers: { cookie } }); sockets.push(client)
    const result = new Promise((resolve) => client.on('message', (raw) => { const msg = JSON.parse(raw); if (msg.type === 'done') resolve(msg) }))
    client.send(JSON.stringify({ type: 'ask', turnId: 'safe-test', text: 'hello' }))
    assert.equal((await result).text, 'Security test reply.')
    client.send(JSON.stringify({ type: 'ask', turnId: 'log-test', text: 'security-log-test' }))
    await once(client, 'close')
    await wait(50)
    const oversized = await dial(`ws://127.0.0.1:${port}/ws`, { origin, headers: auth }); sockets.push(oversized)
    assert.ok(oversized instanceof WebSocket)
    oversized.send(Buffer.alloc(6 * 1024 * 1024 + 1))
    await once(oversized, 'close')
    assert.equal((await get('/health')).status, 200)
    const faceClosed = once(face, 'close'); face.kill(); await faceClosed
    const preview = join(sandbox, 'preview'); await mkdir(preview)
    await writeFile(join(preview, 'index.html'), '<!doctype html><title>Security preview test</title>')
    const previewServer = launch(['node_modules/vite/bin/vite.js', 'preview', '--outDir', preview, '--host', '127.0.0.1', '--port', String(facePort), '--strictPort'])
    await until(async () => { const response = await fetch(origin); if (!response.ok) throw new Error(); return response }, previewServer)
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: clientHeaders })).status, 200)
    const bridgeClosed = once(bridge, 'close'); bridge.kill(); await bridgeClosed
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: clientHeaders })).status, 503)
    const restarted = launch(['--loader', pathToFileURL(join(ROOT, 'tests/sdk-loader.mjs')).href, 'scripts/bridge.mjs'])
    const fresh = await until(async () => {
      const data = JSON.parse(await readFile(join(sandbox, `${port}.json`), 'utf8'))
      if (data.pid !== restarted.pid) throw new Error()
      return data
    }, restarted)
    assert.ok(fresh.token !== state.token, 'Restart reused the bridge credential')
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: clientHeaders })).status, 401)
    assert.ok(!logs.includes(fresh.token), 'Restarted credential reached logs')
    assert.equal((await fetch(imageUrl, { headers: sandboxHeaders })).status, 401)
    const renewed = await frontend('/__jarvis/session', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', 'x-jarvis-client': '1' } })
    assert.equal(renewed.status, 204)
    const renewedHeaders = { ...clientHeaders, cookie: renewed.headers.get('set-cookie').split(';')[0] }
    assert.equal((await frontend('/__jarvis/bridge/readiness', { headers: renewedHeaders })).status, 200)
    assert.ok(!logs.includes(state.token) && !logs.includes('test-speech-key-not-real') && !logs.includes('do-not-log') && !logs.includes('sensitive transcript'), 'Sensitive values reached logs')
    assert.equal(restarted.exitCode, null)
  } catch (err) {
    // Report process outcomes without echoing captured logs or credentials.
    console.error('Security test child exit codes:', children.map((child) => child.exitCode ?? child.signalCode ?? 'running').join(', '))
    console.error('Security test startup failure categories:', ['bridge listen failed', 'private session setup failed', 'Bridge startup failed']
      .filter((label) => logs.includes(label)).join(', ') || 'none')
    throw err
  } finally {
    for (const socket of sockets) socket.terminate()
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = once(child, 'close'); child.kill(); await closed
    }))
    const target = resolve(sandbox)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('jarvis-security-'))
    await rm(target, { recursive: true, force: true })
  }
})
