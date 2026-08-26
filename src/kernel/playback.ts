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
 * The clock is driven by requestAnimationFrame against `performance.now()`,
 * not by the <video> element. A video is only the *source* under the playhead:
 * it starts, ends, and is replaced by the next clip, while the sequence's time
 * runs continuously across gaps where no video exists at all. The Viewer keeps
 * its element in step with this — see ViewerPanel.
 */

import { sequenceDuration, subscribeSequence } from './sequence'

let playing = false
let time = 0
let frame: number | null = null
let lastTick = 0

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

function stopLoop() {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
}

function tick(now: number) {
  if (!playing) return
  const elapsed = (now - lastTick) / 1000
  lastTick = now

  const end = sequenceDuration()
  const next = time + elapsed

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
  emit()
}

// Deleting the clip under the playhead can leave the transport parked past the
// end of everything. Pull it back rather than leaving a playhead floating in
// space that play() then refuses to move.
subscribeSequence(() => {
  const end = sequenceDuration()
  if (time > end) {
    time = end
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
