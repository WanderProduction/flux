/**
 * The `.fluxseq` document — one sequence, as a file.
 *
 *   <root>/sequences/<Sequence Name>.fluxseq
 *
 * A sequence used to live inside the project document, which was fine while
 * there was exactly one of them. Making it a file of its own buys three things
 * at once: a project can hold several, one can be copied to another project and
 * open there, and the thing that decides what the timeline and the viewer *are*
 * — frame size, rate, audio — has somewhere to be written down.
 *
 * ## Why the media travels with it
 *
 * Clips reference assets by id, and an id means nothing in another project. So
 * a sequence carries the media it uses: path, name, kind and what was probed
 * from it. Opening it somewhere else matches those against that project's
 * assets by path and adds whatever is missing, which is what "opens like
 * native" has to mean. Without it a copied sequence is a list of ids pointing
 * at nothing.
 *
 * The media list is a *reference*, not a copy — the files stay where they are,
 * exactly as importing by link does.
 *
 * ## Settings that are in force, and settings that are recorded
 *
 * `width`, `height` and `frameRate` drive the app today: they are the frame the
 * compositor draws into and the grid the timeline snaps to. The audio and
 * preview settings are written down and **not yet acted on** — FLUX has no
 * exporter and no preview render files, so there is nothing for a preview codec
 * to be. They are here because a sequence is where they belong when there is,
 * and because a format that has to grow a field later breaks every file written
 * before it.
 *
 * Anything not in force says so where it is shown. A setting that appears to do
 * something and does not is worse than one that is honestly labelled.
 */

export const SEQUENCE_EXTENSION = '.fluxseq'

/** Sequences live beside the project document, not inside it. */
export const SEQUENCES_DIR = 'sequences'

/**
 * Bumped when the document shape changes incompatibly.
 *
 *   1 — settings, tracks, clips and the media the clips reference.
 */
export const SEQUENCE_FORMAT = 1

export function isSequenceFile(fileName) {
  return fileName.toLowerCase().endsWith(SEQUENCE_EXTENSION)
}

/** Frame rates a timeline can snap to without lying about where a cut is. */
export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]

export const SAMPLE_RATES = [44100, 48000, 96000]

/** What a preview render would be written as, once there is one. */
export const PREVIEW_CODECS = ['none', 'h264', 'prores']
export const PIXEL_FORMATS = ['yuv420p', 'yuv422p10le', 'rgba']

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * @typedef {object} SequenceSettings
 * @property {number} width  the frame everything is composited into
 * @property {number} height
 * @property {number} frameRate
 * @property {{ sampleRate: number, channels: number }} audio recorded, not yet in force
 * @property {{ codec: string, pixelFormat: string, cacheFrames: boolean }} preview
 *   recorded, not yet in force
 */

export function defaultSettings() {
  return {
    width: 1920,
    height: 1080,
    frameRate: 24,
    audio: { sampleRate: 48000, channels: 2 },
    preview: { codec: 'none', pixelFormat: 'yuv420p', cacheFrames: false },
  }
}

/**
 * Every field present and sane, whatever arrived.
 *
 * Settings come from three places that can all be wrong in different ways: a
 * file written by an older FLUX, a file a human has edited, and a dialog. One
 * normaliser means the rest of the app never has to ask which.
 */
export function makeSettings(raw) {
  const base = defaultSettings()
  const width = Math.round(positive(raw?.width, base.width))
  const height = Math.round(positive(raw?.height, base.height))
  return {
    width,
    height,
    // Not snapped to the list: a file can legitimately carry a rate this build
    // does not offer, and refusing it would move every cut in the sequence.
    frameRate: positive(raw?.frameRate, base.frameRate),
    audio: {
      sampleRate: Math.round(positive(raw?.audio?.sampleRate, base.audio.sampleRate)),
      channels: Math.min(8, Math.max(1, Math.round(positive(raw?.audio?.channels, base.audio.channels)))),
    },
    preview: {
      codec: pick(raw?.preview?.codec, PREVIEW_CODECS, base.preview.codec),
      pixelFormat: pick(raw?.preview?.pixelFormat, PIXEL_FORMATS, base.preview.pixelFormat),
      cacheFrames: Boolean(raw?.preview?.cacheFrames),
    },
  }
}

/**
 * The media a set of clips refers to, as the sequence file will carry it.
 *
 * Only what is used: a sequence that dragged the whole project's bin along
 * would import a hundred unrelated files into whatever project it was opened
 * in.
 */
export function mediaFor(clips, assets) {
  const used = new Set(clips.map((clip) => clip.assetId))
  return assets
    .filter((asset) => used.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      path: asset.path,
      name: asset.name,
      kind: asset.kind,
      size: asset.size,
      mtimeMs: asset.mtimeMs,
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      ...(asset.duration ? { duration: asset.duration } : {}),
    }))
}

/**
 * Builds a sequence document from the parts the renderer holds.
 * @returns {object}
 */
export function makeSequenceDocument({ id, name, settings, tracks, clips, media, createdAt, appVersion }) {
  return {
    flux: { format: SEQUENCE_FORMAT, version: appVersion ?? '0.0.0' },
    id,
    name,
    createdAt: createdAt ?? Date.now(),
    savedAt: Date.now(),
    settings: makeSettings(settings),
    tracks: tracks ?? [],
    clips: clips ?? [],
    media: media ?? [],
  }
}

/**
 * Why a sequence document cannot be opened, or null when it can.
 * @returns {'unreadable' | 'newer-format' | null}
 */
export function sequenceProblem(doc) {
  const format = doc?.flux?.format
  if (typeof format !== 'number') return 'unreadable'
  if (format > SEQUENCE_FORMAT) return 'newer-format'
  if (!Array.isArray(doc.tracks) || !Array.isArray(doc.clips)) return 'unreadable'
  return null
}
