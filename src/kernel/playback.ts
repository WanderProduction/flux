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

let playing = false
let time = 0
let frame: number | null = null
let lastTick = 0
let source: ClockSource | null = null

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
 * One source at a time: there is one playhead, so there is one thing that can
 * be authoritative about where it is.
 */
export function setClockSource(next: ClockSource | null): void {
  source = next
}

function stopLoop() {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
}

function tick(now: number) {
  if (!playing) return

  const reported = source?.()
  const elapsed = (now - lastTick) / 1000
  lastTick = now

  const end = sequenceDuration()
  // The source's own position when it has one, and only otherwise the wall
  // clock. Reading rather than accumulating is what makes a throttled animation
  // frame cost smoothness instead of accuracy.
  const next = reported ?? time + elapsed

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

export function play(): void {
  const end = sequenceDuration()
  if (playing || end <= 0) return
  // Pressing play at the end restarts rather than doing nothing, which is what
  // every player does and what the finger expects.
  if (time >= end) time = 0
  playing = true
  lastTick = performance.now()
  frame = requestAnimationFrame(tick)
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
  source = null
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
