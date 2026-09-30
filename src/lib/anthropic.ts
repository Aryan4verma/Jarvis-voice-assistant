import Anthropic from '@anthropic-ai/sdk'
import { abortable, type Turn } from './turn'
import { AIProviderError, aiError, assertCapabilities, legacyEvents, sumUsage, validContent,
  type AIAdapter, type AIHandlers, type AIInteraction, type AIMessage, type AIRequest, type AIResult, type AIUsage, type LegacyAskHandlers } from './ai'
import { anthropicContent, anthropicError, anthropicStopReason, anthropicUsage, claudeInfo } from '../../shared/providers/anthropic.mjs'
import { env, MODEL, FAST_MODE, SYSTEM_PROMPT, activeServers } from '../config'

/**
 * The Claude API supports CORS, so the browser can talk to it directly — no
 * server of our own. `dangerouslyAllowBrowser` is the SDK's acknowledgement
 * that this exposes the key to anyone who opens devtools, which is acceptable
 * for a local demo and not for a public deploy.
 */
const client = new Anthropic({
  apiKey: env.anthropicKey,
  dangerouslyAllowBrowser: true,
})

type ProviderMessage = Anthropic.Beta.BetaMessageParam
const info = claudeInfo('anthropic-api', MODEL, 'chat')

/**
 * A server-side tool loop that runs long enough gets paused rather than
 * finished: `stop_reason: 'pause_turn'`, resumable by replaying the assistant
 * turn back with no extra user message. Left unhandled it looks like a short
 * answer and reads as JARVIS trailing off. Continuations are bounded because
 * this is a voice assistant — after a few the honest thing is to say so rather
 * than keep the user in silence.
 */
const MAX_CONTINUATIONS = 3

/**
 * One turn of conversation.
 *
 * The interesting part is `mcp_servers`: Anthropic connects to those remote MCP
 * endpoints from its own infrastructure and exposes their tools to the model.
 * The browser never touches them, so there's no CORS, no OAuth plumbing here,
 * and no bridge process to keep alive.
 */
