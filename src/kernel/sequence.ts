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

import { loadStore, saveStore } from './store'

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

const STORE = 'sequence'

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

function emit() {
  listeners.forEach((listener) => listener())
  void saveStore(STORE, sequence)
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

export async function loadSequence(): Promise<void> {
  const stored = await loadStore<SequenceState | null>(STORE, null)
  // A stored sequence with no tracks would leave nowhere to drop, and the panel
  // would look broken with no way to recover.
  const base = stored?.tracks?.length ? stored : defaultSequence()

  // Same race as loadAssets: a clip dropped while this read was in flight must
  // not be thrown away by the result arriving.
  const held = sequence.clips
  const heldIds = new Set(held.map((clip) => clip.id))
  sequence = {
    ...base,
    clips: [...(base.clips ?? []).filter((clip) => !heldIds.has(clip.id)), ...held],
  }

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
export function findFreeStart(trackId: string, desired: number, duration: number): number {
  let start = snapToFrame(desired)
  const existing = clipsOnTrack(trackId)

  for (const clip of existing) {
    const clipEnd = clip.start + clip.duration
    const overlaps = start < clipEnd && clip.start < start + duration
    if (overlaps) start = snapToFrame(clipEnd)
  }
  return start
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

export function clearSequence(): void {
  sequence = { ...sequence, clips: [] }
  emit()
}
