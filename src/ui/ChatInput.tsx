import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { submitTyped } from '../lib/chat'
import { getSettings, readinessLabel, watchSettings, type AISettings as Settings } from '../lib/settings'
import { AISettings } from './AISettings'

export function ChatInput({ respond, onStop, onVoice }: {
  respond: (text: string, source: 'typed') => Promise<void>; onStop: () => void; onVoice: () => void
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const phase = useStore(s => s.phase)
  const busy = ['thinking', 'tooling', 'speaking'].includes(phase)
  useEffect(() => {
    const unsubscribe = watchSettings(setSettings), controller = new AbortController()
    void getSettings(controller.signal).catch(() => {}) // One local read; no provider polling.
    return () => { controller.abort(); unsubscribe() }
  }, [])
  return <>
    <form className="chat-input" onSubmit={e => {
      e.preventDefault()
      try { if (submitTyped(text, respond)) setText('') } catch (error) { useStore.getState().setError((error as Error).message) }
    }}>
      <div className="chat-controls"><label htmlFor="typed-message">Message JARVIS</label><button type="button" onClick={() => setOpen(true)}>AI Settings</button><button type="button" onClick={onVoice} disabled={phase === 'boot' || busy}>Enable voice</button></div>
      <div className="chat-send"><input id="typed-message" value={text} autoComplete="off" placeholder="Type a message…" maxLength={32768} disabled={phase === 'boot'} onChange={e => setText(e.target.value)} /><button type="submit" disabled={!text.trim() || phase === 'boot'}>Send</button>{busy && <button type="button" onClick={onStop}>STOP</button>}</div>
      <small role="status">{readinessLabel(settings)}</small>
    </form>
    {open && <AISettings onClose={() => setOpen(false)} />}
  </>
}
