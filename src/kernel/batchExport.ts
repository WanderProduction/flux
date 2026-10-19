/**
 * Turning the reviewed timeline into a render list.
 *
 * The other half of the idea in kernel/batchImport.ts: a clip already says
 * which file it plays, where in that file it starts, how long it runs and at
 * what rate, so the sequence *is* the manifest. Nothing here needs a separate
 * list of what to render, because the review already produced one — by
 * cutting, trimming, reordering and deleting on the timeline.
 *
 * What this module does is the translation, and the three things it has to get
 * right are naming, what counts as a whole file, and what to refuse.
 */

import { getAsset } from './assets'
import { getSequence, type Clip, type SequenceState } from './sequence'

export interface ExportJob {
  /** The clip's id. Carried through so the UI can mark the clip it belongs to. */
  id: string
  name: string
  source: string
  output: string
  /** Seconds into the source where the cut starts. */
  offset: number
  /** Seconds of output. */
  duration: number
  /**
   * Bytes of source this cut is answerable for — the file's size times the
   * share of it the cut uses.
   *
   * Proportional, not the whole file, and this is what makes the compression
   * ratio an honest number. A two-second cut out of a 913MB clip compared
   * against all 913MB reports the export as "168x smaller", which is true of
   * nothing: it is measuring a trim as though it were a compression. The real
   * figure on that material is about twelve.
   *
   * It is also the right comparison for the never-write-a-bigger-file rule,
   * which asks whether an encode cost more than the footage it came from. For a
   * whole file the share is 1 and this is simply the file's size, which is what
   * lets that rule fall back to keeping the original.
   */
  sourceBytes: number
  /**
   * True when this cut is the entire source file.
   *
   * The only reason this matters is the never-write-a-bigger-file rule: where
   * an encode loses, a whole file can be answered by keeping the original, and
   * a trim cannot — there is no original of *that range* to keep.
   */
  wholeFile: boolean
}

export interface SkippedClip {
  id: string
  name: string
  reason: 'missing-asset' | 'offline' | 'stretched' | 'no-length' | 'still'
  detail: string
}

