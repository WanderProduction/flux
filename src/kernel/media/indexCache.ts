import { assetUrl } from '../fsBridge'
import { workEnded, workQueued, workStarted } from '../mediaWork'
import { displaySize, readAudioTrack, readVideoTrack } from '../../../shared/mp4.js'
import { BYTES_PER_SAMPLE, decodeTrack, encodeTrack } from '../../../shared/mp4Index.js'

/**
 * Where a sample table comes from: memory, then disk, then the file.
 *
 * Most of what an open costs is not the parsing. The moov is found by stepping
 * through the file's top-level boxes, and every step is a ranged request
 * through `flux-asset://`, which is an IPC round trip. Measured: six of them,
 * 5.7ms of the 6ms a short clip takes and 12.6ms of the 22ms a 36,000-frame
 * one does — before a single frame is read.
 *
 * So this is as much a cache of a conversation as of a computation, and what
 * it mainly buys is replacing six round trips with one.
 *
 * ## Three layers, and why the middle one earns its keep
 *
 * **Memory** covers the case that actually happens while cutting: the Viewer
 * opens a source per clip, so scrubbing back and forth across a cut reopens
 * the same two files over and over. A hit here costs nothing at all.
 *
 * **Disk** covers reopening a project tomorrow. Without it the first look at
 * every clip pays the full price again — and "every clip" is the point, since
 * the cost is per source, not per project.
 *
 * **The file** is what both of them are avoiding, and it stays the fallback
 * for everything: a cache miss, a stale entry, a build with no bridge at all.
 * Nothing here can make a file unplayable, only slower to open.
 *
 * ## Failures are remembered for the session, and no longer
 *
 * A webm, or an mp4 with an edit list, is refused by the demuxer every time —
 * and the Viewer would ask again on every clip change, paying the same six
 * round trips to be told the same thing. Worth remembering. Worth remembering
 * *only in memory*: a refusal written to disk outlives the reason for it, and
 * a file that a later FLUX could play would go on being refused by a cache
 * entry written by an older one. The successful side is safe to persist
 * because it is checked against the file; a refusal has nothing to check.
 */

/**
 * What uncompressed samples are, for a track that needs no decoder.
 *
 * Present only on PCM audio, and when it is present `codec` and `description`
 * are null — there is nothing to name and nothing to configure, because the
 * samples *are* the audio. See parsePcmEntry in shared/mp4.js.
 */
export interface PcmFormat {
  /** Bits per channel per frame: 8, 16, 24, 32 or 64. */
  bits: number
  float: boolean
  bigEndian: boolean
  signed: boolean
  channels: number
  sampleRate: number
}

export interface VideoTrack {
  /** Null on PCM audio, which has no codec to name. */
  codec: string | null
  /** Null on PCM audio, which has nothing to configure a decoder with. */
  description: Uint8Array | null
  pcm?: PcmFormat
  width: number
  height: number
  /** 0 on a video track. */
  channels: number
  /** 0 on a video track. */
  sampleRate: number
  timescale: number
  duration: number
  count: number
  offset: Float64Array
  bytes: Uint32Array
  dts: Float64Array
  pts: Float64Array
  key: Uint8Array
  order: Int32Array
  /**
   * Degrees counter-clockwise the picture must be turned to be upright.
   *
   * `width` and `height` above stay coded, so a vertically shot clip is
   * 1920x1080 with a rotation of 90. See displaySize() in shared/mp4.js.
   */
  rotation: number
}

export type TrackResult = { ok: true; track: VideoTrack } | { ok: false; reason: string }

/**
 * Which of a file's tracks is wanted.
 *
 * Both are the same sample table with a different description box, so they take
 * the same path through here and are cached the same way. They are separate
 * entries rather than one: a clip usually needs only its picture, and reading
 * the audio index to find that out would double the cost of every open.
 */
export type TrackKind = 'video' | 'audio'

/** What each kind is filed under, in memory and on disk. */
const ENTRY_NAME: Record<TrackKind, string> = {
  video: 'video-index',
  audio: 'audio-index',
}

/**
 * How much decoded index to keep in memory.
 *
 * At 33 bytes a frame this is around forty hours of footage — far more than a
 * timeline holds, and small next to a single decoded frame at 4K. The budget
 * is here so a long session browsing a drive full of media cannot grow without
 * limit, not because indexes are expensive.
 */
const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024

interface Entry {
  token: string
  track: VideoTrack
  bytes: number
}

/** Insertion order is use order: a hit is deleted and re-set. */
const memory = new Map<string, Entry>()
const refused = new Map<string, { token: string; reason: string }>()
const inflight = new Map<string, Promise<TrackResult>>()
/**
 * Writes that have been started and not finished.
 *
 * The app does not wait for a store — the index is already in hand and someone
 * is waiting to see a frame. But *forgetting* has to wait for it, or a write
 * still in flight lands after the entry was deleted and puts it back. Which is
 * not merely untidy: "delete the media cache" that sometimes does not is worse
 * than one that never did, because the next thing anyone does is trust it.
 */
