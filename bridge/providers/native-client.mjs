import { AIProviderError, aiError } from '../../shared/ai.mjs'
import { abortable } from '../abort.mjs'
import { retryAfter } from './openrouter-client.mjs'

export const nativeModelId = id => typeof id === 'string' && id.length <= 192 && !/^(?:sk-|AIza)/.test(id) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)
const names = { openai: 'OpenAI', gemini: 'Google Gemini' }
export function nativeError(providerId, error = {}) {
  const status = Number(error.status ?? error.code), code = String(error.code ?? error.type ?? '')
  const wait = retryAfter(error.retryAfter), name = names[providerId]
  let category = 'unknown', message, normalizedCode
  if (error.name === 'AbortError') category = 'cancelled'
  else if (error.name === 'TimeoutError' || [408, 504].includes(status) || code === 'DEADLINE_EXCEEDED') category = 'timeout'
  else if (status === 401 || status === 403 || ['invalid_api_key', 'API_KEY_INVALID', 'UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(code)) {
    category = 'authentication'; message = `${name} rejected the key or its permissions. Test or replace it in AI Settings.`
  } else if (status === 402 || ['insufficient_quota', 'billing_hard_limit_reached', 'QUOTA_EXCEEDED'].includes(code)) {
    category = 'unavailable'; normalizedCode = 'quota_exhausted'; message = `${name} credits or quota are exhausted. Check the account billing and limits.`
  } else if (status === 429 || ['RESOURCE_EXHAUSTED', 'rate_limit_exceeded', 'rate_limit_error'].includes(code)) {
    category = 'rate-limit'; message = `${name} rate limit or quota reached.${wait !== undefined ? ` Wait ${wait} seconds.` : ' Check account quotas and try later.'}`
  } else if (status === 404 || ['model_not_found', 'NOT_FOUND', 'unsupported_model'].includes(code)) category = 'model-unavailable'
  else if (status >= 500 || ['UNAVAILABLE', 'INTERNAL', 'server_error', 'internal_error'].includes(code)) {
    category = 'unavailable'; normalizedCode = 'provider_busy'; message = `${name} is busy or temporarily unavailable. Try later; no provider was switched.`
  } else if ([400, 422].includes(status) || ['INVALID_ARGUMENT', 'invalid_request_error', 'context_length_exceeded', 'unsupported_parameter', 'unsupported_value'].includes(code)) {
    category = 'invalid-request'; message = `${name} rejected the request or a model capability. Check the selected model’s vision/tool support.`
  } else if (error instanceof TypeError) category = 'network'
  return aiError(category, { providerId, status, ...(normalizedCode ? { code: normalizedCode } : {}), ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) }, message)
}

async function boundedJSON(response, signal, cap = 4 * 1024 * 1024) {
  const reader = response.body?.getReader(), chunks = []; let size = 0
  if (!reader) throw new Error('Missing response')
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal); if (done) break
      size += value.byteLength; if (size > cap) throw new Error('Response limit')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
export async function nativeFailure(providerId, response, signal) {
  let code
  try {
    const value = await boundedJSON(response, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)]), 16384)
    code = value.error?.code === 'insufficient_quota' ? 'insufficient_quota' : value.error?.status ?? value.error?.code ?? value.error?.type
    if (providerId === 'gemini' && value.error?.details?.some(detail => detail.reason === 'API_KEY_INVALID')) code = 'API_KEY_INVALID'
    else if (providerId === 'gemini' && value.error?.details?.some(detail => detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')) code = 'QUOTA_EXCEEDED'
  } catch { /* HTTP status remains authoritative; never expose raw provider messages. */ }
  return nativeError(providerId, { status: response.status, code, retryAfter: response.headers.get('retry-after') })
}
/** SSE with bounded frames. Provider terminal events, rather than EOF, establish success. */
export async function* nativeFrames(providerId, response, signal) {
  if (!response.ok) throw new AIProviderError(await nativeFailure(providerId, response, signal))
  const reader = response.body?.getReader(), decoder = new TextDecoder(); let buffer = ''
  if (!reader) throw new AIProviderError(aiError('network', { providerId }))
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal)
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 1024 * 1024) throw new AIProviderError(aiError('unavailable', { providerId }, 'AI frame limit exceeded.'))
      let boundary
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        try { yield JSON.parse(data) } catch (error) {
          if (error instanceof SyntaxError) throw new AIProviderError(aiError('network', { providerId }, 'AI stream was malformed. No request was replayed.'))
          throw error
        }
      }
      if (done) break
    }
    if (buffer.trim()) throw new AIProviderError(aiError('network', { providerId }, 'AI stream ended with an incomplete frame.'))
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** APIs do not publish full modality/tool metadata. Only documented general chat families are verified.
 * Unknown IDs have unverified vision/tools; specialized endpoints are unsupported here. */
