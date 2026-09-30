import { homedir } from 'node:os'
import { mkdir, realpath, lstat, writeFile, rename, rm, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROOT } from '../scripts/runtime.mjs'

export const userDirectory = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'JarvisAI')
const inside = (parent, target) => { const rel = relative(parent, target); return !rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) }
export async function privateDirectory(directory) {
  if (!isAbsolute(directory) || /^\\\\/.test(directory) || inside(ROOT, resolve(directory))) throw new Error('User storage must be outside the repository on a local drive.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await realpath(directory)
  if (inside(await realpath(ROOT), actual) || (await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe user storage directory.')
  return actual
}
export async function readBoundedFile(path, cap = 8192) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > cap) throw new Error('Invalid local storage file.')
  return readFile(path)
}
export async function atomicUserWrite(directory, name, bytes) {
  const dir = await privateDirectory(directory), path = join(dir, name), temp = join(dir, `${name}.${randomUUID()}.tmp`)
  try {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe local storage file.') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}
