/* Shared microphone PCM framing. Worklet holds one frame; no accumulating audio queue. */
class JarvisWakeAudio extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.frame = new Int16Array(options.processorOptions.frameLength); this.index = 0; this.enabled = false; this.credit = true; this.epoch = 0
    this.port.onmessage = e => { if ('enabled' in e.data) { this.enabled = e.data.enabled; this.epoch = e.data.epoch; this.index = 0 } if (e.data.ack) this.credit = true }
  }
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (!this.enabled || !samples) return true
    for (let i = 0; i < samples.length; i++) {
      this.frame[this.index++] = Math.max(-32768, Math.min(32767, samples[i] * 32768))
      if (this.index === this.frame.length) {
        if (this.credit) { this.credit = false; this.port.postMessage({ pcm: this.frame.slice(), epoch: this.epoch }) }
        this.index = 0
      }
    }
    return true
  }
}
registerProcessor('jarvis-wake-audio', JarvisWakeAudio)
