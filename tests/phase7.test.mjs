import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createClapDetector, listenForClap, diag } from '../src/lib/clap.ts'
import { beginStartup, startupSnapshot, startupStatus, aiStartupStatus, finishStartup } from '../src/lib/startup.ts'
import { filterModels, isFreeModel } from '../src/lib/modelFilter.ts'
import { createNativeClient, nativeError, nativeFrames, nativeInfo } from '../bridge/providers/native-client.mjs'
import { createNativeAdapter } from '../bridge/providers/native-chat.mjs'
import { createSecretStore, dpapi } from '../bridge/secrets.mjs'
import { createAISettings, validateSettings } from '../bridge/ai-settings.mjs'
import { createRouterClient } from '../bridge/providers/openrouter-client.mjs'
import { createTurnScope } from '../bridge/turn.mjs'

const KEY = 'phase-seven-unit-test-fixture-not-real'
const req = content => ({ messages: [{ role: 'user', content }] })
const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''))
const oaText = text => [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 4 } } }]
const gmText = text => [{ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }]
const turn = scope => ({ turnId: scope.turnId, signal: scope.signal, current: scope.live })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const quiet = (detector, start, end) => { for (let t = start; t < end; t += 10) detector.sample(.002, t) }
const clap = (detector, at) => { detector.sample(.2, at, 4); detector.sample(.002, at + 10) }

test('one clap never starts; two distinct claps within the window start once, then detector stops', () => {
  let boots = 0; const d = createClapDetector(() => boots++)
  quiet(d, 0, 100); clap(d, 100); assert.equal(boots, 0)
  quiet(d, 120, 420); clap(d, 420); assert.equal(boots, 1)
  quiet(d, 440, 800); clap(d, 800); assert.equal(boots, 1)
})
test('clap rejects sustained speech, soft background noise, too-close and expired pairs', () => {
  let boots = 0; const d = createClapDetector(() => boots++)
  quiet(d, 0, 100); for (let t = 100; t < 500; t += 10) d.sample(.2, t)
  quiet(d, 500, 700); clap(d, 700); quiet(d, 720, 1750); clap(d, 1750)
  quiet(d, 1770, 1820); clap(d, 1820); assert.equal(boots, 0)
  for (let t = 1840; t < 2500; t += 10) d.sample(.025, t)
  assert.equal(boots, 0); d.stop(); clap(d, 2600); assert.equal(boots, 0)
})
test('claps entering across overlapping analyser windows retain distinct onset ownership', () => {
  let boots = 0; const d = createClapDetector(() => boots++)
  for (const at of [100, 480]) {
    quiet(d, at - 80, at); d.sample(.04, at, 3); d.sample(.08, at + 10, 3); d.sample(.12, at + 20, 3); d.sample(.002, at + 40)
  }
  assert.equal(boots, 1)
})
test('clap analysis retires its timers/nodes before startup and leaves the shared stream/context available', async () => {
  globalThis.document = { hidden: false }; let disconnected = 0, samples = 0
  globalThis.__inputContext = { state: 'running', createMediaStreamSource: () => ({ connect() {}, disconnect() { disconnected++ } }),
    createAnalyser: () => ({ disconnect() { disconnected++ }, getFloatTimeDomainData(buffer) { buffer.fill(0); samples++ } }) }
  const controller = new AbortController(), listener = await listenForClap(() => assert.fail('quiet cannot clap'), controller.signal)
  assert.equal(diag.listening, true); controller.abort(); listener.stop(); assert.equal(disconnected, 2); assert.equal(diag.listening, false)
  const count = samples; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(samples, count)
})
test('boot is presentation-only and never invents configured/failed provider readiness', () => {
  beginStartup('clap', 100); assert.equal(startupSnapshot().systems.graphics, 'STANDBY')
  assert.equal(aiStartupStatus(null), 'UNAVAILABLE')
  assert.equal(aiStartupStatus({ providerId: 'openai', keyConfigured: false, modelId: '', error: null, readiness: 'not-validated' }), 'NOT CONFIGURED')
  assert.equal(aiStartupStatus({ providerId: 'gemini', keyConfigured: true, modelId: 'model', error: null, readiness: 'not-validated' }), 'CONFIGURED')
  assert.equal(aiStartupStatus({ providerId: 'openai', keyConfigured: true, modelId: 'model', error: {}, readiness: 'ready' }), 'UNAVAILABLE')
  startupStatus('bridge', 'UNAVAILABLE'); assert.equal(startupSnapshot().systems.bridge, 'UNAVAILABLE')
  finishStartup(); assert.equal(startupSnapshot().active, false)
})

