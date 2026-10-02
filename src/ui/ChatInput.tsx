import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { submitTyped } from '../lib/chat'
import { getSettings, readinessLabel, watchSettings, type AISettings as Settings } from '../lib/settings'
import { AISettings } from './AISettings'
import { VoiceSettings } from './VoiceSettings'
import { startupSnapshot, watchStartup } from '../lib/startup'

export function ChatInput({ respond, onStop, onVoice, onVoiceChanged, onAudio }: {
  onVoiceChanged: () => void; respond: (text: string, source: 'typed') => Promise<void>; onStop: () => void; onVoice: () => void; onAudio: () => void
}) {
  const [text, setText] = useState('')
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const phase = useStore(s => s.phase)
  const startup = useSyncExternalStore(watchStartup, startupSnapshot, startupSnapshot)
  const voiceStatus = phase === 'listening' ? 'LISTENING' : startup.systems.voice
  const retryVoice = phase !== 'offline' && ['MIC BLOCKED', 'VOICE UNAVAILABLE'].includes(startup.systems.voice)
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
      <div className="chat-controls"><label htmlFor="typed-message">Message JARVIS</label><button type="button" onClick={() => setOpen(true)}>AI Settings</button><button type="button" onClick={() => setVoiceOpen(true)}>Voice Settings</button><span role="status">{phase === 'offline' ? 'VOICE STANDBY' : voiceStatus}</span>{retryVoice && <button type="button" onClick={onVoice} disabled={busy}>Retry voice</button>}{phase !== 'offline' && startup.systems.audio === 'GESTURE NEEDED' && <button type="button" onClick={onAudio}>Allow browser audio</button>}</div>
      <div className="chat-send"><input id="typed-message" value={text} autoComplete="off" placeholder="Type a message…" maxLength={32768} disabled={phase === 'boot'} onChange={e => setText(e.target.value)} /><button type="submit" disabled={!text.trim() || phase === 'boot'}>Send</button>{busy && <button type="button" onClick={onStop}>STOP</button>}</div>
      <small role="status">{readinessLabel(settings)}</small>
    </form>
    {voiceOpen && <VoiceSettings onClose={() => setVoiceOpen(false)} onChanged={onVoiceChanged} />}
    {open && <AISettings onClose={() => setOpen(false)} />}
  </>
}
