/**
 * Thumbnail generation for asset cards.
 *
 * Decoding is done in the renderer: an <img> or a <video> seeked to a frame,
 * drawn down to a small canvas. The result is a JPEG data URL, small enough
 * that thousands of them cost megabytes rather than gigabytes — where holding
 * the full-size decoded images would not be.
 *
 * Two rules keep this from becoming the stall FLUX is supposed to avoid:
 *   - at most CONCURRENCY decodes run at once, because kicking off a hundred
 *     video decodes when a folder opens will hitch the whole window;
 *   - every decode has a deadline, because a malformed or unsupported file can
 *     leave a <video> waiting on an event that never fires, and one of those
 *     would otherwise occupy a queue slot forever;
 *   - a decode still waiting is dropped when the last card or block asking for
 *     it goes away. Scrolling a long bin or a long timeline asks for far more
 *     than it ever looks at, and finishing all of it is work for things that
 *     left the screen a minute ago.
 */

import type { MediaKind } from './fsBridge'

const MAX_EDGE = 320
const JPEG_QUALITY = 0.72
const CONCURRENCY = 3
const IMAGE_TIMEOUT_MS = 10_000
const VIDEO_TIMEOUT_MS = 15_000

/** Cached by path. `null` means "tried and failed" — worth remembering, so we don't retry forever. */
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

let active = 0

interface Waiting {
  /** How many cards or blocks are asking. The same file twice counts twice. */
  wanted: number
  promise: Promise<string | null>
  settle: (value: string | null) => void
  kind: MediaKind
  url: string
}

/** Asked for, not started. Insertion order is the running order. */
const waiting = new Map<string, Waiting>()

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function drawScaled(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('source has no dimensions')

  const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

async function imageThumbnail(url: string): Promise<string> {
  const img = new Image()
  img.src = url
  await withTimeout(img.decode(), IMAGE_TIMEOUT_MS, 'image decode')
  return drawScaled(img, img.naturalWidth, img.naturalHeight)
}

async function videoThumbnail(url: string): Promise<string> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.src = url

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('video could not be loaded'))
      }),
      VIDEO_TIMEOUT_MS,
      'video metadata',
    )

    // A tenth of the way in, capped at one second. Frame zero is very often
    // black or a fade-in, which makes for a useless card.
    const target = Number.isFinite(video.duration)
      ? Math.min(1, Math.max(0, video.duration * 0.1))
      : 0

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve()
        video.onerror = () => reject(new Error('video could not be seeked'))
        video.currentTime = target
      }),
      VIDEO_TIMEOUT_MS,
      'video seek',
    )

    return drawScaled(video, video.videoWidth, video.videoHeight)
  } finally {
    // Without this the element keeps the decoder and the file handle alive.
    video.onloadedmetadata = null
    video.onseeked = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
  }
}

/** Synchronous peek, for rendering a card that already has one. */
export function cachedThumbnail(filePath: string): string | null | undefined {
  return cache.get(filePath)
}

/**
 * Resolves to a data URL, or null when the file could not be decoded — an
 * unsupported codec inside a supported container, a truncated download, a
 * permissions problem. Callers render a placeholder for null; it is a normal
 * outcome, not an error.
 *
 * A request that cannot start yet waits under its own path rather than behind
 * an anonymous resolver, so `abandonThumbnail` can find it again.
 */
export function requestThumbnail(
  filePath: string,
  kind: MediaKind,
  url: string,
): Promise<string | null> {
  const cached = cache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)

  const running = inflight.get(filePath)
  if (running) return running

  const held = waiting.get(filePath)
  if (held) {
    held.wanted += 1
    return held.promise
  }

  if (active < CONCURRENCY) return begin(filePath, kind, url)

  let settle!: (value: string | null) => void
  const promise = new Promise<string | null>((resolveWith) => {
    settle = resolveWith
  })
  waiting.set(filePath, { wanted: 1, promise, settle, kind, url })
  return promise
}

/**
 * Says a card or block no longer needs a thumbnail it asked for.
 *
 * Scroll a bin of four hundred files, or a timeline of a hundred clips, and
 * most of what was asked for belongs to something that has since left the
 * screen. A decode already running is left alone — it holds a `<video>` and a
 * decoder, and tearing those down mid-seek is how this module used to leak
 * them — but one still waiting is simply forgotten.
 *
 * The result is **not** cached. Nothing was decided about the file, and
 * remembering a null here would leave it permanently blank the next time it
 * came into view.
 */
export function abandonThumbnail(filePath: string): void {
  const held = waiting.get(filePath)
  if (!held) return
  held.wanted -= 1
  if (held.wanted > 0) return
  waiting.delete(filePath)
  held.settle(null)
}

/** Decodes asked for and not yet started. For the harnesses. */
export function thumbnailsWaiting(): number {
  return waiting.size
}

function begin(filePath: string, kind: MediaKind, url: string): Promise<string | null> {
  active += 1
  const job = (async () => {
    try {
      const thumbnail = kind === 'video' ? await videoThumbnail(url) : await imageThumbnail(url)
      cache.set(filePath, thumbnail)
      return thumbnail
    } catch (err) {
      console.warn(`[flux] no thumbnail for ${filePath}`, err)
      cache.set(filePath, null)
      return null
    } finally {
      active -= 1
      inflight.delete(filePath)
      pump()
    }
  })()

  inflight.set(filePath, job)
  return job
}

/** Starts whatever is waiting, up to the limit. */
function pump(): void {
  while (active < CONCURRENCY && waiting.size > 0) {
    const [filePath, entry] = waiting.entries().next().value as [string, Waiting]
    waiting.delete(filePath)
    void begin(filePath, entry.kind, entry.url).then(entry.settle)
  }
}

/** Forget a path's cached result so the next request decodes it again. */
export function invalidateThumbnail(filePath: string) {
  cache.delete(filePath)
}
