import { join } from 'node:path'
import { AIProviderError, aiError } from '../shared/ai.mjs'
import { atomicUserWrite, privateDirectory, readBoundedFile, userDirectory } from './user-storage.mjs'
import { validModelId, routerError } from './providers/openrouter-client.mjs'
import { nativeModelId, nativeError } from './providers/native-client.mjs'

const MODES = ['fast', 'balanced', 'deep']
export const API_PROVIDERS = ['openrouter', 'openai', 'gemini']
const PROVIDERS = ['claude-agent', ...API_PROVIDERS]
const validModel = (provider, id) => provider === 'openai' || provider === 'gemini' ? nativeModelId(id) : validModelId(id)
const invalid = () => new AIProviderError(aiError('invalid-request', {}, 'Invalid AI settings. Choose a provider, mode and valid model IDs.'))
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'mode,models,providerId') throw invalid()
  if (!PROVIDERS.includes(value.providerId) || !MODES.includes(value.mode) || !value.models || Object.keys(value.models).sort().join(',') !== 'balanced,deep,fast') throw invalid()
  for (const mode of MODES) if (value.models[mode] !== '' && !validModel(value.providerId, value.models[mode])) throw invalid()
  return { providerId: value.providerId, mode: value.mode, models: Object.fromEntries(MODES.map(mode => [mode, value.models[mode]])) }
}

