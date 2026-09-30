export type CancelReason = 'replaced' | 'barge-in' | 'stop' | 'timeout' | 'disconnect' | 'error' | 'shutdown'

export class TurnCancelled extends Error {
  readonly reason: CancelReason
  constructor(reason: CancelReason, detail?: string) {
    super(detail ?? `Interaction cancelled: ${reason}`)
    this.name = 'AbortError'
    this.reason = reason
  }
}

export type Turn = {
  readonly turnId: string
  readonly signal: AbortSignal
  current: () => boolean
  cancel: (reason: CancelReason, detail?: string) => void
  complete: () => void
}

/** One primary interaction, including its speech tail. No retained history. */
export function createTurnOwner() {
  let active: Turn | null = null
  return {
    begin(): Turn {
      active?.cancel('replaced')
      const controller = new AbortController()
      const turn: Turn = Object.freeze({
        turnId: crypto.randomUUID(),
        signal: controller.signal,
        current: () => active === turn && !controller.signal.aborted,
        cancel: (reason: CancelReason, detail?: string) => {
          if (active !== turn) return
          controller.abort(new TurnCancelled(reason, detail))
          if (active === turn) active = null
        },
        complete: () => { if (active === turn) active = null },
      })
      active = turn
      return turn
    },
    cancel(reason: CancelReason) { active?.cancel(reason) },
    matches(turnId: string) { return active?.turnId === turnId && active.current() },
  }
}

export const turns = createTurnOwner()

/** Abort local waits immediately even if the underlying operation cannot stop. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else resolve(value)
    }, (err) => { signal.removeEventListener('abort', abort); reject(err) })
  })
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
