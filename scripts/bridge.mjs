import { assertSupportedNode } from './runtime.mjs'

try {
  assertSupportedNode()
  if (process.argv.includes('--writes')) process.env.JARVIS_ALLOW_WRITES = '1'
  await import('../bridge/server.mjs')
} catch (err) {
  console.error(`[jarvis] Bridge startup failed: ${err.message}`)
  process.exitCode = 1
}
