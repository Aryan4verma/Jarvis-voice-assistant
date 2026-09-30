import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createSecretStore, dpapi } from '../bridge/secrets.mjs'
import { createAISettings } from '../bridge/ai-settings.mjs'
import { settingsHTTP } from '../bridge/settings-http.mjs'
import { ROOT } from '../scripts/runtime.mjs'
import { aiError, AIProviderError } from '../shared/ai.mjs'

// Non-secret test value. Never contacts OpenRouter.
const KEY = 'mock-openrouter-unit-fixture-key'
const fakeCrypt = async (action, bytes) => {
  const output = Buffer.from(bytes); for (let i = 0; i < output.length; i++) output[i] ^= 0x5a
  return output
}
const preferences = { providerId: 'openrouter', mode: 'balanced', models: { fast: '', balanced: 'fixture/model', deep: '' } }
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-settings-'))
  try { await run(directory) }
  finally {
    const actual = resolve(directory), parent = resolve(tmpdir()) + sep
    assert.ok(actual.startsWith(parent)); await rm(actual, { recursive: true, force: true })
  }
}
const client = {
  cached: () => null, model: async () => ({ modelId: 'fixture/model' }),
  testKey: async key => { assert.equal(key, KEY) }, catalog: async () => [],
}
async function setup(directory, custom = client) {
  const secrets = createSecretStore({ directory: join(directory, 'keys'), crypt: fakeCrypt, supported: true })
  const settings = await createAISettings({ secrets, client: custom, directory: join(directory, 'settings') })
  return { secrets, settings }
}

test('protected storage saves/replaces/deletes outside the repository and never returns a key in settings', async () => temporary(async directory => {
  const { secrets, settings } = await setup(directory)
  assert.equal(await secrets.configured(), false)
  await settings.saveKey(KEY); assert.equal(await secrets.read(), KEY)
  const blob = await readFile(join(directory, 'keys/openrouter.dpapi'))
  assert.ok(!blob.includes(Buffer.from(KEY)))
  await settings.save(preferences)
  const publicValue = await settings.snapshot()
  assert.equal(publicValue.keyConfigured, true); assert.equal(publicValue.modelId, 'fixture/model')
  assert.ok(!JSON.stringify(publicValue).includes(KEY))
  const config = await readFile(join(directory, 'settings/ai.json'), 'utf8')
  assert.deepEqual(JSON.parse(config), preferences); assert.ok(!config.includes(KEY))
  await settings.saveKey(KEY + '-replacement'); assert.equal(await secrets.read(), KEY + '-replacement')
  await settings.deleteKey(); assert.equal(await secrets.configured(), false)
  assert.deepEqual(await readdir(join(directory, 'keys')), [])
}))

test('Windows CurrentUser DPAPI performs a real encrypted round trip', { skip: process.platform !== 'win32' }, async () => temporary(async directory => {
  const secrets = createSecretStore({ directory: join(directory, 'keys') })
  await secrets.save(KEY)
  const encrypted = await readFile(join(directory, 'keys/openrouter.dpapi'))
  assert.ok(!encrypted.includes(Buffer.from(KEY))); assert.equal(await secrets.read(), KEY)
  const tampered = Buffer.from(encrypted); tampered[0] ^= 1
  await assert.rejects(dpapi('Unprotect', tampered), /storage failed/)
  await secrets.delete(); assert.equal(await secrets.configured(), false)
}))

test('storage fails closed on unsupported systems and repository paths', async () => {
  const unavailable = createSecretStore({ supported: false })
  await assert.rejects(unavailable.save(KEY)); await assert.rejects(unavailable.read()); assert.equal(await unavailable.configured(), false)
  const unsafe = createSecretStore({ directory: join(ROOT, 'private-key-fixture'), crypt: fakeCrypt, supported: true })
  await assert.rejects(unsafe.save(KEY), /outside the repository/)
})

test('failed key replacement preserves the previous encrypted key', async () => temporary(async directory => {
  const { secrets } = await setup(directory); await secrets.save(KEY)
  const failing = createSecretStore({ directory: join(directory, 'keys'), supported: true, crypt: async () => { throw new Error('private-fixture') } })
  await assert.rejects(failing.save(KEY + '-new')); assert.equal(await secrets.read(), KEY)
  assert.equal((await readdir(join(directory, 'keys'))).length, 1)
}))

