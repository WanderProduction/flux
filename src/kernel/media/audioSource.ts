import { assetUrl } from '../fsBridge'
import { sampleAt } from '../../../shared/mp4.js'
import { trackFor, type VideoTrack } from './indexCache'

/**
 * One audio file, read forward as decoded sound.
 *
 * The audio twin of media/videoSource.ts, and deliberately a narrower thing.
 * The Viewer needs a *particular* frame at a *particular* moment, so a video
 * source has to be addressable by time and hold what it decodes. Sound is only
 * ever wanted in order and only ever wanted once: the mixer asks for the next
 * frame, hands it to the audio device, and never looks at it again.
 *
 * So this is a cursor, not a buffer. `seek` puts it somewhere and `next` walks
 * forward from there.
 *
 * ## Frames come out whole
 *
 * An AAC frame is 1024 samples — about 21ms — and it is handed over as it
 * arrives rather than being spliced to an exact request. The mixer schedules
 * each one at its own timestamp, which is sample-accurate without anything
 * here having to do arithmetic on sample offsets. Splicing would add a class
 * of bug (an off-by-one in the seam between two frames is a click, forty-seven
 * times a second) in exchange for nothing.
 *
 * ## AudioData is borrowed
 *
 * Same rule as `VideoFrame` and for the same reason — see media/peaks.ts. Each
 * one is copied into plain Float32Arrays and closed immediately, so the
 * decoder's pool never runs dry and nothing downstream has to think about
 * lifetimes.
 */

/**
 * Frames decoded before the one asked for, and thrown away.
 *
 * AAC's filter bank overlaps consecutive frames, so decoding from a standing
 * start produces one frame of wrong-sounding audio before it settles. Two
 * frames of run-up costs 40ms of decode and removes the click at the start of
 * every seek.
 */
const PREROLL_FRAMES = 2

/** Chunks allowed to sit in the decoder before feeding waits for it. */
const MAX_QUEUED_CHUNKS = 24

/** Never ask for more than this in one range request. */
const MAX_FETCH_BYTES = 1 << 20

/** A bound, not a deadline: a decode gone wrong must surface as silence, not a hang. */
const FRAME_TIMEOUT_MS = 4000

export interface AudioFrame {
  /** Seconds from the start of the file. */
  time: number
  duration: number
  sampleRate: number
  /**
   * One array per channel, owned by the caller.
   *
   * Spelled with its buffer type because Web Audio's copyToChannel will not
   * take an array that might be backed by a SharedArrayBuffer, and the plain
   * `Float32Array` alias leaves that open.
   */
  planes: Float32Array<ArrayBuffer>[]
}

export interface AudioInfo {
  channels: number
  sampleRate: number
  duration: number
}

export type OpenFailure = 'no-webcodecs' | 'unsupported-config' | (string & Record<never, never>)

export function hasAudioDecoder(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined'
}

export class AudioSource {
  private constructor(
    private readonly url: string,
    private readonly track: VideoTrack,
  ) {}

  private decoder: AudioDecoder | null = null
  /** Decoded and not yet handed out, in order. */
  private ready: AudioFrame[] = []
  /** Next sample index to submit, or -1 at the end of the file. */
  private nextSample = -1
  /** Frames earlier than this are run-up and are dropped. */
  private from = 0
  private feeding: Promise<void> | null = null
  private closed = false
  private failed = false
  private waiters: Array<() => void> = []
  /** Bumped on every seek, so a feed in flight can ask whether it is still wanted. */
  private generation = 0
  /**
   * Frames the decoder has produced since the last seek.
   *
   * Only interesting as a ratio to how many were *wanted*. Seeking to the right
   * sample and filtering the run-up are two different mechanisms, and each
   * covers for the other well enough that breaking one alone changes nothing
   * audible — so the cheap one has to be checked by counting rather than by
   * listening. See scripts/verify-playback.mjs.
   */
  decoded = 0

  static async open(
    path: string,
  ): Promise<{ ok: true; source: AudioSource } | { ok: false; reason: OpenFailure }> {
    if (!hasAudioDecoder()) return { ok: false, reason: 'no-webcodecs' }

    const index = await trackFor(path, 'audio')
    if (!index.ok) return { ok: false, reason: index.reason }

    const track = index.track
    const config: AudioDecoderConfig = {
      codec: track.codec,
      description: track.description,
      sampleRate: track.sampleRate,
      numberOfChannels: track.channels,
    }
    const support = await AudioDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) return { ok: false, reason: 'unsupported-config' }

