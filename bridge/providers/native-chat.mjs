import { AIProviderError, aiError, capability, sumUsage, readUsage, validContent, validRequest } from '../../shared/ai.mjs'
import { abortable } from '../abort.mjs'
import { CLOUD_PERSONA } from './openrouter.mjs'
import { nativeError, nativeFrames, nativeInfo } from './native-client.mjs'

const parts = content => typeof content === 'string' ? [{ type: 'text', text: content }] : content
const openaiContent = (content, role = 'user') => parts(content).map(block => block.type === 'text'
  ? { type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text }
  : { type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}` })
const geminiParts = content => parts(content).map(block => block.type === 'text' ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } })
const usage = (provider, value) => provider === 'openai'
  ? readUsage({ inputTokens: value?.input_tokens, outputTokens: value?.output_tokens, cacheReadTokens: value?.input_tokens_details?.cached_tokens })
  : readUsage({ inputTokens: value?.promptTokenCount, outputTokens: Number.isSafeInteger(value?.candidatesTokenCount) && Number.isSafeInteger(value?.thoughtsTokenCount) && value.thoughtsTokenCount >= 0
    ? value.candidatesTokenCount + value.thoughtsTokenCount : value?.candidatesTokenCount, cacheReadTokens: value?.cachedContentTokenCount })

/** Native wire formats remain entirely on Node. Both adapters reuse turn, tool and permission contracts. */
export function createNativeAdapter(config) {
  const id = config.providerId
  let info = config.client.cached(config.modelId) ?? nativeInfo(id, config.modelId)
  const start = (request, handlers, turn, runtime = {}) => {
    const controller = new AbortController(), seen = new Set(), uncertain = new Set(), tools = [], samples = []
    let text = '', key, started = false, finished = false, cancelled = false, contextBytes = 0
    const current = () => !finished && !cancelled && turn.current() && !turn.signal.aborted && !controller.signal.aborted
    const emit = event => { if (current()) handlers.onEvent(event) }
    const abort = () => controller.abort(turn.signal.reason)
    turn.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('AI timeout', 'TimeoutError')), config.timeoutMs ?? 90000)
    const fields = () => { const value = sumUsage(samples); return value ? { usage: value } : {} }
    const result = (async () => {
      try {
        if (!current()) return { text, tools, reason: 'cancelled' }
        if (!validRequest(request)) throw new AIProviderError(aiError('invalid-request', { providerId: id }))
        info = await abortable(config.client.model(config.modelId, controller.signal), controller.signal)
        if (capability(info, 'text') === false) throw new AIProviderError(aiError('invalid-request', { providerId: id, code: 'unsupported_capability' }, 'This specialized model is not supported by the chat API. Select a general chat model.'))
        const images = request.messages.some(message => parts(message.content).some(block => block.type === 'image'))
        if (images && capability(info, 'vision') !== true) throw new AIProviderError(aiError('invalid-request', { providerId: id, code: 'unsupported_capability' }, 'Vision is not verified for this model. Select a supported vision model.'))
        config.onInfo?.(info)
        try { key = await abortable(config.getKey(controller.signal), controller.signal) }
        catch { controller.signal.throwIfAborted(); throw new AIProviderError(aiError('authentication', { providerId: id }, 'Provider key is missing or locked. Save or replace it in AI Settings.')) }
        const available = capability(info, 'toolCalling') === true ? (runtime.functionTools ?? []).filter(tool => !tool.vision || capability(info, 'vision') === true) : []
        const registry = new Map(available.map(tool => [tool.name, tool]))
        const persona = CLOUD_PERSONA + (available.length ? '' : '\nNo tools are supplied. Explain that actions/camera access are unavailable.')
        const budget = ({ fast: 1024, balanced: 2048, deep: 4096 })[config.mode] ?? 2048
        let messages = request.messages.map(message => id === 'openai'
          ? { role: message.role, content: openaiContent(message.content, message.role) }
          : { role: message.role === 'assistant' ? 'model' : 'user', parts: geminiParts(message.content) })
        for (let round = 0; round < 4; round++) {
          if (!current()) return { text, tools, reason: 'cancelled', ...fields() }
          const body = id === 'openai' ? { model: config.modelId, input: messages, instructions: persona, stream: true, store: false,
            include: ['reasoning.encrypted_content'], max_output_tokens: budget,
            ...(available.length ? { tools: available.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })), parallel_tool_calls: false } : {}) }
            : { contents: messages, systemInstruction: { parts: [{ text: persona }] }, generationConfig: { maxOutputTokens: budget },
              ...(available.length ? { tools: [{ functionDeclarations: available.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }] } : {}) }
          started = true
          const response = await abortable(config.client.stream(key, body, controller.signal, config.modelId), controller.signal)
          let terminal = false, reason = 'unknown', roundUsage, output = [], calls = [], refusals = false, outputBytes = 0
          for await (const chunk of nativeFrames(id, response, controller.signal)) {
            if (!current()) continue
            if (chunk.error || chunk.type === 'error') throw new AIProviderError(nativeError(id, chunk.error ?? chunk))
            if (id === 'openai') {
              if (!terminal && chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') { text += chunk.delta; emit({ type: 'text', delta: chunk.delta }) }
              if (chunk.type === 'response.refusal.delta') refusals = true
              if (['response.completed', 'response.incomplete', 'response.failed'].includes(chunk.type)) {
                if (terminal) continue
                terminal = true
                const value = chunk.response ?? {}
                if (chunk.type === 'response.failed') throw new AIProviderError(nativeError(id, value.error ?? {}))
                output = value.output ?? []; outputBytes = Buffer.byteLength(JSON.stringify(output)); roundUsage = usage(id, value.usage)
                reason = chunk.type === 'response.incomplete' ? (value.incomplete_details?.reason === 'max_output_tokens' ? 'max-tokens' : 'refused') : refusals ? 'refused' : 'complete'
                calls = output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }))
              }
            } else {
              const candidate = chunk.candidates?.[0]
              if (chunk.promptFeedback?.blockReason) { terminal = true; reason = 'refused' }
              for (const part of terminal ? [] : candidate?.content?.parts ?? []) {
                // Thought signatures stay in private continuation context, never in frontend events.
                outputBytes += Buffer.byteLength(JSON.stringify(part)); output.push(part)
                if (!part.thought && typeof part.text === 'string') { text += part.text; emit({ type: 'text', delta: part.text }) }
                if (part.functionCall) calls.push({ id: part.functionCall.id ?? `${round}:${calls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}), nativeId: part.functionCall.id })
              }
              if (candidate?.finishReason) { terminal = true; reason = ({ STOP: 'complete', MAX_TOKENS: 'max-tokens', SAFETY: 'refused', RECITATION: 'refused', BLOCKLIST: 'refused', PROHIBITED_CONTENT: 'refused', MALFORMED_FUNCTION_CALL: 'error', UNEXPECTED_TOOL_CALL: 'error' })[candidate.finishReason] ?? 'unknown' }
              if (chunk.usageMetadata) roundUsage = usage(id, chunk.usageMetadata)
            }
            if (text.length > 256 * 1024 || output.length > 256 || outputBytes > 4 * 1024 * 1024 || calls.length > 8) throw new AIProviderError(aiError('unavailable', { providerId: id }, 'AI response exceeded its safe limit.'))
          }
          controller.signal.throwIfAborted()
          if (!terminal) throw new AIProviderError(aiError('network', { providerId: id }, 'The AI stream ended unexpectedly. No request was replayed.'))
          samples.push(roundUsage ?? {}); if (sumUsage(samples)) emit({ type: 'usage', usage: sumUsage(samples) })
          if (reason === 'error') throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'The provider returned invalid tool activity.'))
          if (calls.length) {
            if (reason !== 'complete' || !available.length) throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'Incomplete or unsupported tool calls were blocked.'))
            if (round === 3) { const delta = ' Tool limit reached. Ask a follow-up to continue.'; text += delta; emit({ type: 'text', delta }); reason = 'tool-continuation' }
            else {
              contextBytes += Buffer.byteLength(JSON.stringify(output))
              messages.push(...(id === 'openai' ? output : [{ role: 'model', parts: output }]))
              for (const call of calls) {
                const tool = registry.get(call.name)
                if (!tool || typeof call.id !== 'string' || !call.id || call.id.length > 128 || seen.has(call.id) || typeof call.arguments !== 'string' || call.arguments.length > 32768) throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'Unknown or repeated tool activity was blocked.'))
                seen.add(call.id)
                let args; try { args = JSON.parse(call.arguments || '{}') } catch { throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'Invalid tool arguments.')) }
                const signature = call.name + JSON.stringify(args, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
                if (uncertain.has(signature)) throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'An earlier action outcome is uncertain. Ask before repeating it.'))
                if (!current()) return { text, tools, reason: 'cancelled', ...fields() }
                if (!config.decideTool(call.name)) throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'The tool is unavailable under current permissions.'))
                tools.push(call.name); if (!tool.silent) emit({ type: 'tool', name: call.name, id: call.id, displayName: tool.displayName, phase: 'start' })
                let value
                try { value = await abortable(tool.execute(args), controller.signal) }
                catch { controller.signal.throwIfAborted(); uncertain.add(signature); value = { isError: true, content: [{ type: 'text', text: 'Action failed; outcome uncertain. Do not repeat.' }] } }
                if (!current()) return { text, tools, reason: 'cancelled', ...fields() }
                const blocks = value?.content ?? [], toolText = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 65536)
                if (value?.isError) uncertain.add(signature)
                const images = blocks.filter(block => block.type === 'image')
                if (images.length && (capability(info, 'vision') !== true || !validContent(images))) throw new AIProviderError(aiError('invalid-request', { providerId: id }, 'Unsupported tool image.'))
                const resultText = toolText || 'Tool completed.'
                if (id === 'openai') {
                  messages.push({ type: 'function_call_output', call_id: call.id, output: resultText })
                  if (images.length) messages.push({ role: 'user', content: openaiContent(images) })
                } else messages.push({ role: 'user', parts: [{ functionResponse: { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}), response: { result: resultText, ...(value?.isError ? { error: true } : {}) } } }, ...geminiParts(images)] })
                contextBytes += Buffer.byteLength(resultText) + images.reduce((size, image) => size + image.data.length, 0)
                if (contextBytes > 4 * 1024 * 1024) throw new AIProviderError(aiError('unavailable', { providerId: id }, 'Tool continuation context exceeded its safe limit.'))
              }
              continue
            }
          }
          if (reason === 'max-tokens') { const delta = '\nOutput limit reached. Ask me to continue.'; text += delta; emit({ type: 'text', delta }) }
          if (reason === 'refused' && !text.trim()) { text = 'The selected model declined this request.'; emit({ type: 'text', delta: text }) }
          if (!text.trim()) throw new AIProviderError(aiError('unavailable', { providerId: id }, 'The model completed without an answer. Check model support or rephrase.'))
          const answer = { text: text.trim(), tools, reason, ...fields() }; emit({ type: 'done', text: answer.text, reason, ...fields() }); return answer
        }
      } catch (error) {
        if (cancelled || turn.signal.aborted || !turn.current()) return { text: text.trim(), tools, reason: 'cancelled', ...fields() }
        const normalized = error instanceof AIProviderError ? error.toJSON() : nativeError(id, controller.signal.aborted ? controller.signal.reason : error)
        if (turn.current()) handlers.onEvent({ type: 'error', error: normalized })
        return { text: text.trim(), tools, reason: 'error', error: normalized, ...fields() }
      } finally { finished = true; key = undefined; clearTimeout(timer); controller.abort(); turn.signal.removeEventListener('abort', abort); seen.clear(); uncertain.clear() }
    })()
    return { result, cancel() { cancelled = true; abort(); return started ? 'request-abort-requested' : 'not-started' } }
  }
  return { historyMode: 'messages', describe: () => info, start, generate: (request, handlers, turn) => start(request, handlers, turn).result }
}
