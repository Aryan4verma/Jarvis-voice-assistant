import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { lstat, unlink } from 'node:fs/promises'
import { ROOT } from '../scripts/runtime.mjs'
import { atomicUserWrite, privateDirectory, readBoundedFile, userDirectory } from './user-storage.mjs'

export const validKey = key => typeof key === 'string' && key.length >= 20 && key.length <= 512 && /^[A-Za-z0-9_-]+$/.test(key)
/** Built-in Windows DPAPI, current user. Secrets travel over pipes, never command arguments. */
export function dpapi(action, bytes, signal, purpose = 'openrouter') {
  if (!['openrouter', 'elevenlabs', 'picovoice'].includes(purpose)) return Promise.reject(new Error('Invalid secret purpose.'))
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows DPAPI is unavailable. Claude mode remains available.'))
  return new Promise((resolve, reject) => {
    let child, output = '', settled = false
    const finish = (error) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { child?.kill(); reject(new Error('Windows-protected key storage failed or was cancelled.')) }
      else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output) || output.length > 8192) reject(new Error('Invalid Windows secret response.'))
      else resolve(Buffer.from(output, 'base64'))
      output = ''
    }
    const abort = () => finish(new Error('Cancelled'))
    const timer = setTimeout(abort, 10000)
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'dpapi.ps1'), '-Action', action, '-Purpose', purpose],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', finish)
      child.stdin.on('error', finish)
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) abort() })
      child.stderr.resume() // Discard diagnostics, which must never reach logs/UI.
      child.on('close', code => finish(code === 0 ? null : new Error('DPAPI failed')))
      child.stdin.end(bytes.toString('base64'))
    } catch { abort() }
  })
}
export function createSecretStore({ directory = join(userDirectory, 'credentials'), crypt = dpapi, supported = process.platform === 'win32', purpose = 'openrouter', cache = false } = {}) {
  if (!['openrouter', 'elevenlabs', 'picovoice'].includes(purpose)) throw new Error('Invalid secret purpose.')
  const valid = key => purpose === 'picovoice'
    ? typeof key === 'string' && key.length >= 20 && key.length <= 512 && /^[A-Za-z0-9+/=_-]+$/.test(key)
    : validKey(key)
  const filename = `${purpose}.dpapi`, path = join(directory, filename)
  let cached = null, expires = 0, revision = 0
  const clearCache = () => { revision++; cached?.fill(0); cached = null; expires = 0 }
  return {
    supported, clearCache,
    async configured() {
      if (!supported) return false
      try { await privateDirectory(directory); const stat = await lstat(path); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8192 }
      catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Cannot inspect Windows-protected key storage.') }
    },
    async save(key, signal) {
      if (!supported || !valid(key)) throw new Error('Enter a valid key on Windows to use protected storage.')
      const plain = Buffer.from(key)
      let encrypted
      try {
        encrypted = await crypt('Protect', plain, signal, purpose)
        signal?.throwIfAborted()
        await atomicUserWrite(directory, filename, encrypted)
        clearCache()
      } finally { plain.fill(0); encrypted?.fill(0) }
    },
    async read(signal) {
      if (!supported) throw new Error('Windows-protected storage is unavailable.')
      signal?.throwIfAborted()
      if (cache && cached && Date.now() < expires) return cached.toString('utf8')
      clearCache()
      const captured = revision
      let encrypted, plain
      try {
        await privateDirectory(directory); encrypted = await readBoundedFile(path)
        plain = await crypt('Unprotect', encrypted, signal, purpose)
        signal?.throwIfAborted()
        const key = plain.toString('utf8')
        if (!valid(key)) throw new Error()
        if (cache && captured === revision) { cached = Buffer.from(plain); expires = Date.now() + 5 * 60000 }
        return key
      } catch { throw new Error('Protected key is missing or cannot be unlocked. Replace it in Settings.') }
      finally { encrypted?.fill(0); plain?.fill(0) }
    },
    async delete() {
      clearCache()
      await privateDirectory(directory)
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error(); await unlink(path) }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot delete the protected key.') }
    },
  }
}
