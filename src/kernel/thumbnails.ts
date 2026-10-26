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

interface MediaBridge {
  sourceToken: (path: string) => Promise<string | null>
  read: (path: string, name: string, token: string) => Promise<Uint8Array | null>
  write: (
    path: string,
    name: string,
    token: string,
    bytes: Uint8Array,
  ) => Promise<{ ok: boolean; reason?: string }>
  forget: (path: string, name: string) => Promise<boolean>
}

function mediaBridge(): MediaBridge | null {
  return (globalThis as { flux?: { media?: MediaBridge } }).flux?.media ?? null
}

/**
 * The thumbnail this file had last time, if the file has not changed since.
 *
 * The token is a stat rather than a hash, so a file edited in place is not
 * served its old picture — the same rule the other two caches use, and the
 * reason they can be trusted across sessions at all.
 */
async function fromDisk(filePath: string): Promise<string | undefined> {
  const bridge = mediaBridge()
  if (!bridge) return undefined
  try {
    const token = await bridge.sourceToken(filePath)
    if (!token) return undefined
    const bytes = await bridge.read(filePath, ENTRY_NAME, token)
    if (!bytes || bytes.length === 0) return undefined
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Stores in flight, so anything that needs the write to have landed can wait.
 *
 * The app never waits: a thumbnail is on screen the moment it is decoded, and
 * making the card wait for a disk write would be paying for the cache twice.
 * That leaves a window in which the thumbnail exists and is not yet on disk,
 * and the only way to ask about it was to poll and hope — which lost the race
 * whenever the machine was busy, including whenever FLUX itself was indexing
 * in the background.
 */
const storing = new Map<string, Promise<void>>()

/**
 * Forgets in flight, so a store cannot land before the delete it follows.
 *
 * `invalidateThumbnail` does not wait for the disk entry to go — nothing
 * calling it wants to. But the next thumbnail for that file is written while
 * that delete may still be on its way, and a delete that lands second removes
 * the entry that was just written. From outside it looks exactly like a write
 * that never happened, which is how it was read for some time.
 */
const forgetting = new Map<string, Promise<unknown>>()

/** How the last store went, for the harnesses. See toDisk. */
let lastStore: { path: string; ok: boolean; reason?: string } | null = null

/** How the last store went, or null if none has been attempted. */
export function lastThumbnailStore(): { path: string; ok: boolean; reason?: string } | null {
  return lastStore
}

/** Resolves once any store in flight for this file has settled. */
export async function thumbnailSettled(filePath: string): Promise<void> {
  await storing.get(filePath)?.catch(() => {})
}

/**
 * Writes one down. Failures are deliberately **not** written.
 *
 * A file that could not be decoded this time may be a file on a drive that was
 * not mounted, and remembering "no thumbnail" for it on disk would make a
 * temporary condition permanent. In memory it is a useful guard against
 * retrying all session; on disk it would be a lie that outlives the reason.
 */
async function toDisk(filePath: string, thumbnail: string): Promise<void> {
  const bridge = mediaBridge()
  if (!bridge) return
  try {
    // After any delete already on its way, or it removes what this writes.
    await forgetting.get(filePath)
    const token = await bridge.sourceToken(filePath)
    if (!token) {
      lastStore = { path: filePath, ok: false, reason: 'no-token' }
      return
    }
    const written = await bridge.write(
      filePath,
      ENTRY_NAME,
      token,
      new TextEncoder().encode(thumbnail),
    )
    lastStore = { path: filePath, ok: !!written?.ok, reason: written?.reason }
  } catch (err) {
    // A cache that cannot be written is a slower app, not a broken one — but
    // it should still be possible to find out why, which was not true before:
    // every reason a store can fail was swallowed here, so a suite could only
    // report that nothing arrived.
    lastStore = { path: filePath, ok: false, reason: String(err) }
  }
}
import { workEnded, workQueued, workStarted } from './mediaWork'

/**
 * Filed under this in the media cache, beside the waveforms and the frame
 * indexes. See electron/mediaCache.js.
 *
 * Thumbnails used to be the one derived thing FLUX forgot on every launch: a
 * Map and nothing else. Reopening a project re-decoded a frame of every file
 * it showed, which is the most visible work the app does and the least
 * necessary — the answer had been computed, it had simply never been written
 * down.
 */
const ENTRY_NAME = 'thumb'

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

  workQueued('thumbnail', filePath)
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
  workEnded('thumbnail', filePath, 'dropped', 'nothing was asking for it any more')
  held.settle(null)
}

/** Decodes asked for and not yet started. For the harnesses. */
export function thumbnailsWaiting(): number {
  return waiting.size
}

function begin(filePath: string, kind: MediaKind, url: string): Promise<string | null> {
  active += 1
  workStarted('thumbnail', filePath)
  const job = (async () => {
    try {
      const kept = await fromDisk(filePath)
      if (kept !== undefined) {
        cache.set(filePath, kept)
        workEnded('thumbnail', filePath, 'done')
        return kept
      }
      const thumbnail = kind === 'video' ? await videoThumbnail(url) : await imageThumbnail(url)
      cache.set(filePath, thumbnail)
      /*
       * Still not awaited — see toDisk — but recorded, so a caller that
       * genuinely needs it on disk can wait for exactly this write instead of
       * polling for it to appear.
       */
      const stored = toDisk(filePath, thumbnail).finally(() => {
        if (storing.get(filePath) === stored) storing.delete(filePath)
      })
      storing.set(filePath, stored)
      workEnded('thumbnail', filePath, 'done')
      return thumbnail
    } catch (err) {
      console.warn(`[flux] no thumbnail for ${filePath}`, err)
      cache.set(filePath, null)
      workEnded('thumbnail', filePath, 'failed', String((err as Error)?.message ?? err))
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

/**
 * Forget a path's cached result so the next request decodes it again.
 *
 * Both layers, because a disk entry the memory no longer knows about would
 * come straight back on the next request and the invalidation would read as
 * having silently failed.
 */
export function invalidateThumbnail(filePath: string) {
  cache.delete(filePath)
  /*
   * Work already under way is let go of too, and this is the whole point.
   *
   * Without it, invalidating is not invalidating: a request that started
   * before the call is still in `inflight`, the next caller is handed *its*
   * result, and that result was decoded earlier and will never be stored —
   * because the store happens where a thumbnail is made, and this one is not
   * being made, it is being reused. So the caller gets a picture, the disk
   * entry that was just forgotten stays forgotten, and nothing anywhere says
   * so.
   *
   * Measured at one time in twenty asking for it in a tight loop, and about
   * half the time in a suite where other thumbnails are in flight — which is
   * exactly the shape of a flake that gets widened and widened and never
   * fixed.
   *
   * Dropping the entry does not cancel the decode: whatever is running will
   * finish and store itself as usual. It only stops it answering for a
   * question asked after the invalidate.
   */
  inflight.delete(filePath)
  waiting.delete(filePath)
  // Recorded rather than merely started, so the next store waits for it. See
  // `forgetting`.
  const gone = (mediaBridge()?.forget(filePath, ENTRY_NAME) ?? Promise.resolve())
    .catch(() => {})
    .finally(() => {
      if (forgetting.get(filePath) === gone) forgetting.delete(filePath)
    })
  forgetting.set(filePath, gone)
}
