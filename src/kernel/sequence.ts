import type { ClipEffects } from './clipEffects'
import {
  defaultSettings,
  makeSettings,
  makeSequenceDocument,
  readRange,
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
  /** Seconds of the source this clip plays. Not the source's length. */
  duration: number
  /**
   * Seconds into the source where this clip begins — the in point.
   *
   * Trimming the head moves this and `start` together and shortens `duration`
   * by the same amount, which is what makes it a trim rather than a slip: the
   * frames that remain stay exactly where they were on the timeline, and only
   * the ones outside the clip stop being played.
   */
  offset: number
  /**
   * How long the source is, as it was when this clip was cut.
   *
   * Written down rather than looked up, for the same reason a link lives on the
   * clip: it is what decides whether an edge can be pulled back out, and that
   * has to be a fact about the sequence rather than something the panel happens
   * to know. It also survives the asset being removed from the bin, which the
   * clip itself already does.
   *
   * A clip saved before trimming existed was the whole file, so an older
   * document reads back with this equal to its duration — which is true.
   */
  sourceDuration: number
  /**
   * How fast the source runs, as a multiple. 1 is as it was shot.
   *
   * A clip covers `duration * speed` seconds of its source in `duration`
   * seconds of sequence, so every place that turns a moment on the timeline
   * into a moment in a file multiplies by this — the compositor, the mixer, the
   * waveform, and the arithmetic of a trim.
   *
   * Stored rather than derived from the two durations, even though it could be:
   * a clip at 1.0000001 because of floating point would be a clip that is
   * *nearly* untouched, and "is this clip stretched?" has to have a yes or no
   * answer for anything downstream to say so.
   */
  speed: number
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
  /**
   * What this clip does to its picture and its sound — see kernel/clipEffects.
   *
   * Absent until something is actually moved off its default, which is why it
   * is optional rather than filled in: a clip carrying `rotation: 0` claims
   * someone decided not to rotate it, and the defaults for position and anchor
   * are the centre of *the frame*, so writing them down would pin them to
   * whatever size the sequence happened to be at the time.
   */
  effects?: ClipEffects
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
  /**
   * Where the sequence ends, in seconds — or 0 for "as long as the clips are".
   *
   * Zero rather than null because "follow the clips" is a real answer to the
   * question and not a missing one, and a nullable number would have to be
   * checked for everywhere it is read. See sequenceDuration.
   */
  duration: number
  /** What the ruler counts from. An hour is the broadcast convention. */
  startTimecode: number
  pixelAspect: number
  fieldOrder: string
  colour: { space: string; transfer: string; depth: number }
  audio: { sampleRate: number; channels: number; bitDepth: number }
  preview: { codec: string; pixelFormat: string; scale: number; cacheFrames: boolean }
}

/**
 * The span of the sequence a render is about, or null for all of it.
 *
 * In and out are kept separately rather than as one `{from, to}` because they
 * are set separately — `I` and `O` land one each, and an in point with no out
 * yet is an ordinary half-finished state rather than an invalid one. What
 * resolves them into an actual span is `renderRange`, which fills a missing in
 * with zero and a missing out with the end.
 *
 * They belong to the *sequence*, not to the render settings, for the same
 * reason the timeline is the manifest: marking a span is an edit — it is a
 * statement about this cut, it is what you were looking at, and it has to be
 * in the document when you come back tomorrow.
 */
export interface SequenceRange {
  /** Seconds, or null when nothing has been marked. */
  inPoint: number | null
  outPoint: number | null
}

