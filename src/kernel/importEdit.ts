/**
 * Turning an edit document into a FLUX sequence.
 *
 * The one place that happens, for every way a timeline can arrive — a
 * Premiere or Resolve XML, a cut list a model wrote, and whatever comes next.
 * Each reader's job is to be right about its own format and to stop there;
 * this is the only code that has to be right about FLUX. See
 * shared/editDocument.js for why the two are kept apart.
 *
 * ## Paths are the hard part, not the timeline
 *
 * The arithmetic here is dull. What is not dull is that an XML written on
 * someone else's machine names files that do not exist on this one — the
 * sample this was built against points at `C:/Users/romav/Desktop/AI Montage/`
 * on a machine nobody here has, and the same footage lives on a mounted
 * virtual drive under a completely different root.
 *
 * So importing resolves in three widening steps, and **reports what is still
 * missing rather than placing a clip that cannot play**:
 *
 *   1. the path as written, if the project already has that asset
 *   2. the path as written, if the file is on disk
 *   3. the path with a prefix swapped, for callers that know the mapping
 *
 * Anything left is returned by name. A timeline full of offline clips is a
 * worse outcome than an import that says "these fourteen files are not here,
 * where should I look" — the first wastes a review pass before anyone notices.
 *
 * ## Track order flips here
 *
 * An edit document lists the bottom track first, which is xmeml's order and a
 * compositor's. A FLUX sequence holds `[V2, V1]`, top first, because that is
 * the order they are drawn down the screen. One `reverse`, in one place, with
 * a harness on it — the same mistake already put a batch import on V2 once.
 */

import { ensureProbed, getAssets, hasAsset, type Asset } from './assets'
import { existsMany } from './fsBridge'
import { importFiles } from './importPipeline'
import {
  addClip,
  addMarker,
  addTrack,
  asOneStep,
  createSequence,
  getSequence,
  setClipEffects,
  updateSequenceSettings,
  type Track,
  type TrackKind,
} from './sequence'
import type { ClipEffects } from './clipEffects'

/** A path prefix to swap, so an export from another machine resolves here. */
export interface PathRemap {
  from: string
  to: string
}

export interface ImportEditResult {
  sequenceName: string
  /** Clips actually placed. */
  placed: number
  /** Sources named in the document that could not be found, once each. */
  missing: string[]
  /** What the reader could not carry across, plus anything added here. */
  warnings: string[]
}

interface EditClipLike {
  name: string
  source: string | null
  start: number
  duration: number
  offset: number
  speed: number
  enabled: boolean
  /** Loose on purpose: the shape is ClipEffects's, and the readers are JS. */
  transform?: object
  audio?: object
  note?: string
}

interface EditDocumentLike {
  name: string
  frameRate: number
  width: number
  height: number
  video: EditClipLike[][]
  audio: EditClipLike[][]
  markers: Array<{ start: number; end: number; name: string; comment: string }>
  warnings: string[]
}

/** Lower-cased, forward-slashed, for comparing paths from two machines. */
function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

function applyRemap(filePath: string, remaps: PathRemap[]): string {
  for (const { from, to } of remaps) {
    const prefix = normalise(from)
    if (normalise(filePath).startsWith(prefix)) {
      return to.replace(/[\\/]+$/, '') + filePath.slice(from.length)
    }
  }
  return filePath
}

/**
 * Works out which paths in a document exist, and under what name.
 *
 * Done for the whole document up front rather than per clip: `existsMany`
 * takes a list, one source is usually referenced by many clips, and a reel cut
 * from a single interview would otherwise stat the same file two hundred
 * times.
 */
async function resolveSources(
  doc: EditDocumentLike,
  remaps: PathRemap[],
): Promise<{ found: Map<string, string>; missing: string[] }> {
  const wanted = new Set<string>()
  for (const track of [...doc.video, ...doc.audio]) {
    for (const clip of track) if (clip.source) wanted.add(clip.source)
  }

  const byPath = new Map(getAssets().map((asset) => [normalise(asset.path), asset.path]))
  const found = new Map<string, string>()
  const toStat: string[] = []
  const candidates = new Map<string, string>()

  for (const source of wanted) {
    const already = byPath.get(normalise(source))
    if (already) {
      found.set(source, already)
      continue
    }
    const remapped = applyRemap(source, remaps)
    const remappedAsset = byPath.get(normalise(remapped))
    if (remappedAsset) {
      found.set(source, remappedAsset)
      continue
    }
    candidates.set(remapped, source)
    toStat.push(remapped)
  }

  if (toStat.length > 0) {
    const exists = await existsMany(toStat)
    for (const [candidate, original] of candidates) {
      if (exists[candidate]) found.set(original, candidate)
    }
  }

  const missing = [...wanted].filter((source) => !found.has(source))
  return { found, missing }
}

/**
 * Imports a document as a new sequence, and says what it could not place.
 *
 * Everything that needs waiting on — resolving paths, importing assets — is
 * done before a single clip is placed, so the placement itself is synchronous
 * and lands as one undo step. The same shape kernel/batchImport.ts uses, for
 * the same reason: `asOneStep` cannot span an `await`.
 */
