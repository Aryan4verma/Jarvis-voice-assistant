import { mkdirSync, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { runtimeDirectory } from './security.mjs'

export const ARTIFACT_ROOT = join(runtimeDirectory, 'artifacts')
const unsafePath = (path) => /^[/\\]{2}|^\\[?.]\\/.test(path) || path.includes('\0')
export function contained(root, path) {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

export function approvedFileRoots() {
  mkdirSync(ARTIFACT_ROOT, { recursive: true, mode: 0o700 })
  return [ARTIFACT_ROOT, ...(process.env.JARVIS_FILE_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean)].map((root) => {
    if (!isAbsolute(root) || unsafePath(root)) throw new Error('JARVIS_FILE_ROOTS requires absolute local directories; UNC/device paths are not permitted.')
    const real = realpathSync(root)
    if (unsafePath(real)) throw new Error('Approved roots must resolve to local directories.')
    if ([parse(real).root, realpathSync(homedir()), realpathSync(tmpdir())].some((broad) => resolve(broad).toLowerCase() === real.toLowerCase())) {
      throw new Error('JARVIS_FILE_ROOTS must name narrow artifact folders, not a drive, home, or temp root.')
    }
    return { lexical: resolve(root), real }
  })
}

export async function resolveApprovedImage(path, roots) {
  if (!isAbsolute(path) || unsafePath(path)) return null
  if (!roots.some((root) => contained(root.lexical, resolve(path)))) return null
  try {
    const real = await realpath(path)
    return !unsafePath(real) && roots.some((root) => contained(root.real, real)) ? real : null
  } catch { return null }
}
