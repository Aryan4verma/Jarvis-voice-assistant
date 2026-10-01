/** Shared immediate command entry for Space and keyword detection. No greeting. */
export function enterCommand({ cancel, silence, reset, listen }: { cancel: () => void; silence: () => void; reset: () => void; listen: () => void }) {
  cancel(); silence(); reset(); listen()
}
