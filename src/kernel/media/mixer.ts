import { getAsset } from '../assets'
import {
  getSeekToken,
  getTime,
  isPlaying,
  setClockSource,
  subscribePlayback,
} from '../playback'
import {
  getSequence,
  isTrackAudible,
  MIN_GAIN_DB,
  subscribeSequence,
  type Clip,
  type Track,
} from '../sequence'
import { AudioSource } from './audioSource'

/**
 * The mixer: every audio clip under the playhead, summed and played.
 *
 * ## Why an AudioContext and not more media elements
 *
 * A `<video>` or `<audio>` element plays one file, starting when you ask and
 * arriving when it feels like it. That was enough while a sequence had one
 * source; it is not a mixer. Two elements told to start together do not, and
 * nothing can be done about it from outside — the scheduling happens where you
 * cannot reach.
 *
 * Web Audio hands that back. `AudioContext.currentTime` is the audio device's
 * own clock, and a buffer scheduled at a time on it starts at that time, to the
 * sample. So the mixer places every clip on one timeline and the hardware keeps
 * them together, which is the only way several sources stay in sync.
 *
 * ## And so the clock moves here
 *
 * FLUX has always said audio is the master clock (see kernel/playback.ts). Up
 * to now that meant an `<audio>` element in the Viewer, which worked because
 * there was only ever one. With several clips playing at once there is no "the"
 * element to ask, and the context's own clock is a better answer than any of
 * them: it is what the samples are actually being played against.
 *
 * The Viewer keeps the picture. It no longer makes a sound when the pipeline is
 * in use, because the sound is here.
 *
 * ## Scheduling, and why it is a loop rather than one call
 *
 * Everything cannot be scheduled up front: an hour of audio is an hour of
 * decoding before the first sample plays. So a timer runs ahead of the playhead
 * by SCHEDULE_AHEAD, decoding and placing what falls inside that window. Each
 * decoded frame is scheduled at its own timestamp — no splicing, no seams, and
 * the hardware does the rest.
 *
 * What that window is trading: too short and a slow decode arrives after the
 * moment it was meant for, which is a gap you can hear; too long and every seek
 * throws away more work than it needed to.
 *
 * ## Level, mute and solo are a gain node, not a decision about decoding
 *
 * Every track gets a `GainNode` between its clips and the master, and muting
 * sets it to zero. The audio for a muted track is still decoded and still
 * scheduled, which sounds wasteful and is the only way unmuting can be
 * *instant*: skipping the work would mean nothing was in the pipe, and the
 * sound would arrive a scheduling window after the button was pressed.
 *
 * Levels are ramped over a few milliseconds rather than assigned. A gain that
 * steps from 1 to 0 partway through a waveform is a discontinuity, and a
 * discontinuity is a click — which is what "mute makes a noise" sounds like.
 */

/** How far ahead of the playhead audio is decoded and scheduled. */
const SCHEDULE_AHEAD = 0.9

/** How often the scheduler looks. Comfortably inside the window above. */
const TICK_MS = 100

/**
 * How far in the future playback is anchored when it starts.
 *
 * Zero would mean scheduling the first frame at a moment that has already
 * passed by the time the buffer is built, which Web Audio renders as "start
 * now" — audibly late, and out of step with everything scheduled after it.
 */
const START_LEAD = 0.08

/** Frames whose moment has already gone. Dropped rather than played late. */
const LATE_TOLERANCE = 0.005

/**
 * How long a level change takes to happen.
 *
 * Short enough to feel immediate, long enough that the waveform bends rather
 * than jumps. A step change in gain is a click, and a click is louder than
 * whatever was being turned down.
 */
const GAIN_RAMP = 0.012

