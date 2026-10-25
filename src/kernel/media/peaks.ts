import { readPcm } from './audioSource'
import { assetUrl } from '../fsBridge'
import { trackFor, type VideoTrack } from './indexCache'
import {
  bucketCount,
  decodePeaks,
  encodePeaks,
  PEAKS_PER_SECOND,
  type Peaks,
} from '../../../shared/peaks.js'

/**
 * Building a waveform, once per file.
 *
 * The audio has to be decoded from end to end — there is no shortcut to
 * knowing how loud a moment is — so this is the one derived thing in FLUX that
 * is genuinely expensive rather than merely repeated. It is also the one that
 * Premiere makes you watch a progress bar for.
 *
 * So: it happens in the background, once, and the result is kept. Clips draw
 * without a waveform until it arrives, which is what every NLE does; a timeline
 * that will not show a clip until its audio has been read would be worse than
 * one that fills the waveform in a moment later.
 *
 * ## AudioData is borrowed, like VideoFrame
 *
 * Same trap, same rule — see media/videoSource.ts. Each `AudioData` handed back
 * by the decoder holds a buffer from a small pool, and holding them stops the
 * decoder rather than merely using memory. Here it is easy to get right,
 * because nothing needs to be kept: the samples are folded into buckets and the
 * object is closed in the same breath.
 *
 * ## The queue is what needs throttling
 *
 * Not the frames — the *chunks*. An hour of AAC is 150,000 of them, and
 * submitting them all before the decoder has caught up would hold the whole
 * compressed track in memory. So the feed waits whenever the decoder is more
 * than a second or so behind.
 */

/** Filed under this in the media cache. See electron/mediaCache.js. */
const ENTRY_NAME = 'peaks'

/** Chunks allowed to sit in the decoder before the feed waits for it. */
const MAX_QUEUED_CHUNKS = 64

/** Never ask for more than this in one range request. */
const MAX_FETCH_BYTES = 8 << 20

/**
 * A bound on the whole job, not a deadline anyone should hit.
 *
 * A decode that has gone wrong must surface as a clip without a waveform, not
 * as a promise nothing ever settles.
 */
const BUILD_TIMEOUT_MS = 120_000

export type PeaksResult = { ok: true; peaks: Peaks } | { ok: false; reason: string }

const memory = new Map<string, { token: string; peaks: Peaks }>()
const refused = new Map<string, { token: string; reason: string }>()
const inflight = new Map<string, Promise<PeaksResult>>()
/**
 * Writes started and not finished — see media/indexCache.ts for why forgetting
 * has to wait for them even though nothing else does.
 */
const writing = new Map<string, Promise<unknown>>()

const stats = { memory: 0, disk: 0, built: 0, stored: 0, refused: 0 }
export type PeaksStats = typeof stats

export function peaksStats(): PeaksStats {
  return { ...stats }
}

/**
 * Throws away a file's waveform, on disk and in memory.
 *
 * The primitive behind "delete the media cache", and the only way to ask
 * whether building one from scratch still works — a question that has to be
 * askable more than once, which a cache is otherwise very good at preventing.
 */
export async function forgetPeaks(path: string): Promise<void> {
  // The build first, then its write — see media/indexCache.ts. A waveform being
  // built when the cache is emptied would otherwise store itself afterwards.
  await inflight.get(path)?.catch(() => {})
  await writing.get(path)?.catch(() => {})
  memory.delete(path)
  refused.delete(path)
  await mediaBridge()?.forget(path, ENTRY_NAME).catch(() => false)
}

/** Empties the in-memory layer, leaving disk alone. For the harness. */
export function clearPeaksMemory(): void {
  memory.clear()
  refused.clear()
  for (const key of Object.keys(stats) as Array<keyof PeaksStats>) stats[key] = 0
}

/**
 * The peaks already in hand for a file, without asking for any to be built.
 *
 * What a clip renders from. Synchronous on purpose: a waveform is drawn on
 * every redraw, and a component that awaited one would flicker through an
 * empty state on every zoom.
 */
export function cachedPeaks(path: string): Peaks | null {
  return memory.get(path)?.peaks ?? null
}

export interface AudioInfo {
  channels: number
  sampleRate: number
  duration: number
}

/**
 * Whether a file has sound, and if not, which kind of "not".
 *
 * Three answers rather than two, because the difference matters to whoever is
 * looking at the timeline wondering where their audio block went. A file shot
 * without a microphone is *silent* and there is nothing to place; a file whose
 * audio FLUX cannot yet read is *unreadable* and there is something to place
 * once the demuxer grows — and telling someone the second is the first would be
 * a lie they could act on, by going to look for a fault in their footage.
 */
