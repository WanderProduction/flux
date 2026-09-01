import {
  defaultSettings,
  makeSettings,
  makeSequenceDocument,
  mediaFor,
} from '../../shared/sequenceFormat.js'

/**
 * Sequences: tracks, the clips laid out along them, and the shape of the thing
 * being cut.
 *
 * A clip is the first thing in FLUX that *owns time*. In the model from
 * docs/INTERACTION-MODEL.md that is exactly what separates a Timeline-visible
 * node from an ambient one, so this shape is deliberately node-flavoured: a
 * clip references an asset rather than containing it, and carries only its
 * placement. When the signal graph lands, a clip becomes an element node and
 * this stays its time placement — not a second, competing source of truth.
 *
 * Times are in seconds throughout, snapped to the frame grid on write.
 *
 * ## Several of them, one at a time
 *
 * A project holds many sequences and exactly one is active. Everything below
 * that talks about "the sequence" means the active one, which is what the
 * timeline is showing — and every editing function works on it, so switching
 * tabs is the only thing that changes what an edit lands in.
 *
 * They are held here together rather than in a module of their own because
 * there would then be two answers to "what is the sequence": a collection and a
 * current one, kept in step by hand. One list and one pointer cannot disagree.
 *
 * Each is a file: see shared/sequenceFormat.js for what that buys and
 * kernel/project.ts for when it is written.
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

/**
 * What a sequence *is*, as opposed to what is in it.
 *
 * The same shape in memory as in the file, deliberately: a settings object that
 * had to be mapped between two layouts would be two places to add a field and
 * one place to forget.
 *
 * `width`, `height` and `frameRate` drive the app today — the frame the
 * compositor draws into and the grid the timeline snaps to. `audio` and
 * `preview` are recorded and not yet acted on; see shared/sequenceFormat.js.
 */
export interface SequenceSettings {
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
  frameRate: number
  audio: { sampleRate: number; channels: number }
  preview: { codec: string; pixelFormat: string; cacheFrames: boolean }
}

