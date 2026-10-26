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

/**
 * The furthest the wait below will widen its window when a decoder is holding
 * everything back.
 *
 * Four windows is well past anything measured and still a bounded amount of
 * reading, so a frame that genuinely cannot be decoded costs a little extra
 * I/O rather than the rest of the file.
 */
const MAX_FEED_AHEAD = LOOKAHEAD_FRAMES * 4

/**
 * How many runs of already-shrunk frames to keep for playing backwards.
 *
 * Two: the one being played through and the one before it, so crossing a
 * boundary backwards does not immediately throw away what is being left. A
 * third buys nothing — nothing ever asks for it — and these are the only thing
 * here that costs real memory.
 */
const KEPT_RUNS = 2

/**
 * Where the time goes, for the harness that asks.
 *
 * Counters rather than logging: the question "why is playback at a third of
 * realtime" has several plausible answers that look identical from outside —
 * reading, decoding, or waiting on a batch — and guessing between them cost
 * most of an afternoon before these existed.
 */
const stats = {
  hits: 0,
  misses: 0,
  feeds: 0,
  fetches: 0,
  fetchBytes: 0,
  fetchMs: 0,
  submitted: 0,
  decoded: 0,
  waitMs: 0,
  rescues: 0,
  /**
   * The worst single span read, and how many were bad.
   *
   * `fetchMs` is a sum over reads that overlap each other and the decode, so it
   * runs to most of a window even while playback is perfect and says nothing
   * about any one read. The picture stalls on a *single* slow one: the rescue
   * below cannot fire while a read is in flight, by design, so one read that
   * takes seconds holds the frame for exactly that long. These two say whether
   * that is happening.
   */
  fetchWorstMs: 0,
  slowFetches: 0,
  /**
   * Decoder teardowns, which are the most expensive thing this class does.
   *
   * A restart throws away the decoder and begins again at the keyframe before
   * the wanted frame, so every frame between the two is decoded and discarded.
   * One per seek is the cost of seeking. One per *frame* is a different thing
   * entirely, and the only way to tell them apart is to count them.
   */
  restarts: 0,
  /** Runs of frames shrunk and kept so they can be played backwards. */
  runsBuilt: 0,
  /** Pictures handed back from one of those runs rather than decoded. */
  fromRun: 0,
}
/**
 * What the viewer puts on screen.
 *
 * Either a decoded frame or a small copy of one, because playing backwards
 * cannot use decoded frames and playing forwards should not pay for copies.
 * The viewer does not care which it has — both draw — so the difference is
 * stated once, here, rather than everywhere a picture is handled.
 */
export interface Shown {
  readonly picture: VideoFrame | ImageBitmap
  /** Coded size, before the file's own rotation is honoured. */
  readonly width: number
  readonly height: number
  /** Microseconds, as VideoFrame.timestamp is. */
  readonly timestamp: number
}

export type SourceStats = typeof stats

export function sourceStats(): SourceStats {
  return { ...stats }
}

export function resetSourceStats(): void {
  for (const key of Object.keys(stats) as (keyof SourceStats)[]) stats[key] = 0
}

/**
 * How far ahead to keep the decoder fed, in frames.
 *
 * Separate from LOOKAHEAD_FRAMES, which bounds how many decoded frames may be
 * *held* — that is about the decoder's frame pool. This bounds how many
 * encoded chunks are in flight, and chunks cost nothing but memory.
 *
 * A decoder emits nothing until enough chunks are queued behind the one being
 * waited for, so feeding it eight at a time costs a wake cycle per frame
 * whatever the decoder can manage.
 */
let streamAhead = 24

export function framesAhead(): number {
  return streamAhead
}

