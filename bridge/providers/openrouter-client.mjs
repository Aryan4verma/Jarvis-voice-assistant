import { AIProviderError, aiError, readUsage } from '../../shared/ai.mjs'
import { abortable } from '../abort.mjs'

const BASE = 'https://openrouter.ai/api/v1'
export const validModelId = id => typeof id === 'string' && id.length <= 192 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*\/[a-zA-Z0-9._:/-]+$/.test(id)
export function routerError(error) {
  const status = Number(error?.status ?? error?.code)
  const code = typeof error?.code === 'string' ? error.code : ''
  let category = 'unknown'
  if (error?.name === 'AbortError') category = 'cancelled'
  else if (error?.name === 'TimeoutError' || [408,504].includes(status)) category = 'timeout'
  else if ([401,403].includes(status) || code === 'authentication_error') category = 'authentication'
  else if (status === 429 || code === 'rate_limit_error') category = 'rate-limit'
  else if (status === 404 || code === 'model_not_found') category = 'model-unavailable'
  else if (status === 402 || status >= 500 || code === 'server_error') category = 'unavailable'
  else if ([400,422].includes(status)) category = 'invalid-request'
  else if (error instanceof TypeError) category = 'network'
  return aiError(category, { providerId:'openrouter', status }, status === 402 ? 'OpenRouter credits are unavailable. Check your account balance.' : undefined)
}
export function routerUsage(usage) {
  return readUsage({inputTokens:usage?.prompt_tokens,outputTokens:usage?.completion_tokens,
    cacheReadTokens:usage?.prompt_tokens_details?.cached_tokens,cacheWriteTokens:usage?.prompt_tokens_details?.cache_write_tokens,
    ...(Number.isFinite(usage?.cost) && usage.cost >= 0 ? {cost:{amount:usage.cost,currency:'USD',source:'reported'}} : {})})
}
export const routerReason = value => ({stop:'complete',length:'max-tokens',tool_calls:'tool-continuation',content_filter:'refused',error:'error'})[value] ?? 'unknown'
export function routerInfo(model) {
  const inputs = model?.architecture?.input_modalities, outputs = model?.architecture?.output_modalities, params = model?.supported_parameters
  return {providerId:'openrouter',modelId:model?.id ?? '',displayName:'OpenRouter',kind:'chat',capabilities:{
    text:Array.isArray(inputs) && Array.isArray(outputs) ? inputs.includes('text') && outputs.includes('text') : 'unknown',
    vision:Array.isArray(inputs) ? inputs.includes('image') : 'unknown',streaming:true,
    toolCalling:Array.isArray(params) ? params.includes('tools') : 'unknown',agentRuntime:false,
    reasoningControls:Array.isArray(params) ? params.some(p=>['reasoning','reasoning_effort'].includes(p)) : 'unknown',
  }}
}
export async function readJSON(response, signal, cap = 16 * 1024 * 1024) {
  if (!response.ok) { void response.body?.cancel().catch(()=>{}); throw new AIProviderError(routerError({status:response.status})) }
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
        const price = key => {const n=Number(value.pricing?.[key]);return value.pricing?.[key] != null && Number.isFinite(n) && n>=0 ? n*1000000 : undefined}
        fresh.set(value.id,{...info,name:typeof value.name==='string' ? value.name.slice(0,160) : value.id,
          inputPrice:price('prompt'),outputPrice:price('completion')})
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
      await catalog(signal)
      const model=models.get(id)
      if(!model) throw new AIProviderError(aiError('model-unavailable',{providerId:'openrouter'}))
      return model
    },
    async testKey(key,signal) {
      signal=AbortSignal.any([...(signal ? [signal] : []),AbortSignal.timeout(15000)])
      const response=await call('/key',{headers:{authorization:`Bearer ${key}`},signal})
      if(!response.ok) {void response.body?.cancel().catch(()=>{});throw new AIProviderError(routerError({status:response.status}))}
      // The response contains a key label/account data: never return or log it.
      void response.body?.cancel().catch(()=>{})
    },
    stream: (key,body,signal) => call('/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','X-OpenRouter-Title':'JARVIS'},body:JSON.stringify(body),signal}),
  }
}

/** Incremental SSE framing, including fragmented UTF-8, CRLF, comments and multiline data. */
export async function* routerFrames(response, signal) {
  if(!response.ok) {void response.body?.cancel().catch(()=>{});throw new AIProviderError(routerError({status:response.status}))}
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
