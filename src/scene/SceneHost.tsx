import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from '../store'
import { startupSnapshot, watchStartup, startupStatus } from '../lib/startup'
const LazyScene = lazy(() => import('./Scene').then(module => ({ default: module.Scene })))
function Standby() { return <div className="scene-standby" aria-hidden="true"><span /></div> }
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { startupStatus('graphics', 'UNAVAILABLE') }
  render() { return this.state.failed ? <><Standby /><span className="graphics-note">3D unavailable · chat and voice still work</span></> : this.props.children }
}
export function SceneHost() {
  const phase = useStore(s => s.phase)
  const startup = useSyncExternalStore(watchStartup, startupSnapshot)
  return <SceneBoundary>{phase === 'offline' || startup.active ? <Standby /> : <Suspense fallback={<Standby />}><LazyScene /></Suspense>}</SceneBoundary>
}