export interface SequenceState {
  id: string
  name: string
  settings: SequenceSettings
  tracks: Track[]
  clips: Clip[]
  createdAt: number
  /** Absolute path of its `.fluxseq`, once it has been written. */
  file?: string
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
function defaultSequence(name = 'Sequence 1'): SequenceState {
  return {
    id: nextId('s'),
    name,
    createdAt: Date.now(),
    // The size is replaced by the first clip dropped into an empty sequence,
    // which is what makes it a default rather than a setting nobody was
    // offered.
    settings: defaultSettings() as SequenceSettings,
    tracks: [
      makeTrack('V2', 'video'),
      makeTrack('V1', 'video'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ],
    clips: [],
  }
}

/*
 * Ids, defined before anything that makes one.
 *
 * The module builds a default sequence as it initialises, and that calls this —
 * so a counter declared further down would be read before it exists. `let` in
 * a temporal dead zone throws rather than reading undefined, which is the only
 * reason this was a crash at startup and not a sequence with an id of `sNaN`.
 */
let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`
}

function makeTrack(id: string, kind: TrackKind): Track {
  return { id, kind, name: id, gain: 0, muted: false, solo: false, hidden: false }
}

/**
 * The sequence being edited, and every other one in the project.
 *
 * Split rather than a list with a pointer into it, and the split is the point:
 * every editing function below works on `sequence`, so there is no way to
 * mutate one that is not on screen. Switching tabs is the *only* thing that
 * changes which that is.
 *
 * No sequence lives in both places, so there is nothing to keep in step.
 * `order` is the tab order, which is the folder's order on load and then
 * whatever the user has made of it — a list that reshuffled itself when a
 * sequence was renamed would be its own small bug.
 */
let sequence: SequenceState = defaultSequence()
const others = new Map<string, SequenceState>()
let order: string[] = [sequence.id]
let loaded = false
const listeners = new Set<() => void>()

/** Notifies only; kernel/project.ts owns writing the document. */
function emit() {
  listeners.forEach((listener) => listener())
}

/** Every sequence in the project, in tab order. */
export function listSequences(): SequenceState[] {
  return order
    .map((id) => (id === sequence.id ? sequence : others.get(id)))
    .filter((found): found is SequenceState => Boolean(found))
}

export function getActiveSequenceId(): string {
  return sequence.id
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
  others.clear()
  order = [sequence.id]
  loaded = true
  listeners.forEach((listener) => listener())
}

/**
 * Replaces every sequence in the project, without marking anything changed.
 *
 * The load path. An `active` that names nothing falls back to the first, which
 * is what happens when a project remembers a sequence whose file has since been
 * deleted — the alternative is a timeline showing nothing with no way to say
 * why.
 */
export function setSequences(list: SequenceState[], active?: string): void {
  const normalised = list.filter((one) => one?.tracks?.length).map(normalise)
  if (normalised.length === 0) {
    setSequence(null)
    return
  }

  others.clear()
  order = normalised.map((one) => one.id)
  sequence = normalised.find((one) => one.id === active) ?? normalised[0]
  for (const one of normalised) {
    if (one.id !== sequence.id) others.set(one.id, one)
  }
  loaded = true
  listeners.forEach((listener) => listener())
}

/**
 * Makes another sequence the one being edited.
 *
 * The outgoing one goes back into the collection as it stands, unsaved edits
 * and all: switching tabs is not a commit, and an edit that vanished because
 * you looked at something else would be the worst kind of data loss — silent,
 * and blamed on yourself.
 */
export function activateSequence(id: string): boolean {
  if (id === sequence.id) return false
  const wanted = others.get(id)
  if (!wanted) return false

  others.set(sequence.id, sequence)
  others.delete(id)
  sequence = wanted
  emit()
  return true
}

/**
 * Adds a sequence and makes it the one being edited.
 *
 * Settings are inherited from the sequence in front unless given, which is
 * almost always what a second sequence in the same project wants — the same
 * footage, the same frame, a different cut of it.
 */
export function createSequence(options?: {
  name?: string
  settings?: Partial<SequenceSettings>
  activate?: boolean
}): SequenceState {
  const taken = new Set(listSequences().map((one) => one.name))
  let index = listSequences().length + 1
  let name = options?.name
  if (!name) {
    while (taken.has(`Sequence ${index}`)) index += 1
    name = `Sequence ${index}`
  }

  const made: SequenceState = {
    ...defaultSequence(name),
    settings: makeSettings({ ...sequence.settings, ...options?.settings }) as SequenceSettings,
  }

  if (options?.activate === false) {
    others.set(made.id, made)
  } else {
    others.set(sequence.id, sequence)
    sequence = made
  }
  order = [...order, made.id]
  emit()
  return made
}

/**
 * Puts an already-made sequence into the project and opens it.
 *
 * The import path. Its id comes with it, and a clash means the same sequence is
 * already here — so it is given a fresh one rather than replacing what is
 * there, which is what importing a copy of something should do.
 */
export function addSequence(one: SequenceState): SequenceState {
  const taken = new Set(listSequences().map((each) => each.id))
  const made = normalise(taken.has(one.id) ? { ...one, id: nextId('s') } : one)
  others.set(sequence.id, sequence)
  sequence = made
  order = [...order, made.id]
  emit()
  return made
}

/** Renames a sequence. Its file moves with it on the next save. */
export function renameSequence(id: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (id === sequence.id) {
    if (sequence.name === trimmed) return false
    sequence = { ...sequence, name: trimmed }
  } else {
    const found = others.get(id)
    if (!found || found.name === trimmed) return false
    others.set(id, { ...found, name: trimmed })
  }
  emit()
  return true
}

/**
 * Removes a sequence.
 *
 * Refuses the last one, for the reason removeTrack refuses the last track: a
 * project with no sequence has no timeline, and that is a state with no way
 * back out of it.
 */
export function removeSequence(id: string): SequenceState | null {
  if (order.length <= 1) return null
  const removed = id === sequence.id ? sequence : others.get(id)
  if (!removed) return null

  order = order.filter((one) => one !== id)
  others.delete(id)
  if (id === sequence.id) {
    const next = others.get(order[0])
    if (!next) return null
    others.delete(next.id)
    sequence = next
  }
  emit()
  return removed
}

/** A sequence as its file, with the media its clips refer to. */
export function sequenceDocument(
  one: SequenceState,
  assets: Array<{ id: string }>,
  appVersion?: string,
): Record<string, unknown> {
  return makeSequenceDocument({
    id: one.id,
    name: one.name,
    createdAt: one.createdAt,
    settings: one.settings,
    tracks: one.tracks,
    clips: one.clips,
    media: mediaFor(one.clips, assets),
    appVersion,
  }) as Record<string, unknown>
}

/** Records where a sequence's file ended up, without counting as an edit. */
export function noteSequenceFile(id: string, file: string): void {
  if (id === sequence.id) sequence = { ...sequence, file }
  else {
    const found = others.get(id)
    if (found) others.set(id, { ...found, file })
  }
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

  /*
   * Settings, from wherever this arrived with them.
   *
   * A sequence written before it was a file of its own carried its frame rate
   * and size as its own fields; one written after carries a settings object.
   * Both open, and both save forward in the current shape. makeSettings fills
   * in whatever is missing, so nothing downstream has to ask which era a
   * document came from.
   */
  const raw = next.settings ?? {
    width: (next as unknown as { width?: number }).width,
    height: (next as unknown as { height?: number }).height,
    frameRate: (next as unknown as { frameRate?: number }).frameRate,
  }

  return {
    ...next,
    id: next.id || nextId('s'),
    name: next.name || 'Sequence 1',
    createdAt: next.createdAt || Date.now(),
    settings: makeSettings(raw) as SequenceSettings,
    tracks,
    clips,
  }
}


/** Snap to the frame grid, so clips can never land on fractional frames. */
export function snapToFrame(seconds: number, frameRate = sequence.settings.frameRate): number {
  return Math.max(0, Math.round(seconds * frameRate) / frameRate)
}

/**
 * Frame-quantise a *distance*, which unlike a position may be negative.
 *
 * snapToFrame clamps at zero because no clip starts before the sequence does.
 * Running a drag delta through it would silently turn every leftward move into
 * a move to zero.
 */
export function snapDelta(seconds: number, frameRate = sequence.settings.frameRate): number {
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
 * Changes some of the active sequence's settings.
 *
 * A partial rather than the whole object, because almost every caller is
 * changing one thing — and a settings dialog that had to hand back every field
 * it did not touch is a dialog that can drop one.
 */
export function updateSequenceSettings(change: Partial<SequenceSettings>): boolean {
  const settings = makeSettings({ ...sequence.settings, ...change }) as SequenceSettings
  if (JSON.stringify(settings) === JSON.stringify(sequence.settings)) return false
  sequence = { ...sequence, settings }
  emit()
  return true
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
  return updateSequenceSettings({ width: Math.round(width), height: Math.round(height) })
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
  others.clear()
  order = [sequence.id]
  loaded = false
  listeners.forEach((listener) => listener())
}

export function clearSequence(): void {
  sequence = { ...sequence, clips: [] }
  emit()
}
