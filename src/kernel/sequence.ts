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
  /**
   * Level, in decibels. 0 is unity — the clip as it was recorded.
   *
   * Decibels rather than a linear multiplier because that is what the number
   * means to whoever is setting it: -6 is half as loud, and a project file that
   * says `"gain": -6` can be read. The mixer converts once, at the point it
   * hands the number to the audio device.
   */
  gain: number
  muted: boolean
  solo: boolean
  /**
   * Kept out of the picture. Video tracks only — an audio track has mute.
   *
   * Two controls rather than one shared "enabled", because they are not the
   * same thought. Hiding a video track is about what you are looking at while
   * you work; muting one is about what the sequence sounds like. Every NLE
   * gives them separate buttons for that reason.
   */
  hidden: boolean
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
  /** Which half of the file this clip plays. Must match its track. */
  kind: TrackKind
  /**
   * Shared by the picture and the sound that came out of one file.
   *
   * A file with audio lands as two clips, because they sit on different tracks
   * and will eventually be cut apart. Until someone asks for that, they are one
   * thing to the hand: they move together, they are selected together, and
   * deleting one deletes the other. Losing a clip's sound by dragging its
   * picture is not an edit anyone means to make.
   */
  linkId?: string
}

/** Below this a track is off rather than quiet, which is what a fader bottom means. */
export const MIN_GAIN_DB = -60

/** Headroom above unity. Enough to rescue a quiet take, not enough to be a mistake. */
export const MAX_GAIN_DB = 12

export function clampGain(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, db))
}

export interface SequenceState {
  name: string
  frameRate: number
  /**
   * The frame everything is composited into.
   *
   * A sequence needs its own size the moment more than one clip can be on
   * screen at once: two clips of different shapes have to be drawn *into*
   * something, and picking whichever happens to be on top would make the output
   * change size as the playhead crosses a cut.
   */
  width: number
  height: number
  tracks: Track[]
  clips: Clip[]
}

/**
 * Video down to V1, then audio outward from A1.
 *
 * The order is the drawing order and the stacking order at once: the first
 * video track covers the ones below it, and audio hangs under the lot. It is
 * the arrangement every NLE uses, and it is not arbitrary — video stacks
 * *upward* because a higher layer is in front, audio stacks *downward* because
 * nothing is in front of anything, it all just sums.
 */
function defaultSequence(): SequenceState {
  return {
    name: 'Sequence 1',
    frameRate: 24,
    // Replaced by the first clip dropped into an empty sequence, which is what
    // makes this a default rather than a setting nobody was offered.
    width: 1920,
    height: 1080,
    tracks: [
      makeTrack('V2', 'video'),
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ],
    clips: [],
  }
}

function makeTrack(id: string, kind: TrackKind): Track {
  return { id, kind, name: id, gain: 0, muted: false, solo: false, hidden: false }
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
  sequence = next?.tracks?.length ? normalise(next) : defaultSequence()
  loaded = true
  listeners.forEach((listener) => listener())
}

/**
 * Brings a stored sequence up to what the rest of this module assumes.
 *
 * Two things it fixes, and both come from real documents rather than from
 * paranoia. A project saved before audio tracks existed has nowhere to put a
 * sound, so it gets the audio tracks it would have been created with. And a
 * clip saved before clips had a kind has none, so it takes the kind of the
 * track it is on — which is the only answer that can be right.
 *
 * Doing this on load rather than bumping the document format is deliberate: an
 * older project opens, works, and saves forward. Nothing about it was wrong,
 * only older.
 */
