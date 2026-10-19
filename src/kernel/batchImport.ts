/**
 * Importing a folder of footage as a sequence to review.
 *
 * ## The timeline is the manifest
 *
 * This is the whole idea behind batch work in FLUX, and it is why there is no
 * separate list, grid or queue model anywhere in here. A clip already carries
 * exactly what a render needs: which file it plays, where in that file it
 * starts, how long it runs and at what rate. So a folder laid out as clips end
 * to end *is* the render list, and every tool that already exists — the razor,
 * trimming, ripple delete, drag to reorder, Delete — is already a tool for
 * editing it.
 *
 * Nothing here knows about rendering. Place footage, review it with the editor
 * FLUX already is, and the exporter reads the result. See kernel/batchExport.ts.
 *
 * ## Two phases, because only one of them can be batched
 *
 * `planBatch` scans and asks the files what they are. `runBatch` places them.
 * They are separate because the first is slow and cancellable and the second
 * must be atomic:
 *
 *   - Scanning a tree and probing hundreds of files takes seconds to minutes,
 *     and is worth showing progress for and worth being able to call off.
 *   - Placing the clips has to be one undo step and one re-render, which means
 *     it has to be synchronous. See `asOneStep` in kernel/sequence.ts.
 *
 * A plan is also something to *show* before committing: how many files, how
 * much footage, what was skipped and why. An import that silently brought in a
 * folder of proxies beside the originals would double every shot, and the only
 * defence against that is being able to read what the scan decided.
 */

import { importFiles } from './importPipeline'
import { ensureProbed, getAssets, type Asset } from './assets'
import { audioStateFor } from './media/peaks'
import { videoInfoFor } from './media/indexCache'
import { scanFootage, type FileEntry, type SkippedFolder } from './fsBridge'
import {
  addLinkedClips,
  asOneStep,
  createSequence,
  getSequence,
  updateSequenceSettings,
} from './sequence'

/**
 * Files probed at once.
 *
 * Each probe is a `<video>` asked for its metadata, and the browser runs those
 * on a shared pool of media pipelines — asking for four hundred at once does
 * not make them finish sooner, it makes most of them sit in a queue holding a
 * slot while the ones that could have finished wait behind them. Six is a
 * working compromise, on the same reasoning thumbnails.ts caps itself at three;
 * probes are cheaper than thumbnails because they never decode a frame.
 */
const PROBE_CONCURRENCY = 6

/**
 * Clips one sequence will be given in a single import.
 *
 * Not a technical limit — the timeline holds more — but a limit on what can be
 * reviewed. Past a couple of thousand blocks a sequence stops being something
 * a person scrubs through and becomes a list they scroll, with the shoot folder
 * they actually wanted somewhere inside it. The library this was built against
 * has 343 folders holding video and the busiest holds 406, so a per-folder
 * import always fits and a whole-drive import never does. Hitting this is
 * answered with the folder breakdown rather than a truncated import, so the
 * next move is obvious.
 */
export const MAX_BATCH_CLIPS = 2000

export interface BatchPlan {
  root: string
  files: FileEntry[]
  bytes: number
  skipped: SkippedFolder[]
  unreadable: Array<{ path: string; error: string }>
  /** True when the scan hit its own file cap before finishing the tree. */
  truncated: boolean
  /**
   * Still images found and left out.
   *
   * A batch import is for footage. A still has no duration of its own, so it
   * arrives as a five-second clip of a static picture — and a folder of camera
   * footage with a logo and three reference shots in it becomes a review with
   * four frozen clips padding it out. Counted and reported rather than silently
   * dropped, because "14 files, 9 clips" is a discrepancy someone will
   * otherwise have to go and explain to themselves. The Content Browser still
   * imports images exactly as before; this is about what a *footage* scan is
   * for.
   */
  stills: number
  /**
   * Folders under the root holding the most media, biggest first.
   *
   * Carried on the plan rather than computed by whoever shows it, because it is
   * the answer to the only question a too-large plan raises: which folder
   * should be imported instead of this one.
   */
  busiest: Array<{ path: string; files: number }>
}

export type PlanResult =
  | { ok: true; plan: BatchPlan }
  | { ok: false; error: 'denied' | 'unreadable' | 'empty' }

export interface BatchProgress {
  /** What is happening, in words meant to be shown. */
  label: string
  done: number
  total: number
}

export interface BatchResult {
  sequenceName: string
  /** Clips placed on the video track. */
  placed: number
  /** Files that probed as undecodable, and are therefore not on the timeline. */
  unreadable: string[]
  /** Files already in the project, reused rather than imported again. */
  reused: number
  /** Seconds of footage laid out. */
  duration: number
  /** True when the caller asked to stop partway. */
  cancelled: boolean
}

