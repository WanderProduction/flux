/**
 * The sequence: tracks, and the clips laid out along them.
 *
 * A clip is the first thing in FLUX that *owns time*. In the model from
 * docs/INTERACTION-MODEL.md that is exactly what separates a Timeline-visible
 * node from an ambient one, so this shape is deliberately node-flavoured: a
 * clip references an asset rather than containing it, and carries only its
 * placement. When the signal graph lands, a clip becomes an element node and
 * this stays its time placement — not a second, competing source of truth.
 *
 * Times are in seconds throughout, snapped to the frame grid on write.
 */

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
}

export interface Clip {
  id: string
  /** The project asset this clip plays. Not embedded — see the note above. */
  assetId: string
  trackId: string
  /** Seconds from the start of the sequence. */
  start: number
  /** Seconds. Currently always the asset's full length; trimming comes later. */
  duration: number
}

export interface SequenceState {
  name: string
  frameRate: number
  tracks: Track[]
  clips: Clip[]
}

/**
 * Video only, top-down. There is no audio track yet because there is no audio
 * anything yet — adding an empty A1 would imply a capability that does not
 * exist. `TrackKind` already anticipates it.
 */
function defaultSequence(): SequenceState {
  return {
    name: 'Sequence 1',
    frameRate: 24,
    tracks: [
      { id: 'V2', kind: 'video', name: 'V2' },
      { id: 'V1', kind: 'video', name: 'V1' },
    ],
    clips: [],
  }
}

let sequence: SequenceState = defaultSequence()
let loaded = false
const listeners = new Set<() => void>()

