import { assetUrl } from '../fsBridge'
import { sampleAt } from '../../../shared/mp4.js'
import { trackFor, type PcmFormat, type VideoTrack } from './indexCache'

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

/**
 * Interleaved PCM bytes to one plane per channel of -1..1 floats.
 *
 * This is the whole of "decoding" uncompressed audio, and it is arithmetic
 * rather than a codec — which is why it needs no WebCodecs and cannot fail.
 *
 * ## The three ways to get this wrong, and they all sound like noise
 *
 * **The divisor.** A signed 24-bit sample runs -8388608..8388607, so dividing
 * by 8388608 maps it to -1..<1. Dividing by 8388607 would let the most
 * negative sample reach -1.0000001 and clip; dividing by 16777216 would halve
 * the volume of every file in the archive, quietly.
 *
 * **The sign.** The top byte carries it, so a 24-bit value is assembled and
 * then sign-extended by shifting it up into the top of a 32-bit word and back
 * down again — `<< 8 >> 8` — which is what makes the arithmetic shift do the
 * extension for us. Skipping that turns every negative sample into a large
 * positive one, which is full-scale noise.
 *
 * **The order.** Little-endian is least-significant byte first, and the camera
 * in this archive writes little-endian 24-bit. Reading it the other way round
 * is also noise, and is the failure mode a `wave`/`enda` box exists to prevent.
 *
 * None of these is visible as a shape on a waveform — a wrong divisor looks
 * like quiet audio and a wrong sign looks like loud audio. They are checked by
 * decoding a known tone and measuring it; see scripts/verify-demux.mjs.
 */
export function readPcm(
  bytes: Uint8Array,
  pcm: PcmFormat,
  time: number,
): AudioFrame {
  const { bits, channels, sampleRate, float, bigEndian, signed } = pcm
  const width = bits >> 3
  const stride = width * channels
  const frames = Math.floor(bytes.length / stride)

  const planes: Float32Array<ArrayBuffer>[] = []
  for (let c = 0; c < channels; c++) planes.push(new Float32Array(frames))

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const little = !bigEndian
  // -1..1 for a signed integer of this width. Never 2^(n-1) - 1; see above.
  const scale = 1 / 2 ** (bits - 1)

  for (let f = 0; f < frames; f++) {
    const row = f * stride
    for (let c = 0; c < channels; c++) {
      const at = row + c * width
      let value: number
      if (float) {
        value = bits === 64 ? view.getFloat64(at, little) : view.getFloat32(at, little)
      } else if (bits === 8) {
        // 8-bit PCM is unsigned by convention, centred on 128.
        const raw = view.getUint8(at)
        value = signed ? (view.getInt8(at) + 0.5) / 127.5 : (raw - 128) / 128
      } else if (bits === 16) {
        value = (little ? view.getInt16(at, true) : view.getInt16(at, false)) * scale
      } else if (bits === 24) {
        const a = view.getUint8(at)
        const b = view.getUint8(at + 1)
        const c3 = view.getUint8(at + 2)
        const raw = little ? a | (b << 8) | (c3 << 16) : c3 | (b << 8) | (a << 16)
        // Sign-extend 24 bits into 32 by shifting up and arithmetically back.
        value = ((raw << 8) >> 8) * scale
      } else {
        value = (little ? view.getInt32(at, true) : view.getInt32(at, false)) * scale
      }
      planes[c][f] = value
    }
  }

  return { time, duration: frames / sampleRate, sampleRate, planes }
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
    const index = await trackFor(path, 'audio')
    if (!index.ok) return { ok: false, reason: index.reason }

    const track = index.track
    /*
     * Uncompressed audio opens without a decoder, and without asking whether
     * WebCodecs is there at all. There is nothing to configure: the bytes in
     * the file are the samples, and turning them into floats is arithmetic.
     * Gating this on `hasAudioDecoder` would refuse a Fujifilm clip on a build
     * that has no AudioDecoder, for the sake of a decoder it never uses.
     */
    if (track.pcm) return { ok: true, source: new AudioSource(assetUrl(path), track) }

    if (!hasAudioDecoder()) return { ok: false, reason: 'no-webcodecs' }
    const config: AudioDecoderConfig = {
      codec: track.codec as string,
      description: track.description as Uint8Array,
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
      /* PCM never reaches a decoder — open() hands it back before this. */
      codec: (this.track.codec as string),
      description: (this.track.description as Uint8Array),
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

    if (track.pcm) {
      for (let i = from; i <= to; i++) {
        const at = track.offset[i] - start
        if (at + track.bytes[i] > bytes.length) break
        this.ready.push(
          readPcm(bytes.subarray(at, at + track.bytes[i]), track.pcm, track.pts[i]),
        )
        this.decoded += 1
      }
      this.nextSample = to + 1 >= track.count ? -1 : to + 1
      this.wake()
      return
    }

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
