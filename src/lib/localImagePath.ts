/** Normalize local image references; authorization remains on the bridge. */
export function localImagePath(raw: string): string | null {
  let path = raw
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.hostname) return null // Never contact a UNC/network share.
      path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1')
    } catch { return null }
  }
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  return /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//.test(path) ? path : null
}

/** Preserve legacy tool-produced bridge file URLs through authenticated routing. */
export function localBridgeFileUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/file') return null
    return `/__jarvis/bridge/file${url.search}`
  } catch { return null }
}
