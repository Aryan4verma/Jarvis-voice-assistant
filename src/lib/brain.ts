import * as bridge from './bridge'
import type { AIAdapter, AIHandlers, AIMessage, AIRequest, AIResult } from './ai'
import type { Blade, Panel } from '../store'
import { turns, type Turn, type CancelReason } from './turn'
export { turns } from './turn'

export type { AIMessage, AIRequest, AIHandlers, AIEvent, AIResult, AIProviderInfo, AIError, AIUsage } from './ai'
export type { ConnectionState } from './bridge'

/** All AI requests use the authenticated Node bridge, for voice and typed chat. */
const provider: AIAdapter<Turn> = bridge.adapter
export const providerInfo = () => provider.describe()
export const configurationIssue = () => provider.configurationIssue?.() ?? null

/** Shared request entry point, including images; the voice wrapper below uses text. */
export function generate(request: AIRequest, handlers: AIHandlers, turn: Turn): Promise<AIResult> {
  return provider.generate(request, {
    onEvent: event => { if (turn.current()) handlers.onEvent(event) },
  }, turn)
}

/** Adapters decide whether to use message history or their own agent session. */
export async function ask(
  prompt: string,
  history: AIMessage[],
  handlers: AIHandlers,
  turn: Turn,
): Promise<AIResult> {
  return generate({ messages: [...history, { role: 'user', content: prompt }] }, handlers, turn)
}

export async function warm(): Promise<void> {
  await bridge.warmBridge()
}

/** The bridge reports its server list twice — from config on connect, then
 *  with live status once the agent boots — so the HUD subscribes. */
export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

/** HUD panels are pushed mid-turn by the `display` tool, not returned by ask(). */
export function watchPanels(fn: (panel: Panel) => void): void {
  bridge.watchPanels(fn)
}

/** Blades — the big surface — arrive the same way, from the `blade` tool. Like
 *  panels and the ui_* commands, this is a bridge capability: the direct path
 *  has no channel for a server to volunteer anything mid-turn. */
export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

/** Interface tool effects arrive through the bridge with turn ownership. */
export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

/** Camera requests are owned by the originating bridge turn. */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  bridge.watchCapture(fn)
}

/** Cancel the authoritative owner; its signal stops transport, speech and camera waits. */
export function cancel(reason: CancelReason = 'stop'): void { turns.cancel(reason) }
export function interrupt(): void { cancel('barge-in') }
export function shutdown(): void { cancel('shutdown'); bridge.shutdown() }

/** Current bridge connection state. */
export function isConnected(): boolean {
  return bridge.isConnected()
}

/** Connection changes are reported without polling. */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  bridge.watchConnection(fn)
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  return bridge.bridgeServers()
}
