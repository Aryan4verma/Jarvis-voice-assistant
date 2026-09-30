import { AIProviderError, aiError, completionReason, legacyEvents, readUsage, validContent, validRequest,
  type AIAdapter, type AIHandlers, type AIProviderInfo, type AIRequest, type AIResult,
  type AIUsage, type AIError, type LegacyAskHandlers } from './ai'
import type { Blade, Panel } from '../store'
import { BRIDGE_WS_URL } from '../config'
import { ensureBridgeSession } from './bridgeSession'
import { turns, TurnCancelled, type Turn } from './turn'

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The socket is the session. The bridge resumes its SDK conversation between immutable per-turn
 * queries. A dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  turnId?: string
  scope?: 'turn' | 'connection'
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
  provider?: AIProviderInfo
  usage?: AIUsage
  error?: AIError
  displayName?: string
  phase?: 'start' | 'activity'
  historyMode?: 'messages' | 'session'
}


let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
let providerInfo: AIProviderInfo | null = null
let historyMode: 'messages' | 'session' = 'messages'
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  turnId: string
  id: string
  signal: AbortSignal
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial. It gives up after the last delay rather
 *  than retrying forever — a bridge that has been down for half a minute is
 *  usually one you stopped on purpose, and the next ask() re-dials anyway. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 8000]
let attempt = 0
let reconnectTimer = 0
let closing = false
let connectionGeneration = 0
let dialling: WebSocket | null = null

function scheduleReconnect() {
  if (closing || attempt >= RECONNECT_DELAYS.length) return
  const delay = RECONNECT_DELAYS[attempt]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    void connect().catch(() => {})
  }, delay)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    if (socket !== ws) return // Dead connections cannot update even global state.
    let msg: Frame
    try { msg = JSON.parse(e.data as string) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.scope === 'connection' && msg.type === 'ready') {
      providerInfo = msg.provider ?? null
      historyMode = msg.historyMode === 'session' ? 'session' : 'messages'
      servers = (msg.servers ?? []).map((s) => typeof s === 'string' ? s : s.name ?? '').filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
      return
    }
    const owner = pending
    if (!owner || owner.ws !== ws || msg.scope !== 'turn' || msg.turnId !== owner.turn.turnId || !owner.turn.current()) return
    owner.touch()
    try {
      if (msg.type === 'panel' && msg.panel) onPanel?.(msg.panel)
      else if (msg.type === 'blade' && msg.blade) onBlade?.(msg.blade)
      else if (msg.type === 'ui' && msg.op) onUi?.(msg.op, msg.args ?? {})
      else if (msg.type === 'capture-cancel' && msg.id) { owner.captures.get(msg.id)?.abort(); owner.captures.delete(msg.id) }
      else if (msg.type === 'capture' && msg.id) {
        if (owner.captures.size >= 2 || owner.captures.has(msg.id)) return
        const id = msg.id, controller = new AbortController()
        owner.captures.set(id, controller)
        const reply = (payload: CaptureResult) => {
          if (pending === owner && owner.turn.current() && !controller.signal.aborted && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'reply', turnId: owner.turn.turnId, id, ...payload })) }
            catch { owner.turn.cancel('disconnect') }
          }
        }
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          if (!onCapture) return { error: 'The interface has no camera handler.' }
          return onCapture({ turnId: owner.turn.turnId, id, signal: controller.signal,
            mode: msg.mode === 'watch' ? 'watch' : 'look', reason: msg.reason ?? '',
            seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)), when: msg.when === 'past' ? 'past' : 'now' })
        }).then(reply, () => reply({ error: 'Camera capture failed or was cancelled.' }))
          .finally(() => { if (owner.captures.get(id) === controller) owner.captures.delete(id) })
      } else owner.frame(msg)
    } catch (err) { owner.fail(err instanceof Error ? err : new Error('Bridge event failed')) }
  })
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  closing = false
  clearTimeout(reconnectTimer)
  const generation = ++connectionGeneration
  firstReady = deferred()

  connecting = ensureBridgeSession(true).then(() => new Promise<WebSocket>((resolve, reject) => {
    if (generation !== connectionGeneration || closing) { reject(new Error('Bridge closed')); return }
    const ws = new WebSocket(BRIDGE_WS_URL)
    dialling = ws
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (generation === connectionGeneration) connecting = null
      if (dialling === ws) dialling = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      if (generation !== connectionGeneration || closing) { ws.close(); settle(new Error('Bridge closed')); return }
      socket = ws
      attempt = 0
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = () => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        providerInfo = null
        historyMode = 'messages'
        if (pending?.ws === ws) pending.turn.cancel('disconnect')
        turns.cancel('disconnect') // Includes speech still draining after backend completion.
        if (!closing) onConnection?.('lost')
        scheduleReconnect()
      }
    }
  })).catch((err) => {
    if (generation === connectionGeneration) { connecting = null; if (everConnected && !closing) scheduleReconnect() }
    throw err
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      firstReady.promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2500) }),
    ])
  } finally { clearTimeout(timer) }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

