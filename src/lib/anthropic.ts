import { AIProviderError, aiError, type AIAdapter, type AIMessage, type LegacyAskHandlers } from './ai'
import type { Turn } from './turn'

/** Fail closed for old callers: permanent AI keys must never enter browser bundles. */
const issue = () => aiError('invalid-request', {}, 'Browser-direct AI is disabled. Use OpenRouter in AI Settings or the Claude Agent bridge.')
export const adapter: AIAdapter<Turn> = {
  historyMode: 'messages', describe: () => null, configurationIssue: issue,
  async generate() { throw new AIProviderError(issue()) },
}
export async function ask(_messages: AIMessage[], _handlers: LegacyAskHandlers, _turn: Turn) {
  throw new AIProviderError(issue())
}