export interface MixerStats {
  /** Whether the context exists and is running. */
  running: boolean
  /** Clips currently being decoded and scheduled. */
  voices: number
  /** Buffers handed to the audio device since the last start. */
  scheduled: number
  /** Frames dropped for arriving after their moment. */
  late: number
  /**
   * Times playback has been pinned to a moment on the context's clock.
   *
   * One per play, plus one per seek, and never one per tick. Re-anchoring
   * while playing throws away everything already scheduled and starts the
   * decoders again — the audio equivalent of the per-frame decoder flush that
   * cost 95% of the animation frames before the clock moved to the media.
   */
  anchors: number
  sampleRate: number
  state: string
  /**
   * What each track's fader is actually set to, as the audio device has it.
   *
   * Not what the sequence says it should be — that is a different number, and
   * the whole question a mute check is asking is whether the two agree.
   */
  gains: Record<string, number>
}

interface Voice {
  clipId: string
  source: AudioSource
  /** Sequence time up to which this clip's sound has been scheduled. */
  until: number
  nodes: Set<AudioBufferSourceNode>
  /** Set while a decode is in flight, so one tick cannot overtake another. */
  busy: boolean
  done: boolean
}

let context: AudioContext | null = null
let master: GainNode | null = null
/** One per track, between its clips and the master. Outlives the clips on it. */
const trackGains = new Map<string, GainNode>()
/**
 * What each fader was last *told* to be, which is not what it currently is.
 *
 * A level change is a ramp, and for the few milliseconds it is running
 * `gain.value` still reports the old number. Deciding whether anything changed
 * by reading it therefore compares the new request against a value that is on
 * its way somewhere else — so a second change arriving mid-ramp looks like no
 * change at all and is dropped, leaving the first one to win.
 *
 * Which is not a rare case. It is unmute-then-mute, and it is every fader drag,
 * where changes arrive far faster than 12ms apart.
 */
const trackTargets = new Map<string, number>()
let meter: AnalyserNode | null = null
let meterData: Float32Array<ArrayBuffer> | null = null

let running = false
let timer: number | null = null
/** The moment on the context's clock that `anchorSequence` corresponds to. */
let anchorContext = 0
let anchorSequence = 0
const voices = new Map<string, Voice>()

let scheduled = 0
let late = 0
let anchors = 0

export function mixerStats(): MixerStats {
  return {
    running,
    voices: voices.size,
    scheduled,
    late,
    anchors,
    sampleRate: context?.sampleRate ?? 0,
    state: context?.state ?? 'none',
    gains: Object.fromEntries([...trackGains].map(([id, node]) => [id, node.gain.value])),
  }
}

/**
 * A track's level as a multiplier, taking mute and solo into account.
 *
 * The bottom of the fader is silence rather than a very quiet -60dB: a fader
 * pulled all the way down means off, and leaving a thousandth of the signal
 * through would be a bug you could only find with a meter.
 */
export function trackLevel(track: Track, tracks: Track[]): number {
  if (!isTrackAudible(track, tracks)) return 0
  if (track.gain <= MIN_GAIN_DB) return 0
  return 10 ** (track.gain / 20)
}

/** The node a track's clips play into, made on demand. */
function gainFor(trackId: string): GainNode | null {
  const ctx = context
  if (!ctx || !master) return null
  let node = trackGains.get(trackId)
  if (!node) {
    node = ctx.createGain()
    node.connect(master)
    trackGains.set(trackId, node)
  }
  return node
}

/**
 * Pushes every track's level at the audio device.
 *
 * Called whenever the sequence changes, not on the scheduling tick: a mute has
 * to take effect when it is pressed, and a tenth of a second late is the
 * difference between a button and a suggestion.
 */
export function applyTrackLevels(): void {
  const ctx = context
  if (!ctx) return
  const tracks = getSequence().tracks
  for (const track of tracks) {
    if (track.kind !== 'audio') continue
    const node = gainFor(track.id)
    if (!node) continue
    const wanted = trackLevel(track, tracks)
    if (trackTargets.get(track.id) === wanted) continue
    trackTargets.set(track.id, wanted)
    // From wherever the last ramp had got to, which is what cancelling and
    // then pinning the current value is for.
    node.gain.cancelScheduledValues(ctx.currentTime)
    node.gain.setValueAtTime(node.gain.value, ctx.currentTime)
    node.gain.linearRampToValueAtTime(wanted, ctx.currentTime + GAIN_RAMP)
  }
}

