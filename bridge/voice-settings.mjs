/** Authenticated voice configuration. Permanent credentials never enter preferences. */
export async function voiceHTTP(req, res, { stores, legacyEleven, signal, cors, originAllowed }) {
  const path = new URL(req.url, 'http://localhost').pathname
  if (!path.startsWith('/voice/')) return false
  const send = (status, value) => { res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  const snapshot = async () => ({ supported: stores.elevenlabs.supported,
    elevenlabs: await stores.elevenlabs.configured() || Boolean(legacyEleven()), picovoice: await stores.picovoice.configured() })
  try {
    if (req.method !== 'GET' && (!req.headers.origin || !originAllowed(req.headers.origin) || req.headers['x-jarvis-settings'] !== '1')) {
      send(403, { message: 'Voice settings require an authenticated local page.' }); return true
    }
    if (req.method === 'GET' && path === '/voice/settings') send(200, await snapshot())
    else if (req.method === 'POST' && path === '/voice/wake-session') {
      // Porcupine Web requires its license credential in the worker at runtime.
      // Only this optional credential may cross the authenticated bridge; AI/STT keys never do.
      send(200, { accessKey: await stores.picovoice.read(signal) })
    } else {
      const purpose = path.split('/')[2], store = Object.hasOwn(stores, purpose) ? stores[purpose] : null
      if (!store || path !== `/voice/${purpose}/key`) { send(404, { message: 'Unknown voice setting.' }); return true }
      if (req.method === 'DELETE') await store.delete()
      else if (req.method === 'POST') {
        let size = 0; const chunks = []
        for await (const chunk of req) { signal.throwIfAborted(); size += chunk.length; if (size > 1024) throw new Error(); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!body || Object.keys(body).join(',') !== 'key') throw new Error()
        await store.save(body.key, signal); body.key = undefined
      } else { send(405, { message: 'Unsupported settings method.' }); return true }
      send(200, await snapshot())
    }
  } catch { if (!signal.aborted && !res.headersSent) send(400, { message: 'Voice setting failed. Check the key and Windows protected storage.' }) }
  return true
}