export interface SequenceState {
  id: string
  name: string
  settings: SequenceSettings
  /** The marked span. Absent on a document written before it existed. */
  range?: SequenceRange
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
/**
 * Undo, from the module that owns what is being undone.
 *
 * Snapshots rather than inverse operations. An inverse for every edit is a
 * second implementation of every edit — and it is the one nobody exercises, so
 * it is the one that is wrong. A sequence is a few hundred small objects; a
 * hundred of them is a rounding error next to one decoded frame.
 *
 * The whole collection, not the sequence being edited: creating, renaming,
 * closing and switching sequences are edits too, and an undo that restored a
 * sequence into a project that had moved on would be worse than no undo.
 */
interface Snapshot {
  active: string
  order: string[]
  sequences: SequenceState[]
  at: number
  /** The ids and tracks in play, for deciding whether two changes are one. */
  shape: string
}

/** Deep enough: clips and tracks are replaced wholesale by every mutator. */
function takeSnapshot(): Snapshot {
  const all = listSequences()
  return {
    active: sequence.id,
    order: [...order],
    sequences: all.map((one) => ({ ...one, tracks: [...one.tracks], clips: [...one.clips] })),
    at: Date.now(),
    shape: all
      .map((one) => `${one.id}:${one.tracks.map((t) => t.id).join(',')}:${one.clips
        .map((c) => c.id)
        .join(',')}`)
      .join('|'),
  }
}

function restore(shot: Snapshot): void {
  others.clear()
  order = [...shot.order]
  const byId = new Map(shot.sequences.map((one) => [one.id, one]))
  sequence = byId.get(shot.active) ?? shot.sequences[0]
  for (const one of shot.sequences) if (one.id !== sequence.id) others.set(one.id, one)
  listeners.forEach((listener) => listener())
}

/** How many steps back it is possible to go. Old ones fall off the bottom. */
const HISTORY_LIMIT = 200

/**
 * How close together two changes have to be to count as one.
 *
 * A fader dragged across a track emits on every pointer move, and fifty undo
 * steps for one gesture is an undo nobody can use. Time alone is not enough to
 * merge on, though — see `shape` below.
 */
const COALESCE_MS = 400

let past: Snapshot[] = []
let future: Snapshot[] = []
/** What the sequence looked like at the last thing worth undoing. */
let mark: Snapshot | null = null
/**
 * When the last change arrived — not when the last *entry* was pushed.
 *
 * The two are different in exactly the case merging exists for. A fader drag
 * pushes one entry on its first move and then merges the rest into it, so the
 * pushed entry's timestamp is from *before* the drag and gets older with every
 * move. Comparing against that, nothing ever merges and one gesture becomes
 * fifty steps — which is what happened.
 */
let lastChangeAt = 0
/** True while undo or redo is writing, so the write is not recorded as an edit. */
let rewinding = false

function record() {
  if (rewinding) return
  const before = mark
  mark = takeSnapshot()
  if (!before) return

  /*
   * Two changes are one step when they arrive together *and* nothing appeared
   * or disappeared in between.
   *
   * That second half is what keeps this honest: a gain dragged along merges
   * into one step, but a clip deleted a tenth of a second after another clip
   * moved does not, because the set of ids changed. Structure always gets its
   * own step; only values are merged.
   */
  const merge =
    past.length > 0 &&
    mark.at - lastChangeAt < COALESCE_MS &&
    before.shape === past[past.length - 1].shape &&
    before.shape === mark.shape
  lastChangeAt = mark.at
  if (!merge) {
    past.push(before)
    if (past.length > HISTORY_LIMIT) past.shift()
  }
  // Anything done after an undo throws away what was undone. Keeping it would
  // mean a redo that jumps to a version of the sequence nobody was looking at.
  future = []
}

export function canUndo(): boolean {
  return past.length > 0
}

export function canRedo(): boolean {
  return future.length > 0
}

/** How many steps are held either way. For checks, and for saying so. */
export function historyDepth(): { past: number; future: number } {
  return { past: past.length, future: future.length }
}

export function undo(): boolean {
  const shot = past.pop()
  if (!shot) return false
  future.push(takeSnapshot())
  rewinding = true
  try {
    restore(shot)
  } finally {
    rewinding = false
  }
  mark = takeSnapshot()
  return true
}

export function redo(): boolean {
  const shot = future.pop()
  if (!shot) return false
  past.push(takeSnapshot())
  rewinding = true
  try {
    restore(shot)
  } finally {
    rewinding = false
  }
  mark = takeSnapshot()
  return true
}

/**
 * Forgets everything, without touching the sequence.
 *
 * Called when a project opens or closes: undoing into another project's clips
 * would restore ids that mean nothing here, which is the same reason the
 * clipboard is emptied.
 */
export function clearHistory(): void {
  past = []
  future = []
  mark = takeSnapshot()
}

/**
 * Depth of nested asOneStep calls, and whether anything changed inside them.
 *
 * A counter rather than a flag so the outermost caller is the one that
 * publishes: a batch that calls another batched helper must not have its step
 * closed early by the inner one finishing.
 */
let grouping = 0
let groupChanged = false

function emit() {
  if (grouping > 0) {
    groupChanged = true
    return
  }
  record()
  listeners.forEach((listener) => listener())
}

/**
 * Runs many edits as one change: one undo step, one notification.
 *
 * Every mutation here calls `emit`, which snapshots for undo and re-renders
 * whatever is listening. That is right for an edit made by a hand — and wrong
 * for one made by a loop. A batch import placing 406 clips would otherwise push
 * 406 history entries, overflowing HISTORY_LIMIT and throwing away everything
 * the session had done before it, leaving an import that takes 406 presses to
 * undo. It would also re-render the timeline 406 times while building it.
 *
 * So the work is wrapped and the step is published once at the end. Undo then
 * takes the whole import back out, which is the only sensible meaning of
 * undoing an import.
 *
 * **The work must be synchronous.** An `await` inside it would return to the
 * event loop with the group still open, so an unrelated edit arriving in that
 * gap would be swallowed into the same step — and if the promise rejected, the
 * group would never close and nothing would ever repaint again. Anything that
 * has to wait (probing files, reading indexes) belongs before the call, which
 * is also the shape that lets a batch report progress while it waits.
 */
export function asOneStep<T>(work: () => T): T {
  grouping += 1
  try {
    return work()
  } finally {
    grouping -= 1
    if (grouping === 0 && groupChanged) {
      groupChanged = false
      record()
      listeners.forEach((listener) => listener())
    }
  }
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
  // Loading is not an edit, and there is nothing behind it to go back to.
  clearHistory()
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
  clearHistory()
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
    range: one.range,
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
  const clips = next.clips.map((clip) => ({
    ...clip,
    kind: clip.kind ?? kindOf.get(clip.trackId) ?? 'video',
    // A clip saved before trimming existed played its whole file from the top,
    // so these are not defaults standing in for unknowns — they are what that
    // clip actually was.
    offset: Number.isFinite(clip.offset) ? Math.max(0, clip.offset) : 0,
    // A clip saved before stretching existed played at the rate it was shot,
    // which is what 1 means. Not a default standing in for an unknown.
    speed: Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1,
    sourceDuration:
      Number.isFinite(clip.sourceDuration) && clip.sourceDuration > 0
        ? clip.sourceDuration
        : (Number.isFinite(clip.offset) ? Math.max(0, clip.offset) : 0) + clip.duration,
  }))

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
    // Undefined when nothing was marked, which is also what a document from
    // before the marks existed reads back as.
    range: readRange((next as unknown as { range?: unknown }).range),
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
  /** Seconds into the source. Defaults to the top of the file. */
  offset?: number
  /** How fast the source runs. Defaults to the rate it was shot at. */
  speed?: number
  /** The source's full length. Defaults to what is being played, which is what
      a drop means: the whole file. */
  sourceDuration?: number
  /** Ties this clip to the one that came out of the same file. */
  linkId?: string
}

export function addClip({
  assetId,
  trackId,
  start,
  duration,
  offset,
  speed,
  sourceDuration,
  linkId,
}: NewClip): Clip | null {
  const track = sequence.tracks.find((t) => t.id === trackId)
  if (!track || duration <= 0) return null

  const clip: Clip = {
    id: nextId('c'),
    assetId,
    trackId,
    start: findFreeStart(trackId, start, duration),
    duration,
    offset: Math.max(0, offset ?? 0),
    speed: speed && speed > 0 ? speed : 1,
    sourceDuration: Math.max(duration, sourceDuration ?? (offset ?? 0) + duration),
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
 * The other half goes on the first track of its kind that can take it at the
 * same moment, so a linked pair starts life in sync. If none can, a new track
 * is made for it — which is what every NLE does, and the only answer that keeps
 * the pair together. Sliding one half along to the next free gap would put it
 * out of sync with its own other half, and dropping it would lose it silently.
 *
 * `trackId` may name a track of **either** kind, and whichever it names is the
 * half that honours `start`; the other follows it. Placing them independently
 * would let the two halves of one take land at different moments, which is not
 * a pair, it is a sync error waiting to be noticed.
 *
 * Taking an audio track here is what makes a file dropped on A1 arrive whole.
 * It used to land as its sound alone — defensible, and what the audio-only
 * drag in Premiere does, but not what dragging a *file* onto the timeline
 * means. The picture was silently discarded, and the sound that remained was
 * linked to nothing, so it also had to be paired up by hand afterwards.
 */
/**
 * The lowest video track that is free across `start`, or a new one.
 *
 * Searched from the bottom because tracks are stored in the order they stack —
 * `[V2, V1, A1, A2]` — so a plain `find` returns the *top* video track, and a
 * picture dropped alongside its sound would climb to V2 while the same file
 * dropped on a video track went to V1. Audio needs no equivalent: A1 is
 * already the first audio track in that order.
 */
function lowestFreeVideoTrack(start: number, duration: number): Track {
  const video = sequence.tracks.filter((track) => track.kind === 'video')
  for (let i = video.length - 1; i >= 0; i--) {
    if (findFreeStart(video[i].id, start, duration) === start) return video[i]
  }
  return addTrack('video')
}

export function addLinkedClips(
  { assetId, trackId, start, duration }: NewClip,
  withAudio: boolean,
): { video: Clip | null; audio: Clip | null } {
  const target = sequence.tracks.find((track) => track.id === trackId)

  if (target?.kind === 'audio') {
    // Dropped on the sound. The sound is what lands where it was put.
    if (!withAudio) {
      // A silent file has nothing for this track, so its picture goes to the
      // first video track that will have it rather than nowhere at all.
      const home = lowestFreeVideoTrack(start, duration)
      return { video: addClip({ assetId, trackId: home.id, start, duration }), audio: null }
    }

    const pairId = nextId('l')
    const audio = addClip({ assetId, trackId, start, duration, linkId: pairId })
    if (!audio) return { video: null, audio: null }

    const home = lowestFreeVideoTrack(audio.start, duration)

    const picture = addClip({
      assetId,
      trackId: home.id,
      start: audio.start,
      duration,
      linkId: pairId,
    })
    if (!picture) {
      // Same reasoning as below: a clip pointing at a partner that was never
      // made is worse than an unlinked one.
      sequence = {
        ...sequence,
        clips: sequence.clips.map((clip) =>
          clip.id === audio.id ? { ...clip, linkId: undefined } : clip,
        ),
      }
      emit()
    }
    return { video: picture, audio }
  }

  const linkId = withAudio ? nextId('l') : undefined
  const video = addClip({ assetId, trackId, start, duration, linkId })
  if (!video || !withAudio) return { video, audio: null }

  const free =
    sequence.tracks.find(
      (track) =>
        track.kind === 'audio' && findFreeStart(track.id, video.start, duration) === video.start,
    ) ?? addTrack('audio')

  const audio = addClip({ assetId, trackId: free.id, start: video.start, duration, linkId })
  if (!audio) {
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
 * Every clip inside a rectangle of the timeline: a span of time, a run of
 * tracks.
 *
 * The timeline is two-dimensional and every selection gesture on it is a
 * rectangle — a marquee dragged across it, or a range extended from one clip to
 * another. Both are the same question asked twice, so they are the same
 * function, and it lives here because "which clips are in this region" is a
 * fact about the sequence rather than about the panel drawing it.
 *
 * Track *positions*, not ids: a rectangle spans whatever lies between two rows
 * on screen, and the rows are the track order.
 *
 * Touching counts. A clip half inside the rectangle is inside it, because that
 * is what dragging a box across a timeline visibly does — requiring
 * containment would make a marquee across a long clip select nothing at all.
 */
export function clipsInRegion(
  fromTime: number,
  toTime: number,
  fromRow: number,
  toRow: number,
): Clip[] {
  const start = Math.min(fromTime, toTime)
  const end = Math.max(fromTime, toTime)
  const top = Math.min(fromRow, toRow)
  const bottom = Math.max(fromRow, toRow)

  return sequence.clips.filter((clip) => {
    const row = sequence.tracks.findIndex((track) => track.id === clip.trackId)
    if (row < top || row > bottom) return false
    // A zero-width sweep still catches what it lands on: a click is a rectangle
    // with no width, and one that selected nothing would be a dead gesture.
    if (end - start < EPS) return clip.start <= end + EPS && clip.start + clip.duration >= start - EPS
    return clip.start < end - EPS && clip.start + clip.duration > start + EPS
  })
}

/**
 * The clips between two of them, as a range select means it.
 *
 * Not "the clips whose ids fall between", and not "everything on one track":
 * the rectangle from one clip to the other, covering every track in between
 * for the whole span the two of them cover. Shift-clicking an audio clip two
 * tracks below a picture therefore takes the picture, the sound, and whatever
 * else is under that stretch of time — which is what a range on a timeline
 * looks like, and what makes it a *timeline* range rather than a list one.
 *
 * @returns the ids, expanded through links, or the target alone when the
 *   anchor has gone.
 */
export function clipsBetween(anchorId: string, targetId: string): string[] {
  const anchor = sequence.clips.find((clip) => clip.id === anchorId)
  const target = sequence.clips.find((clip) => clip.id === targetId)
  if (!target) return []
  if (!anchor) return withLinked([targetId])

  const row = (clip: Clip) => sequence.tracks.findIndex((track) => track.id === clip.trackId)
  const inside = clipsInRegion(
    Math.min(anchor.start, target.start),
    Math.max(anchor.start + anchor.duration, target.start + target.duration),
    row(anchor),
    row(target),
  )
  // Through the links, like every other selection: a picture whose sound was
  // left out of the range would come apart the moment the range was dragged.
  return withLinked(inside.map((clip) => clip.id))
}

/**
 * The clips the playhead is inside, front-most first.
 *
 * Front-most means the same thing it means to the Viewer: video tracks stack
 * upward, so the last one drawn is the one being looked at. Audio follows,
 * because a sequence with no picture at that moment still has something to be
 * paused on.
 */
export function clipsAtTime(time: number): Clip[] {
  const rows = new Map(sequence.tracks.map((track, index) => [track.id, index]))
  return sequence.clips
    .filter((clip) => time >= clip.start - EPS && time < clip.start + clip.duration - EPS)
    .sort((a, b) => (rows.get(a.trackId) ?? 0) - (rows.get(b.trackId) ?? 0))
}

/**
 * Clips lifted out of a sequence, waiting to be put back somewhere.
 *
 * Held here rather than in the system clipboard, and that is a real decision.
 * A clip is a reference to an asset in *this* project plus a placement in time;
 * pasting one into a text editor could only ever produce nonsense, and pasting
 * something from a text editor into a timeline is not a thing to support. When
 * FLUX can copy clips between its own windows this becomes a serialiser and the
 * shape below is already what it would write.
 *
 * Starts are stored as they were, and the earliest is subtracted at paste time.
 * Keeping them absolute means the internal shape of a copied group — the gaps,
 * the sync between a picture and its sound — is exactly what comes back.
 */
interface Clipboard {
  clips: Clip[]
  /** Only for saying "3 clips" in a menu; the clips themselves are the truth. */
  count: number
}

let clipboard: Clipboard = { clips: [], count: 0 }

/** Clips as they would be copied: the ones asked for, plus their linked halves. */
function snapshot(ids: string[]): Clip[] {
  const wanted = new Set(withLinked(ids))
  return sequence.clips.filter((clip) => wanted.has(clip.id)).map((clip) => ({ ...clip }))
}

export function copyClips(ids: string[]): number {
  const clips = snapshot(ids)
  if (clips.length === 0) return 0
  clipboard = { clips, count: clips.length }
  return clips.length
}

/** How many clips are waiting to be pasted. */
export function clipboardCount(): number {
  return clipboard.count
}

/**
 * Where a set of clips can sit together, at or after `at`.
 *
 * The whole group moves as one, which is the difference between this and
 * placing each clip in turn: a picture and its sound have to land at the same
 * moment or the paste is a sync error. So a single offset is found that clears
 * every obstacle on every track the group touches.
 *
 * Sliding right rather than overwriting or inserting, for the reason a drop
 * gives: it is the only outcome that neither loses a frame nor moves something
 * already placed. These clips are *new*, exactly as a dropped one is, so they
 * follow the drop's rule rather than a move's midpoint rule.
 */
function freeOffsetFor(clips: Clip[], at: number, occupied: Clip[]): number {
  const earliest = Math.min(...clips.map((clip) => clip.start))
  let offset = snapToFrame(at) - earliest

  // Bounded: each pass clears one obstacle, and there are only so many.
  for (let pass = 0; pass <= occupied.length; pass++) {
    let pushed = false
    for (const clip of clips) {
      const start = clip.start + offset
      const end = start + clip.duration
      for (const other of occupied) {
        if (other.trackId !== clip.trackId) continue
        if (start < other.start + other.duration - EPS && other.start < end - EPS) {
          offset = snapToFrame(other.start + other.duration) - clip.start
          pushed = true
          break
        }
      }
      if (pushed) break
    }
    if (!pushed) break
  }
  return offset
}

/**
 * Copies of `clips`, placed with their earliest at or after `at`.
 *
 * New ids throughout, and new link ids — mapped, so a copied pair is linked to
 * itself rather than to the clips it came from. Two pairs sharing a link would
 * mean dragging the copy moved the original, which is the kind of bug that only
 * shows up hours later.
 */
function placeCopies(clips: Clip[], at: number, trackShift: number): Clip[] {
  if (clips.length === 0) return []

  const index = (trackId: string) => sequence.tracks.findIndex((track) => track.id === trackId)

  /*
   * One shift for the whole set, limited by whichever member has least room.
   *
   * The same rule as moving, and for the same reason: a picture that goes up a
   * track while its sound stays behind — because the sound was already on the
   * bottom audio track — is a pair that arrived in two pieces. Either both
   * change track or neither does.
   */
  const room = clips
    .map((clip) => {
      const from = index(clip.trackId)
      if (from < 0) return null
      const band = sequence.tracks.filter((track) => track.kind === clip.kind)
      const first = sequence.tracks.indexOf(band[0])
      const last = sequence.tracks.indexOf(band[band.length - 1])
      return { up: from - first, down: last - from }
    })
    .filter((one): one is { up: number; down: number } => one !== null)
  const shift = room.length
    ? Math.min(
        Math.max(trackShift, -Math.min(...room.map((one) => one.up))),
        Math.min(...room.map((one) => one.down)),
      )
    : 0

  const landing = (clip: Clip): string | null => {
    const from = index(clip.trackId)
    // A track that has gone since the copy: the nearest one of the same kind
    // takes it, because a clip with nowhere to go is a clip that vanishes.
    if (from < 0) return sequence.tracks.find((track) => track.kind === clip.kind)?.id ?? null
    return sequence.tracks[from + shift]?.id ?? clip.trackId
  }

  const moved = clips
    .map((clip) => ({ clip, trackId: landing(clip) }))
    .filter((row): row is { clip: Clip; trackId: string } => row.trackId !== null)
    .map(({ clip, trackId }) => ({ ...clip, trackId }))
  if (moved.length === 0) return []

  const offset = freeOffsetFor(moved, at, sequence.clips)
  const links = new Map<string, string>()
  const copies = moved.map((clip) => {
    const linkId = clip.linkId
      ? (links.get(clip.linkId) ?? links.set(clip.linkId, nextId('l')).get(clip.linkId)!)
      : undefined
    return {
      ...clip,
      id: nextId('c'),
      start: Math.max(0, clip.start + offset),
      ...(linkId ? { linkId } : { linkId: undefined }),
    }
  })

  sequence = { ...sequence, clips: [...sequence.clips, ...copies] }
  emit()
  return copies
}

/**
 * Puts the clipboard down, earliest clip at `at`.
 *
 * @returns the clips that landed, so the caller can select them — which is what
 *   every editor does, and what makes a second paste land after the first
 *   rather than on top of it.
 */
export function pasteClips(at: number, trackShift = 0): Clip[] {
  return placeCopies(clipboard.clips, at, trackShift)
}

/**
 * Puts the clipboard down on a chosen track.
 *
 * The shift is measured from the copied clip that *matches the target's kind*
 * and sits highest in the stack — so pasting onto A2 lines the topmost copied
 * sound up with A2, and anything else in the clipboard moves by the same
 * amount. One shift for the whole set, because a picture and its sound that
 * landed on different offsets would be a paste that arrived out of sync.
 *
 * That shift is then clamped by `placeCopies`, per band, exactly as a move is.
 * A pair targeted at a track its other half cannot follow lands where both
 * halves can — the caller compares the result against what it asked for and
 * says so, which is the only honest thing to do with a request that cannot be
 * met in full.
 */
export function pasteOnto(at: number, trackId: string): Clip[] {
  const target = sequence.tracks.findIndex((track) => track.id === trackId)
  if (target < 0) return placeCopies(clipboard.clips, at, 0)

  const kind = sequence.tracks[target].kind
  const index = (id: string) => sequence.tracks.findIndex((track) => track.id === id)
  const lead = clipboard.clips
    .filter((clip) => clip.kind === kind && index(clip.trackId) >= 0)
    .sort((p, q) => index(p.trackId) - index(q.trackId))[0]
  // Nothing of that kind copied, or its track has since gone: there is no
  // distance to measure, so the paste falls back to where it came from.
  return placeCopies(clipboard.clips, at, lead ? target - index(lead.trackId) : 0)
}

/**
 * Copies clips where they are dragged to, leaving the originals behind.
 *
 * Deliberately not routed through the clipboard: `Alt`-dragging something must
 * not throw away whatever was copied a minute ago, which is a small thing that
 * is infuriating exactly once.
 */
export function duplicateClips(
  ids: string[],
  deltaSeconds: number,
  deltaTracks: number,
): Clip[] {
  const clips = snapshot(ids)
  if (clips.length === 0) return []
  const earliest = Math.min(...clips.map((clip) => clip.start))
  return placeCopies(clips, earliest + snapDelta(deltaSeconds), deltaTracks)
}

/**
 * Ties a set of clips together, or cuts them apart.
 *
 * One gesture rather than two commands, because the question a hand is asking
 * is never "is this linked?" — it is "should this move on its own now?", and
 * the answer to that is always the opposite of what is currently true.
 *
 * The whole group either way. Given one half of a pair, both halves are
 * unlinked: leaving a partner pointing at a link with nobody else in it would
 * be a clip that looks tied to something and is not. Given two clips to link,
 * anything already linked to either of them joins the new group rather than
 * being left behind — a sound that quietly stopped following its picture
 * because the picture was relinked to something else is the failure this whole
 * mechanism exists to prevent.
 *
 * Linking does not move anything. Two clips that drifted apart while unlinked
 * stay where they are and travel together from here — which is what "link"
 * means everywhere else, and re-syncing them would silently undo the edit that
 * separated them.
 *
 * @returns what the clips are now, or null when there was nothing to do.
 */
export function toggleLink(ids: string[]): 'linked' | 'unlinked' | null {
  const group = new Set(withLinked(ids))
  const chosen = sequence.clips.filter((clip) => group.has(clip.id))
  if (chosen.length === 0) return null

  if (chosen.some((clip) => clip.linkId)) {
    sequence = {
      ...sequence,
      clips: sequence.clips.map((clip) =>
        group.has(clip.id) && clip.linkId ? { ...clip, linkId: undefined } : clip,
      ),
    }
    emit()
    return 'unlinked'
  }

  // A single clip has nothing to be tied to. Saying so is the panel's job; here
  // it is simply not an edit.
  if (chosen.length < 2) return null

  const linkId = nextId('l')
  sequence = {
    ...sequence,
    clips: sequence.clips.map((clip) => (group.has(clip.id) ? { ...clip, linkId } : clip)),
  }
  emit()
  return 'linked'
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
/**
 * Changes some of a clip's effect parameters, leaving the rest alone.
 *
 * Merged two levels deep, so a panel can report the one field a hand moved
 * without having to send back everything it is not touching — and without a
 * stale copy of the rest overwriting a change that arrived in between.
 */
export function setClipEffects(id: string, patch: ClipEffects): boolean {
  const clip = sequence.clips.find((c) => c.id === id)
  if (!clip) return false

  const effects: ClipEffects = {
    transform: { ...clip.effects?.transform, ...patch.transform },
    audio: { ...clip.effects?.audio, ...patch.audio },
  }
  sequence = {
    ...sequence,
    clips: sequence.clips.map((c) => (c.id === id ? { ...c, effects } : c)),
  }
  emit()
  return true
}

/** Puts a clip back to no transform and no audio change at all. */
export function clearClipEffects(id: string): boolean {
  const clip = sequence.clips.find((c) => c.id === id)
  if (!clip?.effects) return false
  sequence = {
    ...sequence,
    clips: sequence.clips.map((c) => {
      if (c.id !== id) return c
      const { effects: _dropped, ...rest } = c
      return rest
    }),
  }
  emit()
  return true
}

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
export function moveClips(
  ids: string[],
  deltaSeconds: number,
  deltaTracks: number,
  options?: MoveOptions,
): boolean {
  // Linked partners travel with what they are linked to. Expanded here rather
  // than at the caller: that a picture does not leave its sound behind is a
  // rule about the sequence, not a convenience of the panel that drags it.
  const asked = new Set(ids)
  const moving = new Set(options?.throughLinks === false ? ids : withLinked(ids))
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

/** Which end of a clip a trim is dragging. */
export type TrimEdge = 'start' | 'end'

/**
 * The shortest a clip may be trimmed to: one frame.
 *
 * Not zero, and not "a few frames". A clip is a thing that plays, so the floor
 * is the smallest amount of time that can be played — and a zero-length clip is
 * an invisible object on the timeline that still catches drops and still has to
 * be selected to be deleted.
 */
function minDuration(): number {
  return 1 / sequence.settings.frameRate
}

/**
 * How far an edge can travel, in the direction it was dragged.
 *
 * Positive is later in time for both edges, which is what the hand means: the
 * head moving right shortens the clip and the tail moving right lengthens it.
 * Four things can stop it, and each is a different fact:
 *
 *   - **the source.** The head cannot go before the first frame of the file and
 *     the tail cannot go past the last. This is why a clip records how long its
 *     source was: without it, a trimmed clip could never be pulled back out.
 *   - **the neighbour.** An edge stops where the next clip on that track
 *     begins. Trimming is not a move, so nothing slides out of the way and
 *     nothing is overwritten.
 *   - **one frame.** See above.
 *   - **the start of the sequence.** Nothing lives before zero.
 *
 * A group is clamped to what *every* member can take, so a linked pair trims by
 * one amount and stays in sync. Clamped, not refused: an edge that stops moving
 * when it reaches the file's end is exactly what a hand expects, where a pair
 * that ignores the drag entirely reads as a broken handle.
 *
 * The result lands on the frame grid — inside the limit, never past it, since
 * the last fraction of a frame at the end of a file is not a frame you can play.
 */
export function allowedTrim(ids: string[], edge: TrimEdge, deltaSeconds: number): number {
  const wanted = new Set(withLinked(ids))
  const chosen = sequence.clips.filter((clip) => wanted.has(clip.id))
  if (chosen.length === 0) return 0

  const min = minDuration()
  let low = -Infinity
  let high = Infinity

  for (const clip of chosen) {
    const siblings = clipsOnTrack(clip.trackId).filter((other) => !wanted.has(other.id))
    // A second of timeline is `speed` seconds of source, so the limits the
    // *file* imposes are divided by it: a clip at 2x has half as much timeline
    // left to give as it has file.
    const spare = (clip.sourceDuration - clip.offset) / clip.speed - clip.duration
    if (edge === 'start') {
      const before = siblings
        .filter((other) => other.start + other.duration <= clip.start + EPS)
        .reduce((end, other) => Math.max(end, other.start + other.duration), 0)
      low = Math.max(low, -clip.offset / clip.speed, before - clip.start, -clip.start)
      high = Math.min(high, clip.duration - min)
    } else {
      const after = siblings
        .filter((other) => other.start >= clip.start + clip.duration - EPS)
        .reduce((start, other) => Math.min(start, other.start), Infinity)
      low = Math.max(low, min - clip.duration)
      high = Math.min(high, spare, after - clip.start - clip.duration)
    }
  }

  const fps = sequence.settings.frameRate
  // Onto the grid from the inside: ceil the floor, floor the ceiling. Rounding
  // either the other way would offer a frame that is not there.
  const lowFrame = Math.ceil(low * fps - EPS) / fps
  const highFrame = Math.floor(high * fps + EPS) / fps
  if (lowFrame > highFrame) return 0

  return Math.min(highFrame, Math.max(lowFrame, snapDelta(deltaSeconds)))
}

/**
 * Trims one edge of a clip and everything linked to it.
 *
 * The head takes `offset` with it — the frames left in the clip do not move on
 * the timeline, which is what separates a trim from a slip and from a move.
 *
 * @returns true when anything actually changed.
 */
export function trimClips(ids: string[], edge: TrimEdge, deltaSeconds: number): boolean {
  const delta = allowedTrim(ids, edge, deltaSeconds)
  if (delta === 0) return false

  const wanted = new Set(withLinked(ids))
  const clips = sequence.clips.map((clip) => {
    if (!wanted.has(clip.id)) return clip
    return edge === 'start'
      ? {
          ...clip,
          start: clip.start + delta,
          // Seconds of *source*: trimming a second off the head of a clip
          // running at double speed skips two seconds of the file.
          offset: clip.offset + delta * clip.speed,
          duration: clip.duration - delta,
        }
      : { ...clip, duration: clip.duration + delta }
  })

  sequence = { ...sequence, clips }
  emit()
  return true
}

/**
 * How a move treats a link.
 *
 * `throughLinks: false` moves exactly the clips named and leaves their partners
 * where they are — *without* cutting the link, which is a separate decision.
 * It exists for the keyboard: having narrowed a selection to one half of a pair
 * on purpose, being handed the other half back would make the narrowing
 * pointless. The mouse never passes it; dragging either half drags both, which
 * is the rule everywhere else.
 */
export interface MoveOptions {
  throughLinks?: boolean
}

/**
 * How far a clip's rate may be pushed either way.
 *
 * Ten times faster and ten times slower. Beyond that the picture is a slideshow
 * or a blur and the sound is unusable, and a limit you can reach by dragging is
 * kinder than one you discover by wondering why nothing plays.
 */
export const MIN_SPEED = 0.1
export const MAX_SPEED = 10

/**
 * How much of its source a clip covers, in seconds of that source.
 *
 * The one quantity a stretch holds still: the same frames play, over more or
 * less time. Everything else about a stretch follows from that.
 */
export function sourceSpan(clip: Clip): number {
  return clip.duration * clip.speed
}

/**
 * What an edge can do when it is *stretching* rather than trimming.
 *
 * The same shape as allowedTrim and a different question. A trim changes which
 * frames play; a stretch changes how long the same frames take, so the source
 * span is held and the rate falls out of the new length. Three things stop it:
 * the neighbour, one frame, and the ends of the rate range.
 */
export function allowedStretch(ids: string[], edge: TrimEdge, deltaSeconds: number): number {
  const wanted = new Set(withLinked(ids))
  const chosen = sequence.clips.filter((clip) => wanted.has(clip.id))
  if (chosen.length === 0) return 0

  const min = minDuration()
  let low = -Infinity
  let high = Infinity

  for (const clip of chosen) {
    const span = sourceSpan(clip)
    // Longer means slower, so the *slowest* allowed rate is what caps growth.
    const longest = Math.max(min, span / MIN_SPEED)
    const shortest = Math.max(min, span / MAX_SPEED)
    const siblings = clipsOnTrack(clip.trackId).filter((other) => !wanted.has(other.id))

    if (edge === 'start') {
      const before = siblings
        .filter((other) => other.start + other.duration <= clip.start + EPS)
        .reduce((end, other) => Math.max(end, other.start + other.duration), 0)
      // The head moving right shortens; moving left lengthens, and it stops at
      // its neighbour and at zero.
      low = Math.max(low, before - clip.start, -clip.start, clip.duration - longest)
      high = Math.min(high, clip.duration - shortest)
    } else {
      const after = siblings
        .filter((other) => other.start >= clip.start + clip.duration - EPS)
        .reduce((start, other) => Math.min(start, other.start), Infinity)
      low = Math.max(low, shortest - clip.duration)
      high = Math.min(high, longest - clip.duration, after - clip.start - clip.duration)
    }
  }

  const fps = sequence.settings.frameRate
  const lowFrame = Math.ceil(low * fps - EPS) / fps
  const highFrame = Math.floor(high * fps + EPS) / fps
  if (lowFrame > highFrame) return 0

  return Math.min(highFrame, Math.max(lowFrame, snapDelta(deltaSeconds)))
}

/**
 * Stretches one edge: the same frames, over more or less time.
 *
 * The head anchors the tail and the tail anchors the head, so the edge you are
 * not holding stays where it is — which is what makes this feel like pulling
 * the clip longer rather than moving it. The rate is recomputed from the new
 * length rather than accumulated, so stretching out and back returns a clip to
 * exactly the rate it started at instead of to something near it.
 *
 * @returns true when anything changed.
 */
export function stretchClips(ids: string[], edge: TrimEdge, deltaSeconds: number): boolean {
  const delta = allowedStretch(ids, edge, deltaSeconds)
  if (delta === 0) return false

  const wanted = new Set(withLinked(ids))
  const clips = sequence.clips.map((clip) => {
    if (!wanted.has(clip.id)) return clip
    const span = sourceSpan(clip)
    const duration = edge === 'start' ? clip.duration - delta : clip.duration + delta
    if (duration <= 0) return clip
    return {
      ...clip,
      start: edge === 'start' ? clip.start + delta : clip.start,
      duration,
      speed: span / duration,
    }
  })

  sequence = { ...sequence, clips }
  emit()
  return true
}

/**
 * Cuts every clip that covers `at` into two, where the razor landed.
 *
 * Both halves of a pair, always: a cut through the picture that left the sound
 * whole would produce a clip linked to something twice its length, and the
 * first drag would take them apart. Each side then gets a link of its own, so
 * the two new pairs are pairs rather than four clips sharing one id.
 *
 * The right-hand piece starts further into the source — by the *source*
 * distance, which is the timeline distance times the rate.
 *
 * @param ids when given, only these clips (and their partners) are cut. The
 *   razor passes the clip it was clicked on; a cut-at-the-playhead command
 *   passes nothing and takes everything the playhead crosses.
 * @returns the clips created on the right of the cut.
 */
export function splitClips(at: number, ids?: string[]): Clip[] {
  const when = snapToFrame(at)
  const only = ids ? new Set(withLinked(ids)) : null
  const cutting = sequence.clips.filter(
    (clip) =>
      (!only || only.has(clip.id)) &&
      when > clip.start + EPS &&
      when < clip.start + clip.duration - EPS,
  )
  if (cutting.length === 0) return []

  // One new link per old link, so both halves of a pair land in the same new
  // pair. A clip that was not linked stays unlinked on both sides of the cut.
  const links = new Map<string, string>()
  for (const clip of cutting) {
    if (clip.linkId && !links.has(clip.linkId)) links.set(clip.linkId, nextId('l'))
  }

  const made: Clip[] = []
  const clips: Clip[] = []
  for (const clip of sequence.clips) {
    if (!cutting.includes(clip)) {
      clips.push(clip)
      continue
    }
    const left = { ...clip, duration: when - clip.start }
    const right: Clip = {
      ...clip,
      id: nextId('c'),
      start: when,
      duration: clip.start + clip.duration - when,
      offset: clip.offset + (when - clip.start) * clip.speed,
      ...(clip.linkId ? { linkId: links.get(clip.linkId) } : {}),
    }
    clips.push(left, right)
    made.push(right)
  }

  sequence = { ...sequence, clips }
  emit()
  return made
}

/**
 * A hole in a track: the empty stretch between two clips.
 *
 * Not a clip and not an id — a gap is a *place*, and it stops existing the
 * moment the clips either side of it move. So it is passed around by value and
 * looked up again whenever anything needs it, rather than being held onto.
 */
export interface Gap {
  trackId: string
  start: number
  end: number
}

/**
 * The gap a track has at `time`, if it has one.
 *
 * Bounded on the right by a clip, always: the empty timeline after the last
 * clip is not a gap, it is where the sequence has not been used yet, and
 * closing it would mean nothing. Bounded on the left by a clip *or* by the
 * start of the sequence, because the hole before the first shot is one of the
 * things a gap select is for.
 */
export function gapAt(trackId: string, time: number): Gap | null {
  const clips = clipsOnTrack(trackId)
  if (clips.length === 0) return null
  if (clips.some((clip) => time >= clip.start - EPS && time < clip.start + clip.duration - EPS)) {
    return null
  }

  const after = clips.find((clip) => clip.start > time + EPS)
  if (!after) return null
  const before = [...clips].reverse().find((clip) => clip.start + clip.duration <= time + EPS)
  const start = before ? before.start + before.duration : 0
  if (after.start - start < EPS) return null
  return { trackId, start, end: after.start }
}

/**
 * The first gap at `time`, looking down the tracks in the order they are drawn.
 *
 * For the keyboard, which has no pointer to say *which* track was meant. Top
 * down because that is the order everything else here reads in — the front-most
 * picture first, and the sound under it.
 */
export function gapNear(time: number): Gap | null {
  for (const track of sequence.tracks) {
    const gap = gapAt(track.id, time)
    if (gap) return gap
  }
  return null
}

/**
 * Deletes clips and closes the hole they leave.
 *
 * The ordinary delete leaves a gap where the clip was, which is right: most of
 * the time a shot is being replaced by another one. A ripple is the other
 * intention — take this out and let everything after it fall back — and it is
 * the one that needs care, because it moves things nobody selected.
 *
 * **Only the tracks something was removed from move.** A pair deleted from V1
 * and A1 ripples both, so a picture and its sound stay together; music on A2
 * that had nothing removed from it stays exactly where it was put. The other
 * reading — everything on every track slides — is what Premiere does with sync
 * lock on, and it is the reading that can quietly ruin a soundtrack you were
 * happy with. When there is a sync lock to turn on, this is what it will
 * switch.
 *
 * Rightmost first, so each shift is measured against clips that have not moved
 * yet: two clips removed from one track compose correctly rather than one
 * dragging the other's measurement out from under it.
 *
 * @returns how many clips were removed.
 */
export function rippleDeleteClips(ids: string[]): number {
  const doomed = new Set(withLinked(ids))
  const removing = sequence.clips.filter((clip) => doomed.has(clip.id))
  if (removing.length === 0) return 0

  let clips = sequence.clips.filter((clip) => !doomed.has(clip.id))
  const order = [...removing].sort((a, b) => b.start - a.start)
  for (const gone of order) {
    const end = gone.start + gone.duration
    clips = clips.map((clip) =>
      clip.trackId === gone.trackId && clip.start >= end - EPS
        ? { ...clip, start: snapToFrame(clip.start - gone.duration) }
        : clip,
    )
  }

  sequence = { ...sequence, clips }
  emit()
  return removing.length
}

/**
 * Closes a gap: everything after it on that track falls back into it.
 *
 * One track, because a gap is on one track. The same rule as a ripple delete
 * without the delete.
 */
export function closeGap(gap: Gap): boolean {
  const length = gap.end - gap.start
  if (!(length > EPS)) return false

  const clips = sequence.clips.map((clip) =>
    clip.trackId === gap.trackId && clip.start >= gap.end - EPS
      ? { ...clip, start: snapToFrame(clip.start - length) }
      : clip,
  )
  if (clips.every((clip, i) => clip === sequence.clips[i])) return false

  sequence = { ...sequence, clips }
  emit()
  return true
}

/**
 * Every edge in the sequence: the head and tail of every clip, and zero.
 *
 * What "the next cut" means. Across all tracks rather than the selected one,
 * because the playhead is not on a track — and a cut on any track is a moment
 * worth landing on, which is the whole reason to jump between them.
 */
export function cutEdges(): number[] {
  const edges = new Set<number>([0])
  for (const clip of sequence.clips) {
    edges.add(snapToFrame(clip.start))
    edges.add(snapToFrame(clip.start + clip.duration))
  }
  return [...edges].sort((a, b) => a - b)
}

/** The first edge after `time`, or null when there is nothing further on. */
export function nextEdge(time: number): number | null {
  return cutEdges().find((edge) => edge > time + EPS) ?? null
}

/** The last edge before `time`, or null when there is nothing behind it. */
export function previousEdge(time: number): number | null {
  return [...cutEdges()].reverse().find((edge) => edge < time - EPS) ?? null
}

/**
 * Trims one edge of everything the playhead is inside, up to the playhead.
 *
 * The keyboard's version of dragging an edge, and the one that is *exact*: a
 * hand can land a frame either side of where it meant, and this cannot. Q takes
 * the head up to the playhead, E takes the tail back to it — which is Premiere's
 * pair, minus the fact that its second key is spoken for here by the cut.
 *
 * Each clip gets its own distance, since the playhead is at one moment and the
 * clips crossing it start at different ones. That is why this is not
 * `trimClips`: one delta across a group is the right rule for a drag, where the
 * *hand* moved one distance, and the wrong one here.
 *
 * The hole is left behind. Trimming a head forward leaves a gap in front of the
 * clip, exactly as deleting it leaves one — `Shift W` is the gesture that says
 * "and close it", and doing that silently here would take a decision nobody
 * made.
 *
 * @param ids when given, only these clips are considered (and their partners).
 * @returns how many clips were trimmed.
 */
export function trimToTime(at: number, edge: TrimEdge, ids?: string[]): number {
  const when = snapToFrame(at)
  const only = ids && ids.length > 0 ? new Set(withLinked(ids)) : null
  const crossing = sequence.clips.filter(
    (clip) =>
      (!only || only.has(clip.id)) &&
      when > clip.start + EPS &&
      when < clip.start + clip.duration - EPS,
  )
  if (crossing.length === 0) return 0

  const min = 1 / sequence.settings.frameRate
  const clips = sequence.clips.map((clip) => {
    if (!crossing.includes(clip)) return clip
    if (edge === 'start') {
      const delta = when - clip.start
      if (clip.duration - delta < min - EPS) return clip
      return {
        ...clip,
        start: when,
        // Seconds of source, so a stretched clip skips the right amount.
        offset: clip.offset + delta * clip.speed,
        duration: clip.duration - delta,
      }
    }
    const duration = when - clip.start
    if (duration < min - EPS) return clip
    return { ...clip, duration }
  })

  const changed = clips.filter((clip, i) => clip !== sequence.clips[i]).length
  if (changed === 0) return 0

  sequence = { ...sequence, clips }
  emit()
  return changed
}

/** Which way the keyboard is walking a selection. */
export type Step = 'up' | 'down' | 'left' | 'right'

/**
 * The clip next to this one, in a direction.
 *
 * Sideways is the next clip along the same track, which is what "the next clip"
 * means when you are looking at one track. Up and down are the nearest track
 * that has something *at the same time* — a clip above that does not overlap is
 * not the clip above, it is a different part of the edit, and jumping to it
 * would lose your place.
 */
export function clipNextTo(id: string, direction: Step): Clip | null {
  const from = sequence.clips.find((clip) => clip.id === id)
  if (!from) return null

  if (direction === 'left' || direction === 'right') {
    const onTrack = clipsOnTrack(from.trackId).filter((clip) => clip.id !== from.id)
    const before = onTrack.filter((clip) => clip.start < from.start - EPS)
    const after = onTrack.filter((clip) => clip.start > from.start + EPS)
    return direction === 'left' ? (before.at(-1) ?? null) : (after[0] ?? null)
  }

  const rows = sequence.tracks
  const row = rows.findIndex((track) => track.id === from.trackId)
  if (row < 0) return null
  const end = from.start + from.duration
  const step = direction === 'up' ? -1 : 1

  for (let i = row + step; i >= 0 && i < rows.length; i += step) {
    const found = sequence.clips.find(
      (clip) =>
        clip.trackId === rows[i].id &&
        clip.start < end - EPS &&
        clip.start + clip.duration > from.start + EPS,
    )
    if (found) return found
  }
  return null
}

/** Which way a keyboard nudge is pushing. */
export type Nudge = 'left' | 'right'

/**
 * Moves a selection to the next cut, or swaps it with what is in the way.
 *
 * The keyboard equivalent of shoving a clip along a track, and it is two
 * gestures wearing one key because the answer to "move right" depends on what
 * is to the right:
 *
 *   - **a gap** — the clip travels until it butts against the next edge. Not by
 *     a fixed step: the interesting places on a timeline are the cuts, and
 *     landing exactly on one is the whole point of doing this with a key rather
 *     than with a hand.
 *   - **nothing in the way** — leftward, the start of the sequence is an edge
 *     like any other, so the clip goes there. Rightward there is no cut to go
 *     to, and nothing happens.
 *   - **no gap at all** — the clip and its neighbour trade places, so a shot
 *     can be walked through a sequence without picking anything up.
 *
 * A linked pair moves as a unit, as everywhere else: one distance, taken from
 * whichever half has least room. And a swap needs both halves to be up against
 * the *same* neighbour — a pair whose picture touches one clip while its sound
 * touches another has no unambiguous partner to trade with, and guessing would
 * silently rearrange somebody's edit.
 *
 * @returns what happened, or null when nothing could.
 */
export function nudgeClips(
  ids: string[],
  direction: Nudge,
  options?: MoveOptions,
): 'moved' | 'swapped' | null {
  const moving = new Set(options?.throughLinks === false ? ids : withLinked(ids))
  const chosen = sequence.clips.filter((clip) => moving.has(clip.id))
  if (chosen.length === 0) return null

  const right = direction === 'right'
  const others = sequence.clips.filter((clip) => !moving.has(clip.id))

  /** The clip a member would run into, and how far away it is. */
  const ahead = chosen.map((clip) => {
    const end = clip.start + clip.duration
    const onTrack = others.filter((other) => other.trackId === clip.trackId)
    const touching = right
      ? onTrack.filter((other) => other.start >= end - EPS)
      : onTrack.filter((other) => other.start + other.duration <= clip.start + EPS)
    if (touching.length === 0) {
      // Leftward, zero is the edge; rightward there is nothing to aim at.
      return { clip, neighbour: null, gap: right ? Infinity : clip.start }
    }
    const neighbour = right
      ? touching.reduce((best, other) => (other.start < best.start ? other : best))
      : touching.reduce((best, other) => (other.start > best.start ? other : best))
    const gap = right
      ? neighbour.start - end
      : clip.start - (neighbour.start + neighbour.duration)
    return { clip, neighbour, gap }
  })

  const travel = Math.min(...ahead.map((one) => one.gap))

  // Somewhere to go: every member takes the same distance, which is what keeps
  // a pair a pair.
  if (travel > EPS && travel !== Infinity) {
    const delta = right ? travel : -travel
    sequence = {
      ...sequence,
      clips: sequence.clips.map((clip) =>
        moving.has(clip.id) ? { ...clip, start: snapToFrame(clip.start + delta) } : clip,
      ),
    }
    emit()
    return 'moved'
  }
  if (travel === Infinity) return null

  /*
   * Nowhere to go, so trade places with whatever is against it.
   *
   * The partner is a *unit*, not a clip: swapping with half of a pair would
   * take that pair apart. Every member of the selection has to be up against
   * that same unit, or there is no single trade to make.
   */
  const blockers = ahead.map((one) => one.neighbour).filter((one): one is Clip => one !== null)
  if (blockers.length === 0) return null
  const partnerLink = blockers[0].linkId
  const partner = partnerLink
    ? sequence.clips.filter((clip) => clip.linkId === partnerLink)
    : [blockers[0]]
  const partnerIds = new Set(partner.map((clip) => clip.id))
  if (!blockers.every((one) => partnerIds.has(one.id))) return null

  const span = (clips: Clip[]) => {
    const from = Math.min(...clips.map((clip) => clip.start))
    const to = Math.max(...clips.map((clip) => clip.start + clip.duration))
    return { from, to, length: to - from }
  }
  const mine = span(chosen)
  const theirs = span(partner)

  // Butted together, so the two spans occupy one stretch and exchanging their
  // order inside it cannot overlap anything or move anything else.
  const mineDelta = right ? theirs.length : -theirs.length
  const theirsDelta = right ? -mine.length : mine.length

  sequence = {
    ...sequence,
    clips: sequence.clips.map((clip) => {
      if (moving.has(clip.id)) return { ...clip, start: snapToFrame(clip.start + mineDelta) }
      if (partnerIds.has(clip.id)) return { ...clip, start: snapToFrame(clip.start + theirsDelta) }
      return clip
    }),
  }
  emit()
  return 'swapped'
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
/**
 * How far the sequence runs: the clips, or a length that has been pinned.
 *
 * The one number the transport, the ruler and the viewer all read, so pinning
 * a duration is what makes it a *boundary* rather than a note — the playhead
 * stops there, Go To End goes there, and playing runs out there.
 *
 * A pinned duration shorter than the content does not delete anything. The
 * clips past it are still in the sequence and still in the file; they are
 * simply after the end, which is exactly what happens when somebody shortens a
 * sequence to a delivery length and keeps the tail around.
 */
export function sequenceDuration(): number {
  const pinned = sequence.settings.duration
  return pinned > 0 ? pinned : contentDuration()
}

// ── the marked span ───────────────────────────────────────────────

/**
 * The in and out points as an actual span, with the gaps filled in.
 *
 * A missing in is the start and a missing out is the end, so "nothing marked"
 * and "the whole sequence" are the same answer — which is what lets every
 * caller ask one question instead of four. `marked` is what tells them apart
 * when it matters, which is only ever for saying so on screen.
 */
export function renderRange(
  sequence: SequenceState = getSequenceFor(),
): { start: number; end: number; marked: boolean } {
  const whole = lengthOfSequence(sequence)
  const inPoint = sequence.range?.inPoint ?? null
  const outPoint = sequence.range?.outPoint ?? null
  const start = Math.max(0, Math.min(inPoint ?? 0, whole))
  const end = Math.max(start, Math.min(outPoint ?? whole, whole))
  return { start, end, marked: inPoint !== null || outPoint !== null }
}

/** The active sequence, for defaults above. Named apart to avoid shadowing. */
function getSequenceFor(): SequenceState {
  return sequence
}

/** How long a given sequence is, pinned length or the clips' reach. */
function lengthOfSequence(which: SequenceState): number {
  const pinned = which.settings.duration
  if (pinned > 0) return pinned
  return which.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}

/**
 * Moves one end of the span, or clears it with null.
 *
 * The two ends are kept in order rather than refused when crossed: dragging
 * the in point past the out is a thing hands do, and the useful response is
 * the span you clearly meant rather than a drag that stops dead. Both are
 * snapped to the frame grid for the same reason every other edit is — a mark
 * between two frames is a mark that cannot be rendered to.
 */
export function setRangeEnd(which: 'in' | 'out', at: number | null): boolean {
  const current = sequence.range ?? { inPoint: null, outPoint: null }
  const value = at === null ? null : snapToFrame(Math.max(0, at))

  let { inPoint, outPoint } = current
  if (which === 'in') inPoint = value
  else outPoint = value

  if (inPoint !== null && outPoint !== null && outPoint < inPoint) {
    ;[inPoint, outPoint] = [outPoint, inPoint]
  }

  if (inPoint === current.inPoint && outPoint === current.outPoint) return false
  sequence = { ...sequence, range: { inPoint, outPoint } }
  emit()
  return true
}

/** Sets both ends at once. Null for either clears that end. */
export function setRange(inPoint: number | null, outPoint: number | null): boolean {
  const next = {
    inPoint: inPoint === null ? null : snapToFrame(Math.max(0, inPoint)),
    outPoint: outPoint === null ? null : snapToFrame(Math.max(0, outPoint)),
  }
  if (
    next.inPoint === (sequence.range?.inPoint ?? null) &&
    next.outPoint === (sequence.range?.outPoint ?? null)
  ) {
    return false
  }
  sequence = { ...sequence, range: next }
  emit()
  return true
}

export function clearRange(): boolean {
  return setRange(null, null)
}

/**
 * Marks exactly the span some clips occupy.
 *
 * What `/` does with a selection, and the reason it is worth a key: the span
 * someone wants to render is almost always the span of the clips they just
 * picked, and setting it by dragging two handles to land on the same frames
 * is work the app can simply do.
 *
 * Linked halves are not followed. A selection of one video clip marks that
 * clip's span, and its sound occupies the same span anyway — pulling in
 * partners would only matter for a selection that is already asymmetric, and
 * there the clips you picked are the clips you meant.
 */
export function rangeToFit(ids: Iterable<string>): boolean {
  const wanted = new Set(ids)
  const chosen = sequence.clips.filter((clip) => wanted.has(clip.id))
  if (chosen.length === 0) return false

  let start = Infinity
  let end = 0
  for (const clip of chosen) {
    start = Math.min(start, clip.start)
    end = Math.max(end, clip.start + clip.duration)
  }
  if (!Number.isFinite(start) || end <= start) return false
  return setRange(start, end)
}

/** How far the clips themselves reach, whatever the sequence says its length is. */
export function contentDuration(): number {
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
  // The clipboard goes with it. A clip refers to an asset by an id that means
  // nothing in the next project, so carrying one across would paste a block
  // pointing at footage that is not there. The history goes for the same
  // reason: undoing into another project's clips would restore nothing.
  clipboard = { clips: [], count: 0 }
  clearHistory()
  listeners.forEach((listener) => listener())
}

export function clearSequence(): void {
  sequence = { ...sequence, clips: [] }
  emit()
}
