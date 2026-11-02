import { assetUrl } from '../fsBridge'
import type { ClipSource } from './clipSource'
import type { Shown, SourceInfo } from './videoSource'

/**
 * One picture, addressed by time — and the same picture at every time.
 *
 * The still half of the pipeline, and it is this small on purpose. Everything
 * that makes `videoSource.ts` three thousand lines is about a codec: frames
 * are borrowed from a decoder's small pool, a seek costs a run up from a
 * keyframe, playing backwards needs runs decoded forwards and shrunk. None of
 * it applies to a JPEG. So a still is decoded once, held, and handed back —
 * and the direction the playhead is travelling, the resolution it is being
 * drawn at and how fast it is shuttling make no difference to the answer.
 *
 * ## The bitmap is lent, not given
 *
 * `shownFor` returns the *same* `ImageBitmap` every time, and the Viewer must
 * not close it — which is the rule already, because a `VideoSource` owns and
 * closes its frames too and the composite has never closed a picture it was
 * handed. Worth stating because the two are different in kind: a `VideoFrame`
 * that is held too long stops a decoder, where this one is simply a bitmap
 * and holding it costs only its own memory. A still is the cheap case in
 * every direction.
 *
 * ## Why it is a class at all
 *
 * A map from path to `ImageBitmap` would show the same picture. But then the
 * composite would have a second way of getting one, with its own branch in
 * the draw loop, its own cache and its own eviction — and the next thing that
 * wants a picture (a title, a colour matte, an adjustment layer) would need a
 * third. Behind one interface they are all "a thing a clip plays". See
 * `ClipSource`.
 */
/**
 * The longest edge a held bitmap may have.
 *
 * A still off a modern camera is 6000x4000, and an `ImageBitmap` is four bytes
 * a pixel however the file was compressed — so holding one costs 96MB for a
 * 7MB JPEG, and four of them is most of a gigabyte. What the composite does
 * with it is draw it into the sequence frame, so every pixel past that frame's
 * size is memory spent on detail that is scaled away before anyone sees it.
 *
 * 3840 rather than the sequence's own width, because a source does not know
 * which sequence it is being drawn into and the same file may be in two. It is
 * generous — a 4K sequence loses nothing at all — and it turns the worst case
 * from 96MB into 33MB.
 */
const MAX_STILL_EDGE = 3840

export class StillSource implements ClipSource {
  private constructor(
    readonly path: string,
    private picture: ImageBitmap,
  ) {}

  private closed = false

  /**
   * Decodes the file, once.
   *
   * `imageOrientation: 'from-image'` is what honours a camera's EXIF rotation,
   * and it is why `info.rotation` below is always zero: the bitmap comes back
   * already upright, so there is nothing left for the composite to turn. That
   * is the opposite of the video path, where the decoder hands back the coded
   * picture and the display matrix is applied downstream — and the difference
   * is worth knowing, because a still rotated twice is a still lying on its
   * side.
   *
   * The failure shape matches `VideoSource.open` so that a caller opening
   * either does not have to care which it got.
   */
  static async open(
    path: string,
  ): Promise<{ ok: true; source: StillSource } | { ok: false; reason: string }> {
    if (typeof createImageBitmap !== 'function') return { ok: false, reason: 'no-imagebitmap' }

    try {
      const response = await fetch(assetUrl(path))
      if (!response.ok) return { ok: false, reason: 'unreadable' }
      const blob = await response.blob()
      const full = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return { ok: true, source: new StillSource(path, await withinBudget(full)) }
    } catch {
      /*
       * A file that is not a picture, a picture in a format this build cannot
       * decode, or one that has gone since it was imported. All three are the
       * same answer to the composite — fall back and say why — and telling
       * them apart here would mean guessing from a DOMException's message.
       */
      return { ok: false, reason: 'unreadable' }
    }
  }

  get info(): SourceInfo {
    return {
      codec: 'still',
      width: this.picture.width,
      height: this.picture.height,
      /*
       * A still has no length of its own. Zero rather than Infinity, because
       * this number is read to lay things out and to say how long a file is —
       * and `Infinity` formats as a timecode nobody can read, where zero reads
       * as "it does not have one", which is true. How long a *clip* of it runs
       * for is a fact about the clip; see `Clip.still`.
       */
      duration: 0,
      frames: 1,
      // Already applied. See `open`.
      rotation: 0,
    }
  }

  /** A still cannot fail after it has opened: there is nothing left to do. */
  get broken(): boolean {
    return false
  }

  /**
   * The picture, whatever time is asked for.
   *
   * The timestamp is the moment asked for rather than anything intrinsic,
   * because the composite writes it onto the canvas as "what is on screen" and
   * every check downstream reads it to know which frame it is looking at. A
   * still that reported a timestamp of zero for every frame would make the
   * viewer look stuck on a sequence that is playing perfectly well — and that
   * is exactly the reading a frames-drawn harness takes.
   */
  async shownFor(time: number): Promise<Shown | null> {
    if (this.closed) return null
    return {
      picture: this.picture,
      width: this.picture.width,
      height: this.picture.height,
      timestamp: Math.max(0, time) * 1e6,
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.picture.close()
  }
}

/**
 * The same picture, no larger than `MAX_STILL_EDGE` on its long edge.
 *
 * Two steps, because the resize has to know which edge is longer and only a
 * decoded bitmap can say. The first one is closed — a bitmap that has been
 * replaced and not released is the whole of the memory this exists to save,
 * paid twice.
 *
 * A failed resize keeps the full-size bitmap rather than failing the open: a
 * still that is larger than we would like is better than no still.
 */
async function withinBudget(picture: ImageBitmap): Promise<ImageBitmap> {
  const longest = Math.max(picture.width, picture.height)
  if (longest <= MAX_STILL_EDGE) return picture

  const scale = MAX_STILL_EDGE / longest
  try {
    const smaller = await createImageBitmap(picture, {
      resizeWidth: Math.max(1, Math.round(picture.width * scale)),
      resizeHeight: Math.max(1, Math.round(picture.height * scale)),
      resizeQuality: 'high',
    })
    picture.close()
    return smaller
  } catch {
    return picture
  }
}
