import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { listenForClap, type ClapListener } from '../lib/clap'
import { inputContext } from '../lib/audio'
import * as sfx from '../lib/sfx'

export function Ignition({ onStart }: { onStart: (source?: 'manual' | 'clap') => void }) {
  const phase = useStore(s => s.phase)
  const start = useRef(onStart); start.current = onStart
  const pending = useRef(false)
  const listener = useRef<ClapListener | null>(null), lifetime = useRef(new AbortController())
  const [status, setStatus] = useState('Click once to authorize double-clap activation. Browser permission is required.'), [arming, setArming] = useState(false)
  const arm = useCallback(async () => {
    if (pending.current || listener.current || useStore.getState().phase !== 'offline') return
    pending.current = true; setArming(true); const signal = lifetime.current.signal
    try {
      const result = await listenForClap(() => { listener.current = null; start.current('clap') }, signal)
      if (signal.aborted || useStore.getState().phase !== 'offline') result.stop()
      else { listener.current = result; setStatus(inputContext().state === 'running' ? 'DOUBLE-CLAP ARMED · two sharp claps within 0.9 seconds' : 'Microphone granted. Click Enable double-clap to unlock browser audio analysis.') }
    } catch { if (!signal.aborted) setStatus('Double-clap unavailable. Check microphone permission or use INITIALISE / Space.') }
    finally { pending.current = false; if (!signal.aborted) setArming(false) }
  }, [])
  useEffect(() => {
    if (phase !== 'offline') return
    lifetime.current = new AbortController(); const signal = lifetime.current.signal
    // Permission query never prompts. First-time authorization remains a click.
    void navigator.permissions?.query({ name: 'microphone' as PermissionName }).then(permission => { if (permission.state === 'granted' && !signal.aborted) void arm() }).catch(() => {})
    const unsubscribe = useStore.subscribe(state => { if (state.phase !== 'offline') { lifetime.current.abort(); listener.current?.stop(); listener.current = null } })
    return () => { lifetime.current.abort(); listener.current?.stop(); listener.current = null; unsubscribe() }
  }, [phase, arm])
  if (phase !== 'offline') return null
  return <div className="ignition"><button className="ignition-start" onClick={() => onStart('manual')}><span className="ignition-ring" /><span className="ignition-label"><span className="ignition-word">INITIALISE</span><span className="ignition-sub">click or press Space to power up</span></span></button>
    <div className="clap-gate"><p role="status">{status}</p><button disabled={arming} onClick={() => { void sfx.unlockAudio(); listener.current?.stop(); listener.current = null; void inputContext().resume().catch(() => {}); void arm() }}>Enable double-clap</button><small>Microphone permission does not grant autoplay permission. A click may still be needed for sound.</small></div>
  </div>
}
