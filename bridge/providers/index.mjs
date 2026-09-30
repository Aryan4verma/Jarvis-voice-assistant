import { createClaudeAgentAdapter } from './claude-agent.mjs'
import { createOpenRouterAdapter } from './openrouter.mjs'

/** Provider construction stays on Node, behind the authenticated bridge. */
export function bridgeProviderFactory(selection) {
  if (selection.providerId === 'openrouter') return services => createOpenRouterAdapter({ ...selection, ...services })
  if (selection.providerId === 'claude-agent') return services => createClaudeAgentAdapter({ ...selection, ...services })
  throw new Error('Unsupported JARVIS AI provider.')
}
