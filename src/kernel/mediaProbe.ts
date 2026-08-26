/**
 * Reads intrinsic properties of a media file — dimensions, and for video its
 * duration.
 *
 * Separate from thumbnails.ts because this is far cheaper: metadata only, no
 * seek, no decode of a frame, no canvas. A clip dropped on the timeline needs
 * the duration and nothing else, and making that wait on a full frame decode
 * would put a visible pause between the drop and the block appearing.
 */

import type { MediaKind } from './fsBridge'

/** How long a still image occupies the timeline. The convention most NLEs use. */
export const DEFAULT_IMAGE_DURATION = 5

const METADATA_TIMEOUT_MS = 12_000

export interface MediaInfo {
  width: number
  height: number
  /** Seconds. Images have no inherent duration, so they report the default. */
  duration: number
}

const cache = new Map<string, MediaInfo | null>()
const inflight = new Map<string, Promise<MediaInfo | null>>()

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

async function probeVideo(url: string): Promise<MediaInfo> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.src = url

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('video metadata unreadable'))
      }),
      METADATA_TIMEOUT_MS,
      'video metadata',
    )

    // A stream with no known duration reports Infinity. Treating that as a clip
    // length would produce a block of infinite width.
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
    if (duration === 0) throw new Error('video reports no usable duration')

    return { width: video.videoWidth, height: video.videoHeight, duration }
  } finally {
    video.onloadedmetadata = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
  }
}

async function probeImage(url: string): Promise<MediaInfo> {
  const img = new Image()
  img.src = url
  await withTimeout(img.decode(), METADATA_TIMEOUT_MS, 'image decode')
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    duration: DEFAULT_IMAGE_DURATION,
  }
}

export function cachedProbe(filePath: string): MediaInfo | null | undefined {
  return cache.get(filePath)
}

/** Null when the file could not be read — an unsupported codec, a truncated file. */
export function probeMedia(
  filePath: string,
  kind: MediaKind,
  url: string,
): Promise<MediaInfo | null> {
  const cached = cache.get(filePath)
  if (cached !== undefined) return Promise.resolve(cached)

  const existing = inflight.get(filePath)
  if (existing) return existing

  const job = (async () => {
    try {
      const info = kind === 'video' ? await probeVideo(url) : await probeImage(url)
      cache.set(filePath, info)
      return info
    } catch (err) {
      console.warn(`[flux] could not probe ${filePath}`, err)
      cache.set(filePath, null)
      return null
    } finally {
      inflight.delete(filePath)
    }
  })()

  inflight.set(filePath, job)
  return job
}
