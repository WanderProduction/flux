import { assetUrl } from '../fsBridge'
import { keyframeAt, readVideoTrack, sampleAt } from '../../../shared/mp4.js'

/**
 * One decoded video file, addressed by time.
 *
 * This is the WebCodecs half of the pipeline: the demuxer says which bytes are
 * which frame, and this turns them into `VideoFrame`s the Viewer can draw. It
 * replaces asking a `<video>` element to be at a time and hoping — we hold the
 * frames, so we know exactly which one is on screen.
 *
 * ## What a seek costs, and why the buffer is shaped like this
 *
 * Inter-frame codecs decode forward from a keyframe and nowhere else. Showing
 * 36.9s of a file with a keyframe every two seconds means decoding from 36.0s
 * and throwing away 22 frames on the way. That cost is unavoidable and it is
 * the reason every NLE indexes on import; what *is* avoidable is paying it
 * twice for the same GOP, so decoded frames are kept until the playhead has
 * passed them.
 *
 * ## Frames are borrowed, not owned
 *
 * A `VideoFrame` is a handle on a decoder buffer, and the decoder has a small
 * fixed pool of them. Holding frames does not merely leak memory — it **stops
 * the decoder**, which waits for buffers to come back and produces nothing
 * until they do. Measured, before this was understood: a buffer of thirty-two
 * frames turned a decode that takes 59ms into twelve frames in five seconds,
 * and every seek past the first came back empty.
 *
 * So the rule is not "close them eventually", it is *hold as few as possible*.
 * Frames behind the playhead are closed the moment they are behind it, the
 * lookahead is small enough to stay well inside the pool, and every frame that
 * leaves the decoder is closed exactly once — on trim, on seek, or on close.
 * That accounting is the least interesting and most important part of this file.
 */

/**
 * Frames decoded ahead of the playhead.
 *
 * Small on purpose. Decoding runs many times faster than playback, so a third
 * of a second of lookahead is ample cover — and every frame held past that is
 * a buffer the decoder cannot reuse. This is the number that has to stay under
 * the decoder's pool; the queue of *encoded* chunks below it can be as deep as
 * we like, because chunks cost nothing but memory.
 */
const LOOKAHEAD_FRAMES = 8

/** Never ask for more than this in one range request. */
const MAX_FETCH_BYTES = 8 << 20

/**
 * How long to wait for a frame before giving up on it.
 *
 * A bound, not a deadline anyone should hit: a decode that has gone wrong must
 * surface as a missing frame, not as a viewer that never paints again.
 */
const FRAME_TIMEOUT_MS = 5000

export interface SourceInfo {
  codec: string
  width: number
  height: number
  duration: number
  frames: number
}

interface Mp4Track {
  codec: string
  description: Uint8Array
  width: number
  height: number
  duration: number
  count: number
  offset: Float64Array
  bytes: Uint32Array
  dts: Float64Array
  pts: Float64Array
  key: Uint8Array
}

export type OpenFailure =
  | 'no-webcodecs'
  | 'unreadable'
  | 'unsupported-config'
  | (string & Record<never, never>)

/** True when this build can decode at all. */
export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

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

export class VideoSource {
  private constructor(
    private readonly url: string,
    private readonly track: Mp4Track,
  ) {}

  private decoder: VideoDecoder | null = null
  /** Decoded and not yet passed, ordered by presentation time. */
  private buffer: VideoFrame[] = []
  /** Next sample index to submit, or -1 when the decoder needs a keyframe. */
  private next = -1
  private feeding: Promise<void> | null = null
  private closed = false
  private failed = false
  /** Resolved each time the decoder hands back a frame. */
  private waiters: Array<() => void> = []
  /** The moment the caller last asked for, so arriving frames know what is stale. */
  private wantTime = 0
  /**
   * Incremented whenever the decoder is torn down and restarted.
   *
   * A feed in flight is sitting on a range request when a seek arrives. It
   * wakes up holding sample indices and byte offsets from a decoder that no
   * longer exists, and submits them to the fresh one — which is mid-GOP, so the
   * first chunk is a delta and the whole thing fails with "a key frame is
   * required". The generation is how a feed asks whether it is still wanted.
   */
  private generation = 0

