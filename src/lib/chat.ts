import type { AIMessage } from './ai'

/** Keep cloud context within the existing wire limits, even after long answers. */
export function boundedHistory(messages: AIMessage[]): AIMessage[] {
  const encoder = new TextEncoder()
  const result: AIMessage[] = []
  let bytes = 0
  for (const message of messages.slice(-16).reverse()) {
    if (typeof message.content !== 'string') continue
    // Individual history messages must also fit the shared 32 KB content limit.
    const content = message.content.slice(0, 8000)
    const size = encoder.encode(content).length
    if (bytes + size > 96 * 1024) break
    bytes += size; result.unshift({ ...message, content })
  }
  // Start with a user message when the budget trimmed half of an exchange.
  if (result[0]?.role === 'assistant') result.shift()
  return result
}

/** Typed input delegates to the same interaction entry point as voice. */
export function submitTyped(text: string, respond: (text: string, source: 'typed') => Promise<void>) {
  const prompt = text.trim()
  if (!prompt) return false
  if (new TextEncoder().encode(prompt).length > 32768) throw new Error('Your message is too long. Use at most 32 KB of text.')
  void respond(prompt, 'typed')
  return true
}