export async function generate(request: AIRequest, handlers: AIHandlers, owner: AIInteraction): Promise<AIResult> {
  const servers = activeServers()
  const usedTools: string[] = []
  let text = ''
  let finished = false
  const samples: AIUsage[] = []
  const current = () => !finished && !owner.signal.aborted && owner.current()
  const emit = (event: Parameters<AIHandlers['onEvent']>[0]) => { if (current()) handlers.onEvent(event) }
  const cancelled = (): AIResult => ({ text: text.trim(), tools: usedTools, reason: 'cancelled', ...usageResult() })
  const usageResult = () => { const usage = sumUsage(samples); return usage ? { usage } : {} }
  let active: ReturnType<typeof client.beta.messages.stream> | null = null
  const abort = () => active?.abort()
  owner.signal.addEventListener('abort', abort, { once: true })

  const betas = ['mcp-client-2025-11-20']
  if (FAST_MODE) betas.push('fast-mode-2026-02-01')

  const params = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    betas,
    ...(FAST_MODE ? { speed: 'fast' as const } : {}),
    // Thinking stays on at low effort. Disabling it entirely on Opus 5 can make
    // the model write tool calls into its visible text instead of emitting a
    // real tool_use block, which would silently break every integration here.
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'low' as const },
    mcp_servers: servers.map((s) => ({
      type: 'url' as const,
      name: s.name,
      url: s.url,
      ...(s.token ? { authorization_token: s.token } : {}),
    })),
    tools: [
      // Anthropic-hosted search. Free of any setup, and it makes JARVIS able to
      // answer "what happened today" without wiring up a search provider.
      { type: 'web_search_20260209' as const, name: 'web_search' as const },
      ...servers.map((s) => ({
        type: 'mcp_toolset' as const,
        mcp_server_name: s.name,
      })),
    ],
  }

  let messages: ProviderMessage[] = []

  try {
    assertCapabilities(info, request)
    if (request.messages.some(message => !validContent(message.content))) throw new AIProviderError(aiError('invalid-request', { providerId: info.providerId }))
    messages = request.messages.map(message => ({ role: message.role, content: anthropicContent(message.content) } as ProviderMessage))
    for (let turn = 0; ; turn++) {
      // A barge-in between continuations has no stream to abort, so the loop
      // has to check for itself rather than opening another one.
      if (!current()) return cancelled()
      const before = text.length

      const stream = client.beta.messages.stream({ ...params, messages }, { signal: owner.signal, maxRetries: 0 })
      active = stream
      if (!current()) { stream.abort(); active = null; return cancelled() }

      stream.on('text', (delta) => {
        if (!current()) return
        text += delta
        emit({ type: 'text', delta })
      })

      stream.on('streamEvent', (event) => {
        if (!current()) return
        if (event.type !== 'content_block_start') return
        const block = event.content_block

        // Two different block types reach the HUD by the same road. Tools on a
        // remote MCP server come back as `mcp_tool_use`; Anthropic's own hosted
        // tools — web search among them — come back as `server_tool_use`, and
        // matching only the first meant a search produced no tool phase, no
        // spinner and no filler line. Just several seconds of silence.
        if (block.type === 'mcp_tool_use') {
          if (usedTools.length < 256) usedTools.push(block.name)
          emit({ type: 'tool', name: block.name, id: block.id, phase: 'start' })
        } else if (block.type === 'server_tool_use') {
          if (usedTools.length < 256) usedTools.push(block.name)
          emit({ type: 'tool', name: block.name, displayName: block.name.replace(/_/g, ' '), id: block.id, phase: 'start' })
        }
      })

      let final: Anthropic.Beta.BetaMessage
      try {
        final = await abortable(stream.finalMessage(), owner.signal)
      } catch (err) {
        // A barge-in aborts this stream on purpose. That surfaces as a
        // rejection, and it isn't an error the user should see a toast for —
        // hand back what he'd already said.
        if (!current()) return cancelled()
        throw err
      } finally {
        active = null
      }

      if (!current()) return cancelled()
      // A whole-message-only SDK response still produces the same text event.
      if (text.length === before) {
        const fallback = (final.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
        if (fallback) { text += fallback; emit({ type: 'text', delta: fallback }) }
      }
      samples.push(anthropicUsage(final.usage) ?? {})
      const usage = sumUsage(samples)
      if (usage) emit({ type: 'usage', usage })

      if (final.stop_reason === 'pause_turn' && turn < MAX_CONTINUATIONS) {
        messages = [...messages, { role: 'assistant', content: final.content }]
        continue
      }

      // Everything below has to emit text events as well as return text.
      // App speaks the deltas; the returned text only feeds history, so a line
      // that is merely returned is a line nobody ever hears.
      if (final.stop_reason === 'refusal') {
        const line = "I can't help with that one, sir."
        emit({ type: 'text', delta: line })
        emit({ type: 'done', text: line, reason: 'refused', ...usageResult() })
        return { text: line, tools: usedTools, reason: 'refused', ...usageResult() }
      }

      if (final.stop_reason === 'max_tokens') {
        const line = ' There is more, if you want it.'
        emit({ type: 'text', delta: line })
        text += line
      } else if (final.stop_reason === 'pause_turn') {
        const line = ' That is taking longer than it should, sir. Ask me again.'
        emit({ type: 'text', delta: line })
        text += line
      }

      const answer: AIResult = { text: text.trim(), tools: usedTools, reason: anthropicStopReason(final.stop_reason), ...usageResult() }
      emit({ type: 'done', text: answer.text, reason: answer.reason, ...usageResult() })
      return answer
    }
  } catch (error) {
    if (!current()) return cancelled()
    const normalized = error instanceof AIProviderError ? error.toJSON() : anthropicError(error, info.providerId)
    emit({ type: 'error', error: normalized })
    throw new AIProviderError(normalized)
  } finally {
    finished = true
    active?.abort()
    active = null
    owner.signal.removeEventListener('abort', abort)
  }
}

export const adapter: AIAdapter = {
  historyMode: 'messages', describe: () => info, generate,
  configurationIssue: () => env.anthropicKey ? null : aiError('authentication', { providerId: info.providerId },
    'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.'),
}

/** Keep existing low-level callers working without exporting SDK message types. */
export function ask(history: AIMessage[], handlers: LegacyAskHandlers, owner: Turn): Promise<AIResult> {
  return generate({ messages: history }, legacyEvents(handlers), owner)
}

/**
 * Labels for the HUD's SYSTEMS rail.
 *
 * This is what is *configured*, not what is reachable. Anthropic dials these
 * servers from its own infrastructure when a tool actually runs, so the browser
 * has no way to check one without spending a turn — a revoked token shows green
 * here and only fails at the moment JARVIS tries to use it.
 */
export function connectedLabels(): string[] {
  return activeServers().map((s) => s.label)
}
