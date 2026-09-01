/**
 * The transport: one playhead, shared by every panel.
 *
 * There is exactly one clock in FLUX and this is it. The Viewer does not own
 * playback with the Timeline mirroring it, because the moment two panels each
 * keep their own time they disagree — and "the picture is a few frames off the
 * timeline" is the kind of bug that makes an editor stop trusting the tool.
 * Panels read this and render; only commands move it.
 *
 * Time is in seconds from the start of the sequence, matching sequence.ts.
 *
 * ## Who is the clock
 *
 * Whatever is *playing the media*, when something is. Otherwise the wall clock.
 *
 * This is the one design decision in the file and it took being wrong once to
 * see. The first version accumulated `performance.now()` deltas on every
 * animation frame and treated the <video> element as a follower to be dragged
 * into line. Two things go wrong with that, and both of them were measurable:
 *
 *   - requestAnimationFrame is not a clock. Chromium throttles it whenever it
 *     decides the window does not need painting — to a few frames a second, or
 *     one. The media pipeline keeps running regardless, because it is driven by
 *     the audio device. So the picture stayed correct and the *sequence's own
 *     idea of the time* fell behind it, in visible one-second lurches.
 *   - Correcting the follower means assigning `currentTime`, which is a seek.
 *     Doing that on every frame flushes the decoder on every frame.
 *
 * Every real NLE resolves this the same way, and Premiere is explicit about it:
 * audio is the master clock and video frames are presented against it. Audio
 * glitches are far more perceptible than a dropped frame, so the thing feeding
 * the sound card sets the time and everything else follows.
 *
 * So: while a source is playing it *reports* the sequence time and this module
 * reads it. Animation frames only decide how often the UI resamples — if they
 * are throttled the playhead updates less often, which is a rendering
 * consequence, not a timing one. With no source (a gap, a still, an empty
 * stretch) the wall clock takes over, because time still has to pass there.
 */

import { sequenceDuration, subscribeSequence } from './sequence'

/**
 * Something that is playing media and can say where it is, in sequence
 * seconds. Returns null when it cannot — not loaded, stalled, or paused — and
 * the wall clock covers for it.
 */
export type ClockSource = () => number | null

/**
 * Who can be the clock, in the order they are asked.
 *
 * The mixer first, because it is playing the sequence's own audio and every
 * clip in it against one device. The Viewer's media element second, and only
 * because a file the pipeline cannot read is played by the browser, sound and
 * all — one source, its own device, nothing the mixer can reach.
 *
 * Both can be sounding at once (a webm on V1, a wav on A1) and they will drift,
 * because they are two devices with no way to agree. Someone still has to be
 * the clock; the mixer is the one that speaks for the sequence.
 */
const CLOCK_ORDER = ['mixer', 'element'] as const
export type ClockName = (typeof CLOCK_ORDER)[number]

let playing = false
let time = 0
let frame: number | null = null
let lastTick = 0
const sources = new Map<ClockName, ClockSource>()

/**
 * A timer that keeps the clock honest when nothing is painting.
 *
 * Animation frames stop when Chromium decides the window does not need
 * repainting — behind another window, most of the time. The audio keeps
 * playing, so the *time* is still passing; what stops is anything that finds
 * out about it. Timers are not throttled the same way, so this samples the
 * source when frames dry up and does nothing at all when they are flowing.
 *
 * Roughly 20Hz: enough that nothing reading the clock is ever badly stale,
 * cheap enough to be invisible next to a decoder.
 */
let backstop: number | null = null
let lastFrame = 0
const BACKSTOP_MS = 50
const FRAME_STALE_MS = 100

/**
 * Bumped on every deliberate seek.
 *
 * The Viewer moves its element when this changes and at no other time. Without
 * it there is no way to tell "the time changed because the video advanced" from
 * "the time changed because the user scrubbed" — and treating the first as the
 * second is what put a decoder flush on every animation frame.
 */
