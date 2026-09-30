import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { readFile } from 'node:fs/promises'
import { AIProviderError, aiError, assertCapabilities, capability, completionReason, readUsage, sumUsage, validContent, validRequest } from '../shared/ai.mjs'
import { anthropicError, anthropicStopReason, anthropicUsage, claudeInfo } from '../shared/providers/anthropic.mjs'
import { createClaudeAgentAdapter } from '../bridge/providers/claude-agent.mjs'
import { bridgeProviderFactory } from '../bridge/providers/index.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
globalThis.window = globalThis
globalThis.location = { port: '5173' }
globalThis.fetch = async url => {
  assert.equal(url, '/__jarvis/session')
  return new Response(null, { status: 204 })
}
const sockets = []
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1
  constructor() {
    super(); this.readyState = 0; this.sent = []; sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1; this.onopen?.()
      this.frame({ scope: 'connection', type: 'ready', servers: [], provider: claudeInfo('claude-agent', 'test-model', 'agent'), historyMode:'session' })
    })
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
  close() { this.readyState = 3; this.onclose?.(); this.dispatchEvent(new Event('close')) }
}
const { turns, createTurnOwner } = await import('../src/lib/turn.ts')
const direct = await import('../src/lib/anthropic.ts')
const bridge = await import('../src/lib/bridge.ts')
const brain = await import('../src/lib/brain.ts')
afterEach(() => { bridge.shutdown(); turns.cancel('shutdown') })
const request = content => ({ messages: [{ role: 'user', content }] })
const config = {
  modelId: 'test-model', reasoningEffort: 'high', cwd: '.', systemPrompt: 'Test persona',
  mcpServers: { fixture: {} }, decideTool: name => name.startsWith('Read') || name.startsWith('mcp__'),
}
const textChunk = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const toolChunk = (id, name) => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } } })
const success = (extra = {}) => ({ type: 'result', subtype: 'success', result: 'Answer.', stop_reason: 'end_turn', session_id: 'fixture-session', ...extra })
function queryDouble(chunks, inspect = () => {}) {
  return args => {
    inspect(args)
    const stream = (async function* () { for await (const _message of args.prompt) for (const chunk of chunks) yield chunk })()
    stream.close = () => {}
    return stream
  }
}
function directStream(final, emit = () => {}, inspect = () => {}) {
  return (params, options) => {
    inspect(params, options)
    const callbacks = {}
    return {
      on(name, handler) { callbacks[name] = handler }, abort() {},
      async finalMessage() { emit(callbacks); return final },
    }
  }
}

test('stop reasons normalize independently of provider wire values', () => {
  for (const [wire, expected] of [['end_turn','complete'],['stop_sequence','complete'],['max_tokens','max-tokens'],
    ['model_context_window_exceeded','max-tokens'],['tool_use','tool-continuation'],['pause_turn','tool-continuation'],
    ['refusal','refused'],[null,'unknown'],['future-value','unknown']]) assert.equal(anthropicStopReason(wire), expected)
  assert.equal(completionReason('max-tokens'), 'max-tokens')
  assert.equal(completionReason('max_tokens'), 'unknown')
})

test('provider errors normalize safely without messages, headers, bodies or credentials', () => {
  for (const [wire, expected] of [[{status:401},'authentication'],[{status:429},'rate-limit'],
    [{name:'APIConnectionTimeoutError'},'timeout'],[{name:'APIUserAbortError'},'cancelled'],
    [{status:503},'unavailable'],[{name:'APIConnectionError'},'network'],[{status:400},'invalid-request'],
    ['model_not_found','model-unavailable'],['authentication_failed','authentication'],[{},'unknown']]) {
    const error = typeof wire === 'object' ? { ...wire, message:'private-fixture', headers:{authorization:'private-fixture'}, error:{secret:'private-fixture'} } : wire
    const normalized = anthropicError(error, 'claude-agent')
    assert.equal(normalized.category, expected)
    assert.ok(!JSON.stringify(normalized).includes('private-fixture'))
    assert.equal(new AIProviderError(normalized).toJSON().category, expected)
  }
  assert.deepEqual(aiError('unknown', { providerId:'claude-agent', status:900, code:'credential?private=fixture' }).diagnostics, {providerId:'claude-agent'})
})