for (const provider of ['openai', 'gemini']) {
  const modelId = provider === 'openai' ? 'gpt-5-mini' : 'gemini-3-flash-preview'
  const chunks = provider === 'openai' ? oaText : gmText
  function fixture(responses, extra = {}) {
    const calls = [], events = [], scope = createTurnScope('A', event => events.push(event))
    const client = createNativeClient(provider, async (url, init) => { calls.push({ url, init }); return responses.shift() })
    const adapter = createNativeAdapter({ providerId: provider, client, modelId, mode: 'balanced', getKey: async () => KEY, decideTool: () => true, ...extra })
    const run = (content = 'Question', runtime) => adapter.start(req(content), { onEvent: event => scope.send(event) }, turn(scope), runtime)
    return { calls, events, scope, client, run }
  }
  test(`${provider}: text, usage, vision and streaming normalize; key stays in headers on the Node request`, async () => {
    const f = fixture([sse(chunks('Hello 🌍.'))])
    const result = await f.run([{ type: 'text', text: 'See this' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]).result
    assert.equal(result.text, 'Hello 🌍.'); assert.equal(result.reason, 'complete'); assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 })
    assert.deepEqual(f.events.map(e => e.type), ['text', 'usage', 'done']); assert.ok(f.events.every(e => e.turnId === 'A'))
    assert.equal(f.calls.length, 1); assert.ok(!f.calls[0].url.includes(KEY)); assert.ok(!JSON.stringify(f.events).includes(KEY))
    const body = JSON.parse(f.calls[0].init.body)
    if (provider === 'openai') { assert.ok(f.calls[0].url.endsWith('/responses')); assert.equal(body.store, false); assert.equal(body.input[0].content[1].type, 'input_image') }
    else { assert.ok(f.calls[0].url.endsWith(':streamGenerateContent?alt=sse')); assert.equal(f.calls[0].init.headers['x-goog-api-key'], KEY); assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png') }
  })
  test(`${provider}: fragmented UTF8/CRLF SSE parses; unexpected EOF does not pretend success`, async () => {
    const bytes = new TextEncoder().encode(chunks('café').map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(''))
    const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() } })
    let count = 0; for await (const _ of nativeFrames(provider, new Response(stream), new AbortController().signal)) count++
    assert.equal(count, chunks('café').length)
    const f = fixture([sse([])]); assert.equal((await f.run().result).error.category, 'network')
  })
  test(`${provider}: stream errors distinguish rate limits/busy without replay or private message leakage`, async () => {
    for (const [code, category] of [['rate_limit_exceeded', 'rate-limit'], ['server_error', 'unavailable']]) {
      const f = fixture([sse([{ error: { code, message: KEY } }])]); const result = await f.run().result
      assert.equal(result.error.category, category); assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(f.events).includes(KEY))
    }
  })
  test(`${provider}: AbortSignal cancels the actual request and quarantines late text/completion`, async () => {
    let finish; const f = fixture([])
    f.client.stream = (_key, _body, signal) => { finish = () => sse(chunks('Late A')); f.signal = signal; return new Promise(resolve => { f.release = () => resolve(finish()) }) }
    const operation = f.run(); await flush(); f.scope.stop(); operation.cancel(); assert.equal(f.signal.aborted, true)
    f.release(); assert.equal((await operation.result).reason, 'cancelled'); assert.deepEqual(f.events, [])
  })
  test(`${provider}: auth, rate limits, quota, model, server failures are normalized without retry or raw data`, async () => {
    for (const [status, category] of [[401, 'authentication'], [429, 'rate-limit'], [404, 'model-unavailable'], [503, 'unavailable']]) {
      const f = fixture([Response.json({ error: { message: KEY, code: status } }, { status, headers: { 'retry-after': '20' } })])
      const result = await f.run().result; assert.equal(result.error.category, category); assert.equal(result.error.diagnostics.retryAfterSeconds, 20)
      assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(f.events).includes(KEY))
    }
    assert.match(nativeError(provider, { status: 429, code: 'QUOTA_EXCEEDED' }).message, /quota.*exhausted/)
    assert.equal(nativeError(provider, { status: 429, code: 'QUOTA_EXCEEDED' }).diagnostics.code, 'quota_exhausted')
    assert.equal(nativeError(provider, { status: 503 }).diagnostics.code, 'provider_busy')
    const quotaBody = provider === 'openai' ? { error: { code: 'insufficient_quota' } } : { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }] } }
    assert.equal((await fixture([Response.json(quotaBody, { status: 429 })]).run().result).error.diagnostics.code, 'quota_exhausted')
    assert.equal(nativeError(provider, new TypeError()).category, 'network'); assert.equal(nativeError(provider, { name: 'TimeoutError' }).category, 'timeout')
  })
  test(`${provider}: tool dispatch is once, with private continuation context and original ownership`, async () => {
    const call = provider === 'openai' ? { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call-1', name: 'display', arguments: '{}' }, { type: 'reasoning', encrypted_content: 'private-thinking' }] } }
      : { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'display', args: {} }, thoughtSignature: 'private-thinking' }] }, finishReason: 'STOP' }] }
    const f = fixture([sse([call]), sse(chunks('Done.'))]); let executions = 0
    const result = await f.run('Show', { functionTools: [{ name: 'display', parameters: { type: 'object' }, execute: async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] } } }] }).result
    assert.equal(result.text, 'Done.'); assert.equal(executions, 1); assert.ok(f.calls[1].init.body.includes('private-thinking')); assert.ok(!JSON.stringify(f.events).includes('private-thinking'))
    assert.ok(f.events.every(e => e.turnId === 'A'))
  })
  const toolCall = callId => provider === 'openai'
    ? { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: callId, name: 'display', arguments: '{"x":1}' }] } }
    : { candidates: [{ content: { parts: [{ functionCall: { id: callId, name: 'display', args: { x: 1 } } }] }, finishReason: 'STOP' }] }
  test(`${provider}: uncertain effects are never replayed with another call ID`, async () => {
    const f = fixture([sse([toolCall('first')]), sse([toolCall('second')])]); let effects = 0
    const result = await f.run('Write', { functionTools: [{ name: 'display', parameters: { type: 'object' }, execute: async () => { effects++; throw new Error('uncertain') } }] }).result
    assert.equal(effects, 1); assert.equal(f.calls.length, 2); assert.equal(result.reason, 'error'); assert.match(result.error.message, /uncertain/)
  })
  test(`${provider}: uncancellable tool completion cannot affect a replacement turn`, async () => {
    const f = fixture([sse([toolCall('first')])]); let release
    const operation = f.run('Write', { functionTools: [{ name: 'display', parameters: { type: 'object' }, execute: () => new Promise(resolve => { release = resolve }) }] })
    while (!release) await flush()
    f.scope.stop(); operation.cancel(); const length = f.events.length
    release({ content: [{ type: 'text', text: 'Late result' }] }); assert.equal((await operation.result).reason, 'cancelled')
    assert.equal(f.events.length, length); assert.equal(f.calls.length, 1)
  })
  test(`${provider}: backend timeout aborts work and quarantines ignored-abort results`, async () => {
    const f = fixture([], { timeoutMs: 20 }); let release, signal
    f.client.stream = (_key, _body, inputSignal) => { signal = inputSignal; return new Promise(resolve => { release = resolve }) }
    const operation = f.run(); const result = await operation.result
    assert.equal(result.error.category, 'timeout'); assert.equal(signal.aborted, true)
    release(sse(chunks('Late'))); await flush(); assert.deepEqual(f.events.map(e => e.type), ['error'])
  })
  test(`${provider}: unknown model capabilities remain unknown and block unverified vision/tools`, async () => {
    const f = fixture([], { modelId: 'future-special-model' }); const result = await f.run([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]).result
    assert.equal(result.error.category, 'invalid-request'); assert.equal(f.calls.length, 0); assert.equal(nativeInfo(provider, 'future-model').capabilities.toolCalling, 'unknown')
  })
  test(`${provider}: catalog is on-demand, bounded and cached; key tests use metadata, never inference`, async () => {
    const calls = [], response = provider === 'openai' ? { data: [{ id: modelId }] } : { models: [{ name: `models/${modelId}`, supportedGenerationMethods: ['generateContent'] }] }
    const client = createNativeClient(provider, async (url, init) => { calls.push({ url, init }); return Response.json(response) })
    await client.model(modelId); assert.equal(calls.length, 0)
    await client.catalog(undefined, false, KEY); await client.catalog(undefined, false, KEY); assert.equal(calls.length, 1)
    await client.testKey(KEY, undefined, modelId); assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url.includes('/models') && !call.url.includes(KEY)))
    client.clear(); assert.equal(client.cached(modelId), null)
  })
}
async function temp(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-phase7-'))
  try { await run(directory) } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }) }
}
test('separate provider slots, safe snapshots and model profiles survive switching/restart; legacy settings migrate', async () => temp(async directory => {
  const providers = Object.fromEntries(['openrouter', 'openai', 'gemini'].map(id => [id, { secrets: createSecretStore({ directory: join(directory, 'keys'), purpose: id, supported: true, crypt: async (_action, bytes) => Buffer.from(bytes) }), client: { cached: () => null, model: async () => ({}), testKey: async () => {}, clear() {} } }]))
  const create = () => createAISettings({ providers, ...providers.openrouter, directory: join(directory, 'settings') })
  let settings = await create()
  for (const id of Object.keys(providers)) await settings.saveKey(KEY + '-' + id, undefined, id)
  await settings.save({ providerId: 'openrouter', mode: 'balanced', models: { fast: '', balanced: 'fixture/free', deep: '' } })
  await settings.save({ providerId: 'openai', mode: 'deep', models: { fast: 'gpt-5-mini', balanced: 'gpt-5', deep: 'gpt-5-pro' } })
  await settings.save({ providerId: 'gemini', mode: 'fast', models: { fast: 'gemini-3-flash', balanced: 'gemini-3-pro', deep: '' } })
  const publicValue = await settings.snapshot(); assert.ok(!JSON.stringify(publicValue).includes(KEY)); assert.equal(publicValue.profiles.openai.models.deep, 'gpt-5-pro')
  settings = await create(); assert.equal(settings.selection().providerId, 'gemini'); assert.equal((await settings.snapshot()).profiles.openrouter.models.balanced, 'fixture/free')
  await settings.deleteKey('openai'); assert.equal(await providers.openai.secrets.configured(), false)
  assert.equal(await providers.openrouter.secrets.read(), KEY + '-openrouter'); assert.equal(await providers.gemini.secrets.read(), KEY + '-gemini')
  await writeFile(join(directory, 'settings/ai.json'), JSON.stringify({ providerId: 'openrouter', mode: 'balanced', models: { fast: '', balanced: 'fixture/legacy', deep: '' } }))
  settings = await create(); assert.equal(settings.selection().modelId, 'fixture/legacy'); assert.equal((await settings.snapshot()).profiles.openrouter.models.balanced, 'fixture/legacy')
}))
test('real Windows provider ciphertexts use isolated DPAPI purposes', { skip: process.platform !== 'win32' }, async () => temp(async directory => {
  for (const purpose of ['openai', 'gemini']) {
    const store = createSecretStore({ directory, purpose }); await store.save(KEY)
    const bytes = await readFile(join(directory, `${purpose}.dpapi`)); assert.ok(!bytes.includes(Buffer.from(KEY))); assert.equal(await store.read(), KEY)
    await assert.rejects(dpapi('Unprotect', bytes, undefined, purpose === 'openai' ? 'gemini' : 'openai')); await store.delete()
  }
}))
test('OpenRouter free filters require known zero prices; free router supports manual selection without paid substitution', async () => {
  const info = nativeInfo('openai', 'gpt-5'), base = { ...info, providerId: 'openrouter' }
  const models = [{ ...base, modelId: 'a/free', name: 'Free', inputPrice: 0, outputPrice: 0 }, { ...base, modelId: 'b/unknown:free', name: 'Unknown' }, { ...base, modelId: 'c/paid', name: 'Paid', inputPrice: 1, outputPrice: 2 }]
  assert.equal(isFreeModel(models[1]), false); assert.deepEqual(filterModels(models, '', true).map(model => model.modelId), ['a/free'])
  assert.equal(filterModels(models, '', false, true, true).length, 3)
  const client = createRouterClient(async () => Response.json({ data: [] })); assert.equal((await client.model('openrouter/free')).modelId, 'openrouter/free')
})
test('malformed OpenRouter pricing cannot invent free status; model lookups never download a catalog', async () => {
  let requests = 0
  const client = createRouterClient(async () => { requests++; return Response.json({ data: [
    { id: 'fixture/empty', pricing: { prompt: '', completion: '0' } }, { id: 'fixture/boolean', pricing: { prompt: false, completion: '0' } },
    { id: 'fixture/request-fee', pricing: { prompt: '0', completion: '0', request: '0.01' } },
  ] }) })
  await client.model('fixture/manual'); assert.equal(requests, 0)
  const models = await client.catalog(); assert.equal(requests, 1); assert.ok(models.every(model => !isFreeModel(model)))
})
test('Gemini reports charged thought tokens in normalized output usage without exposing thought text', async () => {
  const client = createNativeClient('gemini', async () => sse([{ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: 'Answer.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 5 } }]))
  const scope = createTurnScope('usage', () => {}), events = []
  const adapter = createNativeAdapter({ providerId: 'gemini', modelId: 'gemini-3-flash-preview', client, getKey: async () => KEY })
  const result = await adapter.start(req('Hello'), { onEvent: e => events.push(e) }, turn(scope)).result
  assert.equal(result.text, 'Answer.'); assert.equal(result.usage.outputTokens, 8); assert.ok(!JSON.stringify(events).includes('private'))
})
test('provider preferences reject credential-looking text accidentally pasted into model fields', () => {
  for (const providerId of ['openai', 'gemini']) for (const id of ['sk-fixture', 'AIza-fixture-not-a-real-key']) {
    assert.throws(() => validateSettings({ providerId, mode: 'balanced', models: { fast: '', balanced: id, deep: '' } }), error => error.category === 'invalid-request')
  }
})
test('capability rules accept documented current chat models and quarantine unknown/specialized IDs', () => {
  assert.equal(nativeInfo('openai', 'gpt-6.1-sol').capabilities.vision, true)
  assert.equal(nativeInfo('gemini', 'gemini-3.8-flash').capabilities.toolCalling, true)
  assert.equal(nativeInfo('openai', 'gpt-5-future-special-model').capabilities.vision, 'unknown')
  assert.equal(nativeInfo('openai', 'o3-mini').capabilities.vision, false)
  assert.equal(nativeInfo('gemini', 'gemini-3.1-flash-live-preview').capabilities.text, false)
  assert.equal(nativeInfo('openai', 'text-embedding-3-large').capabilities.streaming, false)
})