/**
 * How loud the mix is right now, 0..1.
 *
 * A tap on the master bus rather than a number computed from the peaks, which
 * is the point: this is what came out. scripts/verify-playback.mjs listens to
 * it, and a mixer that scheduled nothing, or scheduled the wrong thing, cannot
 * make it move.
 */
export function mixerLevel(): number {
  if (!meter || !meterData) return 0
  meter.getFloatTimeDomainData(meterData)
  let sum = 0
  for (let i = 0; i < meterData.length; i++) sum += meterData[i] * meterData[i]
  return Math.sqrt(sum / meterData.length)
}

function ensureContext(): AudioContext | null {
  if (context) return context
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null

  context = new Ctor({ latencyHint: 'interactive' })
  master = context.createGain()
  meter = context.createAnalyser()
  meter.fftSize = 2048
  meterData = new Float32Array(meter.fftSize)
  // The meter hangs off the master rather than sitting between it and the
  // speakers: a tap should not be able to change what is heard.
  master.connect(meter)
  master.connect(context.destination)
  return context
}

/** True when this build can make a sound at all. */
export function hasAudioOutput(): boolean {
  return ensureContext() !== null
}

function sequenceToContext(time: number): number {
  return anchorContext + (time - anchorSequence)
}

/**
 * Where the audio device has got to, in sequence seconds.
 *
 * Clamped at the anchor because playback is scheduled a little in the future:
 * for the first few tens of milliseconds the context's clock is still short of
 * the moment the first sample belongs to, and reporting that would walk the
 * playhead backwards before it had moved at all.
 */
export function mixerTime(): number | null {
  if (!running || !context) return null
  if (voices.size === 0) return null
  const now = anchorSequence + (context.currentTime - anchorContext)
  return Math.max(anchorSequence, now)
}

/** Audio clips covering `time`, topmost track first. */
function clipsAt(time: number): Clip[] {
  const sequence = getSequence()
  const audio = new Set(
    sequence.tracks.filter((track) => track.kind === 'audio').map((track) => track.id),
  )
  return sequence.clips.filter(
    (clip) =>
      audio.has(clip.trackId) && time < clip.start + clip.duration && time + SCHEDULE_AHEAD > clip.start,
  )
}

function stopVoice(voice: Voice) {
  for (const node of voice.nodes) {
    try {
      node.stop()
    } catch {
      // Already finished. Stopping a node that has ended throws, and there is
      // nothing to do about it.
    }
    node.disconnect()
  }
  voice.nodes.clear()
  voice.source.close()
}

function clearVoices() {
  for (const voice of voices.values()) stopVoice(voice)
  voices.clear()
}

/**
 * Decodes and schedules whatever falls inside the window ahead of the playhead.
 *
 * Runs on a timer rather than on animation frames, for the reason
 * kernel/playback.ts gives at length: frames stop when the window is not being
 * painted, and sound that stops because something is in front of the app would
 * be the worst version of this.
 */
