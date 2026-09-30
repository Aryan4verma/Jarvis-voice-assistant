/** Immutable per-query event ownership, with a small correlated camera map. */
export function createTurnScope(turnId, emit) {
  const controller = new AbortController()
  const waiting = new Map()
  let live = true, seq = 0
  const send = (message) => { if (live) emit({ ...message, scope: 'turn', turnId }) }
  const stop = () => {
    if (!live) return
    live = false
    controller.abort()
    for (const slot of waiting.values()) {
      clearTimeout(slot.timer)
      slot.reject(new Error('Interaction ended; camera request cancelled'))
    }
    waiting.clear()
  }
  return Object.freeze({
    turnId, signal: controller.signal, live: () => live, send, stop,
    pendingCount: () => waiting.size,
    request(kind, args, timeoutMs = 20000) {
      if (!live) return Promise.reject(new Error('Interaction ended'))
      if (waiting.size >= 2) return Promise.reject(new Error('Camera request limit reached'))
      return new Promise((resolve, reject) => {
        const id = `${turnId}:q${++seq}`
        const timer = setTimeout(() => {
          waiting.delete(id)
          send({ type: 'capture-cancel', id })
          reject(new Error('Camera request timed out'))
        }, timeoutMs)
        waiting.set(id, { resolve, reject, timer })
        send({ type: kind, id, ...args })
      })
    },
    reply(message) {
      if (!live || message.turnId !== turnId) return
      const slot = waiting.get(message.id)
      if (!slot) return
      waiting.delete(message.id)
      clearTimeout(slot.timer)
      slot.resolve(message)
    },
  })
}