  static async open(
    path: string,
  ): Promise<{ ok: true; source: VideoSource } | { ok: false; reason: OpenFailure }> {
    if (!hasWebCodecs()) return { ok: false, reason: 'no-webcodecs' }

    const url = assetUrl(path)
    let result
    try {
      result = await readVideoTrack(rangeReader(url))
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    if (!result.ok) return { ok: false, reason: result.reason }

    const track = result.track as Mp4Track
    const config: VideoDecoderConfig = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      // Hardware where it exists, software where it does not, rather than
      // refusing a file because one path is unavailable.
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: true,
    }

    // Asking first turns "this file will never work" into a fallback instead of
    // a decoder that errors on the first chunk.
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) return { ok: false, reason: 'unsupported-config' }

    return { ok: true, source: new VideoSource(url, track) }
  }

  get info(): SourceInfo {
    return {
      codec: this.track.codec,
      width: this.track.width,
      height: this.track.height,
      duration: this.track.duration,
      frames: this.track.count,
    }
  }

  /** True once the decoder has given up; the caller should fall back. */
  get broken(): boolean {
    return this.failed
  }

  close(): void {
    this.closed = true
    this.discardBuffer()
    this.decoder?.close()
    this.decoder = null
  }

  private discardBuffer() {
    for (const frame of this.buffer) frame.close()
    this.buffer = []
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.closed) {
          frame.close()
          return
        }
        this.buffer.push(frame)
        // Presentation order, which is not decode order the moment there are
        // B-frames; the caller picks by time and must be able to trust it.
        this.buffer.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        // Here, not on the way out: frames have to be handed back as they are
        // superseded, or the decoder runs out of buffers and simply stops.
        this.trim()
        this.wake()
      },
      error: () => {
        this.failed = true
        this.wake()
      },
    })
    decoder.configure({
      codec: this.track.codec,
      description: this.track.description,
      codedWidth: this.track.width,
      codedHeight: this.track.height,
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: true,
    })
    this.decoder = decoder
    return decoder
  }

  private wake() {
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) resolve()
  }

  /** Throws away decoder state and points it at the keyframe before `time`. */
  private restartAt(time: number) {
    this.generation += 1
    this.discardBuffer()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    this.next = keyframeAt(this.track as never, time)
  }

  /**
   * Submits samples so the buffer will cover `time` and a little beyond.
   *
   * Bytes are fetched by *span*, not by run of adjacent samples. Video samples
   * are not contiguous in an mp4 — audio is interleaved between them — so
   * "fetch while the next sample starts exactly where this one ends" degrades
   * to one HTTP request per frame. Reading the whole span and slicing the
   * samples out of it pulls a few kilobytes of audio along for the ride and
   * turns a GOP into one request.
   *
   * Note what is *not* here: a flush. `flush()` drains the decoder and then
   * demands a keyframe before it will accept anything else, so calling it at
   * the end of every batch makes the next batch — which starts with delta
   * frames — fail outright with "a key frame is required after flush()".
   */
  private async feed(time: number): Promise<void> {
    const track = this.track
    const mine = this.generation
    const wanted = Math.min(sampleAt(track as never, time) + LOOKAHEAD_FRAMES, track.count - 1)

    while (
      !this.closed &&
      !this.failed &&
      this.generation === mine &&
      this.next >= 0 &&
      this.next <= wanted
    ) {
      const from = this.next
      let to = from
      while (
        to + 1 <= wanted &&
        track.offset[to + 1] + track.bytes[to + 1] - track.offset[from] <= MAX_FETCH_BYTES
      ) {
        to += 1
      }

      const start = track.offset[from]
      const span = track.offset[to] + track.bytes[to] - start
      const bytes = await this.readRange(start, start + span - 1)
      // The await is where a seek gets in. Everything below is about a decoder
      // that may since have been replaced.
      if (!bytes || this.closed || this.failed || this.generation !== mine) return

      const decoder = this.ensureDecoder()
      for (let i = from; i <= to; i++) {
        const at = track.offset[i] - start
        if (at + track.bytes[i] > bytes.length) break
        decoder.decode(
          new EncodedVideoChunk({
            type: track.key[i] ? 'key' : 'delta',
            // Microseconds, which is what WebCodecs counts in.
            timestamp: Math.round(track.pts[i] * 1e6),
            data: bytes.subarray(at, at + track.bytes[i]),
          }),
        )
      }
      this.next = to + 1 >= track.count ? -1 : to + 1
    }
  }

  private async readRange(start: number, end: number): Promise<Uint8Array | null> {
    try {
      const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } })
      if (!res.ok && res.status !== 206) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /**
   * Hands back every frame the playhead has passed.
   *
   * Called as frames arrive rather than as they are used, because the decoder's
   * pool is what is being managed here, not memory. The frame covering
   * `wantTime` is always kept — it is the one about to be drawn.
   */
  private trim() {
    if (this.buffer.length === 0) return
    const keepFrom = Math.round(this.track.pts[sampleAt(this.track as never, this.wantTime)] * 1e6)

    let drop = 0
    while (drop < this.buffer.length && (this.buffer[drop].timestamp ?? 0) < keepFrom) drop += 1
    if (drop === 0) return
    for (let i = 0; i < drop; i++) this.buffer[i].close()
    this.buffer = this.buffer.slice(drop)
  }

  /**
   * The frame to show at `time`, decoding if it is not already in hand.
   *
   * The frame stays owned by the source — the caller draws it and does not
   * close it.
   */
  async frameFor(time: number): Promise<VideoFrame | null> {
    if (this.closed || this.failed) return null

    this.wantTime = time
    const held = this.pick(time)
    if (held) {
      this.trim()
      // Top up in the background so playing forward never waits on a decode.
      if (!this.feeding && this.next >= 0 && this.buffer.length < LOOKAHEAD_FRAMES / 2) {
        this.feeding = this.feed(time).finally(() => {
          this.feeding = null
        })
      }
      return held
    }

    /*
     * Nothing in hand. Either the playhead has run past what was decoded, or it
     * jumped somewhere else entirely — and only the second needs the decoder
     * torn down and restarted from a keyframe.
     */
    const wanted = sampleAt(this.track as never, time)
    /*
     * Keep going only if the frame wanted is *near* where the decoder already
     * is; otherwise start again from the keyframe before it.
     *
     * The bound at the far end matters as much as the one at the near end. A
     * jump of nine hundred frames forward is still "ahead of the decoder", and
     * without the upper bound it is chased a lookahead at a time — nine hundred
     * frames decoded and thrown away to show one, when the keyframe two seconds
     * before it would have cost fifty.
     */
    const runningInto =
      this.next >= 0 &&
      wanted >= this.next - LOOKAHEAD_FRAMES &&
      wanted <= this.next + LOOKAHEAD_FRAMES
    if (!runningInto) this.restartAt(time)

    if (this.feeding) await this.feeding
    this.feeding = this.feed(time).finally(() => {
      this.feeding = null
    })

    /*
     * Wait for the frame to come out rather than flushing to force it. Frames
     * emerge as they are decoded; the lookahead submitted past the target is
     * what pushes the target itself out of the decoder without a flush.
     */
    const deadline = performance.now() + FRAME_TIMEOUT_MS
    while (!this.closed && !this.failed) {
      const frame = this.pick(time)
      if (frame) {
        this.trim()
        return frame
      }
      if (performance.now() > deadline) break

      const arrived = new Promise<void>((resolve) => this.waiters.push(resolve))
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 60))])

      // Everything that could be submitted has been, and the decoder is still
      // holding frames back. This is what flush is actually for.
      if (!this.feeding && this.next < 0 && !this.pick(time)) {
        const decoder = this.decoder
        if (decoder && decoder.state === 'configured') {
          await decoder.flush().catch(() => {
            this.failed = true
          })
          // The flush emptied it, so anything further needs a keyframe again.
          this.next = -1
        }
        break
      }
    }

    const frame = this.pick(time)
    this.trim()
    return frame
  }

  /**
   * The buffered frame that belongs at `time`, or null.
   *
   * Matched by *identity*, not by "the newest frame at or before now". The
   * sample table already says which frame covers a given moment, and the
   * timestamp submitted with its chunk comes back on the decoded frame — so
   * this is an exact lookup rather than a guess.
   *
   * The difference is not academic. Picking the newest earlier frame hands back
   * whatever the buffer happens to hold whenever it is behind, so a seek to 37s
   * with a buffer sitting at 0.16s returns the frame from 0.16s and reports
   * success. Which looks exactly like a seek that did not work.
   */
  private pick(time: number): VideoFrame | null {
    const index = sampleAt(this.track as never, time)
    const want = Math.round(this.track.pts[index] * 1e6)
    for (const frame of this.buffer) {
      if (frame.timestamp === want) return frame
    }
    return null
  }
}
