import { getMic, inputContext } from './audio'

export type ClapListener = { stop: () => void }
export const DOUBLE_CLAP = { minimumMs: 180, maximumMs: 900, sampleMs: 10 }
export const diag = { listening: false, claps: 0, lastPeak: 0, rejected: '' }
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__clap = diag

/** Sharp transient + rapid decay, followed by a second distinct clap. No audio retention. */
export function createClapDetector(onDouble: () => void) {
  const history: number[] = []
  let floor = 0.01, lastClap = -Infinity, firstClap: number | null = null, stopped = false
  let candidate: { at: number; peak: number } | null = null
  return {
    stop() { stopped = true; candidate = null; history.length = 0; firstClap = null },
    sample(level: number, now: number, crest = 3) {
      if (stopped || !Number.isFinite(level)) return
      const before = history.at(-5), previous = history.at(-1)
      history.push(level); if (history.length > 16) history.shift()
      if (firstClap !== null && now - firstClap > DOUBLE_CLAP.maximumMs) firstClap = null
      if (!candidate && level < floor * 3) floor = Math.max(0.002, floor + (level - floor) * 0.05)
      if (candidate) {
        if (level < candidate.peak * 0.35 && now - candidate.at < 130) {
          candidate = null; lastClap = now; diag.claps++; diag.rejected = ''
          if (firstClap !== null && now - firstClap >= DOUBLE_CLAP.minimumMs && now - firstClap <= DOUBLE_CLAP.maximumMs) {
            stopped = true; onDouble()
          } else if (firstClap === null || now - firstClap >= DOUBLE_CLAP.minimumMs) firstClap = now
        } else if (now - candidate.at > 260) { candidate = null; firstClap = null; diag.rejected = 'sustained sound' }
        else candidate.peak = Math.max(candidate.peak, level)
        return
      }
      if (now - lastClap < 120 || level < 0.055 || level < floor * 7) return
      // The shared 16 kHz analyser spans 32 ms: a clap may enter across two
      // samples. Allow that short ramp while still rejecting sustained energy.
      if (before === undefined || before > level * 0.16 || (previous ?? 0) > level * 0.7 || crest < 2) { diag.rejected = 'not a sharp isolated transient'; return }
      diag.lastPeak = level; candidate = { at: now, peak: level }
    },
  }
}
/** Only the ignition gate owns this listener. The voice pipeline takes over the same stream. */
export async function listenForClap(onDouble: () => void, signal?: AbortSignal): Promise<ClapListener> {
  const stream = await getMic(); signal?.throwIfAborted()
  const ctx = inputContext(), source = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser()
  analyser.fftSize = 512; analyser.smoothingTimeConstant = 0; source.connect(analyser)
  const buffer = new Float32Array(analyser.fftSize)
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => { if (stopped) return; stopped = true; diag.listening = false; detector.stop(); if (timer) clearTimeout(timer); source.disconnect(); analyser.disconnect(); signal?.removeEventListener('abort', stop) }
  const detector = createClapDetector(() => { stop(); onDouble() })
  const tick = () => {
    timer = null; if (stopped) return
    if (!document.hidden && ctx.state === 'running') {
      analyser.getFloatTimeDomainData(buffer)
      let sum = 0, peak = 0
      for (const value of buffer) { sum += value * value; peak = Math.max(peak, Math.abs(value)) }
      const rms = Math.sqrt(sum / buffer.length); detector.sample(rms, performance.now(), peak / Math.max(rms, 0.0001))
    }
    if (!stopped) timer = setTimeout(tick, document.hidden || ctx.state !== 'running' ? 500 : DOUBLE_CLAP.sampleMs)
  }
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
  else { diag.listening = true; tick() }
  return { stop }
}
