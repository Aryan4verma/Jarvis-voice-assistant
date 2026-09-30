// Anthropic wire knowledge stays inside adapters (shared by the two existing paths).
import { aiError, readUsage } from '../ai.mjs'

export function anthropicStopReason(value) {
  if (value === 'end_turn' || value === 'stop_sequence') return 'complete'
  if (value === 'max_tokens' || value === 'model_context_window_exceeded') return 'max-tokens'
  if (['tool_use', 'pause_turn', 'compaction'].includes(value)) return 'tool-continuation'
  if (value === 'refusal') return 'refused'
  return 'unknown'
}
export function anthropicUsage(usage, cost) {
  return readUsage({ inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens, cacheWriteTokens: usage?.cache_creation_input_tokens,
    ...(Number.isFinite(cost) && cost >= 0 ? { cost: { amount: cost, currency: 'USD', source: 'reported' } } : {}) })
}
const codes = {
  authentication_error: 'authentication', authentication_failed: 'authentication', oauth_org_not_allowed: 'authentication',
  permission_error: 'authentication', rate_limit_error: 'rate-limit', rate_limit: 'rate-limit',
  overloaded_error: 'unavailable', overloaded: 'unavailable', server_error: 'unavailable',
  invalid_request_error: 'invalid-request', invalid_request: 'invalid-request', model_not_found: 'model-unavailable',
  billing_error: 'unavailable', api_error: 'unavailable',
}
export function anthropicError(error, providerId) {
  const code = typeof error === 'string' ? error : error?.type ?? error?.error?.type
  const name = error?.name
  let category = Object.hasOwn(codes, code) ? codes[code] : 'unknown'
  const status = error?.status
  if (name === 'AbortError' || name === 'APIUserAbortError') category = 'cancelled'
  else if (name === 'TimeoutError' || name === 'APIConnectionTimeoutError' || status === 408 || status === 504) category = 'timeout'
  else if (name === 'APIConnectionError') category = 'network'
  else if (status === 401 || status === 403) category = 'authentication'
  else if (status === 429) category = 'rate-limit'
  else if (category === 'unknown' && status >= 500) category = 'unavailable'
  else if (category === 'unknown' && (status === 400 || status === 404 || status === 422)) category = 'invalid-request'
  return aiError(category, { providerId, status, ...(Object.hasOwn(codes, code) ? { code } : {}) })
}
export function claudeInfo(providerId, modelId, kind) {
  return Object.freeze({ providerId, modelId, kind,
    displayName: kind === 'agent' ? 'Claude Agent SDK' : 'Anthropic Messages API',
    // Adapter support is known; arbitrary configured model capabilities are not.
    // Unknown is not a promise of support or a readiness/credential check.
    capabilities: Object.freeze({ text: true, streaming: true, vision: 'unknown', toolCalling: 'unknown',
      agentRuntime: kind === 'agent', reasoningControls: 'unknown' }),
  })
}
export function anthropicContent(content) {
  if (typeof content === 'string') return content
  return content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : {
    type: 'image', source: { type: 'base64', data: block.data, media_type: block.mimeType },
  })
}
