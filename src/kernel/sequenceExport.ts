/**
 * Turning the whole timeline into one render list — the other render mode.
 *
 * kernel/batchExport.ts plans one file per clip, which is what an archive
 * wants: 2.3TB of camera footage reviewed down to the takes that survived, each
 * still its own file with its own name. This plans the opposite, which is what
 * a deliverable wants: one file that *is* the sequence, layers composited, gaps
 * black, audio mixed down.
 *
 * They are two planners and not one with a flag, deliberately. Almost nothing
 * in `planExport` survives the change of mode — the naming scheme exists to
 * keep several cuts of `DSCF3957.MOV` apart, which a single output does not
 * need; `wholeFile` answers a never-write-a-bigger-file rule that a composite
 * has no original for; the frame-rate policy is a choice there and a fact here,
 * because a sequence has a rate of its own. A flag would have left four
 * branches inside one function, each of them the whole difference.
 *
 * ## What it reads, and why that is what was on screen
 *
 * Picture comes from **visible** video tracks, bottom track first, which is the
 * order ViewerPanel's `layersAt` walks and so the order the layers stack. A
 * hidden track is left out: hiding a track is a statement about what the
 * sequence looks like, and a render that put it back would not be a render of
 * what anyone reviewed.
 *
 * Sound comes from audio tracks through `trackLevel`, which is the mixer's own
 * function — the one place mute, solo and the fader become a number. It is
 * imported rather than reimplemented because "the render agrees with what was
 * heard" is only true if both ask the same question. A track at zero (muted,
 * or not soloed while something else is, or a fader pulled to the bottom) is
 * dropped from the plan entirely rather than mixed in at silence, which saves
 * decoding a file nobody will hear.
 *
 * The audio half of a linked pair is where the sound comes from, and video
 * clips contribute none. That matches playback exactly: the mixer schedules
 * clips on audio tracks and nothing else.
 */

import { getAsset } from './assets'
import { trackLevel } from './media/mixer'
import { getSequence, isTrackVisible, type SequenceState } from './sequence'
import type { SkippedClip } from './batchExport'
import { safeFolderName } from '../../shared/projectNaming.js'

/** One clip, resolved to a span of a file and a place in the sequence. */
export interface SequenceCut {
  /** The clip's id, so a panel can say which clips a job covers. */
  id: string
  source: string
  /** Seconds from the start of the sequence. */
  start: number
  /** Seconds of sequence it covers. */
  duration: number
  /** Seconds into the source where it begins. */
  offset: number
  speed: number
  /** Linear multiplier. Audio only, and only ever from `trackLevel`. */
  gain?: number
}

/**
 * One render of one sequence.
 *
 * A snapshot in exactly the sense kernel/renderQueue.ts argues for, and more
 * completely than a clip job is: every clip's source, in point, duration,
 * placement and gain are resolved the moment it is added, so the queue holds
 * the sequence *as it was reviewed* even after an afternoon of further editing.
 * Nothing reads back through the clip ids.
 */
export interface SequenceJob {
  /** What tells this apart from an ExportJob everywhere both can turn up. */
  kind: 'sequence'
  /** `seq:<sequenceId>`, so re-adding replaces and nothing collides with a clip. */
  id: string
  name: string
  output: string
  /** The frame everything is composited into. */
  width: number
  height: number
  /** The sequence's rate. Not a policy here — see the note above. */
  frameRate: number
  /** Seconds of output, including a gap at the end. */
  duration: number
  /** The sequence's audio format, carried so the snapshot is complete. */
  sampleRate: number
  channels: number
  /** Bottom track first, which is draw order. */
  video: SequenceCut[]
  audio: SequenceCut[]
  /** The share of its sources the render reads, for an honest ratio. */
  sourceBytes: number
}

export interface SequencePlan {
  job: SequenceJob | null
  skipped: SkippedClip[]
  /** Why there is no job, when there is none. */
  reason?: string
}

