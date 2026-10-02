// Test-only agent double: no login, model request, MCP process, or private
// transcript is used by the bridge security integration tests.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ROOT } from '../scripts/runtime.mjs'

const source = `
export const tool = (name, description, schema, handler) => ({ name, description, inputSchema: schema, handler });
export const createSdkMcpServer = (options) => options;
export function query({ prompt }) {
  const stream = (async function* () {
    for await (const message of prompt) {
      if (message.message.content === 'security-log-test') throw new Error('sensitive transcript and ?token=do-not-log');
      yield { type: 'result', subtype: 'success', result: 'Security test reply.' };
    }
  })();
  stream.close = () => {};
  stream.interrupt = async () => {};
  return stream;
}
`
const lifecycle = `
export const tool = (name, description, schema, handler) => ({ name, description, inputSchema: schema, handler });
export const createSdkMcpServer = (options) => options;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export function query({ prompt, options }) {
  let closed = false;
  options.abortController.signal.addEventListener('abort', () => console.log('[test] SDK abort invoked'), {once:true});
  if (options.resume) console.log('[test] SDK resume supplied');
  const effects = async () => {
    await options.mcpServers.jarvis.tools.find(t => t.name === 'display').handler({title:'Fixture',html:'<p>Fixture</p>'});
    await options.mcpServers.jarvis.tools.find(t => t.name === 'blade').handler({kind:'image',title:'Fixture',url:'data:image/png;base64,eA=='});
    await options.mcpServers.jarvis_ui.tools.find(t => t.name === 'ui_reset').handler({});
  };
  const stream = (async function* () {
    for await (const message of prompt) {
      const text = message.message.content;
      yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}};
      if (text === 'late-A' || text === 'hold-camera') {
        const capture = options.mcpServers.jarvis_eyes.tools.find(t=>t.name==='look').handler({reason:'Fixture'});
        if (text === 'hold-camera') { await capture; console.log('[test] camera wait cleared'); }
        else {
          capture.then(() => console.log('[test] camera wait cleared'));
          await effects();
          // Deliberately ignore abort/close so late callbacks exercise quarantine.
          await wait(180); await effects();
          options.mcpServers.jarvis_eyes.tools.find(t=>t.name==='look').handler({reason:'Late fixture'}).then(()=>{});
          yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'late-output'}}};
          yield {type:'result',subtype:'error_during_execution'};
        }
      }
      if (text === 'B') await wait(300);
      yield {type:'result',subtype:'success',result:text,session_id:'11111111-1111-4111-8111-111111111111'};
    }
  })();
  stream.close = () => { if (!closed) { closed = true; console.log('[test] SDK close invoked'); } };
  return stream;
}
`
const network = `
import { Readable } from 'node:stream';
import * as real from ${JSON.stringify(pathToFileURL(join(ROOT, 'bridge/net.mjs')).href)};
export const { vetTarget, proxyError, PROXY_UA, peek } = real;
export async function fetchText(url, options) {
  if (String(url) !== 'https://security-fixture.example/article') return real.fetchText(url, options);
  return { type: 'text/html', url, text: '<html><head><meta property="og:image" content="https://security-fixture.example/image.png"></head><body><article><h1>Security fixture</h1><p>This is a sufficiently long paragraph for the existing reader to include as article content.</p><img src="https://security-fixture.example/image.png"></article></body></html>' };
}
export async function openRemote(url, headers, timeout) {
  if (url.hostname !== 'security-fixture.example') return real.openRemote(url, headers, timeout);
  const media = url.pathname === '/video';
  const ranged = media && headers.range === 'bytes=0-3';
  const res = Readable.from([Buffer.from('test')]);
  res.statusCode = ranged ? 206 : 200;
  res.headers = { 'content-type': media ? 'video/mp4' : 'image/png', 'content-length': url.pathname === '/oversized.png' ? String(16 * 1024 * 1024) : '4' };
  if (ranged) res.headers['content-range'] = 'bytes 0-3/8';
  return { res, url };
}
`
export async function resolve(specifier, context, next) {
  if (process.env.JARVIS_TEST_NATIVE === '1' && specifier === './providers/native-client.mjs' && context.parentURL?.endsWith('/bridge/server.mjs')) {
    const fixture = `
      import { createNativeClient as realClient } from ${JSON.stringify(pathToFileURL(join(ROOT, 'bridge/providers/native-client.mjs')).href)};
      const frame = value => 'data: ' + JSON.stringify(value) + '\\n\\n';
      export const createNativeClient = provider => realClient(provider, async (url, init) => {
        const openai = provider === 'openai', model = openai ? 'gpt-5-mini' : 'gemini-3-flash-preview';
        if (!init.body) return Response.json(openai ? {data:[{id:model}]} : {models:[{name:'models/'+model,supportedGenerationMethods:['generateContent']}]});
        const body=JSON.parse(init.body), last=(openai ? body.input : body.contents).at(-1);
        const prompt=openai ? last.content?.find?.(part=>part.type==='input_text')?.text : last.parts?.find(part=>part.text)?.text;
        const tool = prompt === 'look' ? 'mcp__jarvis_eyes__look' : 'mcp__jarvis_ui__ui_reset';
        const chunks=['look','reset'].includes(prompt) ? [openai
          ? {type:'response.completed',response:{output:[{type:'function_call',call_id:'native-call',name:tool,arguments:'{}'}]}}
          : {candidates:[{content:{parts:[{functionCall:{id:'native-call',name:tool,args:{}}}]},finishReason:'STOP'}]}]
          : openai ? [{type:'response.output_text.delta',delta:'Native mock answer.'},{type:'response.completed',response:{output:[],usage:{input_tokens:4,output_tokens:3}}}]
          : [{candidates:[{content:{parts:[{text:'Native mock answer.'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:3}}];
        const data=chunks.map(frame).join('');
        if (prompt==='hold') return new Response(new ReadableStream({start(controller){
          controller.enqueue(new TextEncoder().encode(frame(openai ? {type:'response.output_text.delta',delta:'Started.'} : {candidates:[{content:{parts:[{text:'Started.'}]}}]})));
          setTimeout(()=>{try{controller.enqueue(new TextEncoder().encode(data));controller.close()}catch{}},250);
        }}));
        return new Response(data);
      });
    `
    return { url: `data:text/javascript,${encodeURIComponent(fixture)}`, shortCircuit: true }
  }
  if (process.env.JARVIS_TEST_OPENROUTER === '1' && specifier === './providers/openrouter-client.mjs' && context.parentURL?.endsWith('/bridge/server.mjs')) {
    const fixture = `
      import { createRouterClient as realClient } from ${JSON.stringify(pathToFileURL(join(ROOT, 'bridge/providers/openrouter-client.mjs')).href)};
      const frame = value => 'data: ' + JSON.stringify(value) + '\\n\\n';
      export const createRouterClient = () => realClient(async (url, init) => {
        if(url.endsWith('/models')) return Response.json({data:[{id:'fixture/model',name:'Fixture',architecture:{input_modalities:['text','image'],output_modalities:['text']},supported_parameters:['tools'],pricing:{prompt:'0',completion:'0'}},{id:'fixture/paid',name:'Paid fixture',pricing:{prompt:'0.000001',completion:'0.000002'}}]});
        if(url.endsWith('/key')) return Response.json({data:{label:'private-key-account-fixture'}});
        const body=JSON.parse(init.body), last=body.messages.at(-1);
        let chunks;
        if(last.role==='user' && ['reset','look'].includes(last.content)) {
          chunks=[{choices:[{delta:{tool_calls:[{index:0,id:'fixture-call',function:{name:last.content==='look' ? 'mcp__jarvis_eyes__look' : 'mcp__jarvis_ui__ui_reset',arguments:'{}'}}]},finish_reason:'tool_calls'}]}];
        } else chunks=[{choices:[{delta:{content:'Mock streaming answer.'},finish_reason:'stop'}]}, {choices:[],usage:{prompt_tokens:4,completion_tokens:3}}];
        const data=chunks.map(frame).join('')+'data: [DONE]\\n\\n';
        if(last.content==='hold') return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'Started.'}}]})));setTimeout(()=>{try{controller.enqueue(new TextEncoder().encode(data));controller.close()}catch{}},250)}}));
        return new Response(data);
      });
    `
    return { url: `data:text/javascript,${encodeURIComponent(fixture)}`, shortCircuit: true }
  }
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: `data:text/javascript,${encodeURIComponent(process.env.JARVIS_TEST_LIFECYCLE === '1' ? lifecycle : source)}`, shortCircuit: true }
  }
  if (specifier === './net.mjs' && /\/bridge\/(server|page)\.mjs$/.test(context.parentURL || '')) {
    return { url: `data:text/javascript,${encodeURIComponent(network)}`, shortCircuit: true }
  }
  return next(specifier, context)
}
