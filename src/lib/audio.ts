/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null

let opening: Promise<MediaStream> | null = null
let analysing: Promise<void> | null = null
let generation = 0
export async function getMic(): Promise<MediaStream> {
  if (stream?.getAudioTracks().some(track => track.readyState === 'live')) return stream
  if (opening) return opening
  const epoch = generation
  const pending = navigator.mediaDevices.getUserMedia({ audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } }).then(value => {
    if (epoch !== generation) { value.getTracks().forEach(track => track.stop()); throw new Error('Microphone initialization cancelled.') }
    stream = value; return value
  })
  opening = pending
  try { return await pending } finally { if (opening === pending) opening = null }
}
/** Shared input context; the browser resamples the mic for the wake engine. */
export function inputContext(): AudioContext {
  if (!ctx) { try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() } }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}
export function stopAudio() {
  generation++; opening = null; analysing = null
  stream?.getTracks().forEach(track => track.stop()); stream = null
  if (ctx) void ctx.close().catch(() => {})
  ctx = null; analyser = null; buf = null
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  if (analysing) return analysing
  const epoch = generation
  const pending = (async () => {
    const s = await getMic()
    if (epoch !== generation) throw new Error('Microphone analysis initialization cancelled.')
    const c = inputContext()
    const src = c.createMediaStreamSource(s)
    analyser = c.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    src.connect(analyser)
    buf = new Uint8Array(analyser.frequencyBinCount)
  })()
  analysing = pending
  try { await pending } finally { if (analysing === pending) analysing = null }
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