test('usage is optional, validates numbers, preserves zero and never invents missing totals', () => {
  assert.equal(anthropicUsage(undefined), undefined)
  assert.deepEqual(anthropicUsage({input_tokens:12,output_tokens:0,cache_read_input_tokens:4}, 0), {
    inputTokens:12, outputTokens:0, cacheReadTokens:4, cost:{amount:0,currency:'USD',source:'reported'},
  })
  assert.equal(readUsage({inputTokens:-1,outputTokens:Infinity,cost:{amount:NaN,currency:'USD',source:'reported'}}), undefined)
  assert.deepEqual(sumUsage([{inputTokens:2,outputTokens:3},{outputTokens:4}]), {outputTokens:7})
  assert.equal(sumUsage([{inputTokens:2},{}]), undefined)
})

test('capabilities distinguish chat from agent and reject explicit unsupported vision', () => {
  const agent = claudeInfo('claude-agent','arbitrary-configured-model','agent')
  const chat = claudeInfo('anthropic-api','arbitrary-configured-model','chat')
  assert.equal(capability(agent,'agentRuntime'), true)
  assert.equal(capability(chat,'agentRuntime'), false)
  assert.equal(capability(chat,'vision'), 'unknown')
  assert.equal(capability(chat,'reasoningControls'), 'unknown')
  assert.equal(capability(null,'text'), 'unknown')
  const image = request([{type:'image',mimeType:'image/png',data:'eA=='}])
  const textOnly = {...chat,capabilities:{...chat.capabilities,vision:false}}
  assert.throws(() => assertCapabilities(textOnly,image), error => error.category === 'invalid-request' && error.diagnostics.code === 'unsupported_capability')
  assert.doesNotThrow(() => assertCapabilities(textOnly,request('Text')))
  assert.doesNotThrow(() => assertCapabilities(chat,image)) // Unknown is delegated, never advertised as supported.
})

test('multimodal wire validation bounds input and rejects malformed or empty messages', () => {
  assert.equal(validContent([{type:'text',text:'See'},{type:'image',mimeType:'image/png',data:'eA=='}]),true)
  for (const content of ['', 'x'.repeat(32769), [{type:'text',text:' '}], [{type:'image',mimeType:'application/zip',data:'eA=='}],
    [{type:'image',mimeType:'image/png',data:'bad?'}], Array.from({length:17},()=>({type:'text',text:'x'})), [{type:'tool_use'}]]) assert.equal(validContent(content),false)
  for(const value of [{messages:[]},{messages:Array.from({length:33},()=>({role:'user',content:'x'}))},
    {messages:[{role:'system',content:'x'}]}, {messages:[{role:'assistant',content:'x'}]},
    {messages:Array.from({length:9},()=>({role:'user',content:'x'.repeat(32768)}))}]) assert.equal(validRequest(value),false)
  assert.equal(validRequest({messages:[{role:'user',content:'One'},{role:'assistant',content:'Answer'},{role:'user',content:'Two'}]}),true)
})

test('Claude adapter streams neutral events, usage and completion and preserves permission/settings policy', async () => {
  const events = [], ready = []; let options, prompt
  const chunks = [
    {type:'system',subtype:'init',mcp_servers:[{name:'usable',status:'pending'},{name:'broken',status:'failed'}]},
    textChunk('First sentence. '), toolChunk('r','Read'), toolChunk('r','Read'),
    toolChunk('d','mcp__jarvis__display'), toolChunk('u','mcp__jarvis_ui__ui_reset'),
    toolChunk('w','Write'), {type:'user',message:{content:[{type:'tool_result',tool_use_id:'w',is_error:true}]}},
    toolChunk('ran','Write'), {type:'user',message:{content:[{type:'tool_result',tool_use_id:'ran',is_error:false}]}},
    success({usage:{input_tokens:5,output_tokens:6},total_cost_usd:0.01}),
  ]
  const adapter = createClaudeAgentAdapter({...config,onReady:servers=>ready.push(servers)}, args => {
    options=args.options
    const stream=(async function*(){ for await(const message of args.prompt) {prompt=message; for(const chunk of chunks) yield chunk} })()
    stream.close=()=>{}
    return stream
  })
  const owner=createTurnOwner(), turn=owner.begin()
  const result=await adapter.generate(request('Question'),{onEvent:event=>events.push(event)},turn)
  assert.equal(adapter.historyMode,'session'); assert.equal(adapter.describe().providerId,'claude-agent')
  assert.deepEqual(ready,[['usable']]); assert.equal(prompt.message.content,'Question')
  assert.equal(options.includePartialMessages,true); assert.deepEqual(options.settingSources,[])
  assert.equal(options.permissionMode,'default'); assert.equal(options.maxTurns,24)
  assert.equal(options.model,config.modelId); assert.equal(options.effort,config.reasoningEffort)
  assert.equal((await options.canUseTool('Write')).behavior,'deny')
  // Finalization aborts/closes this operation, so even a late permission callback is denied.
  assert.equal((await options.canUseTool('Read')).behavior,'deny')
  assert.deepEqual(events.map(event=>event.type),['text','tool','tool','usage','done'])
  assert.deepEqual(result.tools,['Read','Write']); assert.equal(result.text,'First sentence.')
  assert.equal(result.reason,'complete'); assert.equal(result.usage.cost.amount,0.01)
  assert.ok(!events.some(event=>'turnId' in event || 'stop_reason' in event || 'input_tokens' in event))
  turn.complete()
})

