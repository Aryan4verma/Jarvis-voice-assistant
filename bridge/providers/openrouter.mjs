import { AIProviderError, aiError, assertCapabilities, capability, sumUsage, validContent, validRequest } from '../../shared/ai.mjs'
import { abortable } from '../abort.mjs'
import { routerFrames, routerError, routerInfo, routerReason, routerUsage } from './openrouter-client.mjs'

const content = value => typeof value==='string' ? value : value.map(block=>block.type==='text' ? block : {type:'image_url',image_url:{url:`data:${block.mimeType};base64,${block.data}`}})
export const CLOUD_PERSONA = `You are JARVIS, a concise personal assistant. Reply in plain language. Use brief answers for everyday requests and detail when asked.
Use only the tools actually supplied. Never claim access to desktop files, browsers, MCP servers or stored memory without a tool result.
Camera tools are private: use them only when the user explicitly asks you to look or watch. Never poll the camera.
Report tool failures honestly. Do not repeat uncertain actions. The current interaction may be cancelled at any time.`

export function createOpenRouterAdapter(config) {
  let info=config.client.cached(config.modelId) ?? routerInfo({id:config.modelId})
  const start=(request,handlers,turn,runtime={})=>{
    const controller=new AbortController(), tools=[], samples=[], seenCalls=new Set(), uncertainCalls=new Set()
    let imageBytes=0, toolBytes=0
    let text='', started=false, finished=false, cancelled=false
    const current=()=>!finished && !cancelled && turn.current() && !turn.signal.aborted && !controller.signal.aborted
    const emit=event=>{if(current()) handlers.onEvent(event)}
    const abort=()=>controller.abort(turn.signal.reason)
    turn.signal.addEventListener('abort',abort,{once:true})
    const timer=setTimeout(()=>controller.abort(new DOMException('AI timeout','TimeoutError')),config.timeoutMs ?? 90000)
    const usageFields=()=>{const usage=sumUsage(samples);return usage ? {usage} : {}}
    const result=(async()=>{
      let key
      try {
        if(!current()) return {text,tools,reason:'cancelled'}
        if(!validRequest(request)) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'}))
        const model=await abortable(config.client.model(config.modelId,controller.signal),controller.signal)
        if(!current()) return {text,tools,reason:'cancelled'}
        info=model; assertCapabilities(info,request)
        const hasImage=request.messages.some(message=>Array.isArray(message.content) && message.content.some(block=>block.type==='image'))
        if(hasImage && capability(info,'vision')!==true) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'This model does not advertise vision support. Select a verified vision model.'))
        config.onInfo?.(info)
        try {key=await abortable(config.getKey(controller.signal),controller.signal)}
        catch {controller.signal.throwIfAborted();throw new AIProviderError(aiError('authentication',{providerId:'openrouter'},'OpenRouter key is missing or locked. Save or replace it in AI Settings.'))}
        const available=capability(info,'toolCalling')===true ? (runtime.functionTools ?? []).filter(tool=>!tool.vision || capability(info,'vision')===true) : []
        const registry=new Map(available.map(tool=>[tool.name,tool]))
        const limitations=(capability(info,'toolCalling')!==true ? '\nThis model has no verified tool calling: explain that you cannot perform interface or camera actions if asked.' : '')+
          (capability(info,'vision')!==true ? '\nThis model has no verified vision: explain that you cannot inspect camera images if asked.' : '')
        let messages=[{role:'system',content:CLOUD_PERSONA+limitations},...request.messages.map(message=>({role:message.role,content:content(message.content)}))]
        for(let round=0;round<4;round++) {
          controller.signal.throwIfAborted()
          if(!current()) return {text:text.trim(),tools,reason:'cancelled',...usageFields()}
          const calls=new Map(); let reason='unknown', usage
          started=true
          const response=await abortable(config.client.stream(key,{
            model:config.modelId,messages,stream:true,stream_options:{include_usage:true},
            max_tokens:({fast:1024,balanced:2048,deep:4096})[config.mode] ?? 2048,
            provider:{require_parameters:true,allow_fallbacks:false},
            ...(capability(info,'reasoningControls')===true ? {reasoning:{effort:({fast:'low',balanced:'medium',deep:'high'})[config.mode] ?? 'medium'}} : {}),
            ...(available.length ? {tools:available.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}})),tool_choice:'auto'} : {}),
          },controller.signal),controller.signal)
          const before=text.length
          for await(const chunk of routerFrames(response,controller.signal,info.modelId)) {
            if(!current()) continue
            if(chunk.error) throw new AIProviderError(routerError({ ...chunk.error, modelId: info.modelId }))
            const choice=chunk.choices?.[0]
            if(choice?.error) throw new AIProviderError(routerError({ ...choice.error, modelId: info.modelId }))
            if(typeof choice?.delta?.content==='string') {
              text+=choice.delta.content
              if(text.length>256*1024) throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'},'The response exceeded its safe text limit.'))
              emit({type:'text',delta:choice.delta.content})
            }
            if(choice?.finish_reason) reason=routerReason(choice.finish_reason)
            if(chunk.usage) usage=routerUsage(chunk.usage)
            for(const delta of choice?.delta?.tool_calls ?? []) {
              if(!Number.isInteger(delta.index) || delta.index<0 || delta.index>=8) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'}))
              const call=calls.get(delta.index) ?? {id:'',type:'function',function:{name:'',arguments:''}}
              if(delta.id) call.id+=delta.id
              if(delta.function?.name) call.function.name+=delta.function.name
              if(delta.function?.arguments) call.function.arguments+=delta.function.arguments
              if(call.id.length>128 || call.function.name.length>128 || call.function.arguments.length>32768) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'}))
              calls.set(delta.index,call)
            }
          }
          controller.signal.throwIfAborted()
          samples.push(usage ?? {})
          if(sumUsage(samples)) emit({type:'usage',usage:sumUsage(samples)})
          if(reason==='error') throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'}))
          if(calls.size) {
            if(capability(info,'toolCalling')!==true || reason!=='tool-continuation') throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'The model returned unsupported tool activity.'))
            if(round===3) {
              const line=' Tool limit reached. Ask a follow-up to continue.';text+=line;emit({type:'text',delta:line})
            } else {
              messages.push({role:'assistant',content:text.slice(before) || null,tool_calls:[...calls.values()]})
              for(const call of calls.values()) {
                const tool=registry.get(call.function.name)
                if(!tool || !call.id || seenCalls.has(call.id)) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'An unknown or repeated tool call was blocked.'))
                seenCalls.add(call.id)
                let args
                try {args=JSON.parse(call.function.arguments || '{}')} catch {throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'Tool arguments were invalid.'))}
                const signature=call.function.name+JSON.stringify(args,(_key,value)=>value && typeof value==='object' && !Array.isArray(value)
                  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value)
                if(uncertainCalls.has(signature)) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'An earlier tool outcome is uncertain. Ask the user before trying again.'))
                if(!current()) return {text:text.trim(),tools,reason:'cancelled',...usageFields()}
                if(!config.decideTool(call.function.name)) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'This tool is unavailable under the current permissions.'))
                tools.push(call.function.name)
                if(!tool.silent) emit({type:'tool',name:call.function.name,id:call.id,displayName:tool.displayName,phase:'start'})
                // Exactly one dispatch. Errors/uncertain outcomes are never retried.
                let output
                try {output=await abortable(tool.execute(args),controller.signal)}
                catch {controller.signal.throwIfAborted();uncertainCalls.add(signature);output={isError:true,content:[{type:'text',text:'Tool failed; its outcome may be uncertain. Do not repeat it.'}]}}
                if(!current()) return {text:text.trim(),tools,reason:'cancelled',...usageFields()}
                const blocks=output?.content ?? []
                const toolText=blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n').slice(0,65536)
                toolBytes+=Buffer.byteLength(toolText)
                if(toolBytes>256*1024) throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'},'Tool context exceeded its safe limit. Ask a follow-up.'))
                messages.push({role:'tool',tool_call_id:call.id,content:toolText || 'Tool completed.'})
                const images=blocks.filter(block=>block.type==='image')
                if(images.length) {
                  imageBytes+=images.reduce((total,image)=>total+(typeof image.data==='string' ? image.data.length : 0),0)
                  if(imageBytes>4*1024*1024 || capability(info,'vision')!==true || !validContent(images)) throw new AIProviderError(aiError('invalid-request',{providerId:'openrouter'},'The tool image is unsupported or too large.'))
                  messages.push({role:'user',content:content(images)})
                }
              }
              continue
            }
          }
          if(reason==='max-tokens') {
            const note=(text ? '\n' : '')+'Output limit reached. Ask me to continue.'
            text+=note;emit({type:'text',delta:note})
          } else if(reason==='refused' && !text.trim()) {
            text='The selected model declined this request.';emit({type:'text',delta:text})
          }
          if(!text.trim()) throw new AIProviderError(aiError('unavailable',{providerId:'openrouter'},'The model completed without an answer. Try another model or rephrase your request.'))
          const answer={text:text.trim(),tools,reason,...usageFields()}
          emit({type:'done',text:answer.text,reason,...usageFields()})
          return answer
        }
      } catch(error) {
        if(cancelled || turn.signal.aborted || !turn.current()) return {text:text.trim(),tools,reason:'cancelled',...usageFields()}
        const normalized=error instanceof AIProviderError ? error.toJSON() : routerError(controller.signal.aborted ? controller.signal.reason : error)
        // A provider timeout aborts its stream, but still delivers one safe terminal error.
        if(turn.current()) handlers.onEvent({type:'error',error:normalized})
        return {text:text.trim(),tools,reason:'error',error:normalized,...usageFields()}
      } finally {
        finished=true; key=undefined; clearTimeout(timer); controller.abort()
        turn.signal.removeEventListener('abort',abort); seenCalls.clear(); uncertainCalls.clear()
      }
    })()
    return {result,cancel(){cancelled=true;abort();return started ? 'request-abort-requested' : 'not-started'}}
  }
  return {historyMode:'messages',describe:()=>info,start,generate:(request,handlers,turn)=>start(request,handlers,turn).result}
}
