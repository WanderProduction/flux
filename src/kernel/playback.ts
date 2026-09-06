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

import { getSequence, sequenceDuration, subscribeSequence } from './sequence'

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
 * The rungs a shuttle steps between.
 *
 * Doubling each time and stopping at sixteen, which is the ladder every deck
 * and every NLE has used since tape: fast enough to cross a long take, slow
 * enough that sixteen times is still a picture rather than a strobe.
 */
export const SHUTTLE_RATES = [-16, -8, -4, -2, -1, 1, 2, 4, 8, 16] as const

let rate = 1

export function getRate(): number {
  return rate
}

/**
 * Steps the shuttle one rung in a direction, and starts if it was stopped.
 *
 * Pressing the other way lands on the *first rung* of that direction rather
 * than the mirror of where it was: running forward at sixteen and reaching for
 * rewind means "stop going that way", not "go back just as fast". Every deck
 * behaves like this, and it is the only reading that lets a hand slow down
 * without watching the number.
 *
 * @returns the rate it landed on.
 */
export function shuttle(direction: 1 | -1): number {
  const from = playing ? rate : 0
  let next: number
  if (from === 0) next = direction
  else if (Math.sign(from) !== direction) next = direction
  else {
    const rungs = SHUTTLE_RATES.filter((one) => Math.sign(one) === direction)
    const ordered = direction === 1 ? [...rungs] : [...rungs].reverse()
    const at = ordered.indexOf(from as (typeof SHUTTLE_RATES)[number])
    next = ordered[Math.min(at + 1, ordered.length - 1)]
  }

  setRate(next)
  if (!playing) play()
  return next
}

/**
 * Sets the rate the playhead runs at.
 *
 * Anything but 1x is a *shuttle*, and a shuttle runs on the wall clock: the
 * mixer schedules real buffers at real moments and cannot play them backwards
 * or at four times, so it stops and the picture scrubs on its own. Sound while
 * shuttling is a feature that needs a resampler, and pretending to have one by
 * letting the mixer keep the clock would drag the playhead back to 1x while the
 * picture claimed otherwise.
 */
export function setRate(next: number): void {
  const wanted = Math.max(-16, Math.min(16, next))
  if (wanted === rate) return
  rate = wanted
  // The baseline moves with it, or the first tick charges the new rate for time
  // that passed at the old one.
  lastTick = performance.now()
  emit()
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

  const elapsed = (now - lastTick) / 1000
  lastTick = now

  const end = sequenceDuration()
  /*
   * The source's own position when it has one, and only otherwise the wall
   * clock. Reading rather than accumulating is what makes a throttled animation
   * frame cost smoothness instead of accuracy.
   *
   * A shuttle has no source to ask: nothing is playing the sequence's audio at
   * four times or backwards, so the wall clock is the only clock there is.
   */
  const said = rate === 1 ? reported() : null
  const next = said ?? time + elapsed * rate

  if (next <= 0 && rate < 0) {
    // Reached the start going backwards. Park there and stop, which is what the
    // other end of the sequence does going forwards.
    time = 0
    playing = false
    rate = 1
    stopLoop()
    emit()
    return
  }

  /*
   * The far end, and only when travelling towards it.
   *
   * `>=` is what makes a forward run park exactly on the last frame — and it
   * is also true on the *first* backwards tick from the end, where no time has
   * passed yet and `next` still equals `end`. Without the direction, a shuttle
   * back pressed at the end of the sequence stopped on its first frame and
   * looked like a key that did nothing.
   */
  if (rate > 0 && next >= end) {
    // Park exactly on the last frame rather than running past it into empty
    // space: the picture stays on screen, which is what "the clip finished"
    // should look like.
    time = end
    playing = false
    rate = 1
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
  /*
   * Pressing play at the end restarts rather than doing nothing, which is what
   * every player does and what the finger expects — and backwards, the end is
   * where it restarts *from*. Without the second line, a shuttle back pressed
   * at the end of the sequence jumps to zero and stops on its first tick,
   * which looks exactly like the key doing nothing.
   */
  if (rate > 0 && time >= end) time = 0
  if (rate < 0 && time <= 0) time = end
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
  // A stopped transport is a 1x transport: the ladder starts from the bottom
  // next time, which is what a hand that has just stopped expects.
  rate = 1
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

/**
 * Moves the playhead a whole number of frames.
 *
 * The unit is the sequence's frame, not a fixed number of milliseconds: a frame
 * is what an edit is measured in, and "one frame later" has to mean the same
 * thing at 24fps as it does at 60. Read from the sequence at the moment of the
 * step rather than cached, because the frame rate is a setting somebody can
 * change while the playhead is sitting still.
 *
 * It lands on a frame boundary from wherever it starts — the *next* one in the
 * direction of travel, then the rest of the step. Playing, scrubbing and a trim
 * can all leave the playhead between two frames, and adding exactly one frame
 * to that would carry the fraction along for ever; rounding to the nearest
 * would make a step forward from just past a frame skip one. "Next frame" means
 * the next boundary, which is both what the words say and what is symmetric:
 * forward then back is where you started.
 *
 * Stepping stops the transport. Asking for one frame while sixteen a second are
 * going past is not a request that can be honoured, and every NLE answers it
 * the same way: the key means "stop, and show me this frame".
 */
export function stepFrames(frames: number): void {
  const fps = getSequence().settings.frameRate
  if (!Number.isFinite(fps) || fps <= 0 || frames === 0) return
  if (playing) pause()
  /*
   * A hair of tolerance, in frames.
   *
   * A playhead put at frame 24 by dividing and multiplying is not always
   * exactly 24, and without this a step forward from a boundary the arithmetic
   * left at 23.9999999 would go to 24 rather than 25 — a key that does nothing
   * once in a while, which is worse than one that never works.
   */
  const EPS = 1e-6
  const at = time * fps
  const boundary = frames > 0 ? Math.floor(at + EPS) : Math.ceil(at - EPS)
  seek((boundary + frames) / fps)
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
  rate = 1
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
