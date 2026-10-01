import { Porcupine, BuiltInKeyword } from '@picovoice/porcupine-web'
let engine: Porcupine | null = null
let processingEpoch = 0
// One worker, one in-flight frame. Never send SDK exception objects or credential data back.
self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === 'init') {
      engine = await Porcupine.create(event.data.key, { builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 },
        () => self.postMessage({ type: 'wake', epoch: processingEpoch }),
        { publicPath: 'https://raw.githubusercontent.com/Picovoice/porcupine/v4.0/lib/common/porcupine_params.pv', customWritePath: 'jarvis-porcupine-v4', version: 4 },
        { device: 'cpu:1', processErrorCallback: () => self.postMessage({ type: 'failed' }) })
      event.data.key = undefined
      self.postMessage({ type: 'ready', frameLength: engine.frameLength, sampleRate: engine.sampleRate })
    } else if (event.data.type === 'frame' && engine) {
      processingEpoch = event.data.epoch
      await engine.process(event.data.pcm); self.postMessage({ type: 'ack' })
    }
  } catch { self.postMessage({ type: 'failed' }) }
}
