import { BRIDGE_HTTP_URL } from '../config'
import { bridgeFetch } from './bridgeSession'
import type { AIError, AIProviderInfo } from './ai'

export type AIMode = 'fast' | 'balanced' | 'deep'
export type Model = AIProviderInfo & { name: string; inputPrice?: number; outputPrice?: number }
export type AIPreferences = { providerId: 'claude-agent' | 'openrouter'; mode: AIMode; models: Record<AIMode, string> }
export type AISettings = AIPreferences & {
  revision: number; modelId: string; keyConfigured: boolean; storageSupported: boolean
  readiness: string; error: AIError | null; model: Model | null
}
let snapshot: AISettings | null = null
const listeners = new Set<(value: AISettings | null) => void>()
export function acceptSettings(value: AISettings) {
  // Revisions reset on bridge restart, so disconnect clears the old snapshot.
  if (snapshot && value.revision < snapshot.revision) return
  snapshot = value; for (const listener of listeners) listener(snapshot)
}
export function providerDisconnected() {
  if (snapshot) {
    const unavailable = { ...snapshot, readiness: 'unavailable', error: null }
    snapshot = null
    for (const listener of listeners) listener(unavailable)
  }
}
export function watchSettings(listener: (value: AISettings | null) => void) {
  listeners.add(listener); listener(snapshot)
  return () => { listeners.delete(listener) }
}
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await bridgeFetch(`${BRIDGE_HTTP_URL}/ai/${path}`, {
    method, signal, headers: { 'content-type': 'application/json', 'x-jarvis-settings': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(response.status === 429 ? 'The local bridge is busy. Try again shortly.' : 'Local AI settings are unavailable. Start npm start or npm run bridge.')
  }
  const value = await response.json()
  if (!response.ok) throw new Error(value.error?.message || 'Local AI settings are unavailable. Start the JARVIS bridge.')
  return value
}
async function settingsRequest(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<AISettings> {
  const value = await request(path, method, body, signal) as AISettings
  acceptSettings(value); return value
}
export const getSettings = (signal?: AbortSignal) => settingsRequest('settings', 'GET', undefined, signal)
export const saveSettings = (value: AIPreferences, signal?: AbortSignal) => settingsRequest('settings', 'PUT', value, signal)
export const saveKey = (key: string, signal?: AbortSignal) => settingsRequest('key', 'POST', { key }, signal)
export const deleteKey = (signal?: AbortSignal) => settingsRequest('key', 'DELETE', undefined, signal)
export const testConnection = (signal?: AbortSignal) => settingsRequest('test', 'POST', undefined, signal)
export const getModels = async (signal?: AbortSignal): Promise<Model[]> => (await request('models?refresh=1', 'GET', undefined, signal)).models
export function readinessLabel(value: AISettings | null) {
  if (!value) return 'AI settings available when the bridge is running'
  if (value.providerId === 'claude-agent') return `Claude Agent · ${value.error?.message || (value.readiness === 'unavailable' ? 'provider unavailable' : `${value.modelId} · validated on request`)}`
  if (!value.keyConfigured) return 'OpenRouter · key not configured'
  if (!value.modelId) return 'OpenRouter · choose a model in AI Settings'
  if (value.error) return `OpenRouter · ${value.error.message}`
  return `OpenRouter · ${value.mode.toUpperCase()} · ${value.modelId} · ${value.readiness === 'not-validated' ? 'configured, not tested' : value.readiness}`
}
