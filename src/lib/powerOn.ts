export type StartupSource = 'manual' | 'clap'

/** One startup owner for ignition, clap, Space and contextual retries.
 * Invoke initialization synchronously so click/keyboard activation is retained.
 * Optional voice failures leave the powered-on text interface available. */
export function createPowerOn(handlers: {
  ready: () => boolean
  begin: (source: StartupSource) => void
  initialize: () => Promise<void>
  failed: (error: unknown) => void
}) {
  let pending: Promise<void> | null = null
  return {
    pending: () => pending !== null,
    start(source: StartupSource = 'manual'): Promise<void> {
      if (pending) return pending
      if (handlers.ready()) return Promise.resolve()
      let complete!: () => void
      const operation = new Promise<void>(resolve => { complete = resolve })
      pending = operation
      void (async () => {
        try { handlers.begin(source); await handlers.initialize() }
        catch (error) { handlers.failed(error) }
        finally { pending = null; complete() }
      })()
      return operation
    },
  }
}