function join(dir: string, name: string): string {
  const separator = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`
}

/**
 * How long this sequence is.
 *
 * The same rule as `sequenceDuration`, applied to the sequence handed in rather
 * than to the active one — a queue can hold a render of a sequence that is no
 * longer the one on screen. A pinned length wins, because that is what pinning
 * it means; otherwise it is as long as the clips reach.
 *
 * This is also the number that makes a gap a gap. A sequence whose last clip
 * ends ten seconds early renders ten seconds of black, because that is what the
 * sequence is — not a file that stops where the footage did.
 */
export function lengthOf(sequence: SequenceState): number {
  const pinned = sequence.settings.duration
  if (pinned > 0) return pinned
  return sequence.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
}

/**
 * What rendering this sequence as one file would do.
 *
 * A clip is refused rather than guessed at, and each refusal is named in the
 * result so nothing disappears quietly:
 *
 *   - **Its asset is gone, or its file is offline.** Nothing to read.
 *   - **It has no length.** Nothing to draw.
 *   - **It is a still.** The composite has no image path: every layer is a
 *     decoded video stream placed by timestamp, and a held frame would need
 *     `-loop 1` and a rate of its own. Batch export refuses stills too, for a
 *     different reason — there the length would be a number nobody chose, while
 *     here the timeline chose it — so this one is a gap in the graph rather
 *     than a decision about archives, and it is named as such.
 *
 * Note what is *not* refused: a stretched clip. Speed is a `setpts` divide and
 * an `atempo` chain, the same as it is for a cut, and the sequence's rate is
 * forced anyway — so there is no rate decision left to refuse over.
 */
export function planSequence(
  outDir: string,
  sequence: SequenceState = getSequence(),
): SequencePlan {
  const duration = lengthOf(sequence)
  const skipped: SkippedClip[] = []

  const video: SequenceCut[] = []
  const audio: SequenceCut[] = []
  let sourceBytes = 0

  /*
   * Reversed, because tracks are stored in stacking order — V2 above V1 — and
   * the compositor needs the bottom one first. The same walk as `layersAt`,
   * and getting it the wrong way round would put the back layer in front.
   */
  for (const track of [...sequence.tracks].reverse()) {
    const clips = sequence.clips
      .filter((clip) => clip.trackId === track.id)
      .slice()
      .sort((a, b) => a.start - b.start)
    if (clips.length === 0) continue

    if (track.kind === 'video' && !isTrackVisible(track)) continue
    const gain = track.kind === 'audio' ? trackLevel(track, sequence.tracks) : 1
    // A silent track is not decoded at all. See the note above.
    if (track.kind === 'audio' && gain <= 0) continue

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
        skipped.push({
          id: clip.id,
          name: asset.name,
          reason: 'no-length',
          detail: 'the clip has no length',
        })
        continue
      }
      if (asset.kind === 'image') {
        skipped.push({
          id: clip.id,
          name: asset.name,
          reason: 'still',
          detail: 'a still image — the composite has no image layer yet',
        })
        continue
      }

      const cut: SequenceCut = {
        id: clip.id,
        source: asset.path,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset,
        speed: clip.speed,
      }

      if (track.kind === 'audio') {
        audio.push({ ...cut, gain })
        /*
         * Counted on the picture only. An audio clip is the other half of a
         * linked pair — the same file, the same range — so counting both would
         * report every source twice and halve the ratio.
         *
         * The honest cost: sound with no picture anywhere on the timeline is
         * read and not counted, so the ratio flatters the render slightly. It
         * is the right way round — a ratio that is quietly too *good* is
         * visible the moment anyone compares it with the file sizes, while one
         * that double-counts looks plausible and is wrong by half.
         */
        continue
      }

      video.push(cut)
      const share =
        clip.sourceDuration > 0 ? Math.min(1, clip.duration / clip.sourceDuration) : 1
      sourceBytes += Math.round((asset.size ?? 0) * share)
    }
  }

  if (!(duration > 0)) {
    return { job: null, skipped, reason: 'the sequence has no length' }
  }
  if (video.length === 0 && audio.length === 0) {
    return { job: null, skipped, reason: 'the sequence has nothing that can be rendered' }
  }

  return {
    job: {
      kind: 'sequence',
      id: `seq:${sequence.id}`,
      name: sequence.name,
      output: join(outDir, `${safeFolderName(sequence.name)}.mp4`),
      width: sequence.settings.width,
      height: sequence.settings.height,
      frameRate: sequence.settings.frameRate,
      duration,
      sampleRate: sequence.settings.audio.sampleRate,
      channels: sequence.settings.audio.channels,
      video,
      audio,
      sourceBytes,
    },
    skipped,
  }
}

/** Whether a queued row is a sequence render rather than a clip. */
export function isSequenceJob(job: { kind?: string }): job is SequenceJob {
  return job.kind === 'sequence'
}
