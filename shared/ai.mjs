// Pure shared helpers: no SDK, network, timer, worker, or credentials.
const messages = {
  authentication: 'AI authentication failed. Check the configured account or credential.',
  'rate-limit': 'The AI service is busy or rate limited. Try again later.',
  timeout: 'The AI request timed out. Its late output will be ignored.',
  unavailable: 'The AI service is unavailable. Try again later.',
  'invalid-request': 'The AI service cannot accept this request or capability.',
  'model-unavailable': 'The selected AI model is unavailable. Check the model configuration.',
  cancelled: 'The AI interaction was cancelled.',
  network: 'The AI service could not be reached. Check the connection.',
  unknown: 'The AI request failed. Check the local provider configuration.',
}
export function aiError(category, diagnostics = {}, message) {
  if (!Object.hasOwn(messages, category)) category = 'unknown'
  const safe = {}
  // Only adapter-owned identifiers/codes and a numeric status cross this boundary.
  for (const key of ['providerId', 'code']) {
    if (typeof diagnostics[key] === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(diagnostics[key]) && !/^(sk-|github_pat_|xox)/.test(diagnostics[key])) safe[key] = diagnostics[key]
  }
  if (Number.isInteger(diagnostics.status) && diagnostics.status >= 100 && diagnostics.status <= 599) safe.status = diagnostics.status
  return { category, message: message ?? messages[category], ...(Object.keys(safe).length ? { diagnostics: safe } : {}) }
}
export class AIProviderError extends Error {
  constructor(error) {
    super(error.message)
    this.name = 'AIProviderError'
    this.category = error.category
    this.diagnostics = error.diagnostics
  }
  toJSON() { return { category: this.category, message: this.message, ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}) } }
}
export function capability(info, name) {
  const value = info?.capabilities?.[name]
  return value === true || value === false ? value : 'unknown'
}
export function assertCapabilities(info, request) {
  if (capability(info, 'text') === false ||
      (request.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image')) && capability(info, 'vision') === false)) {
    throw new AIProviderError(aiError('invalid-request', { providerId: info.providerId, code: 'unsupported_capability' }))
  }
}
export function legacyEvents(handlers) {
  return { onEvent(event) {
    if (event.type === 'text') handlers.onText(event.delta)
    else if (event.type === 'tool') handlers.onTool(event.displayName ?? event.name)
  } }
}
export function readUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key]
  }
  if (value.cost?.currency === 'USD' && ['reported', 'estimated'].includes(value.cost.source) &&
      Number.isFinite(value.cost.amount) && value.cost.amount >= 0) result.cost = { amount: value.cost.amount, currency: 'USD', source: value.cost.source }
  return Object.keys(result).length ? result : undefined
}
export function completionReason(value) {
  return ['complete', 'max-tokens', 'tool-continuation', 'refused', 'cancelled', 'error', 'unknown'].includes(value) ? value : 'unknown'
}
/** Small wire validation; existing WebSocket limits still cap the whole frame. */
export function validContent(content) {
  if (typeof content === 'string') return content.length <= 32768 && Boolean(content.trim()) && new TextEncoder().encode(content).length <= 32768
  if (!Array.isArray(content) || !content.length || content.length > 16) return false
  let textBytes = 0, imageBytes = 0, meaningful = false
  const valid = content.every(block => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 32768) return false
      textBytes += new TextEncoder().encode(block.text).length
      meaningful ||= Boolean(block.text.trim())
      return textBytes <= 32768
    }
    if (block.type === 'image' && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(block.mimeType) && typeof block.data === 'string') {
      imageBytes += block.data.length
      meaningful = true
      return imageBytes <= 4 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data)
    }
    return false
  })
  return valid && meaningful
}
/** Bound stateless chat history as well as each message; session adapters need only the last user message. */
export function validRequest(request) {
  const history = request?.messages
  if (!Array.isArray(history) || !history.length || history.length > 32 || history.at(-1)?.role !== 'user') return false
  let textBytes = 0, imageBytes = 0
  const encoder = new TextEncoder()
  return history.every(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || !validContent(message.content)) return false
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    for (const block of content) {
      if (block.type === 'text') textBytes += encoder.encode(block.text).length
      else imageBytes += block.data.length
    }
    return textBytes <= 256 * 1024 && imageBytes <= 4 * 1024 * 1024
  })
}
/** Only sum fields supplied for every completed request; missing never means zero. */
export function sumUsage(samples) {
  if (!samples.length) return undefined
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (samples.every(sample => Number.isSafeInteger(sample?.[key]) && sample[key] >= 0)) result[key] = samples.reduce((total, sample) => total + sample[key], 0)
  }
  if (samples.every(sample => sample?.cost?.source === 'reported' && sample.cost.currency === 'USD' && Number.isFinite(sample.cost.amount) && sample.cost.amount >= 0)) {
    result.cost = { amount: samples.reduce((total, sample) => total + sample.cost.amount, 0), currency: 'USD', source: 'reported' }
  }
  return readUsage(result)
}