export interface ExportPlan {
  jobs: ExportJob[]
  skipped: SkippedClip[]
  /** Seconds of footage to encode. */
  duration: number
  /** Bytes of source the jobs read from, for a predicted saving. */
  sourceBytes: number
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function join(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`
}

/**
 * How close two numbers have to be to count as the same moment.
 *
 * A clip's duration and its source's are both seconds held as doubles, arrived
 * at by different arithmetic — one from a sample table, one through a trim that
 * divided by a speed. They will not be bit-identical for a clip nobody touched.
 * A millisecond is far below one frame at any rate in this library and far
 * above the error.
 */
const SAME_S = 0.001

/**
 * Builds the output names for a set of clips.
 *
 * Flat output, original names kept — which means two kinds of collision, and
 * they mean different things:
 *
 *   - **Several cuts from one source.** A clip razored into three is three
 *     clips of `DSCF3957.MOV`, and they get `DSCF3957.mp4`, `DSCF3957_02.mp4`,
 *     `DSCF3957_03.mp4`. Numbered in timeline order, so the suffixes run the
 *     way the review does.
 *   - **Different sources with the same name.** `DSCF3957.MOV` exists in more
 *     than one shoot folder — camera filenames restart. The second one's
 *     outputs get `DSCF3957_1.mp4`, the third's `_2`, and so on.
 *
 * Both suffixes are necessary and they are deliberately different shapes, but
 * `_02` and `_1` are only one character apart and that is a real cost of flat
 * output: which shoot a clip came from is not recoverable from its name. The
 * export log in the output folder carries the full source path for every row,
 * which is where that question gets answered.
 */
function nameJobs(clips: Clip[], outDir: string): Map<string, string> {
  /** Source path -> which same-named source this is (0 for the first seen). */
  const sourceIndex = new Map<string, number>()
  /** Stem -> how many distinct sources have used it. */
  const stemUsers = new Map<string, number>()
  /** Source path -> how many cuts of it have been named. */
  const cutCount = new Map<string, number>()

  const names = new Map<string, string>()

  for (const clip of clips) {
    const asset = getAsset(clip.assetId)
    if (!asset) continue

    if (!sourceIndex.has(asset.path)) {
      const stem = stemOf(asset.name)
      const seen = stemUsers.get(stem) ?? 0
      sourceIndex.set(asset.path, seen)
      stemUsers.set(stem, seen + 1)
    }

    const which = sourceIndex.get(asset.path) ?? 0
    const cut = (cutCount.get(asset.path) ?? 0) + 1
    cutCount.set(asset.path, cut)

    const stem = stemOf(asset.name)
    const collision = which > 0 ? `_${which}` : ''
    // Two digits, so ten or more cuts of one source still sort correctly.
    const nth = cut > 1 ? `_${String(cut).padStart(2, '0')}` : ''
    names.set(clip.id, join(outDir, `${stem}${collision}${nth}.mp4`))
  }

  return names
}

/**
 * What exporting a sequence would do.
 *
 * Only the video tracks are read. An audio clip on the timeline is the other
 * half of a linked pair — the same file, the same range — and rendering it
 * separately would write every clip twice, once as a video with sound and once
 * as the sound alone.
 *
 * A clip is refused rather than guessed at in three cases, and each is named in
 * the result so nothing disappears quietly:
 *
 *   - **Its asset is gone, or its file is offline.** Nothing to read.
 *   - **It has no length.** Nothing to write.
 *   - **It has been stretched.** This is the interesting one. A speed change
 *     needs a frame-rate decision — hold the rate and drop frames, or keep
 *     every frame and change the rate — and shared/renderFormat.js refuses to
 *     conform frame rates at all, because doing that silently is the exact
 *     failure the whole verification step was built to catch. So a stretched
 *     clip is named and left out rather than exported at a rate nobody chose.
 *     Undo the stretch and it exports.
 */
export function planExport(outDir: string, sequence: SequenceState = getSequence()): ExportPlan {
  const videoTracks = new Set(
    sequence.tracks.filter((track) => track.kind === 'video').map((track) => track.id),
  )

  const clips = sequence.clips
    .filter((clip) => videoTracks.has(clip.trackId))
    // Timeline order, which is review order, and what the _02 suffixes follow.
    .slice()
    .sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId))

  const names = nameJobs(clips, outDir)

  const jobs: ExportJob[] = []
  const skipped: SkippedClip[] = []

  for (const clip of clips) {
    const asset = getAsset(clip.assetId)
    if (!asset) {
      skipped.push({
        id: clip.id,
        name: clip.assetId,
        reason: 'missing-asset',
        detail: 'the clip refers to an asset that is no longer in the project',
      })
      continue
    }
    if (asset.missing) {
      skipped.push({
        id: clip.id,
        name: asset.name,
        reason: 'offline',
        detail: `${asset.path} could not be found`,
      })
      continue
    }
    if (!(clip.duration > 0)) {
      skipped.push({ id: clip.id, name: asset.name, reason: 'no-length', detail: 'the clip has no length' })
      continue
    }
    /*
     * A still is refused rather than encoded into the archive.
     *
     * It *can* be encoded — `-loop 1 -framerate n` makes a video of a held
     * frame — and that is exactly why this is a decision and not an oversight.
     * An archive of camera footage has no use for five seconds of HEVC showing
     * a logo, and a still has no duration of its own: the five seconds come
     * from a UI default, so the length of the file produced would be a number
     * nobody chose. Batch import no longer brings stills in at all; this
     * catches the one that reached a timeline some other way, and names it.
     */
    if (asset.kind === 'image') {
      skipped.push({
        id: clip.id,
        name: asset.name,
        reason: 'still',
        detail: 'a still image — batch export writes footage only',
      })
      continue
    }
    if (Math.abs(clip.speed - 1) > 1e-9) {
      skipped.push({
        id: clip.id,
        name: asset.name,
        reason: 'stretched',
        detail: `plays at ${clip.speed.toFixed(2)}x — undo the stretch to export it`,
      })
      continue
    }

    const output = names.get(clip.id)
    if (!output) continue

    /*
     * The whole file, meaning: starts at its beginning and runs to its end.
     * Compared against the clip's own record of its source length rather than
     * the asset's, because that is the number a trim was measured against and
     * it survives the asset being re-probed.
     */
    const wholeFile =
      clip.offset <= SAME_S && Math.abs(clip.duration - clip.sourceDuration) <= SAME_S

    const share =
      clip.sourceDuration > 0 ? Math.min(1, clip.duration / clip.sourceDuration) : 1

    jobs.push({
      id: clip.id,
      name: asset.name,
      source: asset.path,
      output,
      offset: clip.offset,
      duration: clip.duration,
      sourceBytes: Math.round((asset.size ?? 0) * share),
      wholeFile,
    })
  }

  return {
    jobs,
    skipped,
    duration: jobs.reduce((total, job) => total + job.duration, 0),
    sourceBytes: jobs.reduce((total, job) => total + job.sourceBytes, 0),
  }
}