const writing = new Map<string, Promise<unknown>>()

/** Where each answer came from. Read by scripts/verify-playback.mjs. */
const stats = { memory: 0, disk: 0, demux: 0, stored: 0, refused: 0 }

export type IndexCacheStats = typeof stats

export function indexCacheStats(): IndexCacheStats {
  return { ...stats }
}

/**
 * Empties the in-memory layer, leaving disk alone.
 *
 * For the harness, which has to be able to ask "does the *disk* cache work"
 * without restarting the app — and would otherwise only ever be measuring the
 * memory layer in front of it.
 */
export function clearIndexMemory(): void {
  memory.clear()
  refused.clear()
  for (const key of Object.keys(stats) as Array<keyof IndexCacheStats>) stats[key] = 0
}

interface MediaBridge {
  sourceToken: (path: string) => Promise<string | null>
  read: (path: string, name: string, token: string) => Promise<Uint8Array | null>
  has: (path: string, name: string, token: string) => Promise<boolean>
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

function remember(key: string, token: string, track: VideoTrack) {
  memory.delete(key)
  memory.set(key, { token, track, bytes: track.count * BYTES_PER_SAMPLE })

  let held = 0
  for (const entry of memory.values()) held += entry.bytes
  // Oldest use first, which is what Map iteration gives once every hit
  // re-inserts.
  for (const [oldest, entry] of memory) {
    if (held <= MEMORY_BUDGET_BYTES) break
    memory.delete(oldest)
    held -= entry.bytes
  }
}

/**
 * What is remembered about this path right now, without building anything.
 *
 * `trackFor` is the only other way to ask, and it is not a question — it is an
 * instruction, because a miss demuxes the file. The readiness strip has to be
 * able to report on a clip without causing the work it is reporting on, or
 * drawing the strip would turn every timeline into a hundred demuxes.
 *
 * Deliberately does not check the source token: that is a stat per clip per
 * paint. An index for a file that has since changed reads as ready here and is
 * rebuilt on the next open, which is a strip briefly optimistic rather than a
 * strip that costs a hundred stats to draw.
 */
export function cachedTrack(path: string, kind: TrackKind = 'video'): VideoTrack | null {
  return memory.get(`${kind}:${path}`)?.track ?? null
}

/**
 * Why this path was refused, if it was.
 *
 * A file FLUX cannot read is the one readiness state that is not about waiting:
 * no amount of work will make it playable, and a strip that showed it as merely
 * unfinished would be telling the editor to be patient about something broken.
 */
export function refusedReason(path: string, kind: TrackKind = 'video'): string | null {
  return refused.get(`${kind}:${path}`)?.reason ?? null
}

/**
 * Is this path's index on disk, so it will still be ready after a restart?
 *
 * Separate from `cachedTrack` because the two answer different questions. In
 * memory means "this plays now"; on disk means "this plays now *and* after the
 * project is reopened", which is the state worth showing the editor — it is the
 * difference between work that has been banked and work that is about to be
 * done again.
 */
export async function indexOnDisk(path: string, kind: TrackKind = 'video'): Promise<boolean> {
  const bridge = mediaBridge()
  if (!bridge?.has) return false
  const token = await bridge.sourceToken(path).catch(() => null)
  if (token === null) return false
  return bridge.has(path, ENTRY_NAME[kind], token).catch(() => false)
}

/**
 * Throws away everything remembered about a file's index, on disk and in
 * memory, so the next open reads the file itself.
 *
 * The primitive behind "delete the media cache" — see electron/mediaCache.js.
 * It is also the only way to ask whether the *cold* path still works, which is
 * a question a suite has to be able to ask more than once.
 */
export async function forgetIndex(path: string, kind: TrackKind = 'video'): Promise<void> {
  const key = `${kind}:${path}`
  /*
   * Both halves of what might already be under way, in order.
   *
   * A read in flight has not issued its write yet, so waiting only for writes
   * deletes the entry and then watches the read put it straight back. That is
   * not a test artifact: the Viewer opens a source the moment a clip appears,
   * so "delete the media cache" pressed while a project is loading would leave
   * behind exactly the entries the user was trying to be rid of.
   */
  await inflight.get(key)?.catch(() => {})
  await writing.get(key)?.catch(() => {})
  memory.delete(key)
  refused.delete(key)
  await mediaBridge()?.forget(path, ENTRY_NAME[kind]).catch(() => false)
}

export interface VideoInfo {
  /**
   * As displayed, with the file's rotation already applied — so a vertically
   * shot clip reports 1080x1920 even though it is coded 1920x1080.
   *
   * This is the shape a sequence takes from its first clip, which is the only
   * thing this is used for, and the displayed shape is the only one that
   * answers it. Reporting the coded shape gave a landscape sequence for
   * vertical footage with the picture letterboxed inside it — on two in five
   * files in the library this was built against.
   */
  width: number
  height: number
  /** Frames per second, from the sample table rather than a container field. */
  frameRate: number
  duration: number
  /** Degrees counter-clockwise the picture carries. 0 unless the file is turned. */
  rotation: number
}

/**
 * The shape of a file's picture, or null.
 *
 * The frame rate comes from counting: samples divided by duration, which is
 * what the file actually contains. A container's declared rate is a hint an
 * encoder may have got wrong, and a sequence built on the wrong rate puts every
 * cut a fraction of a frame out.
 */
export async function videoInfoFor(path: string): Promise<VideoInfo | null> {
  const index = await trackFor(path, 'video')
  if (!index.ok || !(index.track.duration > 0)) return null
  const { count, duration, rotation } = index.track
  const shown = displaySize(index.track)
  return { width: shown.width, height: shown.height, duration, frameRate: count / duration, rotation }
}

/** Reads bytes for the demuxer through the same ranged protocol the decoder uses. */
function rangeReader(url: string) {
  let total: number | null = null
  return {
    async size(): Promise<number> {
      if (total !== null) return total
      const res = await fetch(url, { method: 'HEAD' })
      if (!res.ok) throw new Error(`HEAD ${res.status}`)
      total = Number(res.headers.get('Content-Length') ?? 0)
      return total
    },
    async read(start: number, end: number): Promise<Uint8Array> {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
      if (!res.ok && res.status !== 206) throw new Error(`GET ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}

/**
 * The sample table for a file.
 *
 * Concurrent callers for the same path share one answer. The Viewer and a
 * future compositor will both want a source the moment a clip appears, and two
 * demuxes of one file racing each other is twelve round trips to learn the
 * same thing twice.
 */
export function trackFor(path: string, kind: TrackKind = 'video'): Promise<TrackResult> {
  const key = `${kind}:${path}`
  const existing = inflight.get(key)
  if (existing) return existing

  /*
   * Reported as one step rather than two. This queue has no waiting room — a
   * demux is cheap enough that it runs when it is asked for — so queued and
   * started are the same instant, and pretending otherwise would put rows in
   * the panel that are never in the state they claim.
   */
  workQueued('index', path)
  workStarted('index', path)
  const work = resolve(path, kind, key)
    .then((result) => {
      workEnded('index', path, result.ok ? 'done' : 'failed', result.ok ? undefined : result.reason)
      return result
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, work)
  return work
}

async function resolve(path: string, kind: TrackKind, key: string): Promise<TrackResult> {
  const bridge = mediaBridge()
  const name = ENTRY_NAME[kind]

  /*
   * The identity first, and on its own.
   *
   * This is a stat and nothing more, which is the point: it says whether
   * anything remembered about this path still applies, for a fraction of a
   * millisecond. Reading the entry to find out would make a memory hit cost a
   * megabyte off disk to answer a question the memory layer exists to avoid.
   */
  const token = bridge ? await bridge.sourceToken(path).catch(() => null) : null

  const held = memory.get(key)
  if (held && (token === null || held.token === token)) {
    stats.memory += 1
    remember(key, held.token, held.track)
    return { ok: true, track: held.track }
  }

  const no = refused.get(key)
  if (no && token !== null && no.token === token) {
    stats.refused += 1
    return { ok: false, reason: no.reason }
  }

  if (bridge && token !== null) {
    const bytes = await bridge.read(path, name, token).catch(() => null)
    const track = bytes ? (decodeTrack(bytes) as VideoTrack | null) : null
    if (track) {
      stats.disk += 1
      remember(key, token, track)
      return { ok: true, track }
    }
    // No entry, or an unreadable one — a layout from before a demuxer change,
    // or a file cut short by a crash. Rebuild; the write below replaces it.
  }

  stats.demux += 1
  let result
  try {
    const read = kind === 'audio' ? readAudioTrack : readVideoTrack
    result = await read(rangeReader(assetUrl(path)))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  if (!result.ok) {
    if (token !== null) refused.set(key, { token, reason: result.reason })
    return { ok: false, reason: result.reason }
  }

  const track = result.track as VideoTrack
  if (token !== null) remember(key, token, track)

  if (bridge && token !== null) {
    // Not awaited. The index is already in hand, and the caller is waiting to
    // show a frame — whether tomorrow's open is fast is not their problem.
    const stored = bridge
      .write(path, name, token, encodeTrack(track))
      .then((written) => {
        if (written?.ok) stats.stored += 1
      })
      .catch(() => {})
      .finally(() => {
        if (writing.get(key) === stored) writing.delete(key)
      })
    writing.set(key, stored)
  }

  return { ok: true, track }
}
