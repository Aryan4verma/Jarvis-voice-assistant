import { useEffect, useRef, useState } from 'react'
import { deleteKey, getModels, getSettings, saveKey, saveSettings, testConnection, readinessLabel, PROVIDER_NAMES,
  type AIMode, type AIPreferences, type AISettings as Settings, type Model, type ProviderId } from '../lib/settings'
import { filterModels, isFreeModel } from '../lib/modelFilter'

const MODES: AIMode[] = ['fast', 'balanced', 'deep']
const IDS: ProviderId[] = ['openrouter', 'openai', 'gemini', 'claude-agent']
const emptyModels = () => ({ fast: '', balanced: '', deep: '' })
export function AISettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), lifetime = useRef(new AbortController())
  const drafts = useRef<Partial<Record<ProviderId, AIPreferences>>>({})
  const [settings, setSettings] = useState<Settings | null>(null), [draft, setDraft] = useState<AIPreferences | null>(null)
  const [key, setKey] = useState(''), [models, setModels] = useState<Model[]>([])
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  useEffect(() => {
    lifetime.current = new AbortController(); dialog.current?.showModal()
    const signal = lifetime.current.signal
    void getSettings(signal).then(value => { if (!signal.aborted) { setSettings(value); setDraft({ providerId: value.providerId, mode: value.mode, models: { ...value.models } }) } }).catch(error => { if (!signal.aborted) setMessage(error.message) })
    return () => lifetime.current.abort()
  }, [])
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setMessage('')
    try { await action() } catch (error) { if (!lifetime.current.signal.aborted) setMessage(error instanceof Error ? error.message : 'Settings request failed.') }
    finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  const signal = () => lifetime.current.signal
  const switchTo = (id: ProviderId) => {
    if (!draft || !settings) return
    drafts.current[draft.providerId] = draft
    const profile = drafts.current[id] ?? settings.profiles?.[id] ?? { mode: 'balanced' as AIMode, models: emptyModels() }
    setDraft({ ...profile, providerId: id }); setModels([]); setKey(''); setMessage('Choose models and save to activate this provider.')
  }
  const slot = draft && settings?.providers?.[draft.providerId]
  const configured = slot?.configured ?? (settings?.providerId === draft?.providerId && settings?.keyConfigured)
  const supported = slot?.storageSupported ?? settings?.storageSupported
  return <dialog className="ai-settings" ref={dialog} onCancel={onClose} aria-labelledby="ai-settings-title">
    <div className="ai-settings-heading"><div><small>SECURE LOCAL CONFIGURATION</small><h2 id="ai-settings-title">AI Settings</h2></div><button onClick={onClose} aria-label="Close AI settings">Close</button></div>
    {draft && settings && <>
      <fieldset className="provider-picker" disabled={busy}><legend>AI PROVIDER</legend>
        {IDS.map(id => <button type="button" key={id} aria-pressed={draft.providerId === id} onClick={() => switchTo(id)}>
          <strong>{PROVIDER_NAMES[id]}</strong><small>{id === 'claude-agent' ? 'Existing login' : settings.providers?.[id]?.configured ? 'Key configured' : 'Not configured'}</small>
        </button>)}
      </fieldset>
      <p>Selected: <strong>{PROVIDER_NAMES[draft.providerId]}</strong> · Active: {PROVIDER_NAMES[settings.providerId]}</p>
      {draft.providerId !== 'claude-agent' ? <>
        <div className="provider-key"><p>{configured ? '✓ Securely configured · stored key never displayed' : 'No key configured'}</p>
          {!supported && <p>Windows protected storage unavailable. Claude Agent remains available.</p>}
          <label>{PROVIDER_NAMES[draft.providerId]} API key<input type="password" autoComplete="new-password" spellCheck={false} value={key} maxLength={512} onChange={e => setKey(e.target.value)} placeholder={configured ? 'Paste replacement key' : 'Paste a new key'} disabled={busy || !supported} /></label>
          <div className="ai-actions"><button disabled={busy || !key.trim() || !supported} onClick={() => void run(async () => {
            const input = key.trim(); setKey(''); setSettings(await saveKey(input, signal(), draft.providerId)); setMessage('Key protected for your Windows user.')
          })}>{configured ? 'Replace Key' : 'Save Key'}</button>
          <button disabled={busy || !configured} onClick={() => void run(async () => { setKey(''); setSettings(await deleteKey(signal(), draft.providerId)); setMessage('Selected provider key deleted. Other slots preserved.') })}>Delete Key</button></div>
        </div>
        <label>MODE<select value={draft.mode} disabled={busy} onChange={e => setDraft({ ...draft, mode: e.target.value as AIMode })}>{MODES.map(mode => <option key={mode} value={mode}>{mode.toUpperCase()}</option>)}</select></label>
        <p>FAST for everyday commands, BALANCED for normal use, DEEP for complex requests. Blank FAST/DEEP mappings use BALANCED.</p>
        <button disabled={busy || draft.providerId !== 'openrouter' && !configured} onClick={() => void run(async () => { setModels(await getModels(signal(), draft.providerId)); setMessage('Catalog loaded on request. Manual IDs remain available.') })}>Load model catalog</button>
        {draft.providerId === 'openrouter' && <button disabled={busy} onClick={() => setDraft({ ...draft, models: { ...draft.models, [draft.mode]: 'openrouter/free' } })}>Use OpenRouter Free Router</button>}
        <ModelSearch key={draft.providerId} provider={draft.providerId} models={models} onChoose={modelId => setDraft({ ...draft, models: { ...draft.models, [draft.mode]: modelId } })} />
        {MODES.map(mode => {
          const id = draft.models[mode] || draft.models.balanced
          const model = models.find(value => value.modelId === id) || (settings.model?.providerId === draft.providerId && settings.model.modelId === id ? settings.model : null)
          const support = (name: 'vision' | 'toolCalling' | 'streaming') => model?.capabilities[name] === true ? '✓' : model?.capabilities[name] === false ? '—' : 'unknown'
          return <div className="model-mapping" key={mode}><label>{mode.toUpperCase()} model ID<input value={draft.models[mode]} disabled={busy} placeholder={mode === 'balanced' ? 'Manual model ID or select above' : 'Uses BALANCED when blank'} maxLength={192} onChange={e => setDraft({ ...draft, models: { ...draft.models, [mode]: e.target.value.trim() } })} /></label>
            <small>Vision {support('vision')} · Tools {support('toolCalling')} · Streaming {support('streaming')}{model && isFreeModel(model) ? ' · FREE' : model?.inputPrice !== undefined ? ` · $${model.inputPrice}/M input` : ''}</small></div>
        })}
        <p>Unknown model capabilities stay unknown. Native APIs do not list all capabilities; documented general chat families are supported. Specialty models may reject this chat API. No automatic provider or paid fallback.</p>
      </> : <p>Uses the existing Claude Agent SDK, login and MCP tools. JARVIS_MODEL remains configured on the backend.</p>}
      <div className="ai-actions"><button disabled={busy} onClick={() => void run(async () => { setSettings(await saveSettings(draft, signal())); drafts.current[draft.providerId] = draft; setMessage('Provider activated. Any active generation was cancelled.') })}>Save AI Settings</button>
        <button disabled={busy || draft.providerId === 'claude-agent' || !configured} onClick={() => void run(async () => {
          setSettings(await saveSettings(draft, signal())); const value = await testConnection(signal(), draft.providerId); setSettings(value)
          setMessage(value.error ? value.error.message : 'Key/model metadata checked without paid inference. Actual generation validates response capabilities.')
        })}>Test Connection</button></div>
      <p role="status">{readinessLabel(settings)}</p>
      <small>Keys use separate Windows CurrentUser DPAPI slots outside the repository. Provider switching preserves other saved keys and model mappings.</small>
    </>}
    <p role="status">{busy ? 'Working…' : message}</p>
  </dialog>
}
function ModelSearch({ models, provider, onChoose }: { models: Model[]; provider: ProviderId; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState(''), [free, setFree] = useState(false), [vision, setVision] = useState(false), [tools, setTools] = useState(false)
  const matches = filterModels(models, query, free, vision, tools)
  return <div className="model-search"><label>Search models<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or model ID" /></label>
    <div className="model-filters">{provider === 'openrouter' && <label><input type="checkbox" checked={free} onChange={e => setFree(e.target.checked)} />Free only</label>}
      <label><input type="checkbox" checked={vision} onChange={e => setVision(e.target.checked)} />Vision</label><label><input type="checkbox" checked={tools} onChange={e => setTools(e.target.checked)} />Tools</label></div>
    <select aria-label="Matching models (sets current mode)" value="" onChange={e => { if (e.target.value) onChoose(e.target.value) }}>
      <option value="">{models.length ? `${matches.length} shown · choose a model` : 'Load a catalog or enter a model ID below'}</option>{matches.map(model => <option key={model.modelId} value={model.modelId}>{isFreeModel(model) ? 'FREE · ' : ''}{model.name} — {model.modelId}</option>)}
    </select></div>
}