let seekToken = 0

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribePlayback(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTime(): number {
  return time
}

export function isPlaying(): boolean {
  return playing
}

export function getSeekToken(): number {
  return seekToken
}

/**
 * Hands the clock to whatever is playing, or takes it back with null.
 *
 * Named rather than a single slot, because there are two things that can be
 * playing and they must not clobber each other by registering in an order
 * nobody controls. There is still only one clock at a time — see CLOCK_ORDER
 * for which one, and why.
 */
export function setClockSource(name: ClockName, next: ClockSource | null): void {
  if (next) sources.set(name, next)
  else sources.delete(name)
}

/** The first source that can say where it is, in priority order. */
function reported(): number | null {
  for (const name of CLOCK_ORDER) {
    const value = sources.get(name)?.()
    if (value !== null && value !== undefined) return value
  }
  return null
}

function stopLoop() {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
  if (backstop !== null) clearInterval(backstop)
  backstop = null
}

function tick(now: number) {
  if (!playing) return
  lastFrame = performance.now()

  const said = reported()
  const elapsed = (now - lastTick) / 1000
  lastTick = now

  const end = sequenceDuration()
  // The source's own position when it has one, and only otherwise the wall
  // clock. Reading rather than accumulating is what makes a throttled animation
  // frame cost smoothness instead of accuracy.
  const next = said ?? time + elapsed

  if (next >= end) {
    // Park exactly on the last frame rather than running past it into empty
    // space: the picture stays on screen, which is what "the clip finished"
    // should look like.
    time = end
    playing = false
    stopLoop()
    emit()
    return
  }

  time = next
  emit()
  frame = requestAnimationFrame(tick)
}

/** Samples the clock when animation frames have stopped arriving. */
function guard() {
  if (!playing) return
  if (performance.now() - lastFrame < FRAME_STALE_MS) return
  tick(performance.now())
  // tick() queues another animation frame; cancel it so a window that starts
  // painting again does not end up with two loops running.
  if (frame !== null) {
    cancelAnimationFrame(frame)
    frame = null
  }
}

export function play(): void {
  const end = sequenceDuration()
  if (playing || end <= 0) return
  // Pressing play at the end restarts rather than doing nothing, which is what
  // every player does and what the finger expects.
  if (time >= end) time = 0
  playing = true
  lastTick = performance.now()
  lastFrame = performance.now()
  frame = requestAnimationFrame(tick)
  backstop = window.setInterval(guard, BACKSTOP_MS)
  emit()
}

export function pause(): void {
  if (!playing) return
  playing = false
  stopLoop()
  emit()
}

export function toggle(): void {
  if (playing) pause()
  else play()
}

/** Moves the playhead. Scrubbing while playing keeps playing, as it should. */
export function seek(seconds: number): void {
  const end = sequenceDuration()
  const clamped = Math.min(Math.max(0, seconds), Math.max(0, end))
  if (clamped === time) return
  time = clamped
  seekToken += 1
  // Reset the tick baseline, or the next frame would charge the playhead for
  // however long the drag took.
  lastTick = performance.now()
  emit()
}

export function goToStart(): void {
  seek(0)
}

export function goToEnd(): void {
  seek(sequenceDuration())
}

/** Drops the transport, without touching the sequence. Used when a project closes. */
export function resetPlayback(): void {
  playing = false
  stopLoop()
  time = 0
  seekToken += 1
  sources.clear()
  emit()
}

// Deleting the clip under the playhead can leave the transport parked past the
// end of everything. Pull it back rather than leaving a playhead floating in
// space that play() then refuses to move.
subscribeSequence(() => {
  const end = sequenceDuration()
  if (time > end) {
    time = end
    seekToken += 1
    if (playing) pause()
    else emit()
  }
})

/**
 * `HH:MM:SS:FF`. Frames rather than milliseconds because a cut lands on a
 * frame, and a timecode that cannot name the frame you are on is decoration.
 */
export function formatTimecode(seconds: number, frameRate: number): string {
  const safeRate = frameRate > 0 ? frameRate : 24
  const total = Math.max(0, Math.round(seconds * safeRate))
  const frames = total % safeRate
  const whole = Math.floor(total / safeRate)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames)}`
}
