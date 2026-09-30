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
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  if (specifier === './net.mjs' && /\/bridge\/(server|page)\.mjs$/.test(context.parentURL || '')) {
    return { url: `data:text/javascript,${encodeURIComponent(network)}`, shortCircuit: true }
  }
  return next(specifier, context)
}
