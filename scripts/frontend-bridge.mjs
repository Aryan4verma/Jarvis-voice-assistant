import { request } from 'node:http'
import { BRIDGE_PREFIX, SESSION_PATH, cookieName, frontendSecret, isLoopback, localHostAllowed, readRuntime, sameSecret } from '../bridge/security.mjs'

/** Vite owns browser authentication; only the Node processes see the bearer. */
export function localBridgePlugin(port) {
  const attach = (server) => {
    const context = (req) => {
      const localPort = server.httpServer?.address()?.port
      if (!isLoopback(req.socket.remoteAddress) || !localHostAllowed(req.headers.host, localPort)) return null
      return `http://${req.headers.host}`
    }
    const permitted = (req, origin, state) => {
      if (req.headers.origin && req.headers.origin !== origin) return false
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false
      const name = cookieName(port, new URL(origin).port)
      const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim())
        .find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1)
      return sameSecret(cookie, frontendSecret(state.token, origin))
    }
    const headers = (req, origin, state, authenticated) => {
      const out = { host: `127.0.0.1:${port}`, origin }
      for (const name of ['content-type', 'content-length', 'x-jarvis-turn', 'x-jarvis-settings', 'range', 'accept', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
        if (req.headers[name]) out[name] = req.headers[name]
      }
      if (authenticated) out.authorization = `Bearer ${state.token}`
      return out
    }
    const failure = (res, status, text) => {
      res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain', 'referrer-policy': 'no-referrer' })
      res.end(text)
    }
    server.middlewares.use((req, res, next) => {
      const pathname = req.url?.split('?')[0]
      if (pathname !== SESSION_PATH && !pathname?.startsWith(`${BRIDGE_PREFIX}/`)) return next()
      const origin = context(req)
      if (!origin) return failure(res, 403, 'Local frontend required.')
      let state
      try { state = readRuntime(port) } catch { return failure(res, 503, 'Bridge unavailable. Start npm start or npm run bridge.') }
      if (pathname === SESSION_PATH) {
        if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['x-jarvis-client'] !== '1') {
          return failure(res, 403, 'Same-origin frontend initialization required.')
        }
        res.writeHead(204, {
          'set-cookie': `${cookieName(port, new URL(origin).port)}=${frontendSecret(state.token, origin)}; HttpOnly; SameSite=Strict; Path=/__jarvis`,
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        })
        return res.end()
      }
      const path = req.url.slice(BRIDGE_PREFIX.length)
      const authenticated = permitted(req, origin, state)
      // Sandbox article images use individually signed URLs, checked by the
      // bridge. They never gain a bearer credential or access to other routes.
      const imageGrant = req.method === 'GET' && pathname === `${BRIDGE_PREFIX}/img` && new URL(req.url, origin).searchParams.has('grant')
      if (!authenticated && !imageGrant) return failure(res, 401, 'Initialize the local JARVIS frontend.')
      const upstream = request({ hostname: '127.0.0.1', port, path, method: req.method, headers: headers(req, origin, state, authenticated) }, (reply) => {
        const outgoing = { ...reply.headers }
        delete outgoing['set-cookie']
        res.writeHead(reply.statusCode || 502, outgoing)
        reply.pipe(res)
        res.on('close', () => reply.destroy())
      })
      upstream.setTimeout(65000, () => upstream.destroy())
      upstream.on('error', () => {
        if (!res.headersSent) failure(res, 502, 'Local bridge request failed.')
        else res.destroy()
      })
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => upstream.destroy())
      req.pipe(upstream)
    })
    server.httpServer?.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] !== `${BRIDGE_PREFIX}/ws`) return
      const reject = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      const origin = context(req)
      let state
      try { state = readRuntime(port) } catch { return reject(503) }
      if (!origin || req.headers.origin !== origin || !permitted(req, origin, state)) return reject(401)
      const upstream = request({ hostname: '127.0.0.1', port, path: '/ws', headers: {
        ...headers(req, origin, state, true), connection: 'Upgrade', upgrade: 'websocket',
      } })
      upstream.setTimeout(10000, () => upstream.destroy())
      upstream.on('upgrade', (reply, link, remainder) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(reply.headers)
          .map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n\r\n')
        if (remainder.length) socket.write(remainder)
        if (head.length) link.write(head)
        socket.pipe(link).pipe(socket)
        socket.on('close', () => link.destroy())
        link.on('error', () => socket.destroy())
      })
      upstream.on('response', (reply) => { reply.resume(); reject(reply.statusCode || 502) })
      upstream.on('error', () => reject(502))
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
      upstream.end()
    })
  }
  return { name: 'jarvis-local-bridge', configureServer: attach, configurePreviewServer: attach }
}
