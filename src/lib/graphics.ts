/** ECO defaults: DPR 1, 30 FPS while active; no animation in standby/hidden tabs. */
export const ECO = Object.freeze({ dpr: 1, frameMs: 1000 / 30, background: '#01060c' })
export function shouldAnimate(phase: string, hidden: boolean): boolean { return !hidden && phase !== 'offline' && phase !== 'dormant' }
