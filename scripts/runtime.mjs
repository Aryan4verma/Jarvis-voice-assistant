import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const NODE_REQUIREMENT = '^20.19.0 || >=22.12.0'

export function supportsNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23
}

export function assertSupportedNode() {
  if (!supportsNode()) {
    throw new Error(`Node.js ${process.versions.node} is unsupported. Use ${NODE_REQUIREMENT}; Node 24 LTS is recommended.`)
  }
}