/** The folder's own name, for naming the sequence after it. */
function folderName(dirPath: string): string {
  const parts = dirPath.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? dirPath
}

function parentOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut > 0 ? filePath.slice(0, cut) : filePath
}

/**
 * Scans a folder and reports what importing it would mean.
 *
 * Reads nothing into the project and changes nothing: this is the question, and
 * `runBatch` is the answer. `empty` is its own result rather than a plan with no
 * files, because "there is no footage in here" is a sentence worth saying and an
 * import of nothing is not worth offering.
 */
export async function planBatch(dirPath: string): Promise<PlanResult> {
  const result = await scanFootage(dirPath)
  if (!result.ok) return { ok: false, error: result.error }

  const { scan } = result
  const videos = scan.files.filter((file) => file.kind === 'video')
  const stills = scan.files.length - videos.length
  if (videos.length === 0) return { ok: false, error: 'empty' }

  const counts = new Map<string, number>()
  for (const file of videos) {
    const parent = parentOf(file.path)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }

  return {
    ok: true,
    plan: {
      root: scan.root,
      files: videos,
      bytes: videos.reduce((total, file) => total + file.size, 0),
      skipped: scan.skipped,
      unreadable: scan.unreadable,
      truncated: scan.truncated,
      stills,
      busiest: [...counts.entries()]
        .map(([path, files]) => ({ path, files }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 12),
    },
  }
}

/** Runs `work` over `items`, `limit` at a time. */
async function pooled<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await work(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * Imports a plan's files and lays them out as one sequence.
 *
 * Always links, never copies — and not as a preference, as the only sensible
 * reading of the gesture. The plans this exists for are hundreds of gigabytes;
 * copying them into the project would duplicate an archive in order to review
 * it. The copy-or-link question `importPipeline` asks for a hand-made import is
 * therefore not asked here, and `'link'` at the call site says so.
 *
 * Files already in the project are reused by path rather than imported twice —
 * that is `importFiles`'s existing behaviour, and it is what makes re-running an
 * import over a folder that has grown do the right thing.
 *
 * Clips go end to end from zero on the first video track, in the scan's order,
 * which for camera footage is also chronological. A file that cannot be probed
 * is left out and named: a block for a file nothing can read would be a clip
 * that never draws and never renders.
 */
export async function runBatch(
  plan: BatchPlan,
  options: {
    onProgress?: (progress: BatchProgress) => void
    /** Polled between phases, so a long import can be called off. */
    cancelled?: () => boolean
  } = {},
): Promise<BatchResult> {
  const { onProgress, cancelled } = options
  const report = (label: string, done: number, total: number) =>
    onProgress?.({ label, done, total })
  const stopped = () => Boolean(cancelled?.())

  const name = folderName(plan.root)
  const giveUp = (unreadable: string[], reused: number): BatchResult => ({
    sequenceName: name,
    placed: 0,
    unreadable,
    reused,
    duration: 0,
    cancelled: true,
  })

  // ── into the project ─────────────────────────────────────────────
  report('Adding to the project…', 0, plan.files.length)
  const before = new Set(getAssets().map((asset) => asset.path))
  const reused = plan.files.filter((file) => before.has(file.path)).length

  await importFiles(
    plan.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      size: file.size,
      mtimeMs: file.mtimeMs,
    })),
    'link',
  )

  /*
   * Collected by path rather than from what importFiles returned: it returns
   * only what it *added*, and a re-run over a folder that grew needs the ones
   * that were already here as well.
   */
  const wanted = new Set(plan.files.map((file) => file.path))
  const assets = getAssets().filter((asset) => wanted.has(asset.path))
  if (stopped()) return giveUp([], reused)

  // ── ask the files what they are ──────────────────────────────────
  /*
   * Everything that needs waiting on happens here, before a single clip is
   * placed: durations, whether each file has sound, and the first one's shape.
   * The placement below is then synchronous, which is what lets it be one step.
   */
  const probed = new Map<string, { asset: Asset; hasAudio: boolean }>()
  const unreadable: string[] = []
  let done = 0

  await pooled(assets, PROBE_CONCURRENCY, async (asset) => {
    if (stopped()) return
    const full = await ensureProbed(asset.id)
    done += 1
    report(`Reading ${done} of ${assets.length}…`, done, assets.length)

    if (!full || full.unreadable || full.missing || !full.duration) {
      unreadable.push(asset.name)
      return
    }
    // Cheap: the audio track's index, not its waveform. See media/peaks.ts.
    const sound = await audioStateFor(full.path)
    probed.set(asset.id, { asset: full, hasAudio: sound.kind === 'sound' })
  })

  if (stopped()) return giveUp(unreadable, reused)

  // The scan's order, not the order the probes happened to finish in.
  const byPath = new Map(assets.map((asset) => [asset.path, asset]))
  const ordered = plan.files
    .map((file) => byPath.get(file.path))
    .map((asset) => (asset ? probed.get(asset.id) : undefined))
    .filter((entry): entry is { asset: Asset; hasAudio: boolean } => Boolean(entry))

  // ── lay it out ───────────────────────────────────────────────────
  report('Laying out the sequence…', assets.length, assets.length)

  const first = ordered[0]
  // Read before the group opens, because it goes to the file's index.
  const shape = first ? await videoInfoFor(first.asset.path) : null

  let sequenceName = name
  let placed = 0
  let duration = 0

  /*
   * Making the sequence is *inside* the group, not before it.
   *
   * createSequence emits like every other mutation, so leaving it outside made
   * an import two undo steps — one that creates an empty sequence and one that
   * fills it. The first press of undo then emptied the timeline and left the
   * tab behind, which is not a state anyone asked for. Caught by
   * scripts/verify-batch.mjs, which counts the steps rather than trusting them.
   */
  asOneStep(() => {
    const made = createSequence({ name })
    sequenceName = made.name

    /*
     * The sequence takes its shape from the first clip — the same rule a hand
     * drop follows, for the same reason, which is that nobody has been shown a
     * dialog they could answer it with. `videoInfoFor` reports the *displayed*
     * shape, so a folder of vertically shot footage produces a vertical
     * sequence rather than a landscape one with the whole review letterboxed
     * inside it.
     */
    if (shape) {
      updateSequenceSettings({
        width: shape.width,
        height: shape.height,
        frameRate: Math.round(shape.frameRate * 1000) / 1000,
      })
    } else if (first?.asset.width && first.asset.height) {
      updateSequenceSettings({ width: first.asset.width, height: first.asset.height })
    }

    /*
     * The *base* video track, which is the last one in the list rather than
     * the first.
     *
     * Tracks are held in display order — V2 above V1 — so `find` returns the
     * top layer, and a batch import laid itself onto V2 with V1 sitting empty
     * underneath it. Nothing is broken by that: one track of clips composites
     * the same wherever it sits. It is simply not where footage goes, and an
     * empty base track under a full one is the kind of small wrongness that
     * makes someone distrust the rest of the import.
     */
    const video = [...getSequence().tracks].reverse().find((track) => track.kind === 'video')
    if (!video) return

    /*
     * Clips are laid out in whole frames of the sequence's rate.
     *
     * Not a detail. `addClip` snaps every start to the frame grid, so placing a
     * clip at the exact second the previous one ended lands it on the nearest
     * frame — which is up to half a frame *before* that end. The two clips then
     * overlap, both are under the playhead for one frame, and the compositor
     * dutifully blends them. Across a hundred clips that is a hundred
     * single-frame cross-dissolves nobody asked for, each one too brief to see
     * and too consistent to be a coincidence once noticed.
     *
     * Giving each clip a whole number of frames makes every start an exact
     * multiple of the frame period, so one clip's end *is* the next one's start
     * and the snap is an identity. The cost is that a clip's length on the
     * timeline differs from its file's by under half a frame, which is below
     * the resolution the timeline can represent at all — and the export reads
     * its length from the clip, so a cut lands within half a frame of where the
     * source ends, where ffmpeg stops at the real end regardless.
     *
     * Caught by scripts/verify-batch.mjs, which checks abutment rather than
     * trusting it.
     */
    const frameRate = getSequence().settings.frameRate

    for (const { asset, hasAudio } of ordered) {
      const length = asset.duration ?? 0
      if (!(length > 0)) continue
      const frames = Math.max(1, Math.round(length * frameRate))
      const { video: clip } = addLinkedClips(
        { assetId: asset.id, trackId: video.id, start: duration, duration: frames / frameRate },
        hasAudio,
      )
      if (!clip) continue
      placed += 1
      /*
       * Measured from where the clip actually landed rather than from a running
       * total. addClip places at the first free spot at or after what it is
       * given, so the two agree until something is in the way — and then the
       * total is the one that is wrong, silently, for every clip after it.
       */
      duration = clip.start + clip.duration
    }
  })

  return { sequenceName, placed, unreadable, reused, duration, cancelled: false }
}
