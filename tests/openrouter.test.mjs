import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenRouterAdapter } from '../bridge/providers/openrouter.mjs'
import { createRouterClient, routerFrames, routerInfo, routerReason } from '../bridge/providers/openrouter-client.mjs'
import { createTurnScope } from '../bridge/turn.mjs'
import { functionTools } from '../bridge/functions.mjs'
import { uiTools } from '../bridge/ui.mjs'

const request = content => ({ messages: [{ role: 'user', content }] })
const model = (extra = {}) => ({ id: 'fixture/model', name: 'Fixture', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], ...extra })
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`
const text = (value, reason = 'stop') => ({ choices: [{ delta: { content: value }, finish_reason: reason }] })
const toolCall = (name = 'mcp__jarvis_ui__ui_reset', id = 'call-1') => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
const response = chunks => new Response(': keepalive\r\n\r\n' + chunks.map(frame).join('') + 'data: [DONE]\r\n\r\n')
const interaction = scope => ({ turnId: scope.turnId, signal: scope.signal, current: scope.live })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture(responses = [response([text('Hello.')])], metadata = model()) {
  const calls = [], infos = [], events = [], scope = createTurnScope('A', event => events.push(event))
  const client = createRouterClient(async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/models')) return Response.json({ data: [metadata] })
    if (url.endsWith('/key')) return Response.json({ data: { label: 'private-account-fixture' } })
    return responses.shift()
  })
  const loaded = client.catalog() // Model capabilities are loaded by Settings, not generation.
  const modelLookup = client.model.bind(client)
  client.model = async (...args) => { await loaded; return modelLookup(...args) }
  const adapter = createOpenRouterAdapter({ client, modelId: metadata.id, mode: 'balanced', getKey: async () => 'mock-provider-key-not-real', decideTool: () => true, onInfo: value => infos.push(value) })
  return { adapter, scope, calls, infos, events, client, run: (value = 'Question', runtime) => adapter.start(request(value), { onEvent: event => scope.send(event) }, interaction(scope), runtime) }
}

test('OpenRouter streaming normalizes text, usage, repeated finishes and optional fields', async () => {
  const f = fixture([response([text('Hello ', null), text('world.'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0 } }])])
  const result = await f.run().result
  assert.equal(result.text, 'Hello world.'); assert.equal(result.reason, 'complete')
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, cost: { amount: 0, currency: 'USD', source: 'reported' } })
  assert.deepEqual(f.events.map(event => event.type), ['text', 'text', 'usage', 'done'])
  assert.ok(f.events.every(event => event.turnId === 'A'))
  const wire = JSON.parse(f.calls.at(-1).init.body)
  assert.equal(wire.stream, true); assert.equal(wire.reasoning.effort, 'medium'); assert.equal(wire.provider.allow_fallbacks, false)
  assert.equal(f.calls.at(-1).init.redirect, 'error')
  assert.ok(!JSON.stringify(f.events).includes('mock-provider-key-not-real'))
})

test('SSE parser handles fragmented UTF-8, CRLF and multiline data', async () => {
  const bytes = new TextEncoder().encode(': comment\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"café 🌍"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  const chunks = []; for await (const chunk of routerFrames(new Response(stream), new AbortController().signal)) chunks.push(chunk)
  assert.equal(chunks[0].choices[0].delta.content, 'café 🌍')
})

test('terminal limits/refusals remain explicit and missing usage stays absent', async () => {
  for(const [wire,reason] of [['length','max-tokens'],['content_filter','refused'],['future-value','unknown']]) {
    const f=fixture([response([text(wire==='future-value' ? 'Answer.' : '',wire)])])
    const answer=await f.run().result
    assert.equal(answer.reason,reason);assert.equal(answer.usage,undefined);assert.ok(answer.text)
    assert.equal(f.events.at(-1).type,'done')
  }
  const empty=fixture([response([text('')])])
  assert.equal((await empty.run().result).error.category,'unavailable')
})

for (const [status, category] of [[401, 'authentication'], [429, 'rate-limit'], [404, 'model-unavailable'], [402, 'unavailable'], [503, 'unavailable']]) {
  test(`OpenRouter HTTP ${status} is safe and never replays an uncertain request`, async () => {
    const f = fixture([new Response('private-provider-error-key-fixture', { status })])
    const answer = await f.run().result
    assert.equal(answer.error.category, category)
    assert.equal(f.calls.filter(call => call.url.endsWith('/chat/completions')).length, 1)
    assert.ok(!JSON.stringify(f.events).includes('private-provider-error'))
  })
}

test('midstream error and unexpected EOF are normalized without replay', async () => {
  for (const [stream, category] of [[new Response(frame(text('Partial', null)) + frame({ error: { code: 429, message: 'private-fixture' } })), 'rate-limit'], [new Response(frame(text('Partial', null))), 'network']]) {
    const f = fixture([stream]); const result = await f.run().result
    assert.equal(result.error.category, category); assert.equal(result.text, 'Partial')
    assert.equal(f.events.at(-1).type, 'error'); assert.ok(!JSON.stringify(f.events).includes('private-fixture'))
  }
})

test('vision rejects unsupported/unknown models before sending inference or reading a key', async () => {
  for (const architecture of [{ input_modalities: ['text'], output_modalities: ['text'] }, undefined]) {
    const f = fixture([], model({ architecture }))
    const result = await f.run([{ type: 'text', text: 'See' }, { type: 'image', mimeType: 'image/png', data: 'eA==' }]).result
    assert.equal(result.error.category, 'invalid-request'); assert.equal(f.calls.length, 1)
  }
})

test('generic image content reaches only the Node provider request', async () => {
  const f = fixture()
  await f.run([{ type: 'text', text: 'See' }, { type: 'image', mimeType: 'image/png', data: 'eA==' }]).result
  const wire = JSON.parse(f.calls.at(-1).init.body)
  assert.equal(wire.messages.at(-1).content[1].image_url.url, 'data:image/png;base64,eA==')
  assert.ok(!JSON.stringify(f.events).includes('data:image'))
})

test('unknown or unsupported tool/reasoning capabilities are not assumed', async () => {
  for (const supported_parameters of [[], undefined]) {
    const f = fixture(undefined, model({ supported_parameters }))
    await f.run('Question', { functionTools: [{ name: 'fixture', execute: () => assert.fail('Unsupported tool') }] }).result
    const wire = JSON.parse(f.calls.at(-1).init.body)
    assert.equal(wire.tools, undefined); assert.equal(wire.reasoning, undefined)
  }
  assert.equal(routerInfo(model({ supported_parameters: undefined })).capabilities.toolCalling, 'unknown')
  assert.equal(routerReason('future-reason'), 'unknown')
})

test('fragmented tool calls reuse validated UI handlers and continue in private provider context', async () => {
  const f = fixture([response([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-', function: { name: 'mcp__jarvis_ui__', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'ui_reset', arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
  ]), response([text('Restored.')])])
  const tools = functionTools('jarvis_ui', uiTools((op, args) => f.scope.send({ type: 'ui', op, args })))
  const result = await f.run('Restore the interface', { functionTools: tools }).result
  assert.equal(result.text, 'Restored.'); assert.equal(f.events.filter(event => event.type === 'ui').length, 1)
  assert.ok(f.events.every(event => event.turnId === 'A'))
  const wire = JSON.parse(f.calls.at(-1).init.body)
  assert.equal(wire.messages.at(-1).role, 'tool'); assert.equal(wire.messages.at(-1).tool_call_id, 'call-1')
})

test('unknown and repeated tool IDs cannot execute effects', async () => {
  let executed = 0
  const tool = { name: 'known', description: 'Fixture', parameters: {}, execute: async () => { executed++; return { content: [] } } }
  const unknown = fixture([response([toolCall('unknown')])])
  assert.equal((await unknown.run('Question', { functionTools: [tool] }).result).reason, 'error')
  const repeated = fixture([response([toolCall('known')]), response([toolCall('known')])])
  assert.equal((await repeated.run('Question', { functionTools: [tool] }).result).reason, 'error')
  assert.equal(executed, 1)
})

test('failed tool dispatch is performed once and reports uncertainty', async () => {
  let executed = 0
  const f = fixture([response([toolCall('known')]), response([text('The action failed.')])])
  await f.run('Question', { functionTools: [{ name: 'known', description: 'Fixture', parameters: {}, execute: async () => { executed++; throw new Error('private-fixture') } }] }).result
  assert.equal(executed, 1)
  assert.match(JSON.parse(f.calls.at(-1).init.body).messages.at(-1).content, /uncertain.*Do not repeat/)
})

test('cancellation aborts the real request signal and quarantines late A output from B', async () => {
  let controller, cancelled = 0
  const stream = new ReadableStream({ start(value) { controller = value }, cancel() { cancelled++ } })
  const f = fixture([new Response(stream), response([text('B.')])])
  const a = f.run(); await flush(); await flush()
  controller.enqueue(new TextEncoder().encode(frame(text('A.', null))))
  await flush(); const oldSignal = f.calls.at(-1).init.signal
  f.scope.stop(); assert.equal(a.cancel(), 'request-abort-requested')
  const bEvents = [], b = createTurnScope('B', event => bEvents.push(event))
  const next = f.adapter.start(request('B'), { onEvent: event => b.send(event) }, interaction(b))
  const answer = await next.result
  assert.equal((await a.result).reason, 'cancelled'); assert.equal(oldSignal.aborted, true); assert.equal(cancelled, 1)
  assert.equal(answer.text, 'B.'); assert.equal(b.live(), true)
  assert.ok(bEvents.every(event => event.turnId === 'B')); assert.deepEqual(bEvents.filter(event => event.type === 'text').map(event => event.delta), ['B.'])
})

test('uncancellable tool work is quarantined, including late UI effects', async () => {
  let finish, invoked = false
  const f = fixture([response([toolCall('slow')])])
  const work = f.run('Question', { functionTools: [{ name: 'slow', description: 'Fixture', parameters: {}, execute: () => {
    invoked = true; return new Promise(resolve => { finish = () => { f.scope.send({ type: 'ui', op: 'reset' }); resolve({ content: [] }) } })
  } }] })
  while (!invoked) await flush()
  f.scope.stop(); work.cancel(); assert.equal((await work.result).reason, 'cancelled')
  const before = f.events.length; finish(); await flush()
  assert.equal(f.events.length, before)
})

test('catalog requests are on demand, cached and key test account data is discarded', async () => {
  const f = fixture()
  await f.client.catalog(); await f.client.model('fixture/model'); await f.client.catalog()
  assert.equal(f.calls.length, 1)
  assert.equal(await f.client.testKey('mock-provider-key-not-real', new AbortController().signal), undefined)
  assert.ok(!JSON.stringify(await f.client.catalog()).includes('private-account-fixture'))
})

test('backend deadline aborts the request and emits one safe timeout, with later output quarantined', async () => {
  let cancelled = 0, signal
  const client = createRouterClient(async (url, init) => {
    if (url.endsWith('/models')) return Response.json({ data: [model()] })
    signal = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled++ } }))
  })
  const scope = createTurnScope('timeout', () => {}), events = []
  const adapter = createOpenRouterAdapter({ client, modelId: 'fixture/model', getKey: async () => 'mock-provider-key-not-real', timeoutMs: 30 })
  const result = await adapter.generate(request('Question'), { onEvent: event => events.push(event) }, interaction(scope))
  assert.equal(result.error.category, 'timeout'); assert.equal(signal.aborted, true); assert.equal(cancelled, 1)
  assert.deepEqual(events.map(event => event.type), ['error'])
})

test('uncertain effects are not repeated even with a new tool call ID', async () => {
  let executed = 0
  const f = fixture([response([toolCall('effect', 'one')]), response([toolCall('effect', 'two')])])
  const result = await f.run('Question', { functionTools: [{ name: 'effect', parameters: {}, description: 'Fixture', execute: () => { executed++; throw new Error('Uncertain') } }] }).result
  assert.equal(executed, 1); assert.match(result.error.message, /outcome is uncertain/)
})

test('operation cancellation alone quarantines output even before its owner is closed', async () => {
  let keyStarted = false, release
  const client = createRouterClient(async () => Response.json({ data: [model()] }))
  const adapter = createOpenRouterAdapter({ client, modelId: 'fixture/model', getKey: () => {
    keyStarted = true; return new Promise(resolve => { release = resolve })
  } })
  const scope = createTurnScope('manual', () => {}), events = []
  const operation = adapter.start(request('Question'), { onEvent: event => events.push(event) }, interaction(scope))
  while (!keyStarted) await flush()
  assert.equal(operation.cancel(), 'not-started')
  assert.equal((await operation.result).reason, 'cancelled')
  release('mock-provider-key-not-real'); await flush()
  assert.deepEqual(events, []); assert.equal(scope.live(), true)
})
