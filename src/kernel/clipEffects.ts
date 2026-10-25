/**
 * What a clip does to its picture and its sound before it is composited.
 *
 * The parameters an editor reaches for first: where the frame sits, how big it
 * is, which way up, how opaque, how much of it is cropped away, and how loud.
 * Premiere calls this Effect Controls and puts Motion at the top of it; the
 * names and the units here are its names and its units, because someone coming
 * from that will type 50 into Scale and expect half.
 *
 * ## Nothing is stored until it is touched
 *
 * `effects` is optional on a clip and stays absent until a parameter actually
 * moves off its default. Two reasons, and both matter more than the bytes.
 *
 * A document is a record of decisions, and a clip carrying `rotation: 0` is
 * claiming someone decided not to rotate it. Worse, the defaults for position
 * and anchor are *the centre of the frame*, so writing them down would pin
 * them to the sequence size they were written at — resize a 1080x1920 sequence
 * to 1080x1080 afterwards and every clip would still be anchored at y=960,
 * half of them off the bottom. Resolved against the frame instead, they simply
 * stay centred.
 *
 * ## Why percentages and degrees rather than a matrix
 *
 * A matrix is what this becomes on the way to the screen, and it is the wrong
 * thing to store: it cannot be read, it cannot be typed into a field, and the
 * same picture has many matrices. Keeping the parameters as the numbers a
 * person set means the panel shows what they set, and the composition of them
 * is decided in one place — see `transformOf` — rather than being whatever
 * order the last caller happened to multiply in.
 */

export interface Point {
  x: number
  y: number
}

export interface Crop {
  /** Percent of the frame taken off each edge. 0 is the whole picture. */
  left: number
  top: number
  right: number
  bottom: number
}

export interface Transform {
  /** Where the anchor point lands, in sequence pixels from the top left. */
  position: Point
  /** The point the clip is scaled and rotated about, in sequence pixels. */
  anchor: Point
  /** Percent. 100 is the size it would be with no transform at all. */
  scale: number
  /** Percent, horizontal only. Ignored while `uniform` is true. */
  scaleWidth: number
  uniform: boolean
  /** Degrees clockwise, the way Premiere's dial reads. */
  rotation: number
  /** Percent. 0 is invisible, 100 is solid. */
  opacity: number
  crop: Crop
  /** Degrees of shear. Premiere has no such control; After Effects does. */
  skew: Point
}

export interface ClipAudio {
  /** Decibels, 0 being the level it was recorded at. */
  level: number
  mute: boolean
  /** -100 hard left, 0 centred, +100 hard right. */
  pan: number
}

export interface ClipEffects {
  transform?: Partial<Transform>
  audio?: Partial<ClipAudio>
}

export interface Size {
  width: number
  height: number
}

/** The quietest level the fader goes to before it means silence. */
export const MIN_LEVEL_DB = -60

/**
 * What a clip does when nothing has been set, given the frame it sits in.
 *
 * Centred, full size, upright, opaque, uncropped — which is to say, exactly
 * what the compositor did before any of this existed. That is the point: a
 * sequence full of untouched clips has to render identically to one from
 * before there were parameters at all.
 */
export function defaultTransform(frame: Size): Transform {
  return {
    position: { x: frame.width / 2, y: frame.height / 2 },
    anchor: { x: frame.width / 2, y: frame.height / 2 },
    scale: 100,
    scaleWidth: 100,
    uniform: true,
    rotation: 0,
    opacity: 100,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    skew: { x: 0, y: 0 },
  }
}

export function defaultAudio(): ClipAudio {
  return { level: 0, mute: false, pan: 0 }
}

/**
 * A number from a document, or the default when it is not one.
 *
 * `??` is not enough here: a .flux is a file a person can edit, and NaN or a
 * string passes `?? ` untouched and then turns a whole composite black with no
 * indication of which clip did it. Every parameter below goes through this.
 */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function point(stored: Partial<Point> | undefined, base: Point): Point {
  return { x: num(stored?.x, base.x), y: num(stored?.y, base.y) }
}

/** A stored transform filled out against the frame it is being drawn into. */
export function resolveTransform(
  stored: Partial<Transform> | undefined,
  frame: Size,
): Transform {
  const base = defaultTransform(frame)
  if (!stored) return base
  return {
    position: point(stored.position, base.position),
    anchor: point(stored.anchor, base.anchor),
    scale: num(stored.scale, base.scale),
    scaleWidth: num(stored.scaleWidth, base.scaleWidth),
    uniform: stored.uniform ?? base.uniform,
    rotation: num(stored.rotation, base.rotation),
    // Clamped, not merely coerced: there is no such thing as 150% opaque, and
    // a negative alpha makes the compositor draw nothing at all.
    opacity: Math.min(100, Math.max(0, num(stored.opacity, base.opacity))),
    crop: {
      left: num(stored.crop?.left, base.crop.left),
      top: num(stored.crop?.top, base.crop.top),
      right: num(stored.crop?.right, base.crop.right),
      bottom: num(stored.crop?.bottom, base.crop.bottom),
    },
    skew: point(stored.skew, base.skew),
  }
}