    return { ok: true, source: new AudioSource(assetUrl(path), track) }
  }

  get info(): AudioInfo {
    return {
      channels: this.track.channels,
      sampleRate: this.track.sampleRate,
      duration: this.track.duration,
    }
  }

  get broken(): boolean {
    return this.failed
  }

  close(): void {
    this.closed = true
    this.ready = []
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
  }

  /** Points the cursor at `time`, throwing away anything decoded for elsewhere. */
  seek(time: number): void {
    this.generation += 1
    this.ready = []
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    this.from = time
    this.decoded = 0
    this.nextSample = Math.max(0, sampleAt(this.track, time) - PREROLL_FRAMES)
  }

  /**
   * The next frame at or after the cursor, or null at the end of the file.
   *
   * Frames that end before the seek point are dropped here rather than never
   * decoded: they are the run-up AAC needs, and they have to go through the
   * decoder to do their job.
   */
  async next(): Promise<AudioFrame | null> {
    if (this.closed || this.failed) return null

    const deadline = performance.now() + FRAME_TIMEOUT_MS
    for (;;) {
      while (this.ready.length > 0) {
        const frame = this.ready.shift() as AudioFrame
        if (frame.time + frame.duration > this.from) return frame
      }
      if (this.nextSample < 0 && !this.feeding) {
        // Everything has been submitted; drain whatever the decoder still holds.
        const decoder = this.decoder
        if (decoder && decoder.state === 'configured') {
          await decoder.flush().catch(() => {
            this.failed = true
          })
          this.decoder = null
          if (this.ready.length > 0) continue
        }
        return null
      }

      if (!this.feeding) {
        this.feeding = this.feed().finally(() => {
          this.feeding = null
        })
      }
      if (performance.now() > deadline) return null

      const arrived = new Promise<void>((resolve) => this.waiters.push(resolve))
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 40))])
      if (this.closed || this.failed) return null
    }
  }

  private wake() {
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) resolve()
  }

  private ensureDecoder(): AudioDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder

    const mine = this.generation
    const decoder = new AudioDecoder({
      output: (data) => {
        try {
          if (this.closed || this.generation !== mine) return
          const channels = data.numberOfChannels
          const frames = data.numberOfFrames
          const planes: Float32Array<ArrayBuffer>[] = []
          for (let c = 0; c < channels; c++) {
            const plane = new Float32Array(frames)
            data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
            planes.push(plane)
          }
          this.decoded += 1
          this.ready.push({
            time: (data.timestamp ?? 0) / 1e6,
            duration: frames / (data.sampleRate || this.track.sampleRate),
            sampleRate: data.sampleRate || this.track.sampleRate,
            planes,
          })
        } finally {
          // Copied, so the pool gets its buffer straight back.
          data.close()
          this.wake()
        }
      },
      error: () => {
        this.failed = true
        this.wake()
      },
    })
    decoder.configure({
      codec: this.track.codec,
      description: this.track.description,
      sampleRate: this.track.sampleRate,
      numberOfChannels: this.track.channels,
    })
    this.decoder = decoder
    return decoder
  }

  /**
   * Submits the next span of samples.
   *
   * By span rather than by run of adjacent samples, for the reason
   * media/videoSource.ts spells out: audio and video are interleaved in an mp4,
   * so "fetch while contiguous" degrades to one request per frame.
   */
  private async feed(): Promise<void> {
    const track = this.track
    const mine = this.generation
    if (this.nextSample < 0) return

    const from = this.nextSample
    let to = from
    while (
      to + 1 < track.count &&
      track.offset[to + 1] + track.bytes[to + 1] - track.offset[from] <= MAX_FETCH_BYTES
    ) {
      to += 1
    }

    const start = track.offset[from]
    const span = track.offset[to] + track.bytes[to] - start
    let bytes: Uint8Array
    try {
      const res = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${start + span - 1}` },
      })
      if (!res.ok && res.status !== 206) throw new Error(`GET ${res.status}`)
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch {
      this.failed = true
      this.wake()
      return
    }

    // The await above is where a seek gets in.
    if (this.closed || this.failed || this.generation !== mine) return

    const decoder = this.ensureDecoder()
    let submitted = from - 1
    for (let i = from; i <= to; i++) {
      const at = track.offset[i] - start
      if (at + track.bytes[i] > bytes.length) break
      decoder.decode(
        new EncodedAudioChunk({
          // Every AAC frame stands on its own; there are no delta frames to
          // mark, which is why seeking in audio is cheap where seeking in video
          // is not.
          type: 'key',
          timestamp: Math.round(track.pts[i] * 1e6),
          data: bytes.subarray(at, at + track.bytes[i]),
        }),
      )
      submitted = i
      // Stop short rather than piling the whole span into the decoder, and
      // resume from here next time. Advancing past what was actually submitted
      // is how frames go missing without anything reporting an error.
      if (decoder.decodeQueueSize > MAX_QUEUED_CHUNKS) break
    }
    this.nextSample = submitted + 1 >= track.count ? -1 : submitted + 1
  }
}
