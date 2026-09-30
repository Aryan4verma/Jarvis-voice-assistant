export function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason ?? new Error('Interaction cancelled')) }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Interaction cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) },
      (err) => { signal.removeEventListener('abort', abort); reject(err) })
  })
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function browserRetrySafe(name, args = {}) {
  return ['get_page_text', 'read_page', 'find'].includes(name) ||
    (name === 'tabs_context_mcp' && args.createIfEmpty === false) ||
    (name === 'computer' && args.action === 'screenshot')
}
