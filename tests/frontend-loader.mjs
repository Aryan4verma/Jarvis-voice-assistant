// Test-only browser/provider doubles. Production modules never load this file.
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transpileModule, ModuleKind } from 'typescript'

export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/sdk') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export default class Anthropic { constructor() { this.beta = { messages: { stream: (...args) => globalThis.__directStream(...args) } }; } }
  `) }
  if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
    const url = new URL(specifier + (specifier.endsWith('.ts') ? '' : '.ts'), context.parentURL)
    try { if ((await stat(url)).isFile()) return { url: url.href, shortCircuit: true } } catch { /* normal resolution */ }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  const fixtures = {
    '/src/config.ts': `export const BACKEND='bridge', BRIDGE_HTTP_URL='/__jarvis/bridge', BRIDGE_WS_URL='ws://localhost:5173/__jarvis/bridge/ws', USE_ELEVENLABS=false, TTS_ENGINE='system', KOKORO_VOICE='test', MODEL='test-model', FAST_MODE=false, SYSTEM_PROMPT='Test', env={anthropicKey:'',elevenKey:''}; export const activeServers=()=>[];`,
    '/src/lib/capabilities.ts': `export const caps=()=>globalThis.__speech;`,
    '/src/lib/kokoro.ts': `export const isUnavailable=()=>true; export const speak=async()=>null;`,
    '/src/lib/audio.ts': `export const getMic=async()=>({});`,
    '/src/lib/vad.ts': `export const startVad=async(handlers)=>{globalThis.__vad=handlers; return {live:()=>true,stop:()=>{},setGuard:()=>{},meter:()=>({speaking:false})};};`,
  }
  for (const [suffix, source] of Object.entries(fixtures)) {
    if (new URL(url).pathname.endsWith(suffix)) return { format: 'module', source, shortCircuit: true }
  }
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    return { format: 'module', shortCircuit: true, source: transpileModule(await readFile(fileURLToPath(url), 'utf8'),
      { compilerOptions: { module: ModuleKind.ESNext, target: 10 } }).outputText }
  }
  return next(url, context)
}
