import { useEffect, useRef, useState } from 'react'
import { voiceReplies, setVoiceReplies, voiceSetting, type VoiceReplies, type VoiceSettings as Settings } from '../lib/voiceSettings'
export function VoiceSettings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const controller = useRef(new AbortController())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [replies, setReplies] = useState(voiceReplies)
  const [keys, setKeys] = useState({ elevenlabs: '', picovoice: '' })
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  useEffect(() => {
    controller.current = new AbortController(); dialog.current?.showModal()
    void voiceSetting('settings', 'GET', undefined, controller.current.signal).then(setSettings).catch(() => setMessage('Bridge unavailable. System voice and typed chat remain available.'))
    return () => controller.current.abort()
  }, [])
  const change = async (purpose: 'elevenlabs' | 'picovoice', remove = false) => {
    if (busy) return
    const key = keys[purpose]; setKeys({ elevenlabs: '', picovoice: '' }); setBusy(true); setMessage('')
    try {
      const value = await voiceSetting(`${purpose}/key`, remove ? 'DELETE' : 'POST', remove ? undefined : key, controller.current.signal)
      if (!controller.current.signal.aborted) { setSettings(value); setMessage('Protected key updated. Voice input will restart if enabled.'); onChanged() }
    } catch (error) { if (!controller.current.signal.aborted) setMessage((error as Error).message) }
    finally { if (!controller.current.signal.aborted) setBusy(false) }
  }
  return <dialog className="ai-settings" ref={dialog} onCancel={onClose}>
    <div className="settings-heading"><h2>VOICE SETTINGS</h2><button onClick={onClose}>Close</button></div>
    <label>VOICE REPLIES<select value={replies} onChange={e => { const value = e.target.value as VoiceReplies; setReplies(value); setVoiceReplies(value) }}>
      <option value="always">Always</option><option value="voice">Voice requests only</option><option value="off">Off</option>
    </select></label>
    <p>System speech is the default. Space starts listening immediately after initialization.</p>
    {(['elevenlabs', 'picovoice'] as const).map(purpose => <fieldset key={purpose} disabled={busy || !settings?.supported}>
      <legend>{purpose === 'elevenlabs' ? 'ElevenLabs Scribe (optional cloud STT)' : 'Porcupine “Jarvis” wake word (optional)'}</legend>
      <p>{settings?.[purpose] ? 'Configured' : 'Not configured'}</p>
      <label>{purpose === 'picovoice' ? 'Picovoice AccessKey' : 'ElevenLabs API key'}<input type="password" autoComplete="new-password" value={keys[purpose]} onChange={e => setKeys({ ...keys, [purpose]: e.target.value })} /></label>
      <button disabled={!keys[purpose].trim()} onClick={() => void change(purpose)}>{settings?.[purpose] ? 'Replace Key' : 'Save Key'}</button>
      <button disabled={!settings?.[purpose]} onClick={() => void change(purpose, true)}>Delete Key</button>
    </fieldset>)}
    <p>Keys are encrypted for your Windows user outside the repository. Porcupine needs its AccessKey in its browser worker at runtime; it is never saved in browser storage. Its model downloads only when configured. Browser wake recognition is the fallback and may use the browser’s speech service.</p>
    <p role="status">{busy ? 'Working…' : message}</p>
  </dialog>
}