test('Claude session resumes only a successful original session; errors stay normalized', async () => {
  const options=[], events=[]; let calls=0
  const adapter=createClaudeAgentAdapter(config,args=>{
    options.push(args.options)
    return queryDouble([++calls===2 ? {type:'assistant',error:'rate_limit'} : textChunk('Answer.'),
      calls===2 ? {type:'result',subtype:'error_during_execution'} : success()])(args)
  })
  const owner=createTurnOwner()
  let turn=owner.begin(); await adapter.generate(request('One'),{onEvent:()=>{}},turn); turn.complete()
  turn=owner.begin(); const failed=await adapter.generate(request('Two'),{onEvent:event=>events.push(event)},turn); turn.complete()
  assert.equal(failed.reason,'error'); assert.equal(failed.error.category,'rate-limit')
  assert.deepEqual(events.map(event=>event.type),['error'])
  turn=owner.begin(); await adapter.generate(request('Three'),{onEvent:()=>{}},turn); turn.complete()
  assert.equal(options[0].resume,undefined); assert.equal(options[1].resume,'fixture-session'); assert.equal(options[2].resume,'fixture-session')
})

test('Claude cancellation requests real abort/close and quarantines late chunks and resume IDs', async () => {
  const release=deferred(), events=[], options=[]; let closes=0
  const adapter=createClaudeAgentAdapter(config,args=>{
    options.push(args.options)
    const stream=(async function*(){
      for await(const _message of args.prompt) {
        if(options.length===1) {yield textChunk('A.'); await release.promise; yield textChunk('Late A.'); yield success({session_id:'cancelled-session'})}
        else {yield textChunk('B.'); yield success()}
      }
    })()
    stream.close=()=>{closes++}
    return stream
  })
  const owner=createTurnOwner(), a=owner.begin()
  const first=adapter.start(request('A'),{onEvent:event=>events.push(event)},a)
  await flush(); a.cancel('timeout')
  assert.equal(options[0].abortController.signal.aborted,true)
  assert.equal(first.cancel(),'termination-requested'); assert.equal(closes,1)
  const b=owner.begin(), second=adapter.start(request('B'),{onEvent:event=>events.push(event)},b)
  const answer=await second.result; release.resolve(); const abandoned=await first.result
  assert.equal(abandoned.reason,'cancelled'); assert.equal(answer.text,'B.')
  assert.equal(options[1].resume,undefined)
  assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.delta),['A.','B.'])
  assert.equal(events.filter(event=>event.type==='done').length,1)
  b.complete()
})

test('Claude cancellation receipts distinguish close failure and work that never started', async () => {
  const owner=createTurnOwner(), a=owner.begin(), release=deferred()
  const adapter=createClaudeAgentAdapter(config,args=>{
    const stream=(async function*(){for await(const _message of args.prompt) {await release.promise; yield success()} })()
    stream.close=()=>{throw new Error('Fixture close failed')}
    return stream
  })
  const running=adapter.start(request('A'),{onEvent:()=>{}},a)
  a.cancel('stop'); assert.equal(running.cancel(),'termination-unconfirmed')
  release.resolve(); assert.equal((await running.result).reason,'cancelled')
  const never=adapter.start(request('Dead'),{onEvent:()=>assert.fail('Late event')},a)
  assert.equal((await never.result).reason,'cancelled'); assert.equal(never.cancel(),'not-started')
})

