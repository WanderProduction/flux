import { assetUrl } from '../fsBridge'
import { readVideoTrack } from '../../../shared/mp4.js'
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

export interface VideoTrack {
  codec: string
  description: Uint8Array
  width: number
  height: number
  timescale: number
  duration: number
  count: number
  offset: Float64Array
  bytes: Uint32Array
  dts: Float64Array
  pts: Float64Array
  key: Uint8Array
  order: Int32Array
}

export type TrackResult = { ok: true; track: VideoTrack } | { ok: false; reason: string }

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
  readIndex: (path: string, token: string) => Promise<Uint8Array | null>
  writeIndex: (
    path: string,
    token: string,
    bytes: Uint8Array,
  ) => Promise<{ ok: boolean; reason?: string }>
}

function mediaBridge(): MediaBridge | null {
  return (globalThis as { flux?: { media?: MediaBridge } }).flux?.media ?? null
}

function remember(path: string, token: string, track: VideoTrack) {
  memory.delete(path)
  memory.set(path, { token, track, bytes: track.count * BYTES_PER_SAMPLE })

  let held = 0
  for (const entry of memory.values()) held += entry.bytes
  // Oldest use first, which is what Map iteration gives once every hit
  // re-inserts.
  for (const [key, entry] of memory) {
    if (held <= MEMORY_BUDGET_BYTES) break
    memory.delete(key)
    held -= entry.bytes
  }
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
export function trackFor(path: string): Promise<TrackResult> {
  const existing = inflight.get(path)
  if (existing) return existing

  const work = resolve(path).finally(() => inflight.delete(path))
  inflight.set(path, work)
  return work
}

async function resolve(path: string): Promise<TrackResult> {
  const bridge = mediaBridge()

  /*
   * The identity first, and on its own.
   *
   * This is a stat and nothing more, which is the point: it says whether
   * anything remembered about this path still applies, for a fraction of a
   * millisecond. Reading the entry to find out would make a memory hit cost a
   * megabyte off disk to answer a question the memory layer exists to avoid.
   */
  const token = bridge ? await bridge.sourceToken(path).catch(() => null) : null

  const held = memory.get(path)
  if (held && (token === null || held.token === token)) {
    stats.memory += 1
    remember(path, held.token, held.track)
    return { ok: true, track: held.track }
  }

  const no = refused.get(path)
  if (no && token !== null && no.token === token) {
    stats.refused += 1
    return { ok: false, reason: no.reason }
  }

  if (bridge && token !== null) {
    const bytes = await bridge.readIndex(path, token).catch(() => null)
    const track = bytes ? (decodeTrack(bytes) as VideoTrack | null) : null
    if (track) {
      stats.disk += 1
      remember(path, token, track)
      return { ok: true, track }
    }
    // No entry, or an unreadable one — a layout from before a demuxer change,
    // or a file cut short by a crash. Rebuild; the write below replaces it.
  }

  stats.demux += 1
  let result
  try {
    result = await readVideoTrack(rangeReader(assetUrl(path)))
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  if (!result.ok) {
    if (token !== null) refused.set(path, { token, reason: result.reason })
    return { ok: false, reason: result.reason }
  }

  const track = result.track as VideoTrack
  if (token !== null) remember(path, token, track)

  if (bridge && token !== null) {
    // Not awaited. The index is already in hand, and the caller is waiting to
    // show a frame — whether tomorrow's open is fast is not their problem.
    void bridge
      .writeIndex(path, token, encodeTrack(track))
      .then((written) => {
        if (written?.ok) stats.stored += 1
      })
      .catch(() => {})
  }

  return { ok: true, track }
}
