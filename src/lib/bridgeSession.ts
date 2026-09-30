let initializing: Promise<void> | null = null

/** Establish an HttpOnly session; credentials never enter JS or localStorage. */
export function ensureBridgeSession(refresh = false): Promise<void> {
  if (refresh) initializing = null
  if (!initializing) {
    initializing = fetch('/__jarvis/session', {
      method: 'POST', headers: { 'x-jarvis-client': '1' }, credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    }).then((res) => {
      if (!res.ok) throw new Error('Local bridge authentication unavailable. Start npm start or npm run bridge.')
    }).catch((err) => { initializing = null; throw err })
  }
  return initializing
}

export async function bridgeFetch(url: string, init?: RequestInit): Promise<Response> {
  await ensureBridgeSession()
  let response = await fetch(url, init)
  if (response.status === 401) {
    await ensureBridgeSession(true)
    response = await fetch(url, init)
  }
  return response
}