export async function createAISettings({ secrets, client, directory = join(userDirectory, 'settings'), claudeModel = 'claude-opus-5', providers = { openrouter: { secrets, client } } }) {
  const environmentProvider = process.env.JARVIS_AI_PROVIDER?.trim() || 'claude-agent'
  const environmentModels = id => Object.fromEntries(MODES.map(mode => [mode, process.env[`JARVIS_${id.toUpperCase()}_${mode.toUpperCase()}_MODEL`]?.trim() || '']))
  let settings = validateSettings({
    providerId: environmentProvider, mode: 'balanced', models: environmentModels(environmentProvider === 'claude-agent' ? 'openrouter' : environmentProvider),
  })
  let profiles = Object.fromEntries(API_PROVIDERS.map(id => [id, { mode: 'balanced', models: validateSettings({ providerId: id, mode: 'balanced', models: environmentModels(id) }).models }]))
  if (API_PROVIDERS.includes(settings.providerId)) profiles[settings.providerId] = { mode: settings.mode, models: { ...settings.models } }
  let storageIssue = null
  try {
    const path = join(await privateDirectory(directory), 'ai.json')
    const stored = JSON.parse((await readBoundedFile(path)).toString('utf8'))
    const { profiles: savedProfiles, ...active } = stored
    settings = validateSettings(active)
    if (savedProfiles !== undefined) {
      if (!savedProfiles || Object.keys(savedProfiles).sort().join(',') !== API_PROVIDERS.slice().sort().join(',')) throw invalid()
      for (const id of API_PROVIDERS) {
        const profile = savedProfiles[id]
        if (!profile || Object.keys(profile).sort().join(',') !== 'mode,models') throw invalid()
        const clean = validateSettings({ providerId: id, ...profile }); profiles[id] = { mode: clean.mode, models: clean.models }
      }
    }
    if (API_PROVIDERS.includes(settings.providerId)) profiles[settings.providerId] = { mode: settings.mode, models: settings.models }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Optional preferences must not prevent the existing Claude bridge booting.
      settings = { ...settings, providerId: 'claude-agent' }
      storageIssue = aiError('unavailable', {}, 'Saved AI settings could not be read. Claude defaults are active. Save AI Settings to repair preferences, or check Windows user storage.')
    }
  }
  let revision = 0, busy = false, readiness = storageIssue ? 'unavailable' : 'not-validated', lastError = storageIssue
  const listeners = new Set()
  const modelId = () => settings.models[settings.mode] || settings.models.balanced
  const provider = id => { if (!API_PROVIDERS.includes(id) || !providers[id]) throw invalid(); return providers[id] }
  const cloneProfiles = () => Object.fromEntries(API_PROVIDERS.map(id => [id, { ...profiles[id], models: { ...profiles[id].models } }]))
  const states = Object.fromEntries(API_PROVIDERS.map(id => [id, { readiness: 'not-validated', error: null }]))
  const publish = changed => { for (const listener of listeners) listener(changed) }
  const mutation = async action => {
    if (busy) throw new AIProviderError(aiError('unavailable', {}, 'Another settings change is in progress. Try again after it completes.'))
    busy = true
    try { await action(); revision++; readiness = 'not-validated'; lastError = null; publish(true) }
    finally { busy = false }
  }
  const report = (expected, error = null) => {
    if (expected !== revision) return
    lastError = error
    readiness = error ? ({ authentication: 'invalid-credentials', 'model-unavailable': 'model-unavailable', 'rate-limit': 'rate-limited', network: 'network-unavailable' }[error.category] || 'unavailable') : 'ready'
    if (states[settings.providerId]) states[settings.providerId] = { readiness, error: lastError }
    publish(false)
  }
  return {
    selection: () => ({ ...settings, models: { ...settings.models }, modelId: API_PROVIDERS.includes(settings.providerId) ? modelId() : claudeModel, revision }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async snapshot() {
      const expected = revision
      const flags = {}
      for (const id of API_PROVIDERS) {
        let configured = false
        try { configured = Boolean(await providers[id]?.secrets.configured()) } catch { /* report unlock failure on use */ }
        flags[id] = { configured, storageSupported: Boolean(providers[id]?.secrets.supported), ...states[id] }
      }
      // model() is a local metadata lookup; catalogs are fetched only by catalog().
      let model = null
      if (API_PROVIDERS.includes(settings.providerId) && modelId()) {
        try { model = await providers[settings.providerId]?.client.model(modelId()) ?? null } catch { /* invalid/unavailable metadata remains unknown */ }
      }
      if (expected !== revision) return this.snapshot()
      const selected = flags[settings.providerId]
      return { ...settings, models: { ...settings.models }, modelId: API_PROVIDERS.includes(settings.providerId) ? modelId() : claudeModel,
        profiles: cloneProfiles(), providers: flags, revision, keyConfigured: selected?.configured ?? flags.openrouter.configured,
        storageSupported: selected?.storageSupported ?? flags.openrouter.storageSupported, readiness, error: lastError,
        model }
    },
    save: value => mutation(async () => {
      const next = validateSettings(value)
      const updated = cloneProfiles()
      if (API_PROVIDERS.includes(next.providerId)) updated[next.providerId] = { mode: next.mode, models: { ...next.models } }
      await atomicUserWrite(directory, 'ai.json', Buffer.from(JSON.stringify({ ...next, profiles: updated }, null, 2)))
      profiles = updated; settings = next
      if (states[next.providerId]) states[next.providerId] = { readiness: 'not-validated', error: null }
    }),
    saveKey: (key, signal, id = 'openrouter') => mutation(async () => { const target = provider(id); await target.secrets.save(key, signal); target.client.clear?.(); states[id] = { readiness: 'not-validated', error: null } }),
    deleteKey: (id = 'openrouter') => mutation(async () => { const target = provider(id); await target.secrets.delete(); target.client.clear?.(); states[id] = { readiness: 'not-validated', error: null } }),
    async catalog(id, signal, refresh) {
      const target = provider(id); let key
      try {
        if (id !== 'openrouter') {
          try { key = await target.secrets.read(signal) }
          catch { signal?.throwIfAborted(); throw new AIProviderError(aiError('authentication', { providerId: id }, 'Provider key is missing or locked. Replace it in AI Settings.')) }
        }
        return await target.client.catalog(signal, refresh, key)
      } catch (error) {
        signal?.throwIfAborted()
        throw error instanceof AIProviderError ? error : new AIProviderError(id === 'openrouter' ? routerError(error) : nativeError(id, error))
      }
      finally { key = undefined }
    },
    async test(signal, id = settings.providerId) {
      const expected = revision
      const target = provider(id), profile = profiles[id], selectedModel = profile.models[profile.mode] || profile.models.balanced
      try {
        let key
        try { key = await target.secrets.read(signal) } catch { throw new AIProviderError(aiError('authentication', { providerId: id }, 'Provider key is missing or locked. Replace it in AI Settings.')) }
        try { await target.client.testKey(key, signal, selectedModel) } finally { key = undefined }
        if (!selectedModel) throw new AIProviderError(aiError('model-unavailable', { providerId: id }, 'Choose a model in AI Settings.'))
        // Test Connection is an explicit Settings catalog request. Generation
        // itself never downloads a catalog or silently changes a model.
        if (id === 'openrouter' && target.client.catalog) {
          await target.client.catalog(signal)
          if (!target.client.cached(selectedModel) && selectedModel !== 'openrouter/free') throw new AIProviderError(aiError('model-unavailable', { providerId: id }, 'Model not found in the public catalog. Check its ID; a manual request can verify private model access.'))
        }
        await target.client.model(selectedModel, signal)
        signal?.throwIfAborted()
        if (expected === revision) { states[id] = { readiness: 'ready', error: null }; if (id === settings.providerId) report(expected); else publish(false) }
      } catch (error) {
        if (signal?.aborted) throw error
        const normalized = error instanceof AIProviderError ? error.toJSON() : id === 'openrouter' ? routerError(error) : nativeError(id, error)
        if (expected === revision) {
          states[id] = { readiness: normalized.category === 'authentication' ? 'invalid-credentials' : 'unavailable', error: normalized }
          if (id === settings.providerId) report(expected, normalized); else publish(false)
        }
      }
      return this.snapshot()
    },
    report,
  }
}
