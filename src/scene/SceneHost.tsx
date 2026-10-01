import { Component, lazy, Suspense, type ReactNode } from 'react'
import { useStore } from '../store'
const LazyScene = lazy(() => import('./Scene').then(module => ({ default: module.Scene })))
function Standby() { return <div className="scene-standby" aria-hidden="true"><span /></div> }
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <><Standby /><span className="graphics-note">3D unavailable · chat and voice still work</span></> : this.props.children }
}
export function SceneHost() {
  const phase = useStore(s => s.phase)
  return <SceneBoundary>{phase === 'offline' ? <Standby /> : <Suspense fallback={<Standby />}><LazyScene /></Suspense>}</SceneBoundary>
}
