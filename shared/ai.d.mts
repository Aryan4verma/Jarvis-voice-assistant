/** Application-owned data; no provider SDK types belong here. */
export type CapabilitySupport = boolean | 'unknown'
export type AICapability = 'text' | 'vision' | 'streaming' | 'toolCalling' | 'agentRuntime' | 'reasoningControls'
export type AICapabilities = Readonly<Record<AICapability, CapabilitySupport>>
export type AIProviderInfo = Readonly<{
  providerId: string
  modelId: string
  displayName: string
  kind: 'chat' | 'agent'
  capabilities: AICapabilities
}>
export type AISelection = Readonly<{
  transport: 'bridge' | 'direct'
  providerId?: string
  modelId?: string
}>
export type AIContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
export type AIMessage = { role: 'user' | 'assistant'; content: string | readonly AIContent[] }
export type AIRequest = { messages: readonly AIMessage[] }
export type AICompletionReason = 'complete' | 'max-tokens' | 'tool-continuation' | 'refused' | 'cancelled' | 'error' | 'unknown'
export type AIUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: { amount: number; currency: 'USD'; source: 'reported' | 'estimated' }
}
export type AIErrorCategory = 'authentication' | 'rate-limit' | 'timeout' | 'unavailable' | 'invalid-request' | 'model-unavailable' | 'cancelled' | 'network' | 'unknown'
export type AIError = {
  category: AIErrorCategory
  message: string
  diagnostics?: { providerId?: string; status?: number; code?: string }
}
/** Lifecycle identity is supplied separately; it never comes from provider chunks. */
export type AIEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; id?: string; displayName?: string; phase?: 'start' | 'activity' }
  | { type: 'usage'; usage: AIUsage }
  | { type: 'done'; text: string; reason: AICompletionReason; usage?: AIUsage }
  | { type: 'cancelled'; reason: 'cancelled' }
  | { type: 'error'; error: AIError }
export type AIHandlers = { onEvent: (event: AIEvent) => void }
export type AIResult = { text: string; tools: string[]; reason: AICompletionReason; usage?: AIUsage; error?: AIError }
export type AIInteraction = { readonly turnId: string; readonly signal: AbortSignal; current: () => boolean }
export interface AIAdapter<Turn extends AIInteraction = AIInteraction> {
  readonly historyMode: 'messages' | 'session'
  describe(): AIProviderInfo | null
  generate(request: AIRequest, handlers: AIHandlers, turn: Turn): Promise<AIResult>
  configurationIssue?(): AIError | null
}
/** Compatibility for existing low-level callers during this migration. */
export type LegacyAskHandlers = { onText: (delta: string) => void; onTool: (name: string) => void }
export class AIProviderError extends Error {
  readonly category: AIErrorCategory
  readonly diagnostics?: AIError['diagnostics']
  constructor(error: AIError)
  toJSON(): AIError
}
export function aiError(category: AIErrorCategory, diagnostics?: AIError['diagnostics'], message?: string): AIError
export function capability(info: AIProviderInfo | null, name: AICapability): CapabilitySupport
export function assertCapabilities(info: AIProviderInfo, request: AIRequest): void
export function legacyEvents(handlers: LegacyAskHandlers): AIHandlers
export function readUsage(value: unknown): AIUsage | undefined
export function completionReason(value: unknown): AICompletionReason
export function validContent(value: unknown): value is AIMessage['content']
export function validRequest(value: unknown): value is AIRequest
export function sumUsage(samples: readonly AIUsage[]): AIUsage | undefined
