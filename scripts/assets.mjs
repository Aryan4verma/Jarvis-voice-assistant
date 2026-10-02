import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './runtime.mjs'

/** Prepare the pinned runtime for every Vite workflow, without a CDN download. */
export function prepareMediaPipe() {
  prepareLegalNotices()
  const packageDir = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision')
  const from = join(packageDir, 'wasm')
  const to = join(ROOT, 'public', 'mediapipe')
  const marker = join(to, '.version')

  try {
    const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const files = readdirSync(from, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    if (!files.includes('vision_wasm_internal.wasm')) {
      throw new Error('The installed MediaPipe package is missing its WASM runtime.')
    }

    const current = existsSync(marker) && readFileSync(marker, 'utf8').trim() === version
    const complete = files.every((file) => {
      const target = join(to, file)
      return existsSync(target) && statSync(target).size === statSync(join(from, file)).size
    })
    if (current && complete) return

    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    // Write last: a failed or incomplete copy must be repaired next time.
    writeFileSync(marker, `${version}\n`)
    console.log('[jarvis] prepared the hand-tracking runtime in public/mediapipe.')
  } catch (err) {
    throw new Error(`Could not prepare MediaPipe assets. Run npm ci and retry. ${err.message}`, { cause: err })
  }
}

/** Keep attribution with generated assets; no runtime worker or network. */
export function prepareLegalNotices() {
  const to = join(ROOT, 'public', 'legal')
  mkdirSync(to, { recursive: true })
  for (const name of ['LICENSE', 'ATTRIBUTION.md', 'THIRD_PARTY_NOTICES.md', 'ASSET_AUDIT.md']) {
    const bytes = readFileSync(join(ROOT, name)), target = join(to, name)
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) writeFileSync(target, bytes)
  }
  const licenses = join(ROOT, 'third-party-licenses'), target = join(to, 'third-party-licenses')
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(licenses)) {
    const bytes = readFileSync(join(licenses, name)), file = join(target, name)
    if (!existsSync(file) || !readFileSync(file).equals(bytes)) writeFileSync(file, bytes)
  }
}
