import { useEffect, useRef, useState } from 'react'
import { deleteKey, getModels, getSettings, saveKey, saveSettings, testConnection, readinessLabel,
  type AIMode, type AIPreferences, type AISettings as Settings, type Model } from '../lib/settings'

const MODES: AIMode[] = ['fast', 'balanced', 'deep']
export function AISettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lifetime = useRef(new AbortController())
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<AIPreferences | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<Model[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const update = (value: Settings, reset = true) => {
    setSettings(value); if (reset) setDraft({ providerId: value.providerId, mode: value.mode, models: { ...value.models } })
  }
  useEffect(() => {
    lifetime.current = new AbortController()
    const signal = lifetime.current.signal
    dialog.current?.showModal()
    void getSettings(signal).then(value => { if (!signal.aborted) update(value) }).catch(error => { if (!signal.aborted) setMessage(error.message) })
    return () => { lifetime.current.abort() }
  }, [])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setMessage('')
    try { await action() } catch (error) { if (!lifetime.current.signal.aborted) setMessage(error instanceof Error ? error.message : 'Settings request failed.') }
    finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  const signal = () => lifetime.current.signal
  return <dialog className="ai-settings" ref={dialog} onCancel={onClose} aria-labelledby="ai-settings-title">
    <div className="ai-settings-heading"><h2 id="ai-settings-title">AI Settings</h2><button onClick={onClose} aria-label="Close AI settings">Close</button></div>
    {draft && settings && <>
      <label>AI Provider<select value={draft.providerId} disabled={busy} onChange={e => setDraft({ ...draft, providerId: e.target.value as AIPreferences['providerId'] })}>
        <option value="openrouter">OpenRouter</option><option value="claude-agent">Claude Agent (existing login)</option>
      </select></label>
      {draft.providerId === 'openrouter' ? <>
        <p>{settings.keyConfigured ? 'Key configured. The stored key is never displayed.' : 'No key configured.'}</p>
        {!settings.storageSupported && <p>Windows protected storage is unavailable. Claude Agent remains available.</p>}
        <label>OpenRouter API key<input type="password" autoComplete="off" spellCheck={false} value={key} maxLength={512} onChange={e => setKey(e.target.value)} placeholder="Paste a new key" disabled={busy || !settings.storageSupported} /></label>
        <div className="ai-actions">
          <button disabled={busy || !key.trim() || !settings.storageSupported} onClick={() => void run(async () => {
            const input = key.trim(); setKey('')
            update(await saveKey(input, signal()), false); setMessage('Key saved using Windows user protection.')
          })}>{settings.keyConfigured ? 'Replace Key' : 'Save Key'}</button>
          <button disabled={busy || !settings.keyConfigured} onClick={() => void run(async () => { setKey(''); update(await deleteKey(signal()), false); setMessage('Key deleted.') })}>Delete Key</button>
        </div>
        <label>Mode<select value={draft.mode} disabled={busy} onChange={e => setDraft({ ...draft, mode: e.target.value as AIMode })}>
          {MODES.map(mode => <option key={mode} value={mode}>{mode.toUpperCase()}</option>)}
        </select></label>
        <p>FAST: everyday commands. BALANCED: default. DEEP: complex reasoning. Choose your own model mappings; blank FAST/DEEP use BALANCED.</p>
        <button disabled={busy} onClick={() => void run(async () => { setModels(await getModels(signal())); setMessage('Model catalog loaded. Type a name or ID in the search field.') })}>Load / refresh model catalog</button>
        <ModelSearch models={models} onChoose={modelId => setDraft({ ...draft, models: { ...draft.models, [draft.mode]: modelId } })} />
        {MODES.map(mode => {
          const id = draft.models[mode] || draft.models.balanced
          const model = models.find(value => value.modelId === id) || (settings.model?.modelId === id ? settings.model : null)
          const support = (name: 'vision' | 'toolCalling' | 'reasoningControls') => model?.capabilities[name] === true ? 'yes' : model?.capabilities[name] === false ? 'no' : 'unknown'
          return <div key={mode}><label>{mode.toUpperCase()} model ID<input value={draft.models[mode]} disabled={busy} placeholder={mode === 'balanced' ? 'provider/model-id' : 'Uses BALANCED when blank'} maxLength={192} onChange={e => setDraft({ ...draft, models: { ...draft.models, [mode]: e.target.value.trim() } })} /></label>
            <small>Vision: {support('vision')} · Tools: {support('toolCalling')} · Reasoning controls: {support('reasoningControls')}{model?.inputPrice !== undefined && ` · $${model.inputPrice}/M input tokens`}</small></div>
        })}
        <p>OpenRouter currently uses JARVIS display, interface and supported camera tools. Claude Agent retains its existing agent/MCP tools.</p>
      </> : <p>Uses the existing Claude Agent SDK and Claude login. Its model remains configured by JARVIS_MODEL on the backend.</p>}
      <div className="ai-actions">
        <button disabled={busy} onClick={() => void run(async () => { update(await saveSettings(draft, signal())); setMessage('AI settings saved. Active generation was cancelled.') })}>Save AI Settings</button>
        <button disabled={busy || draft.providerId !== 'openrouter' || !settings.keyConfigured} onClick={() => void run(async () => {
          await saveSettings(draft, signal()); update(await testConnection(signal())); setMessage('Connection checked without generating a paid AI response.')
        })}>Test Connection</button>
      </div>
      <p role="status">{readinessLabel(settings)}</p>
    </>}
    <p role="status">{busy ? 'Working…' : message}</p>
  </dialog>
}

function ModelSearch({ models, onChoose }: { models: Model[]; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState('')
  if (!models.length) return null
  const matches = models.filter(model => `${model.name} ${model.modelId}`.toLowerCase().includes(query.toLowerCase())).slice(0, 30)
  return <div><label>Search models<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or model ID" /></label>
    <select aria-label="Matching models (sets current mode)" value="" onChange={e => { if (e.target.value) onChoose(e.target.value) }}>
      <option value="">Choose a model for the current mode</option>{matches.map(model => <option key={model.modelId} value={model.modelId}>{model.name} — {model.modelId}</option>)}
    </select></div>
}