/** Notifies only; kernel/project.ts owns writing the document. */
function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeSequence(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSequence(): SequenceState {
  return sequence
}

export function isSequenceLoaded(): boolean {
  return loaded
}

/**
 * Replaces the sequence from a project document, without marking it changed.
 * A stored sequence with no tracks would leave nowhere to drop, so it falls
 * back rather than presenting a timeline the user cannot use.
 */
export function setSequence(next: SequenceState | null): void {
  sequence = next?.tracks?.length ? next : defaultSequence()
  loaded = true
  listeners.forEach((listener) => listener())
}

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`
}

/** Snap to the frame grid, so clips can never land on fractional frames. */
export function snapToFrame(seconds: number, frameRate = sequence.frameRate): number {
  return Math.max(0, Math.round(seconds * frameRate) / frameRate)
}

/**
 * Frame-quantise a *distance*, which unlike a position may be negative.
 *
 * snapToFrame clamps at zero because no clip starts before the sequence does.
 * Running a drag delta through it would silently turn every leftward move into
 * a move to zero.
 */
export function snapDelta(seconds: number, frameRate = sequence.frameRate): number {
  return Math.round(seconds * frameRate) / frameRate
}

function clipsOnTrack(trackId: string): Clip[] {
  return sequence.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.start - b.start)
}

/**
 * The first start time at or after `desired` where `duration` fits without
 * touching another clip.
 *
 * Overlap has to be resolved *somehow*, and every option is a real editing
 * decision: overwrite destroys work, insert shifts everything downstream. Both
 * are wrong to pick by accident on a drag. Sliding right is the only one that
 * neither loses a frame nor moves anything the user already placed.
 */
function freeStartAmong(obstacles: Clip[], desired: number, duration: number): number {
  let start = snapToFrame(desired)
  for (const clip of [...obstacles].sort((a, b) => a.start - b.start)) {
    const clipEnd = clip.start + clip.duration
    const overlaps = start < clipEnd && clip.start < start + duration
    if (overlaps) start = snapToFrame(clipEnd)
  }
  return start
}

export function findFreeStart(trackId: string, desired: number, duration: number): number {
  return freeStartAmong(clipsOnTrack(trackId), desired, duration)
}

/** Floating-point slack. Two edges this close are the same edge. */
const EPS = 1e-9

/**
 * Where a clip *being moved* should land, given what is already there.
 *
 * Deliberately not the same rule as a drop. A drop has no history — the clip is
 * new, nothing about it says "before" or "after", and sliding right to the
 * first free slot is as good an answer as any. A move does have a history: the
 * clip came from somewhere, and how far you dragged it across its neighbour is
 * the whole of what you meant.
 *
 * So: past the neighbour's midpoint goes after it, short of the midpoint butts
 * up before it. That is the behaviour of every reorderable list, and it makes
 * both gestures work — a nudge closes a gap instead of catapulting the clip to
 * the far side of the track, and a decisive drag reorders instead of refusing.
 */
function resolvePlacement(obstacles: Clip[], desired: number, duration: number): number {
  const sorted = [...obstacles].sort((a, b) => a.start - b.start)
  let start = Math.max(0, desired)

  // Bounded: two obstacles can bounce a clip between them, and a timeline that
  // hangs on a drag is worse than one that places a clip imperfectly.
  for (let pass = 0; pass <= sorted.length; pass++) {
    const hit = sorted.find(
      (other) => start < other.start + other.duration - EPS && other.start < start + duration - EPS,
    )
    if (!hit) return start

    const past = start + duration / 2 > hit.start + hit.duration / 2
    const before = hit.start - duration
    start = past || before < 0 ? hit.start + hit.duration : before
  }

  // Gave up choosing a side. Fall back to the rule that cannot overlap, because
  // committing an overlap is the one outcome that must never happen.
  return freeStartAmong(sorted, desired, duration)
}

export interface NewClip {
  assetId: string
  trackId: string
  start: number
  duration: number
}

export function addClip({ assetId, trackId, start, duration }: NewClip): Clip | null {
  const track = sequence.tracks.find((t) => t.id === trackId)
  if (!track || duration <= 0) return null

  const clip: Clip = {
    id: nextId('c'),
    assetId,
    trackId,
    start: findFreeStart(trackId, start, duration),
    duration,
  }
  sequence = { ...sequence, clips: [...sequence.clips, clip] }
  emit()
  return clip
}

/**
 * Adds a track above the rest.
 *
 * Above, not below: tracks are stored in the order they are drawn and the first
 * one covers the others, so a new video track landing *under* everything would
 * be invisible the moment anything is on V1 — which reads as the command having
 * done nothing.
 */
export function addTrack(kind: TrackKind = 'video'): Track {
  const prefix = kind === 'video' ? 'V' : 'A'
  const taken = new Set(sequence.tracks.map((track) => track.id))
  let index = sequence.tracks.filter((track) => track.kind === kind).length + 1
  while (taken.has(`${prefix}${index}`)) index += 1

  const track: Track = { id: `${prefix}${index}`, kind, name: `${prefix}${index}` }
  sequence = { ...sequence, tracks: [track, ...sequence.tracks] }
  emit()
  return track
}

/**
 * Removes a track and every clip on it.
 *
 * Refuses the last one: a sequence with no tracks has nowhere to drop, and the
 * timeline would be a panel you cannot use with no way back.
 */
export function removeTrack(trackId: string): boolean {
  if (sequence.tracks.length <= 1) return false
  if (!sequence.tracks.some((track) => track.id === trackId)) return false

  sequence = {
    ...sequence,
    tracks: sequence.tracks.filter((track) => track.id !== trackId),
    clips: sequence.clips.filter((clip) => clip.trackId !== trackId),
  }
  emit()
  return true
}

/**
 * Moves clips in time and across tracks, keeping their shape.
 *
 * A delta rather than absolute positions, so a group of clips travels as a
 * group: the relative gaps between them are part of the edit, and a move that
 * silently closed them would be a different edit than the one the hand asked
 * for.
 *
 * Two clamps, both applied to the *whole* group rather than clip by clip. The
 * earliest clip cannot go before zero and the outermost clips cannot leave the
 * track list — clamping individually would squash the group's shape against the
 * boundary instead of simply stopping it there.
 *
 * Overlap resolves by the midpoint rule in resolvePlacement, not by the drop
 * rule: dragging a clip a little way into its neighbour should close the gap
 * between them, and dragging it decisively across should reorder them. Neither
 * overwrites, and neither shifts anything downstream.
 *
 * @returns true when anything actually moved.
 */
export function moveClips(ids: string[], deltaSeconds: number, deltaTracks: number): boolean {
  const moving = new Set(ids)
  const chosen = sequence.clips.filter((clip) => moving.has(clip.id))
  if (chosen.length === 0) return false

  const trackIndex = (trackId: string) => sequence.tracks.findIndex((t) => t.id === trackId)
  const indices = chosen.map((clip) => trackIndex(clip.trackId))
  if (indices.some((index) => index < 0)) return false // a clip orphaned by a removed track

  const shift = Math.min(
    Math.max(deltaTracks, -Math.min(...indices)),
    sequence.tracks.length - 1 - Math.max(...indices),
  )
  const earliest = Math.min(...chosen.map((clip) => clip.start))
  const delta = Math.max(snapDelta(deltaSeconds), -earliest)

  if (shift === 0 && delta === 0) return false

  const others = sequence.clips.filter((clip) => !moving.has(clip.id))
  const placed: Clip[] = []

  // Ascending, and already-placed siblings count as obstacles: if one of them
  // is slid right out of an occupied span it must not then land on top of the
  // clip that was travelling behind it.
  for (const clip of [...chosen].sort((a, b) => a.start - b.start)) {
    const trackId = sequence.tracks[trackIndex(clip.trackId) + shift].id
    const obstacles = [...others, ...placed].filter((other) => other.trackId === trackId)
    placed.push({
      ...clip,
      trackId,
      start: resolvePlacement(obstacles, clip.start + delta, clip.duration),
    })
  }

  const byId = new Map(placed.map((clip) => [clip.id, clip]))
  const next = sequence.clips.map((clip) => byId.get(clip.id) ?? clip)
  const changed = next.some(
    (clip, i) => clip.start !== sequence.clips[i].start || clip.trackId !== sequence.clips[i].trackId,
  )
  if (!changed) return false

  sequence = { ...sequence, clips: next }
  emit()
  return true
}

export function removeClips(ids: string[]): number {
  const doomed = new Set(ids)
  const before = sequence.clips.length
  sequence = { ...sequence, clips: sequence.clips.filter((clip) => !doomed.has(clip.id)) }
  const removed = before - sequence.clips.length
  if (removed > 0) emit()
  return removed
}

/** Last frame occupied by any clip. Drives the scrollable width of the timeline. */
export function sequenceDuration(): number {
  return sequence.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}

/**
 * Returns to a pristine default sequence, without writing.
 *
 * Same reason as resetAssets: module-scope state would otherwise carry one
 * project's clips into the next, and the first save would persist them there.
 */
export function resetSequence(): void {
  sequence = defaultSequence()
  loaded = false
  listeners.forEach((listener) => listener())
}

export function clearSequence(): void {
  sequence = { ...sequence, clips: [] }
  emit()
}
