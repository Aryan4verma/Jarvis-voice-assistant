// Test-only browser/provider doubles. Production modules never load this file.
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transpileModule, ModuleKind } from 'typescript'

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL && new URL(context.parentURL).pathname.endsWith('.ts')) {
    const url = new URL(specifier + (specifier.endsWith('.ts') ? '' : '.ts'), context.parentURL)
    try { if ((await stat(url)).isFile()) return { url: url.href, shortCircuit: true } } catch { /* normal resolution */ }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  const fixtures = {
    '/src/config.ts': `export const BACKEND='bridge', AI_SELECTION={transport:'bridge'}, BRIDGE_HTTP_URL='/__jarvis/bridge', BRIDGE_WS_URL='ws://localhost:5173/__jarvis/bridge/ws', USE_ELEVENLABS=true, TTS_ENGINE='system', KOKORO_VOICE='test', MODEL='test-model', FAST_MODE=false, SYSTEM_PROMPT='Test', env={elevenKey:''}; export const activeServers=()=>[];`,
    '/src/lib/capabilities.ts': `export const caps=()=>globalThis.__speech;`,
    '/src/lib/kokoro.ts': `export const isUnavailable=()=>true; export const speak=async()=>null;`,
    '/src/lib/audio.ts': `export const getMic=async()=>({getAudioTracks:()=>[{readyState:"live"}]}); export const inputContext=()=>globalThis.__inputContext;`,
    '/src/lib/wake.ts': `export const startWake=async (...args)=>{ if (!globalThis.__wakeDouble) throw new Error('Unavailable'); return globalThis.__wakeDouble(...args) };`,
    '/src/lib/vad.ts': `export const startVad=async(handlers)=>{globalThis.__vad=handlers; return {live:()=>true,stop:()=>{},setGuard:()=>{},meter:()=>({speaking:false})};};`,
  }
  for (const [suffix, source] of Object.entries(fixtures)) {
    if (!new URL(url).search && new URL(url).pathname.endsWith(suffix)) return { format: 'module', source, shortCircuit: true }
  }
  if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) {
    return { format: 'module', shortCircuit: true, source: transpileModule(await readFile(fileURLToPath(url), 'utf8'),
      { compilerOptions: { module: ModuleKind.ESNext, target: 10 } }).outputText }
  }
  return next(url, context)
}
