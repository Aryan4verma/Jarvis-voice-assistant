import { useEffect, useState, useSyncExternalStore } from 'react'
import { finishStartup, startupSnapshot, watchStartup, type StartupSystem } from '../lib/startup'

const SYSTEMS: [StartupSystem, string][] = [['bridge', 'SECURE BRIDGE'], ['ai', 'AI PROVIDER'], ['audio', 'AUDIO SYSTEM'], ['voice', 'VOICE INTERFACE'], ['graphics', 'GRAPHICS CORE'], ['tools', 'TOOL SYSTEM'], ['integrity', 'SYSTEM INTEGRITY']]
/** Presentation only: bounded timeouts, no functional readiness wait or permanent animation clock. */
export function Boot() {
  const state = useSyncExternalStore(watchStartup, startupSnapshot), [shown, setShown] = useState(0), [exit, setExit] = useState(false)
  useEffect(() => {
    if (!state.active) return
    setShown(0); setExit(false)
    const timers = SYSTEMS.map((_, index) => setTimeout(() => setShown(index + 1), 320 + index * 260))
    timers.push(setTimeout(() => setExit(true), 2850), setTimeout(finishStartup, 3200))
    return () => timers.forEach(clearTimeout)
  }, [state.active, state.startedAt])
  if (!state.active) return null
  return <div className={`cinematic-boot ${exit ? 'boot-exit' : ''}`} role="status" aria-label="JARVIS cinematic startup">
    <div className="boot-terminal"><div className="boot-eyebrow">{state.source === 'clap' ? 'DOUBLE CLAP DETECTED' : 'STARTUP REQUEST ACCEPTED'} · ECO</div>
      <h1>J.A.R.V.I.S.</h1><p className="boot-confirm">&gt; WAKE SIGNAL CONFIRMED<br />&gt; INITIALIZING J.A.R.V.I.S.</p>
      <div className="boot-system-lines">{SYSTEMS.slice(0, shown).map(([id, label]) => <div className="boot-system-line" key={id}><span>&gt; {label}</span><span className="boot-leader" /><strong data-status={state.systems[id]}>{state.systems[id]}</strong></div>)}</div>
      <div className={`boot-online ${shown === SYSTEMS.length ? 'visible' : ''}`}>ONLINE <small>LOCAL INTERFACE · OPTIONAL SERVICES AS REPORTED ABOVE</small></div>
      <p className="boot-available">Voice and typed chat become available independently of this animation.</p>
      <button onClick={finishStartup}>Skip animation</button>
    </div><svg className="boot-reticle" viewBox="-160 -160 320 320" aria-hidden="true"><circle r="145" strokeDasharray="3 9" /><circle r="123" strokeDasharray="48 8 8 8" /><circle r="98" /><path d="M0,-64 L56,32 L-56,32 Z" /><path d="M-156,0 H-112 M112,0 H156 M0,-156 V-112 M0,112 V156" /></svg>
  </div>
}
