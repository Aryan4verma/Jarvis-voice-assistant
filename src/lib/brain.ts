import { AI_SELECTION } from '../config'
import * as direct from './anthropic'
import * as bridge from './bridge'
import type { AIAdapter, AIHandlers, AIMessage, AIRequest, AIResult } from './ai'
import type { Blade, Panel } from '../store'
import { turns, type Turn, type CancelReason } from './turn'
export { turns } from './turn'

export type { AIMessage, AIRequest, AIHandlers, AIEvent, AIResult, AIProviderInfo, AIError, AIUsage } from './ai'
export type { ConnectionState } from './bridge'

/**
 * Picks the brain. Both backends answer a question and stream text and tool
 * events back; they differ in where they run and what they can reach.
 *
 *   bridge — a local Node process running the Claude Agent SDK. Uses your
 *            existing Claude Code login, so no API key, and every MCP server
 *            you have configured is available, including local stdio ones.
 *
 *   direct — the browser calls the Claude API itself. No process to run and it
 *            deploys as a static site, but it needs an API key in the bundle
 *            and can only use remote HTTP MCP servers.
 */

const usingBridge = AI_SELECTION.transport === 'bridge'
const provider: AIAdapter<Turn> = usingBridge ? bridge.adapter : direct.adapter
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
  if (usingBridge) await bridge.warmBridge()
}

/** The bridge reports its server list twice — from config on connect, then
 *  with live status once the agent boots — so the HUD subscribes. */
export function watchServers(fn: (servers: string[]) => void): void {
  if (usingBridge) bridge.watchServers(fn)
}

/** HUD panels are pushed mid-turn by the `display` tool, not returned by ask(). */
export function watchPanels(fn: (panel: Panel) => void): void {
  if (usingBridge) bridge.watchPanels(fn)
}

/** Blades — the big surface — arrive the same way, from the `blade` tool. Like
 *  panels and the ui_* commands, this is a bridge capability: the direct path
 *  has no channel for a server to volunteer anything mid-turn. */
export function watchBlades(fn: (blade: Blade) => void): void {
  if (usingBridge) bridge.watchBlades(fn)
}

/**
 * Redressing the interface — theme, reactor, orbiting objects, effects — is a
 * bridge capability, like panels. The `ui_*` tools live in an in-process MCP
 * server inside the bridge and push straight down the open socket, mid-turn.
 * The direct path has no such channel: the browser talks to the Messages API
 * over one-shot HTTPS requests and gets back an answer, with nowhere for a
 * server to volunteer anything. On that backend this watcher simply never
 * fires and the interface stays exactly as it ships.
 */
export function watchUi(fn: (op: string, args: any) => void): void {
  if (usingBridge) bridge.watchUi(fn)
}

/**
 * The one thing the bridge asks US for.
 *
 * Every other channel here is the bridge volunteering something mid-turn. A
 * camera frame is the exception — the hardware is in the browser and the model
 * is in the bridge — so this handler answers a request rather than receiving a
 * push. Bridge-only for the same reason as the rest: the direct path is one-shot
 * HTTPS, with nowhere for a request to arrive.
 */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  if (usingBridge) bridge.watchCapture(fn)
}

/** Cancel the authoritative owner; its signal stops transport, speech and camera waits. */
export function cancel(reason: CancelReason = 'stop'): void { turns.cancel(reason) }
export function interrupt(): void { cancel('barge-in') }
export function shutdown(): void { cancel('shutdown'); if (usingBridge) bridge.shutdown() }

/**
 * Whether the brain is reachable right now.
 *
 * Only meaningful on the bridge, where a live socket is the session. The direct
 * path holds no connection between turns — each one is its own HTTPS request —
 * so there is nothing that can be down until you try it.
 */
export function isConnected(): boolean {
  return usingBridge ? bridge.isConnected() : true
}

/**
 * Connection state, for the UI.
 *
 * Worth surfacing because in bridge mode the socket *is* the conversation: all
 * of JARVIS's memory of the exchange lives in the agent session behind it, so a
 * drop wipes the conversation while the transcript on screen still shows it.
 * Never fires on the direct path, which has no connection to lose.
 */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  if (usingBridge) bridge.watchConnection(fn)
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  return usingBridge ? bridge.bridgeServers() : direct.connectedLabels()
}