export type AudioState =
  | ({ kind: 'sound' } & AudioInfo)
  | { kind: 'silent' }
  | { kind: 'unreadable'; detail: string }

export async function audioStateFor(path: string): Promise<AudioState> {
  const index = await trackFor(path, 'audio')
  if (index.ok) {
    const { channels, sampleRate, duration } = index.track
    return { kind: 'sound', channels, sampleRate, duration }
  }
  // The demuxer's own words for "this file has no soundtrack". Every other
  // reason it can give — an unsupported codec, a fragmented file, a malformed
  // box — is about FLUX, not about the footage.
  return index.reason === 'no-audio-track'
    ? { kind: 'silent' }
    : { kind: 'unreadable', detail: index.reason }
}

/**
 * What audio a file has, or null if it has none.
 *
 * Reads the audio track's index and nothing more — six ranged requests the
 * first time and nothing after that, against the several hundred milliseconds
 * a waveform costs. That difference is why this is a separate question: a drop
 * needs to know *whether* to make an audio clip immediately, and can find out
 * what the sound looks like whenever.
 */
export async function audioInfoFor(path: string): Promise<AudioInfo | null> {
  const state = await audioStateFor(path)
  return state.kind === 'sound'
    ? { channels: state.channels, sampleRate: state.sampleRate, duration: state.duration }
    : null
}

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

function hasAudioDecoder(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined'
}

/**
 * Waveforms built at once.
 *
 * Thumbnails have had a limit since the beginning, with a note saying that
 * kicking off a hundred video decodes when a folder opens will hitch the whole
 * window. Building a waveform is the *more* expensive of the two — the audio is
 * decoded end to end — and it had no limit at all, so dropping a shoot folder
 * started a hundred and sixteen of them in the same tick.
 *
 * Two rather than three: a waveform decode runs flat out for its whole length,
 * where a thumbnail is one seek and one frame, and the point of the limit is to
 * leave the main thread enough room to stay answerable.
 */
const CONCURRENCY = 2

let active = 0

interface Waiting {
  /** How many clips are asking. A file on the timeline three times counts three. */
  wanted: number
  promise: Promise<PeaksResult>
  settle: (result: PeaksResult) => void
}

/** Asked for, not started. Insertion order is the running order. */
const waiting = new Map<string, Waiting>()

/**
 * Peaks for a file: memory, then disk, then the decoder.
 *
 * Concurrent callers share one job — a timeline with the same file on it three
 * times must not decode its audio three times — and a job waits its turn rather
 * than starting the moment it is asked for.
 */
export function peaksFor(path: string): Promise<PeaksResult> {
  const existing = inflight.get(path)
  if (existing) return existing

  const held = waiting.get(path)
  if (held) {
    held.wanted += 1
    return held.promise
  }

  if (active < CONCURRENCY) return begin(path)

  let settle!: (result: PeaksResult) => void
  const promise = new Promise<PeaksResult>((resolveWith) => {
    settle = resolveWith
  })
  waiting.set(path, { wanted: 1, promise, settle })
  return promise
}

/**
 * Says a caller no longer needs a waveform it asked for.
 *
 * Delete the audio of a clip and its block goes; the waveform it had queued is
 * then work for something nobody can see. A job that has already started is
 * left to finish — it is most of the way through by definition and the result
 * is worth keeping — but one still waiting is dropped, which is what makes
 * clearing a long timeline cheap instead of merely eventual.
 */
export function abandonPeaks(path: string): void {
  const held = waiting.get(path)
  if (!held) return
  held.wanted -= 1
  if (held.wanted > 0) return
  waiting.delete(path)
  held.settle({ ok: false, reason: 'no longer needed' })
}

/** Jobs asked for and not yet started. For the harnesses. */
export function peaksWaiting(): number {
  return waiting.size
}

function begin(path: string): Promise<PeaksResult> {
  active += 1
  const work = resolve(path)
    .catch((err): PeaksResult => ({ ok: false, reason: String(err?.message ?? err) }))
    .finally(() => {
      inflight.delete(path)
      active -= 1
      pump()
    })
  inflight.set(path, work)
  return work
}