/** For the harness that measures it. Not a setting: the value is measured. */
export function setFramesAhead(frames: number): void {
  streamAhead = Math.max(2, Math.min(240, Math.round(frames)))
}

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
 * How long the decoder may emit *nothing at all* before the wait gives up on
 * it and starts again from a keyframe.
 *
 * There is a case — reproducible, not yet explained — where a decoder is fed
 * well past the frame it owes and simply never emits it: the samples before it
 * come out and are trimmed, the ones after it are submitted, and the one asked
 * for never appears. Waiting it out costs the full timeout, which is what a
 * preview freezing for five seconds on play actually was, about one play in
 * three.
 *
 * A restart from the keyframe before it costs about sixty milliseconds and has
 * always produced the frame. So the wait stops being patient long before the
 * timeout.
 *
 * Measured against *silence*, not against elapsed time, and that distinction
 * is the whole of it. Judged on elapsed time this fired on frames that were
 * merely slow — on a real timeline it went off six times in six seconds and
 * made things worse, turning a 623ms worst case into 1572ms and reading an
 * extra 35MB to do it:
 *
 *   rescue on elapsed time   5368ms waiting, 6 rescues, 98.1MB, 99th 1572ms
 *   rescue on silence        3042ms waiting, 0 rescues, 63.7MB, 99th  623ms
 *
 * A decoder still handing back frames is working, even if the one being waited
 * for is not among them yet. A decoder that has handed back nothing for this
 * long has stopped, and that is the case worth tearing down.
 */