test('Claude accepts application images and isolates runtime tool services per operation', async () => {
  let prompt, options
  const adapter=createClaudeAgentAdapter(config,args=>{
    options=args.options
    const stream=(async function*(){for await(const message of args.prompt) {prompt=message; yield success()} })()
    stream.close=()=>{}
    return stream
  })
  const owner=createTurnOwner(), turn=owner.begin(), services={mcpServers:{perTurn:{}}}
  await adapter.start(request([{type:'text',text:'Look'},{type:'image',mimeType:'image/png',data:'eA=='}]),{onEvent:()=>{}},turn,services).result
  assert.equal(options.mcpServers,services.mcpServers)
  assert.deepEqual(prompt.message.content[1],{type:'image',source:{type:'base64',data:'eA==',media_type:'image/png'}})
  turn.complete()
})

test('Claude runtime exceptions expose safe categories and unknown stop values remain unknown', async () => {
  const owner=createTurnOwner(), events=[]
  const failing=createClaudeAgentAdapter(config,()=>{throw Object.assign(new Error('private-fixture'),{status:401})})
  let turn=owner.begin()
  await assert.rejects(failing.generate(request('Text'),{onEvent:event=>events.push(event)},turn),error=>error.category==='authentication' && !error.message.includes('private-fixture'))
  assert.equal(events[0].error.category,'authentication'); turn.complete()
  const fallback=createClaudeAgentAdapter(config,queryDouble([success({stop_reason:null,usage:undefined})]))
  turn=owner.begin(); const answer=await fallback.generate(request('Text'),{onEvent:()=>{}},turn)
  assert.equal(answer.text,'Answer.'); assert.equal(answer.reason,'unknown'); assert.equal(answer.usage,undefined); turn.complete()
  assert.throws(()=>bridgeProviderFactory({providerId:'future-provider'}),/Unsupported JARVIS AI provider/)
})

test('direct chat adapter converts generic images, streams tools and normalizes completion/usage', async () => {
  const events=[]; let params, options
  globalThis.__directStream=directStream({content:[],stop_reason:'end_turn',usage:{input_tokens:8,output_tokens:9}},callbacks=>{
    callbacks.text('Hello. ')
    callbacks.streamEvent({type:'content_block_start',content_block:{type:'server_tool_use',name:'web_search',id:'search'}})
  },(p,o)=>{params=p;options=o})
  const owner=createTurnOwner(), turn=owner.begin()
  const answer=await direct.adapter.generate(request([{type:'text',text:'See'},{type:'image',mimeType:'image/png',data:'eA=='}]),{onEvent:event=>events.push(event)},turn)
  assert.equal(direct.adapter.historyMode,'messages'); assert.equal(direct.adapter.describe().kind,'chat')
  assert.equal(options.signal,turn.signal); assert.equal(options.maxRetries,0)
  assert.equal(params.messages[0].content[1].source.media_type,'image/png')
  assert.deepEqual(events.map(event=>event.type),['text','tool','usage','done'])
  assert.equal(events[1].displayName,'web search'); assert.equal(answer.reason,'complete')
  assert.deepEqual(answer.usage,{inputTokens:8,outputTokens:9}); assert.equal(answer.usage.cost,undefined)
  turn.complete()
})

test('direct continuations preserve private tool context, remain bounded and aggregate only known usage', async () => {
  const params=[], events=[]
  globalThis.__directStream=directStream({content:[{type:'server_tool_use',name:'web_search',id:'fixture'}],stop_reason:'pause_turn',usage:{input_tokens:1,output_tokens:2}},
    callbacks=>callbacks.text('Part. '),(p)=>params.push(p))
  const owner=createTurnOwner(), turn=owner.begin()
  const answer=await direct.adapter.generate(request('Question'),{onEvent:event=>events.push(event)},turn)
  assert.equal(params.length,4); assert.equal(params[1].messages[1].content[0].type,'server_tool_use')
  assert.equal(answer.reason,'tool-continuation'); assert.deepEqual(answer.usage,{inputTokens:4,outputTokens:8})
  assert.equal(events.filter(event=>event.type==='done').length,1); turn.complete()
})

