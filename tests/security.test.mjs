import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { ModuleKind, transpileModule } from 'typescript'
import { blockedAddress, guardedLookup, MAX_REDIRECTS, openRemote, vetTarget } from '../bridge/net.mjs'
import { contained, resolveApprovedImage } from '../bridge/files.mjs'
import { createBridgeSecurity, createLimiter, createRateLimit, errorLabel, sameSecret } from '../bridge/security.mjs'

test('URL and DNS protections reject private, mapped, malformed, and credential URLs', async () => {
  for (const url of ['file:///C:/private.png', 'data:text/plain,x', 'ftp://example.com', 'http://127.1', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://192.168.1.1', 'http://10.0.0.1', 'http://169.254.169.254', 'http://localhost', 'http://printer.local', 'https://user:private@example.com']) {
    assert.throws(() => vetTarget(url))
  }
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '100.64.0.1']) assert.ok(blockedAddress(address))
  assert.equal(vetTarget('https://example.com/image?signature=private').hostname, 'example.com')
  await new Promise((resolve, reject) => guardedLookup('localhost', {}, (err) => {
    if (err?.code === 'EBLOCKEDADDRESS') resolve()
    else reject(new Error('DNS loopback was not blocked'))
  }))
})

test('redirects revalidate every target and stop at the existing cap', async () => {
  let calls = 0, stopped = 0
  const redirect = (target) => async () => { calls++; return { statusCode: 302, headers: { location: target }, destroy() { stopped++ } } }
  await assert.rejects(openRemote(vetTarget('https://example.com'), {}, 1000, redirect('http://127.0.0.1/private')), { status: 403 })
  assert.equal(calls, 1)
  await assert.rejects(openRemote(vetTarget('https://example.com'), {}, 1000, redirect('file:///private')), { status: 400 })
  calls = 0
  await assert.rejects(openRemote(vetTarget('https://example.com'), {}, 1000, redirect('https://example.com/again')), { status: 502 })
  assert.equal(calls, MAX_REDIRECTS + 1)
  assert.equal(stopped, MAX_REDIRECTS + 3, 'Discarded redirect bodies were left downloading')
})

test('authentication fails safely for Unicode, wrong values, and tampered image grants', () => {
  assert.equal(sameSecret('é'.repeat(64), 'a'.repeat(64)), false)
  assert.equal(sameSecret(undefined, 'a'.repeat(64)), false)
  const security = createBridgeSecurity(8787)
  assert.equal(security.authorized({ headers: {} }), false)
  const url = new URL(security.imageUrl('https://example.com/a.png', 'http://localhost:5173/__jarvis/bridge'))
  const request = { method: 'GET', url: '/img' + url.search }
  assert.ok(security.imageAuthorized(request))
  assert.equal(security.imageAuthorized({ ...request, method: 'POST' }), false)
  assert.equal(security.imageAuthorized({ ...request, url: '/file' + url.search }), false)
  url.searchParams.set('url', 'https://example.com/b.png')
  assert.equal(security.imageAuthorized({ ...request, url: '/img' + url.search }), false)
  assert.equal(errorLabel(new Error('Authorization: secret; cookie; transcript; ?token=private')), 'operation failed')
})

test('concurrency slots and rate budgets are bounded and safely released', () => {
  const acquire = createLimiter({ stt: 1 })
  const release = acquire('stt')
  assert.ok(release)
  assert.equal(acquire('stt'), null)
  release(); release()
  assert.ok(acquire('stt'))
  const allowed = createRateLimit(1)
  assert.equal(allowed(), true)
  assert.equal(allowed(), false)
})

test('containment and UNC/device guards reject escapes before filesystem access', async () => {
  if (process.platform === 'win32') {
    assert.equal(contained('C:\\approved', 'C:\\approved-other\\a.png'), false)
    assert.equal(contained('C:\\approved', 'D:\\approved\\a.png'), false)
    assert.equal(contained('C:\\approved', 'C:\\approved\\a.png'), true)
  }
  for (const path of ['\\\\server\\share\\private.png', '\\\\?\\C:\\private.png', '//server/share/private.png', '../private.png']) {
    assert.equal(await resolveApprovedImage(path, []), null)
  }
})

test('Windows image paths and legacy bridge URLs retain authenticated frontend routing', async () => {
  const source = await readFile(new URL('../src/lib/localImagePath.ts', import.meta.url), 'utf8')
  const js = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
  const { localImagePath, localBridgeFileUrl } = await import(`data:text/javascript,${encodeURIComponent(js)}`)
  assert.equal(localImagePath('C:\\approved\\image.png'), 'C:\\approved\\image.png')
  assert.equal(localImagePath('file:///C:/approved/image.png'), 'C:/approved/image.png')
  assert.equal(localImagePath('file://server/share/image.png'), null)
  assert.equal(localImagePath('/vite.svg'), null)
  assert.equal(localBridgeFileUrl('http://localhost:8787/file?path=approved.png'), '/__jarvis/bridge/file?path=approved.png')
  assert.equal(localBridgeFileUrl('http://other.example/file?path=private.png'), null)
})