export function resolveAudio(stored: Partial<ClipAudio> | undefined): ClipAudio {
  const base = defaultAudio()
  if (!stored) return base
  return {
    level: Math.max(MIN_LEVEL_DB, num(stored.level, base.level)),
    mute: stored.mute ?? base.mute,
    pan: Math.min(100, Math.max(-100, num(stored.pan, base.pan))),
  }
}

/**
 * Whether anything here would change the picture or the sound.
 *
 * Asked by the panel, to show which sections have been touched, and by the
 * export, which refuses what it cannot yet render. Compared against the
 * resolved defaults rather than against `undefined`, so a clip that was set
 * back to 100% by hand counts as untouched — it is.
 */
export function isTransformed(stored: Partial<Transform> | undefined, frame: Size): boolean {
  if (!stored) return false
  const t = resolveTransform(stored, frame)
  const d = defaultTransform(frame)
  return (
    t.position.x !== d.position.x ||
    t.position.y !== d.position.y ||
    t.anchor.x !== d.anchor.x ||
    t.anchor.y !== d.anchor.y ||
    t.scale !== d.scale ||
    (!t.uniform && t.scaleWidth !== d.scaleWidth) ||
    t.uniform !== d.uniform ||
    t.rotation !== d.rotation ||
    t.opacity !== d.opacity ||
    t.crop.left !== 0 ||
    t.crop.top !== 0 ||
    t.crop.right !== 0 ||
    t.crop.bottom !== 0 ||
    t.skew.x !== 0 ||
    t.skew.y !== 0
  )
}

export function isAudioTouched(stored: Partial<ClipAudio> | undefined): boolean {
  if (!stored) return false
  const a = resolveAudio(stored)
  return a.level !== 0 || a.mute || a.pan !== 0
}

/**
 * The crop, as a rectangle of the source picture to take.
 *
 * In the picture's own pixels rather than the frame's, because cropping
 * happens to the clip before it is placed — crop 50% off the left and what is
 * left is half a picture, which is then positioned and scaled like any other.
 * Doing it the other way round would make the crop move when the clip did.
 *
 * Opposite edges that together take everything leave a zero-width rectangle,
 * which is not drawn rather than being an error: dragging two crops past each
 * other is a thing a hand does on the way somewhere.
 */
export function cropRect(crop: Crop, picture: Size) {
  const left = (Math.min(100, Math.max(0, crop.left)) / 100) * picture.width
  const right = (Math.min(100, Math.max(0, crop.right)) / 100) * picture.width
  const top = (Math.min(100, Math.max(0, crop.top)) / 100) * picture.height
  const bottom = (Math.min(100, Math.max(0, crop.bottom)) / 100) * picture.height
  return {
    x: left,
    y: top,
    width: Math.max(0, picture.width - left - right),
    height: Math.max(0, picture.height - top - bottom),
  }
}

/**
 * The 2D matrix a transform comes to, as `[a, b, c, d, e, f]` — the order
 * `CanvasRenderingContext2D.setTransform` takes.
 *
 * Composed in one place so that every surface agrees on what the parameters
 * mean together, which is the part that is easy to get wrong and impossible to
 * notice: the same five numbers applied in a different order put the picture
 * somewhere else entirely, and both look plausible until two clips are meant
 * to line up.
 *
 * The order is the one After Effects and Premiere use. Read right to left, a
 * point of the picture is first moved so the anchor sits at the origin, then
 * skewed, then scaled, then rotated, and finally moved out to `position`.
 * Anchor first is what makes rotation turn about the anchor rather than about
 * the picture's corner, which is the whole reason the control exists.
 */
export function transformOf(t: Transform): [number, number, number, number, number, number] {
  const scaleY = t.scale / 100
  const scaleX = (t.uniform ? t.scale : t.scaleWidth) / 100
  const radians = (t.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const shearX = Math.tan((t.skew.x * Math.PI) / 180)
  const shearY = Math.tan((t.skew.y * Math.PI) / 180)

  // scale ∘ skew
  const a0 = scaleX
  const b0 = scaleY * shearY
  const c0 = scaleX * shearX
  const d0 = scaleY

  // rotate ∘ (scale ∘ skew)
  const a = cos * a0 - sin * b0
  const b = sin * a0 + cos * b0
  const c = cos * c0 - sin * d0
  const d = sin * c0 + cos * d0

  return [a, b, c, d, t.position.x, t.position.y]
}