/** Starts whatever is waiting, up to the limit. */
function pump(): void {
  while (active < CONCURRENCY && waiting.size > 0) {
    const [path, entry] = waiting.entries().next().value as [string, Waiting]
    waiting.delete(path)
    void begin(path).then(entry.settle)
  }
}

async function resolve(path: string): Promise<PeaksResult> {
  const bridge = mediaBridge()
  const token = bridge ? await bridge.sourceToken(path).catch(() => null) : null

  const held = memory.get(path)
  if (held && (token === null || held.token === token)) {
    stats.memory += 1
    return { ok: true, peaks: held.peaks }
  }

  const no = refused.get(path)
  if (no && token !== null && no.token === token) {
    stats.refused += 1
    return { ok: false, reason: no.reason }
  }

  if (bridge && token !== null) {
    const bytes = await bridge.read(path, ENTRY_NAME, token).catch(() => null)
    const peaks = bytes ? (decodePeaks(bytes) as Peaks | null) : null
    if (peaks) {
      stats.disk += 1
      memory.set(path, { token, peaks })
      return { ok: true, peaks }
    }
  }

  if (!hasAudioDecoder()) return { ok: false, reason: 'no-webcodecs' }

  const index = await trackFor(path, 'audio')
  if (!index.ok) {
    // No audio track is a perfectly ordinary answer — most of the fixtures in
    // this repo are silent — so it is remembered rather than asked again on
    // every redraw.
    if (token !== null) refused.set(path, { token, reason: index.reason })
    return { ok: false, reason: index.reason }
  }

  stats.built += 1
  let peaks: Peaks
  try {
    peaks = await build(path, index.track)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'decode-failed'
    if (token !== null) refused.set(path, { token, reason })
    return { ok: false, reason }
  }

  if (token !== null) memory.set(path, { token, peaks })

  if (bridge && token !== null) {
    // Not awaited: the waveform is already drawable, and whether tomorrow is
    // fast is not this caller's problem.
    const stored = bridge
      .write(path, ENTRY_NAME, token, encodePeaks(peaks))
      .then((written) => {
        if (written?.ok) stats.stored += 1
      })
      .catch(() => {})
      .finally(() => {
        if (writing.get(path) === stored) writing.delete(path)
      })
    writing.set(path, stored)
  }

  return { ok: true, peaks }
}

/**
 * Decodes the whole track, keeping only the loudest sample in each direction
 * per bucket.
 *
 * Buckets are addressed by each `AudioData`'s own timestamp rather than by a
 * running count of samples decoded. The two agree in a well-formed file and
 * disagree in exactly the files where it matters — a gap in the audio would
 * otherwise slide every peak after it earlier, and a waveform that drifts out
 * of step with the picture is worse than no waveform.
 */