export function nativeInfo(providerId, id, metadata = {}) {
  const specialized = /(?:audio|realtime|live|image|tts|transcrib|embedding|moderation|research|search|robotics|cyber)/i.test(id)
  const stem = id.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const known = !specialized && (providerId === 'openai'
    ? /^(?:gpt-4o(?:-mini)?|gpt-4\.1(?:-(?:mini|nano))?|gpt-5(?:\.[1-6])?(?:-(?:mini|nano|pro|codex(?:-mini|-max)?|sol|terra|luna))?|gpt-6(?:\.1)?-(?:astra|sol|luna)|o1|o3(?:-mini|-pro)?|o4-mini)$/.test(stem)
    : /^gemini-[23](?:\.\d+)?-(?:flash(?:-lite)?|pro)(?:-preview(?:-\d{2}-\d{2})?|-\d{3})?$/.test(stem))
  return { providerId, modelId: id, displayName: names[providerId], kind: 'chat', name: String(metadata.displayName ?? id).slice(0, 160),
    capabilities: { text: specialized ? false : true, vision: specialized || /^o3-mini(?:-|$)/.test(id) ? false : known ? true : 'unknown', toolCalling: specialized ? false : known ? true : 'unknown',
      streaming: specialized ? false : known ? true : 'unknown', agentRuntime: false, reasoningControls: 'unknown' } }
}
export function createNativeClient(providerId, fetchImpl = fetch) {
  if (!Object.hasOwn(names, providerId)) throw new Error('Unknown provider')
  const base = providerId === 'openai' ? 'https://api.openai.com/v1' : 'https://generativelanguage.googleapis.com/v1beta'
  let models = new Map(), expires = 0, generation = 0
  const call = (path, key, init = {}) => fetchImpl(base + path, { ...init, redirect: 'error', headers: {
    'content-type': 'application/json', ...(providerId === 'openai' ? { authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }),
  } })
  const json = async (path, key, signal) => {
    const response = await call(path, key, { signal })
    if (!response.ok) throw new AIProviderError(await nativeFailure(providerId, response, signal))
    return boundedJSON(response, signal)
  }
  return {
    clear() { models.clear(); expires = 0; generation++ }, cached: id => models.get(id) ?? null,
    async catalog(signal, refresh = false, key) {
      if (!refresh && models.size && Date.now() < expires) return [...models.values()]
      const captured = generation, fresh = new Map(), timeout = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)])
      let token = '', pages = 0
      do {
        const value = await json('/models' + (providerId === 'gemini' ? `?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}` : ''), key, timeout)
        const list = providerId === 'openai' ? value.data : value.models
        if (!Array.isArray(list) || list.length > 5000) throw new AIProviderError(aiError('unavailable', { providerId }))
        for (const model of list) {
          const id = providerId === 'openai' ? model.id : model.name?.replace(/^models\//, '')
          if (!nativeModelId(id) || (providerId === 'gemini' && !model.supportedGenerationMethods?.includes('generateContent'))) continue
          fresh.set(id, nativeInfo(providerId, id, model))
        }
        token = providerId === 'gemini' ? value.nextPageToken ?? '' : ''
        if (typeof token !== 'string' || token.length > 2048 || fresh.size > 5000 || ++pages > 50) throw new AIProviderError(aiError('unavailable', { providerId }))
      } while (token)
      timeout.throwIfAborted()
      if (captured === generation) { models = fresh; expires = Date.now() + 30 * 60000 }
      return [...fresh.values()]
    },
    async model(id) {
      if (!nativeModelId(id)) throw new AIProviderError(aiError('model-unavailable', { providerId }))
      return models.get(id) ?? nativeInfo(providerId, id)
    },
    async testKey(key, signal, id) {
      const timeout = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)])
      const path = nativeModelId(id) ? `/models/${encodeURIComponent(id)}` : '/models'
      await json(path, key, timeout) // Metadata only; no inference credits or account data returned.
    },
    stream(key, body, signal, id) {
      return call(providerId === 'openai' ? '/responses' : `/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`, key,
        { method: 'POST', body: JSON.stringify(body), signal })
    },
  }
}