test('direct terminal limits/refusals and whole-message fallback retain audible text', async () => {
  for(const [stop,reason] of [['max_tokens','max-tokens'],['refusal','refused'],['new_stop','unknown']]) {
    const seen=[], owner=createTurnOwner(), turn=owner.begin()
    globalThis.__directStream=directStream({content:[{type:'text',text:'Whole answer.'}],stop_reason:stop})
    const answer=await direct.adapter.generate(request('Question'),{onEvent:event=>seen.push(event)},turn)
    assert.equal(answer.reason,reason); assert.equal(answer.usage,undefined)
    assert.equal(seen.at(-1).type,'done'); assert.ok(seen.some(event=>event.type==='text'))
    if(stop==='max_tokens') assert.ok(answer.text.includes('There is more'))
    if(stop==='refusal') assert.ok(answer.text.includes("can't help"))
    turn.complete()
  }
})

test('direct errors normalize without blindly retrying an uncertain request', async () => {
  let calls=0; const events=[], owner=createTurnOwner(), turn=owner.begin()
  globalThis.__directStream=()=>{calls++; throw Object.assign(new Error('private-fixture'),{status:429})}
  await assert.rejects(direct.adapter.generate(request('Question'),{onEvent:event=>events.push(event)},turn),error=>error.category==='rate-limit')
  assert.equal(calls,1); assert.equal(events[0].error.category,'rate-limit')
  assert.ok(!JSON.stringify(events).includes('private-fixture')); turn.complete()
})

test('direct abort uses the original signal and old callbacks cannot affect B', async () => {
  const final=deferred(), events=[], owner=createTurnOwner(); let callbacks, aborted=0, signal
  globalThis.__directStream=(_params,options)=>{
    signal=options.signal; callbacks={}
    return {on(name,handler){callbacks[name]=handler},abort(){aborted++},finalMessage:()=>final.promise}
  }
  const a=owner.begin(), first=direct.adapter.generate(request('A'),{onEvent:event=>events.push(event)},a)
  callbacks.text('A.'); a.cancel('stop')
  const old=callbacks; assert.equal(signal.aborted,true); assert.equal(aborted,1)
  globalThis.__directStream=directStream({content:[],stop_reason:'end_turn'},cb=>cb.text('B.'))
  const b=owner.begin(), second=await direct.adapter.generate(request('B'),{onEvent:event=>events.push(event)},b)
  old.text('Late A.'); old.streamEvent({type:'content_block_start',content_block:{type:'server_tool_use',name:'late',id:'late'}})
  final.resolve({content:[],stop_reason:'end_turn'}); assert.equal((await first).reason,'cancelled')
  assert.equal(second.text,'B.'); assert.equal(b.current(),true)
  assert.deepEqual(events.filter(event=>event.type==='text').map(event=>event.delta),['A.','B.'])
  b.complete()
})

test('brain consumes only neutral bridge events and keeps authoritative turn IDs through cancellation', async () => {
  const seen=[], a=turns.begin(), first=brain.ask('A',[],{onEvent:event=>seen.push(event)},a)
  first.catch(()=>{}); await flush()
  const ws=sockets.at(-1)
  assert.equal(brain.providerInfo().kind,'agent')
  assert.deepEqual(ws.sent[0],{type:'ask',turnId:a.turnId,text:'A'})
  ws.frame({scope:'turn',turnId:a.turnId,type:'text',delta:'A.'}); a.cancel('stop'); await assert.rejects(first)
  assert.ok(ws.sent.some(frame=>frame.type==='cancel' && frame.turnId===a.turnId))
  const b=turns.begin(), second=brain.ask('B',[],{onEvent:event=>seen.push(event)},b); await flush()
  for(const frame of [{type:'text',delta:'Late A.'},{type:'usage',usage:{inputTokens:999}},{type:'done',text:'Late A.'},{type:'error',error:aiError('authentication')}]) ws.frame({scope:'turn',turnId:a.turnId,...frame})
  ws.frame({scope:'turn',turnId:b.turnId,type:'tool',name:'Read',phase:'start'})
  ws.frame({scope:'turn',turnId:b.turnId,type:'usage',usage:{outputTokens:3}})
  ws.frame({scope:'turn',turnId:b.turnId,type:'done',text:'B.',reason:'complete',usage:{outputTokens:3}})
  const answer=await second
  assert.equal(answer.text,'B.'); assert.equal(answer.reason,'complete'); assert.deepEqual(answer.usage,{outputTokens:3})
  assert.deepEqual(seen.map(event=>event.type),['text','tool','usage','text','done'])
  assert.ok(!JSON.stringify(seen).includes('Late A.')); assert.equal(b.current(),true)
  ws.close(); assert.equal(brain.providerInfo(),null)
})