function normalise(next: SequenceState): SequenceState {
  const withAudio = next.tracks.some((track) => track.kind === 'audio')
    ? next.tracks
    : [...next.tracks, ...defaultSequence().tracks.filter((track) => track.kind === 'audio')]

  // A track saved before it could be turned down has no level, which is not
  // the same as a level of zero — it means unity, the clip as recorded.
  const tracks = withAudio.map((track) => ({
    ...track,
    gain: typeof track.gain === 'number' ? clampGain(track.gain) : 0,
    muted: Boolean(track.muted),
    solo: Boolean(track.solo),
    hidden: Boolean(track.hidden),
  }))

  const kindOf = new Map(tracks.map((track) => [track.id, track.kind]))
  const clips = next.clips.map((clip) =>
    clip.kind ? clip : { ...clip, kind: kindOf.get(clip.trackId) ?? 'video' },
  )

  // A sequence saved before it had a size gets the default rather than a zero,
  // which would composite into a frame with no pixels in it.
  const width = Number(next.width) > 0 ? Math.round(Number(next.width)) : 1920
  const height = Number(next.height) > 0 ? Math.round(Number(next.height)) : 1080

  return { ...next, width, height, tracks, clips }
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
  /** Ties this clip to the one that came out of the same file. */
  linkId?: string
}

export function addClip({ assetId, trackId, start, duration, linkId }: NewClip): Clip | null {
  const track = sequence.tracks.find((t) => t.id === trackId)
  if (!track || duration <= 0) return null

  const clip: Clip = {
    id: nextId('c'),
    assetId,
    trackId,
    start: findFreeStart(trackId, start, duration),
    duration,
    // Taken from the track rather than passed in. A clip's kind and the track
    // it sits on cannot disagree, so there is no point offering a way for them
    // to.
    kind: track.kind,
    ...(linkId ? { linkId } : {}),
  }
  sequence = { ...sequence, clips: [...sequence.clips, clip] }
  emit()
  return clip
}

/**
 * Drops a file's picture and its sound as one linked pair.
 *
 * The audio goes on the first audio track that can take it at the same moment,
 * so a linked pair starts life in sync. If none can, the video is placed alone
 * rather than nothing being placed at all — a timeline that refuses a drop
 * because the audio tracks are busy would be a strange thing to explain.
 *
 * `start` is honoured for the video; the audio follows it. Placing them
 * independently would let the two halves of one take land at different moments,
 * which is not a pair, it is a sync error waiting to be noticed.
 */
export function addLinkedClips(
  { assetId, trackId, start, duration }: NewClip,
  withAudio: boolean,
): { video: Clip | null; audio: Clip | null } {
  const linkId = withAudio ? nextId('l') : undefined
  const video = addClip({ assetId, trackId, start, duration, linkId })
  if (!video || !withAudio) return { video, audio: null }

  const free = sequence.tracks.find(
    (track) => track.kind === 'audio' && findFreeStart(track.id, video.start, duration) === video.start,
  )
  if (!free) {
    // Nothing to link to. Strip the link rather than leaving a clip pointing at
    // a partner that was never made.
    sequence = {
      ...sequence,
      clips: sequence.clips.map((clip) =>
        clip.id === video.id ? { ...clip, linkId: undefined } : clip,
      ),
    }
    emit()
    return { video, audio: null }
  }

  const audio = addClip({ assetId, trackId: free.id, start: video.start, duration, linkId })
  return { video, audio }
}

/**
 * The given clips, plus everything linked to them.
 *
 * Every operation that acts on a selection runs through this, which is the
 * whole of what "linked" means: there is no separate bookkeeping, only the
 * shared id and this one expansion.
 */
