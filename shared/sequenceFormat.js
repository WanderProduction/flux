/**
 * The `.fluxseq` document — one sequence, as a file.
 *
 *   <root>/project_files/sequences/<Sequence Name>.fluxseq
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
 * Five drive the app today. `width` and `height` are the frame the compositor
 * draws into; `frameRate` is the grid the timeline snaps to and the unit the
 * arrow keys step in; `duration` is where the sequence ends, when it has been
 * pinned rather than left to follow the clips; and `startTimecode` is what the
 * ruler counts from.
 *
 * The rest are written down and **not yet acted on** — FLUX has no exporter and
 * no preview render files, so there is nothing for a preview codec to be, and
 * nothing reads a colour space yet. They are here because a sequence is where
 * they belong when there is something to read them, and because a format that
 * grows a field later breaks every file written before it. Recording them now
 * costs a few bytes; adding them later costs a migration.
 *
 * Anything not in force says so where it is shown. A setting that appears to do
 * something and does not is worse than one that is honestly labelled, and this
 * is the whole reason the dialog is split into two halves rather than sorted
 * by topic.
 */

export const SEQUENCE_EXTENSION = '.fluxseq'

/**
 * Sequences live beside the project document, not inside it.
 *
 * The folder's *name*; where it sits is composed in electron/project.js, under
 * project_files. It moved there because the project root is a place people
 * look at — imports and exports are theirs, and a third folder of the app's
 * own bookkeeping beside them is a folder they have to learn to ignore.
 * project_files is already where the app keeps its own things.
 */
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

/** 44.1 is CD and most music; 48 is what every camera shoots and every NLE
 *  masters to; the rest are for people who already know why they want them. */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000, 192000]

/**
 * Channel layouts, by the name people use rather than a count.
 *
 * Stored as a count on the track and named here, because "stereo" is the thing
 * being chosen and "2" is an implementation detail of it. 5.1 is in the list
 * because a sequence is where that decision belongs even though nothing mixes
 * to it yet.
 */
export const CHANNEL_LAYOUTS = [
  { id: 'mono', label: 'Mono', channels: 1 },
  { id: 'stereo', label: 'Stereo', channels: 2 },
  { id: '5.1', label: '5.1 Surround', channels: 6 },
]

/** How many bits a sample is mastered at. 24 is the working standard. */
export const AUDIO_BIT_DEPTHS = [16, 24, 32]

/** What a preview render would be written as, once there is one. */
export const PREVIEW_CODECS = ['none', 'h264', 'prores', 'dnxhr']
export const PIXEL_FORMATS = ['yuv420p', 'yuv422p10le', 'yuv444p10le', 'rgba']

/**
 * How large preview frames are rendered, as a fraction of the sequence frame.
 *
 * The single most useful performance control an editor has, and the first one
 * anybody reaches for on a machine that is struggling.
 */
export const PREVIEW_SCALES = [1, 0.5, 0.25]

/**
 * The colour the sequence works in.
 *
 * Rec.709 for HD and the safe default, sRGB for anything screen-bound, P3 and
 * Rec.2020 for wide gamut, and Linear for compositing that has to be done in
 * light rather than in code values.
 */
export const COLOUR_SPACES = ['rec709', 'srgb', 'display-p3', 'rec2020', 'linear']

/** Transfer function — how code values map to light. HLG and PQ are the two HDR ones. */
export const TRANSFERS = ['rec709', 'srgb', 'linear', 'hlg', 'pq']

/** Bits per channel the compositor works at, once it can be told. */
export const COLOUR_DEPTHS = [8, 10, 12, 16]

/**
 * How the frame is scanned. Progressive unless the footage is genuinely
 * interlaced, which in 2026 means archive material and broadcast delivery.
 */
export const FIELD_ORDERS = ['progressive', 'upper-first', 'lower-first']

/**
 * Pixel aspect ratio: how wide a pixel is against its height.
 *
 * Square for everything shot this century. The others are here because the
 * footage that needs them is exactly the footage nobody can reshoot.
 */
export const PIXEL_ASPECTS = [
  { id: 'square', label: 'Square (1.0)', ratio: 1 },
  { id: 'dv-ntsc', label: 'DV NTSC (0.9091)', ratio: 0.9091 },
  { id: 'dv-pal', label: 'DV PAL (1.0940)', ratio: 1.094 },
  { id: 'anamorphic-2x', label: 'Anamorphic 2:1', ratio: 2 },
]

