import { createClaudeAgentAdapter } from './claude-agent.mjs'

/** Selection happens once at startup, not throughout HTTP/WebSocket handling. */
export function bridgeProviderFactory(selection) {
  if (selection.providerId !== 'claude-agent') throw new Error('Unsupported JARVIS AI provider. This build supports claude-agent.')
  return (services) => createClaudeAgentAdapter({ ...selection, ...services })
}