export function withLinked(ids: Iterable<string>): string[] {
  const wanted = new Set(ids)
  const links = new Set<string>()
  for (const clip of sequence.clips) {
    if (clip.linkId && wanted.has(clip.id)) links.add(clip.linkId)
  }
  if (links.size === 0) return [...wanted]

  for (const clip of sequence.clips) {
    if (clip.linkId && links.has(clip.linkId)) wanted.add(clip.id)
  }
  return [...wanted]
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

  const track = makeTrack(`${prefix}${index}`, kind)
  // Outward from the middle, which is what the numbering means: V3 above V2, A3
  // below A2. Putting either at the far end of the list would break the one
  // rule the track order encodes, that video is above audio.
  const tracks =
    kind === 'video' ? [track, ...sequence.tracks] : [...sequence.tracks, track]
  sequence = { ...sequence, tracks }
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
 * Whether a track is heard, given what else is soloed.
 *
 * Solo picks a subset and mute silences within it: a track that is both soloed
 * and muted stays silent. That is the rule that surprises nobody, because each
 * button keeps meaning exactly one thing rather than one of them quietly
 * overriding the other.
 */
export function isTrackAudible(track: Track, tracks: Track[] = sequence.tracks): boolean {
  if (track.muted) return false
  const soloing = tracks.some((other) => other.kind === 'audio' && other.solo)
  return soloing ? track.solo : true
}

function updateTrack(trackId: string, change: (track: Track) => Track): boolean {
  const existing = sequence.tracks.find((track) => track.id === trackId)
  if (!existing) return false
  const next = change(existing)
  if (
    next.gain === existing.gain &&
    next.muted === existing.muted &&
    next.solo === existing.solo
  ) {
    return false
  }
  sequence = {
    ...sequence,
    tracks: sequence.tracks.map((track) => (track.id === trackId ? next : track)),
  }
  emit()
  return true
}

/** @param db decibels, 0 being unity. Clamped to the fader's range. */
export function setTrackGain(trackId: string, db: number): boolean {
  return updateTrack(trackId, (track) => ({ ...track, gain: clampGain(db) }))
}

export function setTrackMuted(trackId: string, muted: boolean): boolean {
  return updateTrack(trackId, (track) => ({ ...track, muted }))
}

export function setTrackSolo(trackId: string, solo: boolean): boolean {
  return updateTrack(trackId, (track) => ({ ...track, solo }))
}

export function setTrackHidden(trackId: string, hidden: boolean): boolean {
  const existing = sequence.tracks.find((track) => track.id === trackId)
  if (!existing || existing.hidden === hidden) return false
  sequence = {
    ...sequence,
    tracks: sequence.tracks.map((track) =>
      track.id === trackId ? { ...track, hidden } : track,
    ),
  }
  emit()
  return true
}

/** Whether a video track is drawn. The picture's answer to mute. */
export function isTrackVisible(track: Track): boolean {
  return !track.hidden
}

/**
 * Sets the frame everything is composited into.
 *
 * Called when the first clip lands in an empty sequence, so the output matches
 * the footage without anyone being asked a question they have no way to answer
 * yet. Once there is an edit, the size stays: changing it under someone
 * halfway through would reframe every shot at once.
 */
export function setSequenceSize(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false
  const next = { width: Math.round(width), height: Math.round(height) }
  if (sequence.width === next.width && sequence.height === next.height) return false
  sequence = { ...sequence, ...next }
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
 * ## A linked pair is one thing to move
 *
 * Resolving each clip on its own is what a group of unrelated clips wants, and
 * it is exactly wrong for a linked pair. Their tracks are different, so what
 * blocks one need not block the other — and the moment that happens the picture
 * and its sound move by different amounts and the take is out of sync. Found on
 * real footage: two clips end to end on V1, drag the first one right, and the
 * audio track was clear so the sound slid three seconds while the picture,
 * blocked by its neighbour, did not move at all.
 *
 * So a link moves as a unit. The clip that was actually grabbed decides the
 * distance and the rest follow it exactly; if a follower cannot sit there, the
 * unit does not move. A pair that will not fit somewhere should refuse to go
 * there, which is a thing you can see and undo — unlike silently arriving in
 * two pieces.
 *
 * @returns true when anything actually moved.
 */
export function moveClips(ids: string[], deltaSeconds: number, deltaTracks: number): boolean {
  // Linked partners travel with what they are linked to. Expanded here rather
  // than at the caller: that a picture does not leave its sound behind is a
  // rule about the sequence, not a convenience of the panel that drags it.
  const asked = new Set(ids)
  const moving = new Set(withLinked(ids))
  const chosen = sequence.clips.filter((clip) => moving.has(clip.id))
  if (chosen.length === 0) return false

  const trackIndex = (trackId: string) => sequence.tracks.findIndex((t) => t.id === trackId)
  const indices = chosen.map((clip) => trackIndex(clip.trackId))
  if (indices.some((index) => index < 0)) return false // a clip orphaned by a removed track

  /*
   * A clip may only travel within tracks of its own kind.
   *
   * The bands are contiguous — video above, audio below — so this is a clamp
   * rather than a search. Without it, dragging a clip off the bottom video
   * track would drop a picture onto an audio track: not merely untidy, but a
   * clip whose kind and track disagree, which every other rule here assumes
   * cannot happen.
   */
  const room = chosen.map((clip) => {
    const band = sequence.tracks.filter((track) => track.kind === clip.kind)
    const first = sequence.tracks.indexOf(band[0])
    const last = sequence.tracks.indexOf(band[band.length - 1])
    return { up: trackIndex(clip.trackId) - first, down: last - trackIndex(clip.trackId) }
  })
  const shift = Math.min(
    Math.max(deltaTracks, -Math.min(...room.map((r) => r.up))),
    Math.min(...room.map((r) => r.down)),
  )
  const earliest = Math.min(...chosen.map((clip) => clip.start))
  const delta = Math.max(snapDelta(deltaSeconds), -earliest)

  if (shift === 0 && delta === 0) return false

  const others = sequence.clips.filter((clip) => !moving.has(clip.id))
  const placed: Clip[] = []

  const trackAfter = (clip: Clip) => sequence.tracks[trackIndex(clip.trackId) + shift].id
  const obstaclesOn = (trackId: string) =>
    [...others, ...placed].filter((other) => other.trackId === trackId)
  const collides = (obstacles: Clip[], start: number, duration: number) =>
    obstacles.some(
      (other) => start < other.start + other.duration - EPS && other.start < start + duration - EPS,
    )

  /*
   * Units, not clips: a linked pair travels as one.
   *
   * Ascending by where the unit begins, and already-placed units count as
   * obstacles — if one is slid right out of an occupied span it must not then
   * land on top of whatever was travelling behind it.
   */
  const units = new Map<string, Clip[]>()
  for (const clip of chosen) {
    const key = clip.linkId ?? `solo:${clip.id}`
    units.set(key, [...(units.get(key) ?? []), clip])
  }
  const ordered = [...units.values()].sort(
    (a, b) => Math.min(...a.map((c) => c.start)) - Math.min(...b.map((c) => c.start)),
  )

  for (const unit of ordered) {
    if (unit.length === 1) {
      const clip = unit[0]
      const trackId = trackAfter(clip)
      placed.push({
        ...clip,
        trackId,
        start: resolvePlacement(obstaclesOn(trackId), clip.start + delta, clip.duration),
      })
      continue
    }

    /*
     * The clip that was grabbed decides the distance.
     *
     * Its own placement still goes through the midpoint rule, so dragging a
     * pair behaves like dragging a clip. The others take the same distance
     * without re-deciding it, which is the whole point — a second opinion is
     * how they come apart.
     */
    const leader = unit.find((clip) => asked.has(clip.id)) ?? unit[0]
    const leaderTrack = trackAfter(leader)
    const wanted =
      resolvePlacement(obstaclesOn(leaderTrack), leader.start + delta, leader.duration) -
      leader.start
    // No member may be pushed before the start of the sequence.
    const unitDelta = Math.max(wanted, -Math.min(...unit.map((clip) => clip.start)))

    const attempt = unit.map((clip) => ({
      ...clip,
      trackId: trackAfter(clip),
      start: clip.start + unitDelta,
    }))
    // Each against the obstacles on its own track, plus its own travelling
    // siblings. A pair that will not fit stays where it is rather than landing
    // in two pieces.
    const fits = attempt.every(
      (clip, i) =>
        !collides(
          [...obstaclesOn(clip.trackId), ...attempt.slice(0, i).filter((s) => s.trackId === clip.trackId)],
          clip.start,
          clip.duration,
        ),
    )
    placed.push(...(fits ? attempt : unit))
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
  const doomed = new Set(withLinked(ids))
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
