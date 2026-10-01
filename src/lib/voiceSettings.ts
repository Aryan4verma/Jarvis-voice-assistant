import { BRIDGE_HTTP_URL } from '../config'
import { bridgeFetch } from './bridgeSession'
export type VoiceReplies = 'always' | 'voice' | 'off'
const PREF = 'jarvis.voiceReplies'
let sessionPreference: VoiceReplies | undefined
export function voiceReplies(): VoiceReplies {
  if (sessionPreference) return sessionPreference
  try { const value = localStorage.getItem(PREF); return value === 'voice' || value === 'off' ? value : 'always' } catch { return 'always' }
}
export function shouldSpeak(source: 'typed' | 'voice', preference = voiceReplies()): boolean {
  return preference === 'always' || preference === 'voice' && source === 'voice'
}
export function setVoiceReplies(value: VoiceReplies) {
  sessionPreference = value
  try { localStorage.setItem(PREF, value) } catch { /* still usable this session */ }
  window.dispatchEvent(new CustomEvent('jarvis-voice-preference', { detail: value }))
}
export type VoiceSettings = { supported: boolean; elevenlabs: boolean; picovoice: boolean }
export async function voiceSetting(path: string, method = 'GET', key?: string, signal?: AbortSignal): Promise<VoiceSettings> {
  const response = await bridgeFetch(`${BRIDGE_HTTP_URL}/voice/${path}`, {
    method, signal, headers: { 'x-jarvis-settings': '1', ...(key !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(key !== undefined ? { body: JSON.stringify({ key }) } : {}),
  })
  if (!response.ok) throw new Error('Voice settings unavailable. Check the bridge, key and Windows protected storage.')
  return response.json()
}
export async function wakeCredential(signal: AbortSignal): Promise<string> {
  const response = await bridgeFetch(`${BRIDGE_HTTP_URL}/voice/wake-session`, { method: 'POST', signal, headers: { 'x-jarvis-settings': '1' } })
  if (!response.ok) throw new Error('Wake credential unavailable')
  return (await response.json()).accessKey
}
