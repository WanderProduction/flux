/**
 * How ready each stretch of the timeline is to play, as a strip of spans.
 *
 * The question this answers is the one an editor asks before pressing play on a
 * freshly filled timeline: *which parts of this will actually run, and which
 * are still being worked on?* Until now the only way to find out was to press
 * play and see, and a stretch that stalls looks exactly like a stretch that is
 * slow — the same confusion that cost a long session chasing the preview.
 *
 * Five states, and the order they are decided in matters more than the colours:
 *
 *   broken   the file is gone, or FLUX cannot read it. No amount of waiting
 *            helps, so this outranks everything — a strip that showed a
 *            missing file as merely unfinished would be telling the editor to
 *            be patient about something that is never going to arrive.
 *   working  something is queued or running for it right now.
 *   baked    its index is on disk, so it plays now *and* after a reopen.
 *   ready    its index is in memory. Plays now; will be rebuilt next session.
 *   unknown  nothing has looked at it yet. Not a problem, just not yet asked.
 *
 * `baked` and `ready` are deliberately separate. They feel like the same state
 * and are not: the difference is whether the work has been banked or is about
 * to be done again, and that is exactly what the editor wanted to know when
 * they asked why everything runs again on every project reload.
 *
 * Nothing here causes work. `trackFor` would — a miss demuxes the file — so
 * this reads only what is already known, through `cachedTrack`. A strip that
 * demuxed a hundred files in order to colour itself in would be the most
 * expensive thing on screen and would report its own progress.
 */

import { getAssets, subscribeAssets, type Asset } from './assets'
import { cachedTrack, indexOnDisk, refusedReason } from './media/indexCache'
import { mediaWork, subscribeMediaWork, type WorkKind } from './mediaWork'
import { getSequence, subscribeSequence } from './sequence'

export type Readiness = 'broken' | 'working' | 'baked' | 'ready' | 'unknown'

export interface ReadySpan {
  /** The clip this covers, so the panel can line it up and name it. */
  clipId: string
  name: string
  /** Seconds from the start of the sequence. */
  start: number
  duration: number
  state: Readiness
  /** Said to the editor on hover. A sentence, not a code. */
  note: string
}

const listeners = new Set<() => void>()

/**
 * What the disk said, per path. Absent means "not asked yet".
 *
 * Kept rather than asked per paint because the answer costs an IPC round trip
 * and a stat, and a paint covers every clip on screen. It changes only when
 * work finishes, which is when the sweep below runs again.
 */
const banked = new Map<string, boolean>()

/** Paths the sweep is currently asking about, so it never asks twice at once. */
const asking = new Set<string>()

/**
 * Work whose finish has already been acted on.
 *
 * `mediaWork()` hands back finished items too — four hundred of them, so the
 * panel can say what just happened. Without this, every progress tick would
 * read the whole history, decide that four hundred paths had just finished,
 * and throw away everything the sweep had learned: a strip that re-probed the
 * entire timeline several times a second while any work was running, which is
 * the exact load the strip exists to help the editor avoid.
 */