async function tick() {
  const ctx = context
  if (!running || !ctx) return

  const now = mixerTime() ?? anchorSequence
  const horizon = now + SCHEDULE_AHEAD
  const wanted = clipsAt(now)
  const live = new Set(wanted.map((clip) => clip.id))

  for (const [id, voice] of voices) {
    if (!live.has(id)) {
      stopVoice(voice)
      voices.delete(id)
    }
  }

  for (const clip of wanted) {
    let voice = voices.get(clip.id)
    if (!voice) {
      const asset = getAsset(clip.assetId)
      if (!asset || asset.missing) continue
      const opened = await AudioSource.open(asset.path)
      if (!opened.ok) continue
      // Where in the file this clip's sound starts, given where the playhead
      // already is. A clip joined halfway through starts halfway through.
      const from = Math.max(0, now - clip.start)
      opened.source.seek(from)
      voice = { clipId: clip.id, source: opened.source, until: clip.start + from, nodes: new Set(), busy: false, done: false }
      voices.set(clip.id, voice)
    }

    if (voice.busy || voice.done) continue
    voice.busy = true
    try {
      while (voice.until < horizon && !voice.done) {
        const frame = await voice.source.next()
        if (!frame) {
          voice.done = true
          break
        }
        if (!running || !voices.has(clip.id)) break

        const at = clip.start + frame.time
        const end = clip.start + clip.duration
        if (at >= end) {
          voice.done = true
          break
        }
        voice.until = at + frame.duration

        const when = sequenceToContext(at)
        if (when < ctx.currentTime - LATE_TOLERANCE) {
          // Its moment has gone. Playing it now would put it out of step with
          // everything after it, so the gap is the honest outcome.
          late += 1
          continue
        }

        const buffer = ctx.createBuffer(
          frame.planes.length,
          frame.planes[0].length,
          frame.sampleRate,
        )
        for (let c = 0; c < frame.planes.length; c++) buffer.copyToChannel(frame.planes[c], c)

        const node = ctx.createBufferSource()
        node.buffer = buffer
        // Into its track's fader, not straight at the master: that is what
        // makes a level change apply to everything already scheduled.
        node.connect(gainFor(clip.trackId) ?? (master as GainNode))
        node.onended = () => {
          voice?.nodes.delete(node)
          node.disconnect()
        }
        node.start(Math.max(when, ctx.currentTime))
        voice.nodes.add(node)
        scheduled += 1
      }
    } finally {
      voice.busy = false
    }
  }
}

let ticking = false
function schedule() {
  if (ticking) return
  ticking = true
  void tick().finally(() => {
    ticking = false
  })
}

/** Starts playing the sequence's audio from `at`. */
export function startMix(at: number): void {
  const ctx = ensureContext()
  if (!ctx) return

  stopMix()
  running = true
  scheduled = 0
  late = 0
  anchors = 0
  // Resuming can be refused before any user gesture. Nothing to recover: the
  // context stays suspended, no sound comes out, and the wall clock keeps the
  // playhead moving.
  void ctx.resume().catch(() => {})
  anchorContext = ctx.currentTime + START_LEAD
  anchorSequence = at
  anchors += 1
  applyTrackLevels()
  // The clock, for as long as there is something to hear. mixerTime returns
  // null when no clip is sounding, and the transport falls through to the wall
  // clock — a silent stretch still has to pass at the right speed.
  setClockSource('mixer', mixerTime)
  schedule()
  timer = window.setInterval(schedule, TICK_MS)
}

export function stopMix(): void {
  running = false
  if (timer !== null) window.clearInterval(timer)
  timer = null
  setClockSource('mixer', null)
  clearVoices()
}

/**
 * Moves playback to `at` without stopping.
 *
 * Everything already scheduled is thrown away rather than left to play out:
 * buffers placed against the old anchor belong to moments that are no longer
 * coming, and letting them finish is how a scrub turns into a stutter of old
 * sound over new.
 */
export function seekMix(at: number): void {
  if (!running || !context) return
  clearVoices()
  anchorContext = context.currentTime + START_LEAD
  anchorSequence = at
  anchors += 1
  schedule()
}

/**
 * Follows the transport: play starts the mix, pause stops it, a seek moves it.
 *
 * A subscriber rather than calls inside kernel/playback.ts, which knows about
 * the playhead and deliberately nothing about media. The transport says what
 * happened; this decides what that means for the sound.
 *
 * Seeks are told apart from the clock advancing by the token, the same way the
 * Viewer tells them apart — "the time changed" is not a reason to do anything,
 * or every tick would restart the audio.
 */
export function connectMixer(): () => void {
  let wasPlaying = isPlaying()
  let lastSeek = getSeekToken()

  // Levels follow the sequence rather than the transport: a mute pressed while
  // paused has to be in force by the time play is pressed, and one pressed
  // while playing has to be in force now.
  const stopSequence = subscribeSequence(applyTrackLevels)

  const stopPlayback = subscribePlayback(() => {
    const playing = isPlaying()
    const token = getSeekToken()

    if (playing && !wasPlaying) startMix(getTime())
    else if (!playing && wasPlaying) stopMix()
    else if (playing && token !== lastSeek) seekMix(getTime())

    wasPlaying = playing
    lastSeek = token
  })

  return () => {
    stopSequence()
    stopPlayback()
  }
}
