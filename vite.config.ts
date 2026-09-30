import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { prepareMediaPipe } from './scripts/assets.mjs'
import { assertSupportedNode, ROOT } from './scripts/runtime.mjs'
import { LOCAL_HOSTS } from './bridge/security.mjs'
import { localBridgePlugin } from './scripts/frontend-bridge.mjs'

assertSupportedNode()
prepareMediaPipe()

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, 'VITE_')
  const configured = process.env.VITE_BRIDGE_URL || env.VITE_BRIDGE_URL
  if (configured) {
    const url = new URL(configured)
    if (url.protocol !== 'ws:' || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password) {
      throw new Error('VITE_BRIDGE_URL must name a local ws:// bridge; remote bridge hosting is unsupported.')
    }
  }
  const bridgePort = Number(configured ? new URL(configured).port || 8787 : process.env.JARVIS_BRIDGE_PORT || 8787)
  return {
    plugins: [react(), localBridgePlugin(bridgePort)],
    server: {
      host: '127.0.0.1',
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
    },
    preview: { host: '127.0.0.1' },
    optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
