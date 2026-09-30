import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../scripts/runtime.mjs'

export const BRIDGE_PREFIX = '/__jarvis/bridge'
export const SESSION_PATH = '/__jarvis/session'
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const runtimeDirectory = process.env.JARVIS_RUNTIME_DIR || join(
  process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'),
  'JarvisAI', 'bridge', createHash('sha256').update(ROOT).digest('hex').slice(0, 16),
)
export const runtimeFile = (port) => join(runtimeDirectory, `${port}.json`)
export const cookieName = (port, frontendPort) => `jarvis-client-${port}-${frontendPort}`
export const frontendSecret = (token, origin) => createHmac('sha256', token).update(`frontend:${origin}`).digest('hex')

export function sameSecret(candidate, secret) {
  if (typeof candidate !== 'string') return false
  const given = Buffer.from(candidate), expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function readRuntime(port) {
  try {
    const file = runtimeFile(port)
    if (statSync(file).size > 4096) throw new Error()
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.port !== port || !/^[a-f0-9]{64}$/.test(data.token) || !Number.isInteger(data.pid)) throw new Error()
    process.kill(data.pid, 0)
    return data
  } catch {
    throw new Error('Bridge unavailable. Start npm start or npm run bridge.')
  }
}

export function localHostAllowed(host, port) {
  try {
    const url = new URL(`http://${host}`)
    return LOCAL_HOSTS.has(url.hostname) && Number(url.port) === port && url.host === host
  } catch { return false }
}

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function createBridgeSecurity(port) {
  const token = randomBytes(32).toString('hex')
  const file = runtimeFile(port)
  const sign = (url, expires) => createHmac('sha256', token).update(`/img\n${url}\n${expires}`).digest('base64url')
  return {
    publish() {
      mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ token, port, pid: process.pid }), { mode: 0o600 })
      renameSync(temporary, file)
      process.once('exit', () => {
        try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file) } catch { /* stale records are rejected */ }
      })
    },
    authorized(req) {
      return sameSecret(req.headers.authorization?.replace(/^Bearer /, ''), token)
    },
    // Opaque sandboxed article frames cannot send SameSite cookies. Give only
    // their individual public-image URLs a short-lived, URL-bound capability.
    imageUrl(url, base) {
      const expires = Math.floor(Date.now() / 1000) + 600
      return `${base}/img?url=${encodeURIComponent(url)}&grant=${expires}.${sign(url, expires)}`
    },
    imageAuthorized(req) {
      const asked = new URL(req.url, 'http://localhost')
      if (req.method !== 'GET' || asked.pathname !== '/img') return false
      const [expires, signature, extra] = (asked.searchParams.get('grant') || '').split('.')
      const now = Math.floor(Date.now() / 1000)
      return !extra && /^\d{10}$/.test(expires || '') && Number(expires) >= now && Number(expires) <= now + 600 &&
        sameSecret(signature, sign(asked.searchParams.get('url') || '', expires))
    },
  }
}

export function errorLabel(err) {
  const code = err?.code
  const safe = new Set(['ENOENT', 'EACCES', 'EADDRINUSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'ERR_STREAM_PREMATURE_CLOSE', 'ERR_INVALID_URL', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'])
  return safe.has(code) ? code : 'operation failed'
}

export function limitValue(name, fallback, max = 32) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}.`)
  return value
}

export function createLimiter(limits) {
  const active = new Map()
  return (kind) => {
    if ((active.get(kind) || 0) >= limits[kind]) return null
    active.set(kind, (active.get(kind) || 0) + 1)
    let released = false
    return () => { if (!released) { released = true; active.set(kind, active.get(kind) - 1) } }
  }
}

export function createRateLimit(count, windowMs = 60000) {
  let tokens = count, last = Date.now()
  return () => {
    const now = Date.now()
    tokens = Math.min(count, tokens + (now - last) * count / windowMs)
    last = now
    if (tokens < 1) return false
    tokens--
    return true
  }
}
