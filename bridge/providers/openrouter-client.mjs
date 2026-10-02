import { AIProviderError, aiError, readUsage } from '../../shared/ai.mjs'
import { abortable } from '../abort.mjs'

const BASE = 'https://openrouter.ai/api/v1'
export const validModelId = id => typeof id === 'string' && id.length <= 192 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*\/[a-zA-Z0-9._:/-]+$/.test(id)
export function retryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(86400, Math.ceil(seconds)) : undefined
}
export function routerError(error) {
  const status = Number(error?.status ?? error?.code)
  const code = typeof error?.code === 'string' ? error.code : ''
  const source = error?.metadata?.limit_source
  const upstream = typeof error?.metadata?.provider_name === 'string' || source === 'upstream_provider_shared_pool'
  const free = error?.modelId?.endsWith(':free') || error?.modelId === 'openrouter/free'
  const wait = retryAfter(error?.retryAfter)
  const hint = wait !== undefined ? ` Wait ${wait} seconds before trying again.` : ' Try again later.'
  let category = 'unknown', message, normalizedCode
  if (error?.name === 'AbortError') category = 'cancelled'
  else if (error?.name === 'TimeoutError' || [408,504].includes(status)) category = 'timeout'
  else if ([401,403].includes(status) || code === 'authentication_error') {
    category = 'authentication'; message = 'OpenRouter rejected the API key or account permissions. Test or replace the key in AI Settings.'
  } else if (status === 429 || code === 'rate_limit_error') {
    category = 'rate-limit'
    message = upstream ? `${free ? 'The selected free model’s' : 'The selected model’s'} upstream provider is busy or rate limited.${hint} You can manually select another model; none was switched automatically.`
      : `OpenRouter request limit reached (HTTP 429).${hint} Check the account’s free-model minute/day quota if applicable.`
  } else if (status === 404 || code === 'model_not_found') {
    category = 'model-unavailable'; message = 'This model is no longer available. Refresh models and select a model in AI Settings.'
  } else if (status === 402) {
    category = 'unavailable'; normalizedCode = source === 'openrouter_in_flight_budget' ? 'provider_busy' : 'quota_exhausted'
    message = source === 'openrouter_in_flight_budget' ? `OpenRouter’s temporary in-flight spending budget is full.${hint}`
      : source === 'openrouter_key_limit' ? 'OpenRouter API-key credit limit exhausted. Check the key’s spending cap.'
      : 'Insufficient OpenRouter credits or request budget (HTTP 402). Check the balance, key spending limit, or reduce request size.'
  } else if (status >= 500 || code === 'server_error') {
    category = 'unavailable'; normalizedCode = 'provider_busy'; message = `${free ? 'The selected free model/provider' : 'OpenRouter or the selected provider'} is temporarily unavailable (HTTP ${status || 503}).${hint} No paid fallback was selected.`
  } else if ([400,422].includes(status)) category = 'invalid-request'
  else if (error instanceof TypeError) category = 'network'
  return aiError(category, { providerId:'openrouter', status, ...(normalizedCode ? { code: normalizedCode } : {}), ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) }, message)
}
/** Read only bounded error metadata. Raw messages/account/provider payloads never reach UI or logs. */
export async function routerFailure(response, signal, modelId) {
  let error = {}, bytes = 0
  const reader = response.body?.getReader(), chunks = []
  const readSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)])
  try {
    if (reader) while (true) {
      const part = await abortable(reader.read(), readSignal)
      if (part.done) break
      bytes += part.value.byteLength; if (bytes > 16384) break; chunks.push(Buffer.from(part.value))
    }
    if (bytes <= 16384) error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error ?? {}
  } catch { /* HTTP status remains authoritative if the body cannot be read. */ }
  finally { if (reader) { void reader.cancel().catch(()=>{}); reader.releaseLock() } }
  return routerError({ status: response.status, metadata: error?.metadata, retryAfter: response.headers.get('retry-after'), modelId })
}
export function routerUsage(usage) {
  return readUsage({inputTokens:usage?.prompt_tokens,outputTokens:usage?.completion_tokens,
    cacheReadTokens:usage?.prompt_tokens_details?.cached_tokens,cacheWriteTokens:usage?.prompt_tokens_details?.cache_write_tokens,
    ...(Number.isFinite(usage?.cost) && usage.cost >= 0 ? {cost:{amount:usage.cost,currency:'USD',source:'reported'}} : {})})
}
export const routerReason = value => ({stop:'complete',length:'max-tokens',tool_calls:'tool-continuation',content_filter:'refused',error:'error'})[value] ?? 'unknown'
export function routerInfo(model) {
  if (model?.id === 'openrouter/free') return { providerId: 'openrouter', modelId: model.id, displayName: 'OpenRouter', kind: 'chat',
    capabilities: { text: true, vision: true, streaming: true, toolCalling: true, agentRuntime: false, reasoningControls: 'unknown' } }
  const inputs = model?.architecture?.input_modalities, outputs = model?.architecture?.output_modalities, params = model?.supported_parameters
  return {providerId:'openrouter',modelId:model?.id ?? '',displayName:'OpenRouter',kind:'chat',capabilities:{
    text:Array.isArray(inputs) && Array.isArray(outputs) ? inputs.includes('text') && outputs.includes('text') : 'unknown',
    vision:Array.isArray(inputs) ? inputs.includes('image') : 'unknown',streaming:true,
    toolCalling:Array.isArray(params) ? params.includes('tools') : 'unknown',agentRuntime:false,
    reasoningControls:Array.isArray(params) ? params.some(p=>['reasoning','reasoning_effort'].includes(p)) : 'unknown',
  }}
}
export async function readJSON(response, signal, cap = 16 * 1024 * 1024) {
  if (!response.ok) throw new AIProviderError(await routerFailure(response, signal))
  const reader=response.body?.getReader()
  if (!reader) throw new AIProviderError(aiError('unknown',{providerId:'openrouter'}))
  const chunks=[]; let size=0
  try {
    while(true) {
      const {value,done}=await abortable(reader.read(),signal); if(done) break
      size+=value.byteLength; if(size>cap) throw new Error('Response limit')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { void reader.cancel().catch(()=>{}); reader.releaseLock() }
}
export function createRouterClient(fetchImpl = fetch) {
  let models = new Map(), expires = 0, loading = null
  const call = (path, init) => fetchImpl(BASE + path, { ...init, redirect:'error' })
  const catalog = async (signal, refresh=false) => {
    if (!refresh && models.size && Date.now() < expires) return [...models.values()]
    // No polling. Concurrent readers share one bounded request, with their own abortable waits.
    if (!loading) loading=(async()=>{
      const timeout=AbortSignal.timeout(15000)
      const response=await call('/models',{signal:timeout})
      const json=await readJSON(response,timeout)
      if(!Array.isArray(json.data) || json.data.length>5000) throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'}))
      const fresh=new Map()
      for(const value of json.data) if(validModelId(value?.id)) {
        const info=routerInfo(value)
        if(info.capabilities.text===false) continue
        const price = key => {const raw=value.pricing?.[key], n=Number(raw);return ['string','number'].includes(typeof raw) && String(raw).trim() !== '' && Number.isFinite(n) && n>=0 ? n*1000000 : undefined}
        fresh.set(value.id,{...info,name:typeof value.name==='string' ? value.name.slice(0,160) : value.id,
          inputPrice:price('prompt'),outputPrice:price('completion'),
          free: price('prompt') === 0 && price('completion') === 0 && Object.values(value.pricing ?? {}).every(raw => ['string','number'].includes(typeof raw) && String(raw).trim() !== '' && Number(raw) === 0)})
      }
      models=fresh; expires=Date.now()+30*60000
      return [...models.values()]
    })().catch(error=>{throw error instanceof AIProviderError ? error : new AIProviderError(routerError(error))}).finally(()=>{loading=null})
    return abortable(loading,signal)
  }
  return {
    catalog,
    cached: id => models.get(id) ?? null,
    async model(id,signal) {
      if(!validModelId(id)) throw new AIProviderError(aiError('model-unavailable',{providerId:'openrouter'},'Choose an OpenRouter model in AI Settings.'))
      signal?.throwIfAborted()
      const model=models.get(id)
      if (!model && id === 'openrouter/free') return { ...routerInfo({ id }), name: 'Free Models Router', inputPrice: 0, outputPrice: 0 }
      if (!model) return { ...routerInfo({ id }), name: id } // manual text fallback; Settings verifies capabilities via catalog
      return model
    },
    async testKey(key,signal) {
      signal=AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(15000)])
      const response=await call('/key',{headers:{authorization:`Bearer ${key}`},signal})
      if(!response.ok) throw new AIProviderError(await routerFailure(response, signal))
      // The response contains a key label/account data: never return or log it.
      void response.body?.cancel().catch(()=>{})
    },
    stream: (key,body,signal) => call('/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','X-OpenRouter-Title':'JARVIS'},body:JSON.stringify(body),signal}),
  }
}