async function build(path: string, track: VideoTrack): Promise<Peaks> {
  const count = bucketCount(track.duration)
  const min = new Int8Array(count)
  const max = new Int8Array(count)

  let planes: Float32Array[] = []
  let failure: string | null = null
  let finished = false
  let waiters: Array<() => void> = []

  const wake = () => {
    const waiting = waiters
    waiters = []
    for (const resolve of waiting) resolve()
  }

  /**
   * Folds one block of samples into the buckets.
   *
   * Shared by the decoder and the uncompressed path, because the *fold* is the
   * part that has to agree between them: which bucket a sample lands in, and
   * that a bucket keeps the extremes rather than an average. Two copies of
   * that would be two waveforms, drawn differently, for the same file.
   */
  const fold = (
    blocks: Float32Array[],
    channels: number,
    frames: number,
    start: number,
    sampleRate: number,
  ) => {
    const step = 1 / (sampleRate || track.sampleRate || 48000)
    for (let i = 0; i < frames; i++) {
      const bucket = Math.floor((start + i * step) * PEAKS_PER_SECOND)
      if (bucket < 0 || bucket >= count) continue
      let low = 0
      let high = 0
      for (let c = 0; c < channels; c++) {
        const value = blocks[c][i]
        if (value < low) low = value
        if (value > high) high = value
      }
      const lowByte = Math.max(-127, Math.round(low * 127))
      const highByte = Math.min(127, Math.round(high * 127))
      if (lowByte < min[bucket]) min[bucket] = lowByte
      if (highByte > max[bucket]) max[bucket] = highByte
    }
  }

  /*
   * Uncompressed audio draws its waveform without a decoder at all — the same
   * arithmetic the mixer uses to play it. Done here as a straight read of the
   * file rather than through the decoder machinery below, because none of that
   * machinery has anything to do: no queue to drain, no flush, no error path.
   */
  if (track.pcm) {
    const url = assetUrl(path)
    const deadline = performance.now() + BUILD_TIMEOUT_MS
    let next = 0
    while (next < track.count) {
      if (performance.now() > deadline) throw new Error('timed-out')
      let to = next
      while (
        to + 1 < track.count &&
        track.offset[to + 1] + track.bytes[to + 1] - track.offset[next] <= MAX_FETCH_BYTES
      ) {
        to += 1
      }
      const from = track.offset[next]
      const span = track.offset[to] + track.bytes[to] - from
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + span - 1}` } })
      if (!res.ok && res.status !== 206) throw new Error('unreadable')
      const bytes = new Uint8Array(await res.arrayBuffer())
      for (let i = next; i <= to; i++) {
        const at = track.offset[i] - from
        if (at + track.bytes[i] > bytes.length) break
        const frame = readPcm(bytes.subarray(at, at + track.bytes[i]), track.pcm, track.pts[i])
        fold(frame.planes, frame.planes.length, frame.planes[0].length, frame.time, frame.sampleRate)
      }
      next = to + 1
    }
    return {
      perSecond: PEAKS_PER_SECOND,
      count,
      duration: track.duration,
      channels: track.channels,
      sampleRate: track.sampleRate,
      min,
      max,
    }
  }

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        if (finished) return
        const frames = data.numberOfFrames
        const channels = data.numberOfChannels
        if (planes.length < channels || planes[0]?.length < frames) {
          planes = Array.from({ length: channels }, () => new Float32Array(frames))
        }
        for (let c = 0; c < channels; c++) {
          data.copyTo(planes[c], { planeIndex: c, format: 'f32-planar' })
        }

        const start = (data.timestamp ?? 0) / 1e6
        fold(planes, channels, frames, start, data.sampleRate)
      } finally {
        // In the same breath as reading it. Held AudioData stops the decoder,
        // exactly as held VideoFrames do.
        data.close()
        wake()
      }
    },
    error: (err) => {
      failure = err.message || 'decoder-error'
      wake()
    },
  })

  decoder.configure({
    /* PCM returned above, so anything reaching a decoder has a codec. */
    codec: (track.codec as string),
    description: (track.description as Uint8Array),
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
  })

  const url = assetUrl(path)
  const deadline = performance.now() + BUILD_TIMEOUT_MS

  try {
    let next = 0
    while (next < track.count && !failure) {
      if (performance.now() > deadline) throw new Error('timed-out')

      let to = next
      while (
        to + 1 < track.count &&
        track.offset[to + 1] + track.bytes[to + 1] - track.offset[next] <= MAX_FETCH_BYTES
      ) {
        to += 1
      }

      const start = track.offset[next]
      const span = track.offset[to] + track.bytes[to] - start
      // By span rather than by run of adjacent samples: audio samples are
      // interleaved with video in an mp4, so "fetch while contiguous" is one
      // request per frame. See videoSource.ts, which learned this the same way.
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + span - 1}` } })
      if (!res.ok && res.status !== 206) throw new Error('unreadable')
      const bytes = new Uint8Array(await res.arrayBuffer())

      for (let i = next; i <= to; i++) {
        const at = track.offset[i] - start
        if (at + track.bytes[i] > bytes.length) break
        decoder.decode(
          new EncodedAudioChunk({
            type: track.key[i] ? 'key' : 'delta',
            timestamp: Math.round(track.pts[i] * 1e6),
            data: bytes.subarray(at, at + track.bytes[i]),
          }),
        )

        while (decoder.decodeQueueSize > MAX_QUEUED_CHUNKS && !failure) {
          if (performance.now() > deadline) throw new Error('timed-out')
          await Promise.race([
            new Promise<void>((resolve) => waiters.push(resolve)),
            new Promise((r) => setTimeout(r, 50)),
          ])
        }
      }
      next = to + 1
    }

    if (failure) throw new Error(failure)
    // The one place a flush belongs: everything has been submitted and the
    // decoder is still holding the tail.
    await decoder.flush()
    if (failure) throw new Error(failure)
  } finally {
    finished = true
    if (decoder.state !== 'closed') decoder.close()
  }

  return {
    perSecond: PEAKS_PER_SECOND,
    count,
    duration: track.duration,
    channels: track.channels,
    sampleRate: track.sampleRate,
    min,
    max,
  }
}
