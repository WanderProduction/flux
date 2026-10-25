/**
 * The arithmetic behind the Viewer: what shape the frame is, how big it is on
 * screen, and how many pixels are worth compositing into it.
 *
 * Pure functions, no state. The panel holds zoom and pan — they are where you
 * happen to be looking, not a fact about the work — and the two resolution
 * preferences ride in the project's view state, where they neither mark the
 * document dirty nor follow a project onto someone else's machine as an edit.
 *
 * Keeping the maths here rather than in the component is what lets it be
 * checked without a window: zoom-toward-the-cursor in particular is easy to get
 * subtly wrong in a way that is maddening to debug by hand and trivial to pin
 * down with three numbers.
 */

/** `fit` means "whatever makes the frame fill the stage"; a number is a scale. */
export type Zoom = 'fit' | number

/**
 * The levels the menu offers, as Premiere's does.
 *
 * Below 10% a 4K frame is a postage stamp and above 1600% a single pixel is
 * most of the panel; both ends are past the point of being useful, which is
 * why this is a list rather than a range.
 */
export const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16] as const

/**
 * How much of the sequence's own resolution to composite.
 *
 * This is the lever Premiere calls Playback Resolution, and it buys exactly one
 * thing: fewer pixels to scale into and fewer to hand the compositor. It does
 * *not* make the decoders do less work — a decoded frame arrives at its coded
 * size whatever this says — so it pays off on stacks and on big frames rather
 * than on a single small clip.
 */
export const RESOLUTIONS = [
  { value: 1, label: 'Full' },
  { value: 1 / 2, label: '1/2' },
  { value: 1 / 4, label: '1/4' },
  { value: 1 / 8, label: '1/8' },
  { value: 1 / 16, label: '1/16' },
] as const

export type Resolution = (typeof RESOLUTIONS)[number]['value']

/** The default pair: full when stopped on a frame, a quarter while running. */
export const DEFAULT_PLAYBACK_RESOLUTION: Resolution = 1 / 2
export const DEFAULT_PAUSED_RESOLUTION: Resolution = 1

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * `1920×1080` -> `16:9`, `1080×1920` -> `9:16`, `1080×1350` -> `4:5`.
 *
 * Reduced by the greatest common divisor, so any custom size gets a name
 * instead of a special case — the familiar ratios are not a list here, they
 * are just the ones that reduce to small numbers.
 *
 * A ratio that reduces to something unwieldy (`1001:540`) is reported as a
 * decimal instead, because "1001:540" tells nobody anything and "1.85:1" is
 * the thing a camera department would actually say.
 */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return '—'
  const divisor = gcd(Math.round(width), Math.round(height))
  const w = Math.round(width) / divisor
  const h = Math.round(height) / divisor
  if (w <= 64 && h <= 64) return `${w}:${h}`
  return `${(width / height).toFixed(2)}:1`
}

/**
 * The scale at which the frame exactly fills the stage without cropping.
 *
 * Zero when either box has no area. A stage with no size is the ordinary state
 * for one paint after mount — before a ResizeObserver has measured it — and a
 * fit scale of Infinity there would put the frame at an absurd size for a
 * frame and then snap it back, which reads as a flash on every panel open.
 */
export function fitScale(frame: Size, stage: Size): number {
  if (!(frame.width > 0) || !(frame.height > 0)) return 0
  if (!(stage.width > 0) || !(stage.height > 0)) return 0
  return Math.min(stage.width / frame.width, stage.height / frame.height)
}

/**
 * The scale actually in force, resolving `fit` against the stage.
 *
 * A zoom that is not a finite number is not a zoom, and is treated as Fit.
 * Without this one NaN is self-sustaining: the scale feeds the ref that the
 * next zoom step reads, so a single bad value makes every later one NaN too,
 * and the only visible symptom is the frame vanishing with
 * "`NaN` is an invalid value for the `width` css style property" in the
 * console — which names the stylesheet rather than the arithmetic.
 */
export function resolveZoom(zoom: Zoom, frame: Size, stage: Size): number {
  if (zoom === 'fit' || !Number.isFinite(zoom)) return fitScale(frame, stage)
  return zoom
}

/**
 * Where the frame has to move so that the point under the cursor stays under
 * the cursor as the scale changes.
 *
 * `pointer` and `pan` are both measured from the centre of the stage, which is
 * where the frame sits when the pan is zero.
 *
 * Without this, a wheel zoom pulls everything towards the middle: you point at
 * the corner of a shot, zoom in, and the thing you were pointing at leaves the
 * panel. The identity being preserved is that some point of the picture is
 * under the cursor and must still be — in frame space that point is
 * `(pointer - pan) / from`, and holding it fixed at the new scale gives the
 * line below.
 */
export function zoomToward(pointer: Point, pan: Point, from: number, to: number): Point {
  if (!(from > 0) || !(to > 0)) return pan
  const ratio = to / from
  return {
    x: pointer.x - (pointer.x - pan.x) * ratio,
    y: pointer.y - (pointer.y - pan.y) * ratio,
  }
}

/**
 * The next level up or down from wherever the zoom currently is.
 *
 * Takes the *resolved* scale rather than the Zoom, so stepping up from `fit`
 * goes to the first level above whatever fit happens to be — which is what
 * makes a zoom-in from Fit feel like one step rather than a jump to 100%.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const levels = ZOOM_LEVELS
  if (direction > 0) {
    return levels.find((level) => level > current * 1.001) ?? levels[levels.length - 1]
  }
  return [...levels].reverse().find((level) => level < current * 0.999) ?? levels[0]
}

/**
 * How many pixels to composite into, at a given resolution.
 *
 * Floored at 16 on each axis: a 1/16 preview of a small frame would otherwise
 * round towards a canvas a few pixels across, and a canvas of zero width
 * throws outright. The point of a low resolution is to be cheap, not absent.
 */
export function framePixels(frame: Size, resolution: number): Size {
  return {
    width: Math.max(16, Math.round(frame.width * resolution)),
    height: Math.max(16, Math.round(frame.height * resolution)),
  }
}

/** `0.25` -> `1/4`, for anything that has a number and needs the label. */
export function resolutionLabel(resolution: number): string {
  return RESOLUTIONS.find((r) => Math.abs(r.value - resolution) < 1e-6)?.label ?? 'Full'
}

/** `'fit'` -> `Fit`, `1` -> `100%`. */
export function zoomLabel(zoom: Zoom): string {
  return zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`
}
