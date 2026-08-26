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
 *     would otherwise occupy a queue slot forever.
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
const pending: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < CONCURRENCY) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => pending.push(resolve))
}

function release() {
  const next = pending.shift()
  if (next) next()
  else active--
}

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
 */
export function requestThumbnail(
  filePath: string,
  kind: MediaKind,
  url: string,
): Promise<string | null> {
  const cached = cache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)

  const existing = inflight.get(filePath)
  if (existing) return existing

  const job = (async () => {
    await acquire()
    try {
      const thumbnail = kind === 'video' ? await videoThumbnail(url) : await imageThumbnail(url)
      cache.set(filePath, thumbnail)
      return thumbnail
    } catch (err) {
      console.warn(`[flux] no thumbnail for ${filePath}`, err)
      cache.set(filePath, null)
      return null
    } finally {
      release()
      inflight.delete(filePath)
    }
  })()

  inflight.set(filePath, job)
  return job
}

/** Forget a path's cached result so the next request decodes it again. */
export function invalidateThumbnail(filePath: string) {
  cache.delete(filePath)
}