/**
 * Frame sizes worth one click.
 *
 * Not a closed list — width and height stay editable, and this is a shortcut
 * rather than a gate. Vertical and square are in it because that is what a
 * great deal of work is delivered as now, and typing 1080x1920 by hand every
 * time is the kind of small friction that adds up.
 */
export const FRAME_PRESETS = [
  { id: 'uhd', label: 'UHD 4K — 3840 × 2160', width: 3840, height: 2160 },
  { id: 'dci4k', label: 'DCI 4K — 4096 × 2160', width: 4096, height: 2160 },
  { id: 'hd1080', label: 'HD 1080p — 1920 × 1080', width: 1920, height: 1080 },
  { id: 'hd720', label: 'HD 720p — 1280 × 720', width: 1280, height: 720 },
  { id: 'vertical', label: 'Vertical — 1080 × 1920', width: 1080, height: 1920 },
  { id: 'square', label: 'Square — 1080 × 1080', width: 1080, height: 1080 },
]

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function positive(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** For the numbers where zero is a real answer rather than a missing one. */
function atLeastZero(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * @typedef {object} SequenceSettings
 * @property {number} width  the frame everything is composited into
 * @property {number} height
 * @property {number} frameRate
 * @property {number} duration  seconds, or 0 for "as long as the clips are"
 * @property {number} startTimecode  seconds the ruler counts from
 * @property {number} pixelAspect
 * @property {string} fieldOrder
 * @property {{ space: string, transfer: string, depth: number }} colour recorded
 * @property {{ sampleRate: number, channels: number, bitDepth: number }} audio
 *   sampleRate and channels recorded; nothing acts on bitDepth yet
 * @property {{ codec: string, pixelFormat: string, scale: number, cacheFrames: boolean }} preview
 *   recorded, not yet in force
 */

export function defaultSettings() {
  return {
    width: 1920,
    height: 1080,
    frameRate: 24,
    /*
     * Zero means "as long as the clips are", which is what a sequence does
     * until somebody says otherwise — and it is a different statement from
     * "this sequence is zero seconds long". A nullable number would say the
     * same thing and would have to be checked for at every use.
     */
    duration: 0,
    /*
     * Where the ruler starts counting. Zero for most work; an hour is the
     * broadcast convention, and the reason it exists is that 00:00:00:00 and
     * "no timecode at all" are indistinguishable on a tape.
     */
    startTimecode: 0,
    pixelAspect: 1,
    fieldOrder: 'progressive',
    colour: { space: 'rec709', transfer: 'rec709', depth: 8 },
    audio: { sampleRate: 48000, channels: 2, bitDepth: 24 },
    preview: { codec: 'none', pixelFormat: 'yuv420p', scale: 1, cacheFrames: false },
  }
}

/** The layout whose channel count this is, or the nearest sensible name. */
export function layoutFor(channels) {
  return CHANNEL_LAYOUTS.find((one) => one.channels === channels) ?? CHANNEL_LAYOUTS[1]
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
    // Zero and absent both mean "follow the clips", so this one is allowed to
    // be zero where every other number here is not.
    duration: atLeastZero(raw?.duration, base.duration),
    startTimecode: atLeastZero(raw?.startTimecode, base.startTimecode),
    pixelAspect: positive(raw?.pixelAspect, base.pixelAspect),
    fieldOrder: pick(raw?.fieldOrder, FIELD_ORDERS, base.fieldOrder),
    colour: {
      space: pick(raw?.colour?.space, COLOUR_SPACES, base.colour.space),
      transfer: pick(raw?.colour?.transfer, TRANSFERS, base.colour.transfer),
      depth: pick(Math.round(positive(raw?.colour?.depth, base.colour.depth)), COLOUR_DEPTHS, base.colour.depth),
    },
    audio: {
      sampleRate: Math.round(positive(raw?.audio?.sampleRate, base.audio.sampleRate)),
      channels: Math.min(8, Math.max(1, Math.round(positive(raw?.audio?.channels, base.audio.channels)))),
      bitDepth: pick(Math.round(positive(raw?.audio?.bitDepth, base.audio.bitDepth)), AUDIO_BIT_DEPTHS, base.audio.bitDepth),
    },
    preview: {
      codec: pick(raw?.preview?.codec, PREVIEW_CODECS, base.preview.codec),
      pixelFormat: pick(raw?.preview?.pixelFormat, PIXEL_FORMATS, base.preview.pixelFormat),
      scale: pick(Number(raw?.preview?.scale), PREVIEW_SCALES, base.preview.scale),
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
