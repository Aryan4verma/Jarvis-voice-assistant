/** One latest interaction, no transcript/history retention and no monitoring timer. */
export type TimingEvent = 'wake' | 'listening' | 'speechEnd' | 'stt' | 'aiStart' | 'firstToken' | 'ttsAudio' | 'complete'
export type Timing = { turnId?: string; status: string; marks: Partial<Record<TimingEvent, number>> }
let current: Timing = { status: 'idle', marks: {} }
const listeners = new Set<() => void>()
const publish = () => { current = { ...current, marks: { ...current.marks } }; listeners.forEach(fn => fn()) }
export const timingSnapshot = () => current
export const watchTiming = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function beginListening(wake = false, now = performance.now()) { current = { status: 'listening', marks: { ...(wake ? { wake: now } : {}), listening: now } }; publish() }
export function beginTiming(turnId: string, source: 'typed' | 'voice', now = performance.now()) {
  current = { turnId, status: 'active', marks: { ...(source === 'voice' && current.status === 'listening' ? current.marks : {}), aiStart: now } }; publish()
}
export function markTiming(event: TimingEvent, turnId?: string, now = performance.now()) {
  if (turnId ? current.turnId !== turnId || current.status !== 'active' : current.status !== 'listening') return
  if (current.marks[event] !== undefined) return
  current.marks[event] = now; if (event === 'complete') current.status = 'complete'; publish()
}
export function cancelTiming(turnId?: string) { if (turnId && current.turnId !== turnId) return; current.status = 'cancelled'; publish() }
export function timingDurations(value: Timing = current) {
  const m = value.marks
  const difference = (end: TimingEvent, start: TimingEvent) => m[end] !== undefined && m[start] !== undefined ? Math.max(0, Math.round(m[end]! - m[start]!)) : null
  return { wakeToListen: difference('listening', 'wake'), stt: difference('stt', 'speechEnd'), firstToken: difference('firstToken', 'aiStart'), ttsAudio: difference('ttsAudio', 'firstToken'), total: difference('complete', 'aiStart') }
}
