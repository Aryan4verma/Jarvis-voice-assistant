import { getMic, inputContext } from './audio'
import { wakeCredential } from './voiceSettings'
export type WakeDetector = { stop: () => void; sync: () => void }
/** Opt-in local detector using the existing mic, one CPU thread and a bounded PCM channel. */
export async function startWake(active: () => boolean, detected: () => void, failed: () => void, signal: AbortSignal): Promise<WakeDetector> {
  const ctx = inputContext()
  let worker: Worker | null = null, node: AudioWorkletNode | null = null, source: MediaStreamAudioSourceNode | null = null
  let enabled = false, stopped = false, epoch = 0
  const stop = () => {
    if (stopped) return; stopped = true; signal.removeEventListener('abort', stop)
    if (node) { node.port.onmessage = null; node.disconnect(); node.port.close() }
    source?.disconnect(); worker?.terminate()
  }
  try {
    if (ctx.sampleRate !== 16000 || !ctx.audioWorklet) throw new Error('Wake audio unavailable')
    let key: string | undefined = await wakeCredential(signal)
    signal.throwIfAborted()
    worker = new Worker(new URL('./wake-worker.ts', import.meta.url), { type: 'module' })
    const ready = new Promise<{ frameLength: number; sampleRate: number }>((resolve, reject) => {
      const timeout = setTimeout(() => { signal.removeEventListener('abort', abort); reject(new Error('Wake initialization timeout')) }, 15000)
      const abort = () => { clearTimeout(timeout); reject(new Error('Wake initialization cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      worker!.onerror = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); reject(new Error('Wake initialization failed')) }
      worker!.onmessage = e => { clearTimeout(timeout); signal.removeEventListener('abort', abort); if (e.data.type === 'ready') resolve(e.data); else reject(new Error('Wake initialization failed')) }
      worker!.postMessage({ type: 'init', key }); key = undefined
    })
    const format = await ready
    signal.throwIfAborted()
    if (format.sampleRate !== ctx.sampleRate || format.frameLength !== 512) throw new Error('Unsupported wake audio format')
    await ctx.audioWorklet.addModule('/wake-audio.js')
    signal.throwIfAborted()
    node = new AudioWorkletNode(ctx, 'jarvis-wake-audio', { processorOptions: { frameLength: format.frameLength } })
    const stream = await getMic(); signal.throwIfAborted()
    source = ctx.createMediaStreamSource(stream); source.connect(node)
    // An unconnected worklet is culled by some browsers. Its output is silence.
    node.connect(ctx.destination)
    worker.onmessage = e => {
      if (stopped) return
      if (e.data.type === 'ack') node?.port.postMessage({ ack: true })
      else if (e.data.type === 'wake' && active() && e.data.epoch === epoch) detected()
      else if (e.data.type === 'failed') { stop(); failed() }
    }
    worker.onerror = () => { stop(); failed() }
    node.port.onmessage = e => { if (!stopped && active() && e.data.epoch === epoch) worker?.postMessage({ type: 'frame', pcm: e.data.pcm, epoch }); else node?.port.postMessage({ ack: true }) }
    const sync = () => { const value = active(); if (value !== enabled) { enabled = value; node?.port.postMessage({ enabled, epoch: ++epoch }) } }
    signal.addEventListener('abort', stop, { once: true }); sync()
    return { stop, sync }
  } catch (error) { stop(); throw error }
}
