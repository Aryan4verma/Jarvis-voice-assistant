/** Global startup presentation is independent of primary AI turn ownership. */
export type StartupSystem = 'bridge' | 'ai' | 'audio' | 'voice' | 'graphics' | 'tools' | 'integrity'
export type Startup = { active: boolean; source: 'manual' | 'clap'; startedAt: number; systems: Record<StartupSystem, string> }
const initial = () => ({ bridge: 'CHECKING', ai: 'NOT CONFIGURED', audio: 'CHECKING', voice: 'INITIALIZING', graphics: 'STANDBY', tools: 'STANDBY', integrity: 'CHECKING' })
let state: Startup = { active: false, source: 'manual', startedAt: 0, systems: initial() }
const listeners = new Set<() => void>()
export const startupSnapshot = () => state
export const watchStartup = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const publish = () => listeners.forEach(fn => fn())
export function beginStartup(source: Startup['source'], now = performance.now()) { state = { active: true, source, startedAt: now, systems: initial() }; publish() }
export function startupStatus(system: StartupSystem, value: string) { state = { ...state, systems: { ...state.systems, [system]: value } }; publish() }
export function finishStartup() { state = { ...state, active: false }; publish() }
export function aiStartupStatus(value: { providerId: string; keyConfigured: boolean; modelId: string; readiness: string; error: unknown } | null) {
  if (!value) return 'UNAVAILABLE'
  if (value.error) return 'UNAVAILABLE'
  if (value.providerId === 'claude-agent') return value.readiness === 'ready' ? 'READY' : 'LOGIN ON REQUEST'
  if (!value.keyConfigured || !value.modelId) return 'NOT CONFIGURED'
  return value.readiness === 'ready' ? 'READY' : 'CONFIGURED'
}