test('generic frontend message contracts have no provider SDK type imports', async () => {
  for(const path of ['../shared/ai.d.mts','../src/lib/ai.ts','../src/lib/brain.ts','../src/lib/bridge.ts','../src/App.tsx']) {
    const source=await readFile(new URL(path,import.meta.url),'utf8')
    assert.ok(!source.includes('@anthropic-ai/'),path)
    assert.ok(!/\b(?:BetaMessageParam|Msg)\b/.test(source),path)
  }
})

test('cancellation during provider handle creation still closes the returned work', async () => {
  let closes=0, aborts=0
  const owner=createTurnOwner(), a=owner.begin()
  const agent=createClaudeAgentAdapter(config,args=>{
    a.cancel('stop')
    const stream=queryDouble([success()])(args)
    stream.close=()=>{closes++}
    return stream
  })
  const operation=agent.start(request('A'),{onEvent:()=>assert.fail('Cancelled event')},a)
  assert.equal((await operation.result).reason,'cancelled')
  assert.equal(operation.cancel(),'termination-requested'); assert.equal(closes,1)
  const b=owner.begin()
  globalThis.__directStream=()=>{
    b.cancel('stop')
    return {abort(){aborts++},on(){assert.fail('Cancelled stream listener')},finalMessage(){assert.fail('Cancelled stream wait')}}
  }
  assert.equal((await direct.adapter.generate(request('B'),{onEvent:()=>assert.fail('Cancelled event')},b)).reason,'cancelled')
  assert.equal(aborts,1)
})

test('brain forwards generic image blocks with original ownership and surfaces categorized bridge errors', async () => {
  const image=[{type:'text',text:'See'},{type:'image',mimeType:'image/png',data:'eA=='}]
  const a=turns.begin(), events=[]
  const pending=brain.generate(request(image),{onEvent:event=>events.push(event)},a)
  pending.catch(()=>{}); await flush()
  const ws=sockets.at(-1)
  assert.deepEqual(ws.sent[0],{type:'ask',turnId:a.turnId,content:image})
  ws.frame({scope:'turn',turnId:a.turnId,type:'error',error:aiError('authentication',{providerId:'claude-agent',status:401})})
  await assert.rejects(pending,error=>error.reason==='error')
  assert.equal(events[0].error.category,'authentication'); assert.equal(a.signal.aborted,true)
  assert.ok(ws.sent.some(frame=>frame.type==='cancel' && frame.turnId===a.turnId))
})

test('finished direct adapter rejects late callbacks while its turn remains active for speech', async () => {
  let callbacks; const events=[], owner=createTurnOwner(), turn=owner.begin()
  globalThis.__directStream=directStream({content:[],stop_reason:'end_turn'},cb=>{callbacks=cb;cb.text('Answer.')})
  await direct.adapter.generate(request('Question'),{onEvent:event=>events.push(event)},turn)
  callbacks.text('Late text.')
  callbacks.streamEvent({type:'content_block_start',content_block:{type:'server_tool_use',id:'late',name:'late'}})
  assert.equal(turn.current(),true); assert.deepEqual(events.map(event=>event.type),['text','done'])
  turn.complete()
})

test('bridge adapter forwards bounded neutral history when a backend requests messages', async () => {
  await brain.warm()
  const ws=sockets.at(-1)
  ws.frame({scope:'connection',type:'ready',servers:[],historyMode:'messages'})
  const history=[{role:'user',content:'First question'},{role:'assistant',content:'First answer'}]
  const turn=turns.begin(), pending=brain.ask('Follow up',history,{onEvent:()=>{}},turn)
  await flush()
  assert.deepEqual(ws.sent[0],{type:'ask',turnId:turn.turnId,messages:[...history,{role:'user',content:'Follow up'}]})
  ws.frame({scope:'turn',turnId:turn.turnId,type:'done',text:'Answer.',reason:'complete'})
  assert.equal((await pending).reason,'complete'); assert.equal(bridge.adapter.historyMode,'messages')
  turn.complete()
})