export async function importEditDocument(
  doc: EditDocumentLike,
  options: { remaps?: PathRemap[]; sequenceName?: string } = {},
): Promise<ImportEditResult> {
  const warnings = [...doc.warnings]
  const { found, missing } = await resolveSources(doc, options.remaps ?? [])

  // Link rather than copy, as batch import does: a document can name hundreds
  // of gigabytes and copying them in to look at them is not what was meant.
  const toImport = [...new Set(found.values())].filter((path) => !hasAsset(path))
  if (toImport.length > 0) {
    await importFiles(
      toImport.map((path) => ({ path, kind: 'video' as const })),
      'link',
    )
  }

  /*
   * Probed before anything is placed, because the clamp below needs to know
   * how long each source really is — and because `importFiles` starts probing
   * in the background and does not wait, so without this the durations are
   * whatever happened to have arrived.
   *
   * Capped rather than all at once: an XML can name a hundred sources, and a
   * hundred simultaneous `<video>` elements asking for metadata is the stall
   * thumbnails.ts caps itself at three to avoid.
   */
  const resolved = [...new Set(found.values())]
  const byPathNow = new Map(getAssets().map((one) => [normalise(one.path), one]))
  const needed = resolved
    .map((filePath) => byPathNow.get(normalise(filePath)))
    .filter((one): one is Asset => Boolean(one))

  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(6, needed.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= needed.length) return
        await ensureProbed(needed[index].id)
      }
    }),
  )

  const assetFor = new Map<string, Asset>()
  for (const asset of getAssets()) assetFor.set(normalise(asset.path), asset)

  if (missing.length > 0) {
    warnings.push(
      `${missing.length} source file${missing.length === 1 ? '' : 's'} could not be found. ` +
        `Clips using ${missing.length === 1 ? 'it' : 'them'} were left out.`,
    )
  }

  const name = options.sequenceName || doc.name || 'Imported sequence'
  let sequenceName = name
  let placed = 0

  asOneStep(() => {
    const made = createSequence({ name })
    sequenceName = made.name

    updateSequenceSettings({
      width: doc.width,
      height: doc.height,
      frameRate: Math.round(doc.frameRate * 1000) / 1000,
    })

    /*
     * Tracks, bottom first, which is the order the document lists them and the
     * reverse of how a sequence stores them. A fresh sequence already has two
     * of each; anything beyond that is added, and the whole list is reversed
     * at the end so the document's first track ends up at the bottom.
     */
    const place = (tracks: EditClipLike[][], kind: TrackKind) => {
      if (tracks.length === 0) return
      const existing = getSequence().tracks.filter((track) => track.kind === kind)
      const needed = tracks.length - existing.length
      for (let i = 0; i < needed; i++) addTrack(kind)

      const lanes: Track[] = getSequence()
        .tracks.filter((track) => track.kind === kind)
        .slice()
        .reverse()

      for (const [index, clips] of tracks.entries()) {
        const lane = lanes[index]
        if (!lane) continue
        for (const clip of clips) {
          if (!clip.source) continue
          const resolved = found.get(clip.source)
          if (!resolved) continue
          const asset = assetFor.get(normalise(resolved))
          if (!asset) continue
          if (!(clip.duration > 0)) continue

          /*
           * Clamped to what the file actually holds.
           *
           * A document can ask for more than exists — a model guessing an out
           * point, an XML whose media was later re-cut shorter. Placing it
           * anyway produces a clip that renders fewer frames than it claims,
           * and the *render verifier* is what catches that: hours later, as a
           * failed job reading "24 frames, expected about 36". Which is a true
           * statement about a cut nobody should have been allowed to make.
           *
           * So it is trimmed here and said out loud. A clip clamped to nothing
           * at all is left out entirely — a zero-length block is not a clip.
           */
          const available = asset.duration ?? 0
          let duration = clip.duration
          if (available > 0) {
            const left = Math.max(0, available - clip.offset) / clip.speed
            if (left <= 0) {
              warnings.push(
                `"${clip.name}" starts at ${clip.offset.toFixed(2)}s, past the end of a ` +
                  `${available.toFixed(2)}s file — left out`,
              )
              continue
            }
            if (left < duration - 1e-6) {
              warnings.push(
                `"${clip.name}" asked for ${duration.toFixed(2)}s from ${clip.offset.toFixed(2)}s ` +
                  `but the file is ${available.toFixed(2)}s — trimmed to ${left.toFixed(2)}s`,
              )
              duration = left
            }
          }

          const made = addClip({
            assetId: asset.id,
            trackId: lane.id,
            start: clip.start,
            duration,
            offset: clip.offset,
            speed: clip.speed,
            /*
             * What the document says the source is, not what the asset was
             * probed as. A trim can only be pulled back out as far as this,
             * and the document is the thing that knew the range was legal.
             */
            sourceDuration: clip.offset + duration * clip.speed,
          })
          if (!made) continue
          placed += 1

          if (clip.transform || clip.audio) {
            setClipEffects(made.id, {
              ...(clip.transform ? { transform: clip.transform } : {}),
              ...(clip.audio ? { audio: clip.audio } : {}),
            } as ClipEffects)
          }
        }
      }
    }

    place(doc.video, 'video')
    place(doc.audio, 'audio')

    /*
     * Markers last, and inside the same step, so undoing an import takes the
     * whole thing back out. They are the only part of the document that says
     * what the edit is *about* — the sequence this was built against carries
     * five named beats with comments — and dropping them at the door would
     * mean re-deriving that from camera filenames.
     */
    for (const marker of doc.markers) {
      addMarker({
        start: marker.start,
        end: marker.end,
        name: marker.name,
        comment: marker.comment,
      })
    }
  })

  return { sequenceName, placed, missing, warnings }
}
