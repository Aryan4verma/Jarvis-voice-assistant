import { join } from 'node:path'
import { AIProviderError, aiError } from '../shared/ai.mjs'
import { atomicUserWrite, privateDirectory, readBoundedFile, userDirectory } from './user-storage.mjs'
import { validModelId, routerError } from './providers/openrouter-client.mjs'

const MODES = ['fast', 'balanced', 'deep']
const PROVIDERS = ['claude-agent', 'openrouter']
const invalid = () => new AIProviderError(aiError('invalid-request', {}, 'Invalid AI settings. Choose a provider, mode and valid model IDs.'))
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'mode,models,providerId') throw invalid()
  if (!PROVIDERS.includes(value.providerId) || !MODES.includes(value.mode) || !value.models || Object.keys(value.models).sort().join(',') !== 'balanced,deep,fast') throw invalid()
  for (const mode of MODES) if (value.models[mode] !== '' && !validModelId(value.models[mode])) throw invalid()
  return { providerId: value.providerId, mode: value.mode, models: Object.fromEntries(MODES.map(mode => [mode, value.models[mode]])) }
}

export async function createAISettings({ secrets, client, directory = join(userDirectory, 'settings'), claudeModel = 'claude-opus-5' }) {
  let settings = validateSettings({
    providerId: process.env.JARVIS_AI_PROVIDER?.trim() || 'claude-agent', mode: 'balanced',
    models: Object.fromEntries(MODES.map(mode => [mode, process.env[`JARVIS_OPENROUTER_${mode.toUpperCase()}_MODEL`]?.trim() || ''])),
  })
  let storageIssue = null
  try {
    const path = join(await privateDirectory(directory), 'ai.json')
    settings = validateSettings(JSON.parse((await readBoundedFile(path)).toString('utf8')))
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
    publish(false)
  }
  return {
    selection: () => ({ ...settings, models: { ...settings.models }, modelId: settings.providerId === 'openrouter' ? modelId() : claudeModel, revision }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async snapshot() {
      const expected = revision
      let keyConfigured = false
      try { keyConfigured = await secrets.configured() } catch { /* Access failure is reported when saving/testing the key. */ }
      if (expected !== revision) return this.snapshot()
      return { ...settings, models: { ...settings.models }, modelId: settings.providerId === 'openrouter' ? modelId() : claudeModel,
        revision, keyConfigured, storageSupported: secrets.supported, readiness, error: lastError,
        model: settings.providerId === 'openrouter' ? client.cached(modelId()) : null }
    },
    save: value => mutation(async () => {
      const next = validateSettings(value)
      await atomicUserWrite(directory, 'ai.json', Buffer.from(JSON.stringify(next, null, 2)))
      settings = next
    }),
    saveKey: (key, signal) => mutation(() => secrets.save(key, signal)),
    deleteKey: () => mutation(() => secrets.delete()),
    async test(signal) {
      const expected = revision
      if (settings.providerId !== 'openrouter') throw new AIProviderError(aiError('invalid-request', {}, 'Claude readiness is checked through its existing agent connection.'))
      try {
        let key
        try { key = await secrets.read(signal) } catch { throw new AIProviderError(aiError('authentication', { providerId: 'openrouter' }, 'OpenRouter key is missing or locked. Replace it in AI Settings.')) }
        try { await client.testKey(key, signal) } finally { key = undefined }
        if (!modelId()) throw new AIProviderError(aiError('model-unavailable', {}, 'Choose an OpenRouter model in AI Settings.'))
        await client.model(modelId(), signal)
        signal?.throwIfAborted()
        report(expected)
      } catch (error) {
        if (signal?.aborted) throw error
        report(expected, error instanceof AIProviderError ? error.toJSON() : routerError(error))
      }
      return this.snapshot()
    },
    report,
  }
}
