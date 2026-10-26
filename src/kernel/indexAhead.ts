/**
 * Builds frame indexes for the timeline, nearest the playhead first.
 *
 * The readiness strip made a thing visible that had always been true: a clip
 * only gets an index when something opens it, so a freshly filled timeline is
 * mostly *unknown* and stays that way until you play through it. Watching that
 * strip, the obvious question is why the gaps do not fill in — and there was no
 * good answer, only the absence of anything to fill them.
 *
 * This is that thing. It also answers the older complaint underneath it: the
 * first pass over a stretch is slower than every pass after, because the first
 * pass is the one paying for the index.
 *
 * Three rules, and each exists because of something already measured:
 *
 *   One at a time. An index for a 4K clip takes about a third of a second and
 *   reads the file's sample tables; a hundred of those at once is exactly the
 *   main-process load that turned span reads from 15ms into 700ms and made the
 *   preview stall. See electron/assetServer.js.
 *
 *   Never while playing. The preview is the thing the editor is looking at, and
 *   nothing here is worth a dropped frame. It waits, and carries on when the
 *   playhead stops.
 *
 *   Nearest the playhead first, because that is where the editor is about to
 *   go, and because a strip that fills outward from where you are reads as
 *   progress rather than as something happening elsewhere.
 */

import { getAssets } from './assets'
import { indexSettled, trackFor } from './media/indexCache'
import { mediaWork, subscribeMediaWork } from './mediaWork'
import { isPlaying, getTime, subscribePlayback } from './playback'
import { forgetBanked } from './readiness'
import { getSequence, subscribeSequence } from './sequence'

/**
 * How long to wait before starting, and between finding nothing and looking
 * again.
 *
 * Long enough that dropping a folder in, or scrubbing, settles first: every
 * such change restarts this, and a shorter wait would mean beginning an index
 * for a clip that is about to be moved or thrown away.
 */
const SETTLE_MS = 1200

/** Paths this has already tried, so a file that cannot be indexed is tried once. */
const tried = new Set<string>()

let running = false
let wanted = false
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Is anything the editor can actually see being worked on?
 *
 * Thumbnails and waveforms are asked for because something is on screen
 * wanting them. Indexes are speculative — nobody has asked to play this clip
 * yet — so this is the lowest-priority work in the app and has to behave like
 * it. Running alongside the thumbnail queue simply makes the visible thing
 * slower, which is a bad trade for work that may never be needed.
 *
 * `index` is excluded for the obvious reason: this reports its own jobs to the
 * same board, so counting them would mean standing down for itself and never
 * starting again.
 */
function visibleWorkPending(): boolean {
  return mediaWork().some(
    (item) =>
      item.kind !== 'index' && (item.state === 'waiting' || item.state === 'running'),
  )
}

/** Video clips on the timeline, nearest the playhead first, not yet tried. */
function queue(): string[] {
  const byId = new Map(getAssets().map((asset) => [asset.id, asset]))
  const now = getTime()
  const seen = new Set<string>()
  const found: { path: string; distance: number }[] = []

  for (const clip of getSequence().clips) {
    if (clip.kind !== 'video') continue
    const asset = byId.get(clip.assetId)
    if (!asset || asset.missing || asset.unreadable) continue
    if (tried.has(asset.path) || seen.has(asset.path)) continue
    seen.add(asset.path)
    /*
     * Distance to the clip, not to its start: a clip the playhead is inside is
     * nearer than one beginning just after it, and it is the one the editor is
     * looking at.
     */
    const from = clip.start
    const to = clip.start + clip.duration
    const distance = now < from ? from - now : now > to ? now - to : 0
    found.push({ path: asset.path, distance })
  }

  return found.sort((a, b) => a.distance - b.distance).map((one) => one.path)
}

async function work(): Promise<void> {
  if (running) return
  running = true
  try {
    while (wanted) {
      if (isPlaying()) return
      // Thumbnails and waveforms first; see visibleWorkPending. Returning
      // rather than waiting, because finishing them fires the subscription
      // below and starts this again.
      if (visibleWorkPending()) return
      // Re-asked every time rather than taken once: the timeline changes under
      // this, and the playhead moves, so the nearest clip is not the one it was.
      const next = queue()[0]
      if (!next) return
      tried.add(next)
      /*
       * `trackFor` is the whole job. It reports itself to the work board as an
       * `index` job, so the ring and the strip both show this happening without
       * anything here having to tell them.
       */
      await trackFor(next).catch(() => null)
      /*
       * Wait for the store, then tell the strip to ask the disk again. Without
       * both, a clip indexed just now reads as "ready, not saved" for the rest
       * of the session — the strip would have cached a no from the window
       * before the write landed, and nothing else ever asks twice.
       */
      await indexSettled(next)
      forgetBanked(next)
      // Back to the scheduler between files, so a long run never holds the
      // thread against the editor.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    running = false
  }
}

/** Starts, or restarts, the pass — after things have settled. */
export function indexAhead(): void {
  wanted = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void work()
  }, SETTLE_MS)
}

/** Stops the pass and forgets what has been tried. For closing a project. */
export function stopIndexingAhead(): void {
  wanted = false
  if (timer) clearTimeout(timer)
  timer = null
  tried.clear()
}

/** What is left to do, and whether it is doing it. For the harnesses. */
export function indexAheadState(): { running: boolean; waiting: number; tried: number } {
  return { running, waiting: queue().length, tried: tried.size }
}

/*
 * Wired once, at import. The timeline changing is the reason to look again —
 * clips arrived, or moved — and the playhead stopping is the moment this is
 * allowed to resume.
 */
subscribeSequence(() => indexAhead())
subscribePlayback(() => {
  if (!isPlaying()) indexAhead()
})
/*
 * Work finishing is the other moment this is allowed to start: it stands down
 * for thumbnails and waveforms, so the end of them is its cue.
 */
subscribeMediaWork(() => {
  if (!visibleWorkPending()) indexAhead()
})
