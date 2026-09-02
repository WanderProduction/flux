import { assetUrl } from '../fsBridge'
import { keyframeAt, sampleAt } from '../../../shared/mp4.js'
import { trackFor, type VideoTrack } from './indexCache'

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

/**
 * How many times a source will rebuild its decoder before giving up.
 *
 * Three, and the count resets on every frame that comes out. A decoder lost to
 * a driver hiccup comes back on the first attempt; a file that cannot be
 * decoded at all fails three times in a row and is handed to the element,
 * which is the fallback that exists for exactly this.
 */
const MAX_REPAIRS = 3

export interface SourceInfo {
  codec: string
  width: number
  height: number
  duration: number
  frames: number
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

export class VideoSource {
  private constructor(
    private readonly url: string,
    private readonly track: VideoTrack,
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

  /**
   * Repairs spent since the last frame this source actually produced.
   *
   * A decoder can go away mid-stream — a driver hiccup, a lost hardware
   * context, an error on one bad sample — and WebCodecs answers by closing it.
   * That state is recoverable: throw the decoder away, start again from the
   * keyframe before the playhead. What is not recoverable is a file that fails
   * every time, so the attempts are counted and the source gives up rather than
   * restarting for ever. The count resets whenever a frame comes out, because a
   * source that recovered is not a source that is failing.
   */
  private repairs = 0

  /**
   * Sync samples this decoder has refused to start from. See the catch in
   * `feed`. Per source rather than per file: it is cheap to relearn, and a
   * cache keyed on a path would have to be invalidated when the file changed.
   */
  private refused = new Set<number>()

  /**
   * Every source currently open, newest last.
   *
   * Here for one reason: the verification harnesses have to be able to reach
   * the *instance a panel is using*, rather than one they opened themselves.
   * Recovery from a broken decoder cannot be checked any other way — the fault
   * has to be introduced into the source the picture is actually coming from.
   * Reading it costs nothing and it is never used to find a source to work
   * with; kernel/media is not a registry.
   */
  static live = new Set<VideoSource>()

  static async open(
    path: string,
  ): Promise<{ ok: true; source: VideoSource } | { ok: false; reason: OpenFailure }> {
    if (!hasWebCodecs()) return { ok: false, reason: 'no-webcodecs' }

    const url = assetUrl(path)
    // Where the index comes from — memory, disk, or the file — is not this
    // class's business. See media/indexCache.ts.
    const result = await trackFor(path)
    if (!result.ok) return { ok: false, reason: result.reason }

    const track = result.track
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

    const source = new VideoSource(url, track)
    VideoSource.live.add(source)
    return { ok: true, source }
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

  /**
   * True once this source has given up — it has failed and spent every repair.
   *
   * The caller should stop asking and fall back. A source that has failed but
   * has repairs left is not broken; it is about to start again.
   */
  get broken(): boolean {
    return this.failed && this.repairs >= MAX_REPAIRS
  }

  close(): void {
    this.closed = true
    this.discardBuffer()
    this.decoder?.close()
    this.decoder = null
    VideoSource.live.delete(this)
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

  /**
   * The sync sample at or before `sample` that the decoder has not refused.
   *
   * Falls back to zero, which is the first sample of the file and an IDR in
   * anything that plays at all — so this always answers, and the answer is
   * always somewhere the decoder can start.
   */
  private startBefore(sample: number): number {
    for (let i = sample - 1; i > 0; i--) {
      if (this.track.key[i] && !this.refused.has(i)) return i
    }
    return 0
  }

  /** Throws away decoder state and points it at the keyframe before `time`. */
  private restartAt(time: number) {
    this.generation += 1
    this.discardBuffer()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    const at = keyframeAt(this.track, time)
    // Straight past the ones already known to be no good, rather than
    // rediscovering them a fetch at a time on every seek.
    this.next = this.refused.has(at) ? this.startBefore(at) : at
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
    const wanted = Math.min(sampleAt(track, time) + LOOKAHEAD_FRAMES, track.count - 1)

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

      /*
       * A decoder that has to be built here must be handed a keyframe first.
       *
       * Normally it is: every restart points `next` at one. But a decoder can
       * also go away on its own — WebCodecs closes it on an internal error —
       * and then the next batch builds a fresh one and hands it whatever comes
       * next in the file, which is a delta frame in the middle of a GOP.
       * `decode()` throws DataError, the throw escapes as a rejected feed, and
       * the source is left alive but producing nothing: a black picture that
       * never comes back, which is exactly how this was reported.
       *
       * So the invariant is held at the point where it has to be true, rather
       * than trusted from four call sites away. Rewinding costs one wasted
       * range read on a path that only runs after something has already gone
       * wrong.
       */
      if ((!this.decoder || this.decoder.state === 'closed') && !track.key[from]) {
        this.next = keyframeAt(track, track.pts[from])
        continue
      }

      const fresh = !this.decoder || this.decoder.state === 'closed'
      const decoder = this.ensureDecoder()
      let submitted = 0
      try {
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
          submitted += 1
        }
      } catch {
        /*
         * A sync sample the decoder will not start from.
         *
         * `stss` says "you may begin here", and for H.264 that is not the same
         * promise as "this is an IDR". An open GOP marks I-frames that refer
         * back across the boundary; Chromium refuses to configure a decoder and
         * then start on one, and says so with the same message as a delta —
         * "a key frame is required". Phone and drone footage does this
         * routinely: the file that prompted this has three sync samples and
         * only the first is an IDR.
         *
         * So the sample is remembered as no good and the one before it is
         * tried, down to sample zero, which is an IDR in any file that plays at
         * all. Learned rather than assumed, because there is no way to know
         * without the bytes, and reading them to find out would mean fetching
         * every keyframe in the file before playing a frame of it.
         */
        if (submitted === 0 && fresh && track.key[from]) {
          this.refused.add(from)
          const earlier = this.startBefore(from)
          if (earlier < from) {
            // The decoder goes too. It was configured and handed nothing it
            // would take, and the next start point has to meet a decoder that
            // is genuinely new — otherwise the second refusal in one pass is
            // not recognised as one, which is a black frame that fixes itself
            // on the next seek and looks like a race.
            if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
            this.decoder = null
            this.next = earlier
            continue
          }
        }
        // Marked, not thrown. A rejection here reaches nobody — the feed is
        // deliberately not awaited on the fast path — and a source that has
        // silently stopped decoding is worse than one that says so.
        this.failed = true
        return
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
    const keepFrom = Math.round(this.track.pts[sampleAt(this.track, this.wantTime)] * 1e6)

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
    if (this.closed) return null

    /*
     * A failed decoder is thrown away and started again, not given up on.
     *
     * The failure that prompted this is transient by nature: the decoder is
     * gone, and a new one starting from a keyframe has no memory of whatever
     * upset it. Bounded, because a file that fails every time would otherwise
     * restart on every frame for ever — after MAX_REPAIRS the source reports
     * itself broken and the Viewer falls back to the element.
     */
    if (this.failed) {
      if (this.repairs >= MAX_REPAIRS) return null
      this.repairs += 1
      this.failed = false
      this.restartAt(time)
    }

    this.wantTime = time
    const held = this.pick(time)
    if (held) {
      this.repairs = 0
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
    const wanted = sampleAt(this.track, time)
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
        this.repairs = 0
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
    // A source that produced a frame is not a source that is failing, so its
    // repair budget starts again. Otherwise three hiccups spread across an
    // afternoon would retire a file that works.
    if (frame) this.repairs = 0
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
    const index = sampleAt(this.track, time)
    const want = Math.round(this.track.pts[index] * 1e6)
    for (const frame of this.buffer) {
      if (frame.timestamp === want) return frame
    }
    return null
  }
}