type Pending = {
  turn: Turn
  ws: WebSocket | null
  captures: Map<string, AbortController>
  touch: () => void
  frame: (msg: Frame) => void
  fail: (error: Error) => void
}
let pending: Pending | null = null

export function generate(request: AIRequest, handlers: AIHandlers, turn: Turn): Promise<AIResult> {
  const last = request.messages.at(-1)
  if (last?.role !== 'user' || !validContent(last.content)) return Promise.reject(new AIProviderError(aiError('invalid-request')))
  const content = last.content
  if (pending && pending.turn !== turn) pending.turn.cancel('replaced')
  return new Promise((resolve, reject) => {
    let text = '', done = false, timer: ReturnType<typeof setTimeout> | null = null
    const tools: string[] = []
    let usage: AIUsage | undefined
    const cleanup = () => {
      done = true
      if (pending === owner) pending = null
      if (timer) clearTimeout(timer)
      turn.signal.removeEventListener('abort', abort)
      for (const capture of owner.captures.values()) capture.abort()
      owner.captures.clear()
    }
    const abort = () => {
      if (done) return
      if (owner.ws?.readyState === WebSocket.OPEN) {
        try { owner.ws.send(JSON.stringify({ type: 'cancel', turnId: turn.turnId })) } catch { /* disconnected */ }
      }
      cleanup()
      reject(turn.signal.reason ?? new TurnCancelled('stop'))
    }
    const owner: Pending = {
      turn, ws: null, captures: new Map(),
      touch() {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => turn.cancel('timeout'), IDLE_TIMEOUT_MS)
      },
      fail(error) {
        if (done) return
        turn.cancel('error', error.message)
      },
      frame(msg) {
        if (done) return
        if (msg.type === 'text') { text += msg.delta ?? ''; handlers.onEvent({ type: 'text', delta: msg.delta ?? '' }) }
        else if (msg.type === 'tool' && msg.name) {
          if (tools.length < 256) tools.push(msg.name)
          handlers.onEvent({ type: 'tool', name: msg.name, id: msg.id, displayName: msg.displayName, phase: msg.phase })
        } else if (msg.type === 'usage') {
          usage = readUsage(msg.usage)
          if (usage) handlers.onEvent({ type: 'usage', usage })
        } else if (msg.type === 'done') {
          // SDK builds without deltas still need an audible answer.
          if (!text && msg.text) { text = msg.text; handlers.onEvent({ type: 'text', delta: text }) }
          usage = readUsage(msg.usage) ?? usage
          const reason = completionReason(msg.reason)
          handlers.onEvent({ type: 'done', text: text.trim(), reason, ...(usage ? { usage } : {}) })
          cleanup(); resolve({ text: text.trim(), tools, reason, ...(usage ? { usage } : {}) })
        } else if (msg.type === 'error') {
          const error = msg.error ? aiError(msg.error.category, msg.error.diagnostics, msg.error.message) : aiError('unknown')
          handlers.onEvent({ type: 'error', error })
          owner.fail(new AIProviderError(error))
        } else if (msg.type === 'cancelled') {
          handlers.onEvent({ type: 'cancelled', reason: 'cancelled' })
          turn.cancel('stop')
        }
      },
    }
    pending = owner
    turn.signal.addEventListener('abort', abort, { once: true })
    if (!turn.current()) { abort(); return }
    owner.touch()
    void connect().then((ws) => {
      if (done || pending !== owner || !turn.current()) return
      owner.ws = ws
      if (historyMode === 'messages' && !validRequest(request)) { owner.fail(new AIProviderError(aiError('invalid-request'))); return }
      const payload = historyMode === 'session'
        ? (typeof content === 'string' ? { text: content } : { content })
        : { messages: request.messages }
      try { ws.send(JSON.stringify({ type: 'ask', turnId: turn.turnId, ...payload })) }
      catch { turn.cancel('disconnect') }
    }, () => { if (!done) turn.cancel('disconnect') })
  })
}

export const adapter: AIAdapter<Turn> = { get historyMode() { return historyMode }, describe: () => providerInfo, generate }

/** Compatibility for callers using the original transport callbacks. */
export function ask(prompt: string, handlers: LegacyAskHandlers, turn: Turn): Promise<AIResult> {
  return generate({ messages: [{ role: 'user', content: prompt }] }, legacyEvents(handlers), turn)
}

/** No request replay on reconnect. A dead connection loses its owned turn. */
export function shutdown(): void {
  closing = true
  connectionGeneration++
  clearTimeout(reconnectTimer)
  pending?.turn.cancel('shutdown')
  dialling?.close()
  socket?.close()
  socket = null
  connecting = null
  servers = []
  providerInfo = null
  historyMode = 'messages'
}
