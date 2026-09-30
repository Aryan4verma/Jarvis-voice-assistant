import { query } from '@anthropic-ai/claude-agent-sdk'
import { AIProviderError, aiError, assertCapabilities, validContent } from '../../shared/ai.mjs'
import { anthropicContent, anthropicError, anthropicStopReason, anthropicUsage, claudeInfo } from '../../shared/providers/anthropic.mjs'

const failures = {
  error_during_execution: ['unknown', 'The turn failed part way through.'],
  error_max_turns: ['timeout', 'The turn ran too long and was stopped.'],
  error_max_budget_usd: ['unavailable', 'The budget for this turn ran out.'],
  error_max_structured_output_retries: ['unavailable', 'The answer could not be assembled.'],
}
function toolDisplayName(raw) {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
/** One adapter per connection; only a successful session ID survives a turn. */
export function createClaudeAgentAdapter(config, queryImpl = query) {
  const info = claudeInfo('claude-agent', config.modelId, 'agent')
  let resumeId = null
  const start = (request, handlers, turn, runtime = {}) => {
    const resume = resumeId // Never consult mutable session state inside late callbacks.
    const controller = new AbortController()
    const seen = new Set(), held = new Map()
    const tools = []
    let session = null, receipt = null, text = '', providerFailure = null
    const current = () => turn.current() && !turn.signal.aborted && !controller.signal.aborted
    const emit = (event) => { if (current()) handlers.onEvent(event) }
    const cancel = () => {
      if (receipt && (receipt !== 'not-started' || !session)) return receipt
      controller.abort()
      seen.clear(); held.clear()
      receipt = 'not-started'
      if (session) {
        try { session.close(); receipt = 'termination-requested' }
        catch { receipt = 'termination-unconfirmed' }
      }
      return receipt
    }
    turn.signal.addEventListener('abort', cancel, { once: true })
    const announce = (id, name) => {
      if (!current() || !name || (id && seen.has(id))) return
      if (id && seen.size < 256) seen.add(id)
      // Preserve the HUD's silent display tools and the existing permission gate.
      if (name === 'mcp__jarvis__display' || name.startsWith('mcp__jarvis_ui__')) return
      if (config.decideTool(name)) {
        if (tools.length < 256) tools.push(name)
        emit({ type: 'tool', name, displayName: toolDisplayName(name), ...(id ? { id } : {}), phase: 'start' })
      } else if (id && held.size < 256) held.set(id, name)
    }
    const result = (async () => {
      try {
        if (!current()) return { text: '', tools, reason: 'cancelled' }
        assertCapabilities(info, request)
        const last = request.messages.at(-1)
        if (last?.role !== 'user' || !validContent(last.content)) throw new AIProviderError(aiError('invalid-request', { providerId: info.providerId }))
        async function* messages() {
          yield { type: 'user', message: { role: 'user', content: anthropicContent(last.content) }, parent_tool_use_id: null, ...(resume ? { session_id: resume } : {}) }
        }
        session = queryImpl({ prompt: messages(), options: {
          abortController: controller, ...(resume ? { resume } : {}),
          mcpServers: runtime.mcpServers ?? config.mcpServers, systemPrompt: config.systemPrompt, cwd: config.cwd,
          // Keep Phase 2's settings boundary and permission callback unchanged.
          settingSources: [], model: config.modelId, effort: config.reasoningEffort,
          maxTurns: 24, permissionMode: 'default', includePartialMessages: true,
          canUseTool: async (name) => {
            const ok = current() && config.decideTool(name)
            console.log(`[jarvis] tool decision: ${ok ? 'allow' : 'deny'}`)
            return ok ? { behavior: 'allow' } : { behavior: 'deny', message:
              'Blocked: JARVIS is running in read-only mode and cannot take' +
              ' actions that change anything. Tell the user this action is' +
              ' unavailable until they enable write access on the machine.' }
          },
        } })
        // A provider factory may observe cancellation before returning its handle.
        if (!current()) cancel()
        for await (const message of session) {
          if (!current()) continue
          if (config.debug) console.log('[msg]', message.type, message.event?.type ?? '')
          if (message.type === 'stream_event') {
            const event = message.event
            if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              text += event.delta.text
              emit({ type: 'text', delta: event.delta.text })
            }
            if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') announce(event.content_block.id, event.content_block.name)
          } else if (message.type === 'assistant') {
            if (message.error) providerFailure = anthropicError(message.error, info.providerId)
            for (const block of message.content ?? message.message?.content ?? []) {
              if (block.type === 'tool_use') announce(block.id, block.name)
            }
          } else if (message.type === 'user') {
            const blocks = message.message?.content
            if (!Array.isArray(blocks)) continue
            for (const block of blocks) {
              const name = held.get(block?.tool_use_id)
              if (block?.type !== 'tool_result' || !name) continue
              held.delete(block.tool_use_id)
              if (!block.is_error) {
                if (tools.length < 256) tools.push(name)
                emit({ type: 'tool', name, displayName: toolDisplayName(name), id: block.tool_use_id, phase: 'activity' })
              }
            }
          } else if (message.type === 'system' && message.subtype === 'init') {
            const servers = (message.mcp_servers ?? []).filter(server => server.status !== 'needs-auth' && server.status !== 'failed').map(server => server.name)
            config.onReady?.(servers)
          } else if (message.type === 'result') {
            const usage = anthropicUsage(message.usage, message.total_cost_usd)
            if (usage) emit({ type: 'usage', usage })
            if (message.subtype !== 'success' || message.is_error === true) {
              const [category, messageText] = failures[message.subtype] ?? ['unknown', 'The turn ended without an answer.']
              const failure = providerFailure ?? (message.api_error_status
                ? anthropicError({ status: message.api_error_status }, info.providerId)
                : aiError(category, { providerId: info.providerId,
                  ...(Object.hasOwn(failures, message.subtype) ? { code: message.subtype } : {}) }, messageText))
              emit({ type: 'error', error: failure })
              return { text: text.trim(), tools, reason: 'error', error: failure, ...(usage ? { usage } : {}) }
            }
            if (typeof message.session_id === 'string') resumeId = message.session_id
            const answer = { text: (text || message.result || '').trim(), tools, reason: anthropicStopReason(message.stop_reason), ...(usage ? { usage } : {}) }
            emit({ type: 'done', text: answer.text, reason: answer.reason, ...(usage ? { usage } : {}) })
            return answer
          }
        }
        if (!current()) return { text: text.trim(), tools, reason: 'cancelled' }
        throw new AIProviderError(aiError('unknown', { providerId: info.providerId, code: 'stream_ended' }, 'The agent stream ended without a result.'))
      } catch (error) {
        if (!current()) return { text: text.trim(), tools, reason: 'cancelled' }
        const normalized = error instanceof AIProviderError ? error.toJSON() : anthropicError(error, info.providerId)
        emit({ type: 'error', error: normalized })
        throw new AIProviderError(normalized)
      } finally {
        cancel()
        turn.signal.removeEventListener('abort', cancel)
        seen.clear(); held.clear()
      }
    })()
    return { result, cancel }
  }
  return {
    historyMode: 'session', describe: () => info, start,
    generate: (request, handlers, turn) => start(request, handlers, turn).result,
  }
}