test('configuration whitelist rejects keys/private fields and model modes remain configurable', async () => temporary(async directory => {
  const { settings } = await setup(directory)
  await assert.rejects(settings.save({ ...preferences, apiKey: KEY }), error => error.category === 'invalid-request')
  await assert.rejects(settings.save({ ...preferences, models: { ...preferences.models, deep: '../secret' } }))
  await settings.save({ ...preferences, mode: 'deep' }); assert.equal(settings.selection().modelId, 'fixture/model')
  await settings.save({ ...preferences, mode: 'fast', models: { ...preferences.models, fast: 'other/custom-model' } })
  assert.equal(settings.selection().modelId, 'other/custom-model')
  const { settings: restarted } = await setup(directory)
  assert.equal(restarted.selection().mode, 'fast'); assert.equal(restarted.selection().modelId, 'other/custom-model')
}))

test('damaged optional preferences retain a usable Claude fallback and can be repaired explicitly', async () => temporary(async directory => {
  await setup(directory)
  await writeFile(join(directory, 'settings/ai.json'), '{broken')
  const { settings } = await setup(directory)
  assert.equal(settings.selection().providerId, 'claude-agent')
  assert.equal((await settings.snapshot()).readiness, 'unavailable')
  await settings.save(preferences)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings/ai.json'), 'utf8')), preferences)
  assert.equal((await settings.snapshot()).error, null)
}))

test('readiness changes only on a test/request and ignores reports from older configuration', async () => temporary(async directory => {
  const { settings } = await setup(directory); await settings.saveKey(KEY); await settings.save(preferences)
  assert.equal((await settings.snapshot()).readiness, 'not-validated')
  await settings.test(new AbortController().signal); assert.equal((await settings.snapshot()).readiness, 'ready')
  const old = settings.selection().revision
  await settings.save({ ...preferences, mode: 'deep' })
  settings.report(old, aiError('authentication'))
  assert.equal((await settings.snapshot()).readiness, 'not-validated')
  settings.report(settings.selection().revision, aiError('rate-limit'))
  assert.equal((await settings.snapshot()).readiness, 'rate-limited')
}))

test('connection failures produce safe status and account/key data never reaches the frontend', async () => temporary(async directory => {
  const { settings } = await setup(directory, { ...client, testKey: async () => { throw new AIProviderError(aiError('authentication')) } })
  await settings.saveKey(KEY); await settings.save(preferences)
  const value = await settings.test(new AbortController().signal)
  assert.equal(value.readiness, 'invalid-credentials'); assert.ok(!JSON.stringify(value).includes(KEY))
}))

test('HTTP settings require mutation Origin/header, reject oversized bodies and never echo saved secrets', async () => temporary(async directory => {
  const { settings } = await setup(directory)
  const server = createServer((req, res) => {
    void settingsHTTP(req, res, { settings, client, signal: new AbortController().signal, cors: {}, originAllowed: origin => origin === 'http://localhost:5173' })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`, headers = { origin: 'http://localhost:5173', 'x-jarvis-settings': '1', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(base + '/ai/key', { method: 'POST', body: JSON.stringify({ key: KEY }) })).status, 403)
    assert.equal((await fetch(base + '/ai/key', { method: 'POST', headers: { origin: headers.origin }, body: JSON.stringify({ key: KEY }) })).status, 403)
    const saved = await fetch(base + '/ai/key', { method: 'POST', headers, body: JSON.stringify({ key: KEY }) })
    assert.equal(saved.status, 200); const body = await saved.text()
    assert.ok(!body.includes(KEY)); assert.equal(JSON.parse(body).keyConfigured, true)
    const giant = await fetch(base + '/ai/key', { method: 'POST', headers, body: JSON.stringify({ key: KEY, extra: 'x'.repeat(9000) }) })
    assert.equal(giant.status, 400)
    await settings.save(preferences)
    const checked = await fetch(base + '/ai/test', { method: 'POST', headers })
    assert.equal(checked.status, 200); assert.equal((await checked.json()).readiness, 'ready')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))

test('aborted settings test cannot publish readiness or retain work after a configuration change', async () => temporary(async directory => {
  let finish
  const { settings } = await setup(directory, { ...client, testKey: () => new Promise(resolve => { finish = resolve }) })
  await settings.saveKey(KEY); await settings.save(preferences)
  const controller = new AbortController(), pending = settings.test(controller.signal)
  while (!finish) await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort(); await settings.save({ ...preferences, mode: 'deep' }); finish()
  await assert.rejects(pending); assert.equal((await settings.snapshot()).readiness, 'not-validated')
}))
