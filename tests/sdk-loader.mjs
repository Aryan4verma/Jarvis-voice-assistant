// Test-only agent double: no login, model request, MCP process, or private
// transcript is used by the bridge security integration tests.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ROOT } from '../scripts/runtime.mjs'

const source = `
export const tool = (name, description, schema, handler) => ({ name, handler });
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
export const tool = (name, description, schema, handler) => ({ name, handler });
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
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: `data:text/javascript,${encodeURIComponent(process.env.JARVIS_TEST_LIFECYCLE === '1' ? lifecycle : source)}`, shortCircuit: true }
  }
  if (specifier === './net.mjs' && /\/bridge\/(server|page)\.mjs$/.test(context.parentURL || '')) {
    return { url: `data:text/javascript,${encodeURIComponent(network)}`, shortCircuit: true }
  }
  return next(specifier, context)
}