const RESTART_AFTER_MS = 350

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
  /**
   * Degrees clockwise the picture must be turned to be upright.
   *
   * The width and height above stay *coded* — the shape the decoder hands
   * back, and the shape it has to be configured with. Anything laying the
   * picture out wants the two swapped on a quarter turn, which is what
   * `displaySize` in shared/mp4.js is for.
   */
  rotation: number
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
   * Runs of shrunk frames, for playing backwards. See shownFor.
   *
   * Keyed by the run's first and last sample, and by the width they were made
   * at — a change of preview resolution makes every one of them the wrong
   * size, and handing back a picture built for a different canvas is a
   * silently soft image rather than an error.
   */
  private runs: {
    from: number
    to: number
    width: number
    pictures: Map<number, ImageBitmap>
  }[] = []
  /** The run being built, so two requests never build the same one twice. */
  private buildingRun: Promise<void> | null = null
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
   * Aborts the reads when this source closes.
   *
   * A span can be several megabytes off a spinning drive, and a source that
   * has been closed is one nobody will ever look at again — the clip under the
   * playhead has changed. Letting its read run to completion holds the
   * connection that the *new* clip's first frame is queueing behind, which is
   * most of what a cut costs.
   */
  private readonly reads = new AbortController()

  /**
   * The furthest sample this run has decoded and then thrown away.
   *
   * The one fact that separates "this frame is still coming" from "this frame
   * has been and gone". Frames are dropped in presentation order as the
   * playhead passes them, so anything at or below this was decoded and is now
   * unrecoverable — only a restart will produce it. Anything above it may be
   * submitted and still inside the decoder, and waiting is exactly right.
   *
   * Counted at the drop rather than at the *output*, which was tried first and
   * is wrong wherever there are B-frames: decode order is not presentation
   * order, so the furthest frame emitted runs ahead of frames still to come,
   * and treating those as gone restarts the decoder for nothing. One clip in
   * the test set went from 51fps to 19 that way — same codec, same size, more
   * B-frames.
   *
   * Getting this wrong in either direction is expensive and the two costs look
   * nothing alike: too eager and the decoder restarts on almost every frame
   * (the whole file read eight times over to play it once); too reluctant and
   * a frame that can never arrive is waited on for five seconds.
   */
  private dropped = -1

  /**
   * The sample this decoder run began at.
   *
   * The other half of "can this frame still arrive". Submitting only ever
   * moves forward, so anything before where the run started was never handed
   * to this decoder and never will be: seeking backwards past it has to begin
   * again, however little has been thrown away since.
   */
  private runFrom = 0

  /**
   * This source's own share of the counters.
   *
   * The module-wide ones answer "what is this app doing", which is what makes
   * them useful while chasing a stall — and useless to a check, because the
   * Viewer is holding a source of its own and feeding it. A harness needs the
   * numbers for the source it opened.
   */
  readonly counts = { submitted: 0, decoded: 0, fetches: 0 }

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

  /**
   * The file this is decoding.
   *
   * So a caller can tell whether a source it already has is for the file it
   * now wants. The viewer uses it to hand a decoder from a clip that is
   * leaving to one arriving on the same file — a razor cut is the same
   * decoder at the same place, and tearing it down to build an identical one
   * was the freeze at every cut.
   */
  path = ''

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
      /* Never null on video: only uncompressed audio has no codec string. */
      codec: (track.codec as string),
      description: (track.description as Uint8Array),
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
    source.path = path
    VideoSource.live.add(source)
    return { ok: true, source }
  }

  get info(): SourceInfo {
    return {
      codec: (this.track.codec as string),
      width: this.track.width,
      height: this.track.height,
      duration: this.track.duration,
      frames: this.track.count,
      rotation: this.track.rotation ?? 0,
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
    /*
     * Everything waiting on this source is told now rather than discovering it
     * up to a wait-cycle later. Callers check `closed` the moment they wake,
     * so this turns an abandoned frame request into an immediate null — and
     * those were costing most of a second each at every cut, because the
     * caller was parked inside an await on a read that nobody needed any more.
     */
    this.reads.abort()
    this.wake()
    this.discardBuffer()
    this.discardRuns()
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
        stats.decoded += 1
        this.counts.decoded += 1
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
      codec: (this.track.codec as string),
      description: (this.track.description as Uint8Array),
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
    stats.restarts += 1
    this.generation += 1
    this.discardBuffer()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    const at = keyframeAt(this.track, time)
    // Straight past the ones already known to be no good, rather than
    // rediscovering them a fetch at a time on every seek.
    this.dropped = -1
    this.next = this.refused.has(at) ? this.startBefore(at) : at
    this.runFrom = this.next
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
  private async feed(time: number, ahead: number = LOOKAHEAD_FRAMES): Promise<void> {
    stats.feeds += 1
    const track = this.track
    const mine = this.generation
    const wanted = Math.min(sampleAt(track, time) + ahead, track.count - 1)

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
      const readAt = performance.now()
      const bytes = await this.readRange(start, start + span - 1)
      stats.fetches += 1
      this.counts.fetches += 1
      const took = performance.now() - readAt
      stats.fetchMs += took
      stats.fetchBytes += bytes ? bytes.length : 0
      if (took > stats.fetchWorstMs) stats.fetchWorstMs = took
      // A span is a few megabytes off a drive that reads at 345 MB/s, so a
      // fifth of a second is already an order of magnitude out.
      if (took > 200) stats.slowFetches += 1
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
        this.runFrom = this.next
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
          stats.submitted += 1
          this.counts.submitted += 1
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
      const res = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: this.reads.signal,
      })
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
    for (let i = 0; i < drop; i++) {
      this.dropped = Math.max(
        this.dropped,
        sampleAt(this.track, (this.buffer[i].timestamp ?? 0) / 1e6),
      )
      this.buffer[i].close()
    }
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
      stats.hits += 1
      this.repairs = 0
      this.trim()
      // Top up in the background so playing forward never waits on a decode.
      if (!this.feeding && this.next >= 0 && this.buffer.length < streamAhead / 2) {
        this.feeding = this.feed(time, streamAhead).finally(() => {
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
    stats.misses += 1
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
    /*
     * Being *ahead* is not a reason to start again — and reading it as one is
     * what made playback a slideshow.
     *
     * The old test asked whether the wanted sample was within a lookahead of
     * `next` in either direction. But `next` is where submitting has reached,
     * and the whole point of submitting ahead is that it outruns the playhead:
     * the moment it did, every frame fell outside the window, tore the decoder
     * down and started again from the keyframe before. Ninety frames of a
     * clip cost 229 range reads, 920MB — eight times the size of the file —
     * and 849 decoded frames to deliver 90. Raising the lookahead made it
     * worse, which is why it looked like the lookahead was not the problem.
     *
     * What genuinely needs a restart is the playhead moving *behind* what this
     * decoder run still holds, because frames already handed back cannot be
     * fetched out of a decoder again. So the near bound is the oldest frame in
     * hand rather than the furthest chunk submitted.
     */
    /*
     * Can this frame still arrive? Three ways it cannot, and they are
     * different failures that look identical from here — a frame that never
     * comes.
     *
     *   before the run began  — never submitted to this decoder, never will be
     *   at or below the drops — decoded once and thrown away as the playhead passed
     *   far beyond what is submitted — a jump, cheaper from a keyframe than chased
     *
     * Anything else is either in the decoder already or a few chunks ahead of
     * it, and waiting is right.
     */
    const reachable = wanted >= this.runFrom && wanted > this.dropped
    /*
     * A decoder that is gone starts again at a keyframe, whatever the arithmetic
     * says. WebCodecs closes a decoder on an internal error, and the samples it
     * had reached are mid-GOP by definition — carrying on from there hands a
     * fresh decoder a delta frame, which it refuses. The old bound happened to
     * cover this by being narrow enough to fail; now that being ahead is
     * allowed, the invariant has to be stated rather than fallen into.
     */
    const decoderGone = !this.decoder || this.decoder.state === 'closed'
    const runningInto =
      !decoderGone &&
      reachable &&
      this.next >= 0 &&
      wanted <= this.next + MAX_FEED_AHEAD
    if (!runningInto) this.restartAt(time)

    if (this.feeding) await this.feeding
    this.feeding = this.feed(time, streamAhead).finally(() => {
      this.feeding = null
    })

    /*
     * Wait for the frame to come out rather than flushing to force it. Frames
     * emerge as they are decoded; the lookahead submitted past the target is
     * what pushes the target itself out of the decoder without a flush.
     */
    const began = performance.now()
    const deadline = began + FRAME_TIMEOUT_MS
    /** One rescue per call: a restart that does not help must not become a loop. */
    let rescued = false
    /** Frames out of the decoder when the wait began, and when it last moved. */
    let emitted = this.counts.decoded
    let movedAt = began
    /*
     * How far past the target this wait is willing to submit.
     *
     * A decoder emits nothing until enough chunks are in flight, and how many
     * is a property of the decoder and the stream rather than something we can
     * know: measured here as 14 for a 1080p camera clip against 2 for a 360p
     * fixture. With the window fixed at 8 — above every fixture, below real
     * footage — `feed` submitted its eight, stopped, and this loop then waited
     * without ever offering more. The decoder was waiting on us and we were
     * waiting on it, with a five second timer on the deadlock: a black viewer
     * with the sound playing on, and a picture that appeared only while the
     * playhead was dragged, each drag submitting a few chunks more.
     *
     * Widening here rather than raising LOOKAHEAD_FRAMES is deliberate. That
     * constant also decides how many decoded frames are held and how far the
     * playhead may drift before the decoder is restarted; raising it decodes a
     * second of video ahead on every call, which costs far more than the rare
     * starvation it would avoid.
     */
    let ahead = LOOKAHEAD_FRAMES
    /** The flush below is worth doing once; a second asks a decoder that is
        already waiting for a keyframe to produce frames it will not touch. */
    let flushed = false
    while (!this.closed && !this.failed) {
      const frame = this.pick(time)
      if (frame) {
        this.repairs = 0
        this.trim()
        return frame
      }
      if (performance.now() > deadline) break

      // Anything at all out of the decoder means it is alive and working.
      if (this.counts.decoded !== emitted) {
        emitted = this.counts.decoded
        movedAt = performance.now()
      }

      /*
       * Silent for too long. Not "slow" — silent: the chunks went in and
       * nothing whatever has come back, so stop waiting on a decoder that has
       * stopped and start again from the keyframe before.
       */
      /*
       * ...and nothing being read either. A feed in flight means bytes are on
       * their way, and a span off a spinning drive can easily outlast this
       * window — tearing the decoder down then throws away a read that was
       * about to arrive and starts the same one again.
       */
      if (!rescued && !this.feeding && performance.now() - movedAt > RESTART_AFTER_MS) {
        rescued = true
        stats.rescues += 1
        if (this.feeding) await this.feeding
        this.restartAt(time)
        this.feeding = this.feed(time, streamAhead).finally(() => {
          this.feeding = null
        })
      }

      const waitAt = performance.now()
      const arrived = new Promise<void>((resolve) => this.waiters.push(resolve))
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 60))])
      stats.waitMs += performance.now() - waitAt

      // Still nothing, and there is more of the file to offer: widen and
      // submit again rather than waiting on a decoder that is waiting on us.
      // `next < 0` is end of file — that belongs to the flush below, not here.
      if (!this.feeding && this.next >= 0 && ahead < MAX_FEED_AHEAD && !this.pick(time)) {
        ahead = Math.min(ahead + LOOKAHEAD_FRAMES, MAX_FEED_AHEAD)
        this.feeding = this.feed(time, ahead).finally(() => {
          this.feeding = null
        })
      }

      /*
       * Everything that could be submitted has been, and the decoder is still
       * holding frames back. This is what flush is actually for.
       *
       * Started once and *not awaited*. Frames come out during a flush, and
       * this loop is already watching for them every sixty milliseconds —
       * while awaiting it means the deadline above cannot run, so a flush that
       * does not settle takes the whole call with it. That is not theoretical:
       * seeking into the last seconds of a clip reaches here, and the flush
       * hung indefinitely, leaving the source marked failed for the seek after
       * it. `next` is already -1 by then — feed sets it when it submits the
       * last sample — so there is nothing to put back afterwards.
       *
       * Reaching this at all is new. The window used to stop short of the end
       * of the file on anything long, so the last samples were never submitted
       * and this branch never ran.
       */
      if (!flushed && !this.feeding && this.next < 0 && !this.pick(time)) {
        flushed = true
        const decoder = this.decoder
        if (decoder && decoder.state === 'configured') {
          /*
           * The rejection counts only if this decoder is still the one in use.
           *
           * An unawaited flush outlives the call that started it, and the next
           * seek throws the decoder away and builds another. The old flush
           * then rejects — correctly, it was abandoned — and blaming the
           * source for that marked it failed just as the new decoder was
           * about to work. Measured as a seek that returned nothing with
           * `failed` set, immediately after a seek to the end of the clip
           * had succeeded.
           */
          const mine = this.generation
          void decoder.flush().catch(() => {
            if (this.decoder === decoder && this.generation === mine) this.failed = true
          })
        }
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
  /**
   * The picture for a moment, whichever way the playhead is travelling.
   *
   * Forwards this is `frameFor` and nothing more: decoded frames are what the
   * decoder is for, and copying them would be pure cost.
   *
   * Backwards it is a different problem wearing the same clothes. A frame can
   * only be had by decoding from the keyframe before it, so asking for frames
   * in descending order asks the decoder to do its worst case every single
   * time — measured at 15 decoder restarts in five seconds, 24.7 frames
   * decoded for each one shown, and three times the bytes of forward playback
   * to show a fourteenth of the frames.
   *
   * So the run is decoded *forwards*, once, and each frame is shrunk to the
   * size the viewer actually draws and kept. Then playing backwards is reading
   * an array in reverse. The shrinking is what makes this affordable: holding
   * thirty decoded 4K frames exhausts the decoder's own pool, while thirty
   * copies at preview size are about fifteen megabytes and cost a tenth of a
   * millisecond each to make.
   */
  async shownFor(
    time: number,
    options: { backwards?: boolean; width?: number } = {},
  ): Promise<Shown | null> {
    if (!options.backwards) {
      const frame = await this.frameFor(time)
      if (!frame) return null
      return {
        picture: frame,
        width: frame.displayWidth,
        height: frame.displayHeight,
        timestamp: frame.timestamp ?? 0,
      }
    }

    const width = Math.max(16, Math.round(options.width ?? this.track.width / 4))
    const at = sampleAt(this.track, time)

    const held = this.runFor(at, width)
    if (held) {
      const picture = held.pictures.get(at)
      if (picture) {
        stats.fromRun += 1
        /*
         * Build the run *before* this one while there is still some of this
         * one left to play. Not awaited: the point is that it happens while
         * frames are being handed back from memory, so reaching the boundary
         * costs nothing. Half way is early enough at any sane rate and late
         * enough not to build runs that are never reached.
         */
        if (at <= held.from + (held.to - held.from) / 2) {
          void this.buildRun(held.from - 1, width)
        }
        return { picture, width: picture.width, height: picture.height, timestamp: Math.round(this.track.pts[at] * 1e6) }
      }
    }

    await this.buildRun(at, width)
    const built = this.runFor(at, width)
    const picture = built?.pictures.get(at)
    if (!picture) {
      // Nothing to hand back from a run, so fall back to decoding the one
      // frame. Slow, and right: a picture late beats a picture missing.
      const frame = await this.frameFor(time)
      if (!frame) return null
      return {
        picture: frame,
        width: frame.displayWidth,
        height: frame.displayHeight,
        timestamp: frame.timestamp ?? 0,
      }
    }
    stats.fromRun += 1
    return {
      picture,
      width: picture.width,
      height: picture.height,
      timestamp: Math.round(this.track.pts[at] * 1e6),
    }
  }

  /** The kept run covering this sample at this width, if there is one. */
  private runFor(at: number, width: number) {
    return this.runs.find((run) => run.width === width && at >= run.from && at <= run.to)
  }

  /**
   * Decodes the run of frames containing `at` forwards, shrinking each.
   *
   * One at a time across the whole source: two of these at once would have two
   * walks competing for one decoder, which is the behaviour this exists to
   * stop rather than reproduce.
   */
  private async buildRun(at: number, width: number): Promise<void> {
    if (at < 0 || at >= this.track.count) return
    if (this.runFor(at, width)) return
    /*
     * A build is already running, for some other stretch. Say so and return,
     * rather than handing this caller that build's promise to wait on.
     *
     * Waiting on it was a deadlock. The draw awaits `shownFor`, `shownFor`
     * awaited this, and this handed back a promise belonging to a build that
     * had been started for a different moment — one that could outlive the
     * reason it existed, or never settle at all once its source had moved on.
     * The draw then never finished, `drawingRef` stayed true, and every later
     * notification returned early without drawing. Measured: one draw begun
     * and none finished, for three seconds, while the playhead ran the whole
     * way and the canvas kept the last picture it had. Which is exactly what a
     * freeze looks like from the outside — the playhead moving and the frame
     * standing still.
     *
     * The caller falls back to decoding the one frame it needs, which is
     * slower than a run and always ends.
     */
    if (this.buildingRun) return

    const run = (async () => {
      /*
       * The decoder run this build belongs to.
       *
       * A build walks a whole stretch of frames through `frameFor`, and that
       * takes a few hundred milliseconds. If the playhead leaves in the middle
       * — a seek, or simply stopping somewhere else — carrying on decodes
       * frames nobody is going to look at *and* leaves the buffer sitting
       * where the build was rather than where the playhead now is.
       *
       * Measured: after playing backwards and seeking away, the buffer still
       * held the frames the build had reached, 1.6 seconds later and a hundred
       * and fifty frames from the playhead. The next press of play then missed
       * every frame it asked for and took half a second to catch up, which had
       * been read as "starting playback is slow" for some time.
       *
       * `generation` already counts decoder runs and already changes when the
       * playhead goes somewhere this one cannot reach, so it is the thing to
       * watch rather than a new flag.
       */
      const mine = this.generation
      const from = keyframeAt(this.track, this.track.pts[at])
      let to = from
      while (to + 1 < this.track.count && !this.track.key[to + 1]) to += 1

      const pictures = new Map<number, ImageBitmap>()
      const height = Math.max(
        16,
        Math.round((width * this.track.height) / Math.max(1, this.track.width)),
      )
      for (let i = from; i <= to; i++) {
        if (this.closed) break
        // Somewhere else now; this run is nobody's business any more.
        if (this.generation !== mine) break
        // Walking forwards, which is the direction the decoder is good at.
        const frame = await this.frameFor(this.track.pts[i])
        if (!frame) continue
        /*
         * Awaited before the next frame is asked for, because asking trims the
         * buffer and the frame this is copying lives in it.
         */
        const picture = await createImageBitmap(frame, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'low',
        }).catch(() => null)
        if (picture) pictures.set(i, picture)
      }
      // Nothing worth keeping, or abandoned part way: a half-built run would
      // answer for frames it does not hold and send every one of them to the
      // slow path.
      if (pictures.size === 0 || this.generation !== mine) {
        for (const one of pictures.values()) one.close()
        return
      }

      stats.runsBuilt += 1
      this.runs.push({ from, to, width, pictures })
      while (this.runs.length > KEPT_RUNS) {
        const dropped = this.runs.shift()
        if (dropped) for (const one of dropped.pictures.values()) one.close()
      }
    })()

    this.buildingRun = run.finally(() => {
      this.buildingRun = null
    })
    return this.buildingRun
  }

  /** Lets go of every kept run. */
  private discardRuns() {
    for (const run of this.runs) for (const one of run.pictures.values()) one.close()
    this.runs = []
  }

  private pick(time: number): VideoFrame | null {
    const index = sampleAt(this.track, time)
    const want = Math.round(this.track.pts[index] * 1e6)
    for (const frame of this.buffer) {
      if (frame.timestamp === want) return frame
    }
    return null
  }
}