/** Incremental SSE framing, including fragmented UTF-8, CRLF, comments and multiline data. */
export async function* routerFrames(response, signal, modelId) {
  if(!response.ok) throw new AIProviderError(await routerFailure(response, signal, modelId))
  if(!response.body) throw new AIProviderError(aiError('unknown',{providerId:'openrouter'}))
  const reader=response.body.getReader(), decoder=new TextDecoder()
  let buffer='', ended=false
  try {
    while(!ended) {
      const {value,done}=await abortable(reader.read(),signal)
      buffer+=done ? decoder.decode() : decoder.decode(value,{stream:true})
      if(buffer.length>1024*1024) throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'},'The AI stream exceeded its safe frame limit.'))
      let boundary
      while((boundary=/\r?\n\r?\n/.exec(buffer))) {
        const frame=buffer.slice(0,boundary.index); buffer=buffer.slice(boundary.index+boundary[0].length)
        const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
        if(!data) continue
        if(data==='[DONE]') {ended=true; break}
        let chunk
        try {chunk=JSON.parse(data)} catch {throw new AIProviderError(aiError('unknown',{providerId:'openrouter'},'The AI stream was malformed.'))}
        yield chunk
      }
      if(done) break
    }
    if(!ended) throw new AIProviderError(aiError('network',{providerId:'openrouter'},'The AI stream ended unexpectedly. No request was replayed.'))
  } finally {void reader.cancel().catch(()=>{}); reader.releaseLock()}
}
