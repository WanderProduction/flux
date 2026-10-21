/**
 * What a render does, as settings rather than as constants in the encoder.
 *
 * shared/renderFormat.js holds the *format* — the flags, and the measurements
 * behind each one. This holds the handful of them a person is allowed to move,
 * plus where the files go. The split matters: the format is a finding, arrived
 * at by encoding this library's own footage and scoring it, and nothing in the
 * UI should imply it is a matter of preference. What is genuinely a choice is
 * the quality/size trade, how hard to drive the disk, and the output folder.
 *
 * Saved in the project document under `settings.render`, so a project reopens
 * rendering the way it last rendered — and changing one marks the project
 * dirty, because it is a real decision about the work rather than a view state.
 *
 * ## Frame rate is the one with a trap in it
 *
 * `source` keeps every clip at the rate it was shot, which is what an archive
 * wants: this library mixes 25, 29.97 and 50fps, and the 50fps material is kept
 * for slow motion. `sequence` conforms everything to the sequence's rate, which
 * is what an editor wants when the output is a set of deliverables.
 *
 * It defaults to `source`, and not as a coin flip. A silent conform is the
 * exact failure the verifier was built to catch — an Adobe export in the
 * encode tests turned an 1850-frame 50fps source into 1108 frames at 29.97 and
 * looked perfectly healthy. Choosing it should be a thing you did on purpose.
 */

const MIN_CQ = 1
const MAX_CQ = 51

export type FrameRatePolicy = 'source' | 'sequence'

export interface RenderSettings {
  /** Absolute path, or null until one is chosen. */
  outDir: string | null
  /** Constant-quality target. Lower is bigger and better. */
  cq: number
  /** Keyframe interval in frames. One second at the sequence rate is the point. */
  gop: number
  /** Encodes at once. */
  concurrency: number
  frameRate: FrameRatePolicy
  /** Skip outputs that already exist and verify. */
  resume: boolean
}

export const DEFAULTS: RenderSettings = {
  outDir: null,
  cq: 26,
  gop: 30,
  concurrency: 2,
  frameRate: 'source',
  resume: true,
}

let settings: RenderSettings = { ...DEFAULTS }
const listeners = new Set<() => void>()
let onChange: (() => void) | null = null

export function subscribeRenderSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRenderSettings(): RenderSettings {
  return settings
}

/**
 * Lets kernel/project.ts hear about changes without this module importing it.
 *
 * The dependency only runs one way: project reads these settings when it saves
 * and writes them back when it opens. If this module called into project to
 * mark it dirty, the two would import each other.
 */
export function onRenderSettingsChanged(handler: () => void): void {
  onChange = handler
}

/**
 * Applies a change, clamped to what the encoder will accept.
 *
 * Clamped here rather than at the input, because the setting is reachable from
 * the palette and from a restored project as well as from the panel — and a
 * CQ of 300 read out of a hand-edited document should become a number the
 * encoder takes, not a render that fails four hundred times.
 */
export function updateRenderSettings(change: Partial<RenderSettings>, options?: { persist?: boolean }): void {
  const next: RenderSettings = {
    ...settings,
    ...change,
    cq: clamp(change.cq ?? settings.cq, MIN_CQ, MAX_CQ),
    gop: clamp(Math.round(change.gop ?? settings.gop), 1, 600),
    /*
     * Capped at eight because that is what NVENC allows concurrently on current
     * drivers. The practical limit is lower and it is the disk, not the GPU:
     * these are 60-100 Mbps sources read off spinning drives, and four parallel
     * reads of large files on one spindle is slower in total than two.
     */
    concurrency: clamp(Math.round(change.concurrency ?? settings.concurrency), 1, 8),
  }
  if (JSON.stringify(next) === JSON.stringify(settings)) return
  settings = next
  listeners.forEach((listener) => listener())
  if (options?.persist !== false) onChange?.()
}

/** Restores from a project document. Never marks the project dirty. */
export function setRenderSettings(stored: Partial<RenderSettings> | undefined): void {
  settings = { ...DEFAULTS }
  if (stored) updateRenderSettings(stored, { persist: false })
  else listeners.forEach((listener) => listener())
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}
