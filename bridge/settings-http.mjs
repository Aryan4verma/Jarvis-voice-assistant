import { AIProviderError, aiError } from '../shared/ai.mjs'
import { validKey } from './secrets.mjs'

/** Called only after the bridge's Host/Origin/bearer checks. Never returns a key. */
export async function settingsHTTP(req, res, { settings, client, signal, cors, originAllowed }) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/ai/')) return false
  const send = (status, body) => { res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  try {
    if (req.method !== 'GET' && (!req.headers.origin || !originAllowed(req.headers.origin) || req.headers['x-jarvis-settings'] !== '1')) {
      send(403, { error: aiError('invalid-request', {}, 'Settings require an authenticated local page and settings header.') }); return true
    }
    const read = async () => {
      let size = 0, chunks = []
      for await (const chunk of req) {
        signal.throwIfAborted(); size += chunk.length
        if (size > 8192) throw new AIProviderError(aiError('invalid-request', {}, 'Settings request is too large.'))
        chunks.push(chunk)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AIProviderError(aiError('invalid-request')) }
    }
    if (req.method === 'GET' && url.pathname === '/ai/settings') send(200, await settings.snapshot())
    else if (req.method === 'GET' && url.pathname === '/ai/models') send(200, { models: await client.catalog(signal, url.searchParams.get('refresh') === '1') })
    else if (req.method === 'PUT' && url.pathname === '/ai/settings') { await settings.save(await read()); send(200, await settings.snapshot()) }
    else if (req.method === 'POST' && url.pathname === '/ai/key') {
      const body = await read()
      if (!body || Object.keys(body).join(',') !== 'key' || !validKey(body.key)) throw new AIProviderError(aiError('invalid-request', {}, 'Enter a valid OpenRouter API key.'))
      await settings.saveKey(body.key, signal); body.key = undefined
      send(200, await settings.snapshot())
    } else if (req.method === 'DELETE' && url.pathname === '/ai/key') { await settings.deleteKey(); send(200, await settings.snapshot()) }
    // Provider 401 is data, not a bridge 401 that could replay the test.
    else if (req.method === 'POST' && url.pathname === '/ai/test') send(200, await settings.test(signal))
    else send(404, { error: aiError('invalid-request') })
  } catch (error) {
    if (!signal.aborted && !res.headersSent) send(error instanceof AIProviderError && error.category === 'invalid-request' ? 400 : 503,
      { error: error instanceof AIProviderError ? error.toJSON() : aiError('unavailable', {}, 'AI settings could not be accessed. Check Windows user storage and try again.') })
  }
  return true
}