const settled = new Set<string>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeReadiness(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Which kinds of work are outstanding for a path, if any. */
function workingOn(path: string): WorkKind[] {
  const kinds: WorkKind[] = []
  for (const item of mediaWork()) {
    if (item.path !== path) continue
    if (item.state !== 'waiting' && item.state !== 'running') continue
    if (!kinds.includes(item.kind)) kinds.push(item.kind)
  }
  return kinds
}

function nameFor(kinds: WorkKind[]): string {
  const said = kinds.map((kind) =>
    kind === 'waveform' ? 'waveform' : kind === 'thumbnail' ? 'thumbnail' : 'frame index',
  )
  if (said.length === 0) return 'work'
  if (said.length === 1) return said[0]
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`
}

function stateOf(asset: Asset | undefined): { state: Readiness; note: string } {
  if (!asset) return { state: 'broken', note: 'this clip has no asset in the project' }
  if (asset.missing) return { state: 'broken', note: `${asset.name} is not where it was` }
  if (asset.unreadable) return { state: 'broken', note: `${asset.name} cannot be decoded` }

  const refused = refusedReason(asset.path)
  if (refused) return { state: 'broken', note: `${asset.name} was refused: ${refused}` }

  const kinds = workingOn(asset.path)
  if (kinds.length > 0) {
    return { state: 'working', note: `building the ${nameFor(kinds)} for ${asset.name}` }
  }

  // Banked beats in-memory: it is the stronger claim about the same clip.
  if (banked.get(asset.path)) {
    return { state: 'baked', note: `${asset.name} is indexed on disk — ready after a reopen too` }
  }
  if (cachedTrack(asset.path)) {
    return { state: 'ready', note: `${asset.name} is ready to play, but not yet saved to disk` }
  }
  return { state: 'unknown', note: `nothing has been worked out for ${asset.name} yet` }
}

/**
 * The strip, in sequence order.
 *
 * Video clips only. The sound of a clip is on its own track and has its own
 * derived work, but the strip is one line over the time units and it is the
 * picture an editor is waiting for — two overlapping answers for one moment
 * would have to be drawn one on top of the other, and the lower one would be a
 * colour nobody could see.
 */
export function readySpans(): ReadySpan[] {
  const sequence = getSequence()
  const byId = new Map(getAssets().map((asset) => [asset.id, asset]))

  return sequence.clips
    .filter((clip) => clip.kind === 'video')
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((clip) => {
      const asset = byId.get(clip.assetId)
      const { state, note } = stateOf(asset)
      return {
        clipId: clip.id,
        name: asset?.name ?? 'missing',
        start: clip.start,
        duration: clip.duration,
        state,
        note,
      }
    })
}

/** How many spans are in each state. For the harnesses, and for a summary. */
export function readinessSummary(): Record<Readiness, number> {
  const counts: Record<Readiness, number> = {
    broken: 0,
    working: 0,
    baked: 0,
    ready: 0,
    unknown: 0,
  }
  for (const span of readySpans()) counts[span.state] += 1
  return counts
}

/**
 * Asks the disk about paths it has not asked about yet.
 *
 * A few at a time rather than all at once: this runs behind an editor who is
 * doing something else, and a hundred simultaneous round trips through the main
 * process is precisely the kind of load that made the preview stall.
 *
 * Only ever *adds* knowledge, so a sweep that is interrupted leaves the strip
 * correct-but-incomplete rather than wrong.
 */
const AT_A_TIME = 4

export async function sweepReadiness(): Promise<void> {
  const paths = new Set<string>()
  const byId = new Map(getAssets().map((asset) => [asset.id, asset]))
  for (const clip of getSequence().clips) {
    if (clip.kind !== 'video') continue
    const asset = byId.get(clip.assetId)
    if (!asset || asset.missing || asset.unreadable) continue
    if (banked.has(asset.path) || asking.has(asset.path)) continue
    paths.add(asset.path)
  }
  if (paths.size === 0) return

  const queue = [...paths]
  let learned = false
  while (queue.length > 0) {
    const batch = queue.splice(0, AT_A_TIME)
    batch.forEach((path) => asking.add(path))
    const answers = await Promise.all(
      batch.map(async (path) => [path, await indexOnDisk(path)] as const),
    )
    for (const [path, onDisk] of answers) {
      asking.delete(path)
      banked.set(path, onDisk)
      learned = true
    }
    // Between batches, so a long sweep fills the strip in rather than all at
    // the end — the strip is itself a progress report.
    if (learned) emit()
  }
}

/**
 * Forgets what the disk said about a path, so the next sweep asks again.
 *
 * Called when work for it finishes: the whole point of `baked` is that it
 * becomes true at a moment, and a cached "no" from before the write would keep
 * the strip claiming otherwise for the rest of the session.
 */
export function forgetBanked(path: string): void {
  banked.delete(path)
}

/** Forgets everything. For closing a project, and for the harnesses. */
export function clearReadiness(): void {
  banked.clear()
  asking.clear()
  settled.clear()
  emit()
}

/**
 * Wired once, at import.
 *
 * The strip follows three things and owns none of them: what is on the
 * timeline, what the project knows about its files, and what is being worked on
 * right now. A sweep is kicked off on the first two, because a clip arriving is
 * the moment a new path needs asking about.
 */
subscribeSequence(() => {
  emit()
  void sweepReadiness()
})
subscribeAssets(() => {
  emit()
  void sweepReadiness()
})
subscribeMediaWork(() => {
  /*
   * Work finishing is the one event that can make `baked` true, and the cached
   * answer from before it is now wrong — but only the *newly* finished, for the
   * reason `settled` gives.
   */
  for (const item of mediaWork()) {
    if (item.state !== 'done' || settled.has(item.key)) continue
    settled.add(item.key)
    forgetBanked(item.path)
  }
  // The history is bounded and these keys are not, so a long session would
  // otherwise keep every key it ever saw. Dropping them all costs one extra
  // probe per path, which is the cheap direction to be wrong in.
  if (settled.size > 2000) settled.clear()
  emit()
  void sweepReadiness()
})
