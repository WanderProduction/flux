/**
 * Reading an FCP7 XML (`xmeml`) sequence — what Premiere and Resolve both export.
 *
 * Chosen over Premiere's own `.prproj` (undocumented and binary) and over
 * FCPXML (Final Cut only) because xmeml is the one interchange both halves of
 * this shop already write. It is a dated format and it is the one that moves
 * an edit between the two applications people here actually use.
 *
 * Produces an edit document — see shared/editDocument.js — so everything after
 * this point is shared with the cut lists a model writes.
 *
 * ## Six things that will be wrong if you read this format naively
 *
 * Every one of these is in the single real sequence this was built against, a
 * 25-second vertical reel with graphics. They are not edge cases; they are
 * what a normal export contains.
 *
 * **1. A file element appears once and is then referenced empty.** The second
 * music clip is `<file id="file-6"/>` with no body at all — the path, rate and
 * duration are up in the first clip that used it. A reader that takes each
 * `<file>` at face value loses the media on every repeat use, which in a music
 * bed split around a stop is half the soundtrack.
 *
 * **2. `timebase` is not the frame rate.** `<timebase>30</timebase>` with
 * `<ntsc>TRUE</ntsc>` means 29.97, and the same integer frame numbers then
 * land at different seconds. The sample says FALSE, so it really is 30 — which
 * is exactly why reading it from one machine's exports and assuming it holds
 * is how this breaks later.
 *
 * **3. `start`/`end` and `in`/`out` are different coordinate systems.**
 * `start`/`end` are where the clip sits on the timeline; `in`/`out` are which
 * part of the source it plays. The graphics insert starts at frame 168 with an
 * in-point of 0. Confusing them puts every clip at the wrong moment, trimmed
 * to the wrong range, and it still looks plausible.
 *
 * **4. Geometry comes from a filter, not from fitting.** The talking head is a
 * 2160x3840 file in a 1080x1920 sequence with a Basic Motion scale of 50. Any
 * reader that scales to fit instead gets the framing wrong on exactly the
 * clips someone bothered to reframe.
 *
 * **5. Paths are percent-encoded URLs, and not in ASCII.** `pathurl` is
 * `file://localhost/C:/...` with Hebrew and Russian filenames encoded in it.
 * They also point at the machine that wrote them, so importing someone else's
 * export resolves nothing until the paths are remapped.
 *
 * **6. A clip can contain a whole sequence.** Premiere's nest puts a
 * `<sequence>` inside a `<clipitem>` where a `<file>` would be. FLUX has no
 * sequence-inside-a-sequence, so this reader *says so* rather than dropping
 * it — a nest that silently vanished would take a third of this reel's
 * graphics with it and leave a timeline that looked complete.
 */

import { emptyDocument, pathName } from './editDocument.js'
import { child, children, flagOf, numberOf, parseXml, textOf } from './xml.js'

/**
 * Frames a second, from a `<rate>`.
 *
 * `ntsc` is the whole point. NTSC rates are the integer timebase slowed by
 * 1000/1001 — 30 becomes 29.97, 24 becomes 23.976 — and the flag is the only
 * thing in the file that says which. See trap 2 above.
 *
 * @param {object | null} node anything that may hold a `<rate>`
 * @param {number} fallback
 */
export function rateOf(node, fallback = 25) {
  const rate = child(node, 'rate')
  if (!rate) return fallback
  const timebase = numberOf(rate, 'timebase', 0)
  if (!(timebase > 0)) return fallback
  return flagOf(rate, 'ntsc') ? (timebase * 1000) / 1001 : timebase
}

/**
 * An absolute filesystem path from a `pathurl`.
 *
 * `file://localhost/C:/Users/...` — the host is a legacy of the format and is
 * always either `localhost` or empty. Percent-decoding has to happen after the
 * host is removed, and has to be tolerant: a path containing a literal `%`
 * that was never encoded makes `decodeURIComponent` throw, and an edit should
 * not fail to open over one character in one filename.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function pathFromUrl(url) {
  if (!url) return null
  let rest = url
  if (rest.startsWith('file://')) {
    rest = rest.slice('file://'.length)
    // Strip an authority: `localhost` or empty, then the path's leading slash.
    const slash = rest.indexOf('/')
    if (slash >= 0) rest = rest.slice(slash)
  }
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // Left as-is. A path that will not decode is far more useful to a human
    // reading a warning than no path at all.
  }
  // `/C:/Users/...` -> `C:/Users/...`
  if (/^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1)
  return decoded || null
}

/**
 * Basic Motion and Opacity, as a FLUX transform.
 *
 * Only the parameters FLUX has somewhere to put are read. Premiere writes a
 * `<filter>` for every effect on a clip, most of which have no equivalent
 * here, and silently absorbing one would claim the render matches when it
 * does not — so anything unrecognised is named in the document's warnings by
 * the caller.
 *
 * @param {object} clipitem
 * @returns {{ transform: object | null, audio: object | null, unknown: string[] }}
 */
function effectsOf(clipitem) {
  /** @type {Record<string, number>} */
  const motion = {}
  let opacity = null
  let level = null
  const unknown = []

  for (const filter of children(clipitem, 'filter')) {
    const effect = child(filter, 'effect')
    if (!effect) continue
    const id = textOf(effect, 'effectid')
    const params = children(effect, 'parameter')
    const valueOf = (name) => {
      const p = params.find((one) => textOf(one, 'parameterid') === name)
      return p ? numberOf(p, 'value', NaN) : NaN
    }

    if (id === 'basic') {
      const scale = valueOf('scale')
      const rotation = valueOf('rotation')
      if (Number.isFinite(scale)) motion.scale = scale
      if (Number.isFinite(rotation)) motion.rotation = rotation
      /*
       * `center` is a nested <value><horiz>/<vert> in normalised units where 0
       * is the middle of the frame, not pixels from the corner. Converting it
       * needs the sequence size, which this function does not have — so it is
       * handled by the caller, which does.
       */
      const centre = params.find((one) => textOf(one, 'parameterid') === 'center')
      if (centre) {
        const value = child(centre, 'value')
        motion.centerX = numberOf(value, 'horiz', 0)
        motion.centerY = numberOf(value, 'vert', 0)
      }
      continue
    }
    if (id === 'opacity') {
      const value = valueOf('opacity')
      if (Number.isFinite(value)) opacity = value
      continue
    }
    if (id === 'audiolevels') {
      const value = valueOf('level')
      if (Number.isFinite(value)) level = value
      continue
    }
    unknown.push(textOf(effect, 'name') || id || 'an unnamed effect')
  }

  const transform = {}
  if (motion.scale !== undefined) {
    transform.scale = motion.scale
    transform.scaleWidth = motion.scale
    transform.uniform = true
  }
  if (motion.rotation !== undefined) transform.rotation = motion.rotation
  if (opacity !== null) transform.opacity = opacity
  if (motion.centerX !== undefined) {
    transform.centerX = motion.centerX
    transform.centerY = motion.centerY
  }

  return {
    transform: Object.keys(transform).length > 0 ? transform : null,
    audio: level !== null ? { level } : null,
    unknown,
  }
}

/**
 * Reads one `<track>` into edit clips.
 *
 * @param {object} track
 * @param {number} rate sequence frames a second
 * @param {Map<string, object>} files id -> the `<file>` that defined it
 * @param {{ width: number, height: number }} frame
 * @param {string[]} warnings
 * @param {string} kind 'video' or 'audio'
 */
function readTrack(track, rate, files, frame, warnings, kind) {
  const clips = []

  for (const item of children(track, 'clipitem')) {
    const name = textOf(item, 'name') || 'clip'

    /*
     * A nest. See trap 6 — refused by name rather than dropped, because the
     * timeline that results is missing a third of its graphics and says
     * nothing about it.
     */
    if (child(item, 'sequence')) {
      warnings.push(
        `"${name}" is a nested sequence. FLUX has no sequence inside a sequence, so it was left ` +
          `out — flatten it in Premiere (or render it) and import again.`,
      )
      continue
    }

    const fileNode = child(item, 'file')
    if (!fileNode) {
      warnings.push(`"${name}" has no media and was left out`)
      continue
    }

    /*
     * Trap 1: resolve a bare `<file id="..."/>` back to the element that
     * carried the path. The first mention of an id is the definition; every
     * later one may be empty.
     */
    const id = fileNode.attrs.id
    const defined = id && files.has(id) ? files.get(id) : null
    if (id && !files.has(id) && child(fileNode, 'pathurl')) files.set(id, fileNode)
    const file = child(fileNode, 'pathurl') ? fileNode : defined
    if (!file) {
      warnings.push(`"${name}" references file ${id ?? '(unnamed)'}, which this file never defines`)
      continue
    }

    const source = pathFromUrl(textOf(file, 'pathurl'))

    /*
     * Trap 3. `start`/`end` place the clip; `in`/`out` choose the part of the
     * source. A clip's own rate can differ from the sequence's, and its
     * in/out are counted in *its* rate — which is also how speed shows up in
     * this format, as a source span that does not match the timeline span.
     */
    const clipRate = rateOf(item, rate) || rate
    const start = numberOf(item, 'start', 0)
    const end = numberOf(item, 'end', 0)
    const inPoint = numberOf(item, 'in', 0)
    const outPoint = numberOf(item, 'out', 0)

    /*
     * A clip inside a nest can carry start -1, meaning "wherever the nest puts
     * it". Nests are refused above, so reaching this means something stranger;
     * it is clamped rather than allowed to place a clip before zero.
     */
    const timelineFrames = end > start ? end - start : outPoint - inPoint
    if (!(timelineFrames > 0)) {
      warnings.push(`"${name}" has no length and was left out`)
      continue
    }

    const duration = timelineFrames / rate
    const sourceSeconds = (outPoint - inPoint) / clipRate
    // Speed is the ratio of source consumed to time on the timeline.
    const speed = sourceSeconds > 0 && duration > 0 ? sourceSeconds / duration : 1

    const { transform, audio, unknown } = effectsOf(item)
    for (const effect of unknown) {
      warnings.push(`"${name}" has a ${effect} effect, which FLUX cannot apply`)
    }

    const media = child(file, 'media')
    const visual = child(child(media, 'video'), 'samplecharacteristics')
    const sourceSize = visual
      ? { width: numberOf(visual, 'width', 0), height: numberOf(visual, 'height', 0) }
      : null

    /*
     * Trap 4's other half: Premiere's `center` is normalised to the frame, so
     * turning it into the pixel position FLUX wants needs the sequence size,
     * which is why it is finished here and not in effectsOf.
     */
    let placement = transform
    if (transform && transform.centerX !== undefined) {
      const { centerX, centerY, ...rest } = transform
      placement = {
        ...rest,
        position: {
          x: frame.width / 2 + centerX * frame.width,
          y: frame.height / 2 + centerY * frame.height,
        },
      }
    }

    clips.push({
      name,
      source,
      start: Math.max(0, start) / rate,
      duration,
      offset: Math.max(0, inPoint) / clipRate,
      speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
      enabled: flagOf(item, 'enabled', true),
      ...(placement ? { transform: placement } : {}),
      ...(audio ? { audio } : {}),
      ...(sourceSize && sourceSize.width > 0 ? { sourceSize } : {}),
      sourceRate: clipRate,
    })
  }

  return clips.sort((a, b) => a.start - b.start)
}

/**
 * Reads an xmeml document into an edit document.
 *
 * @param {string} source the file's text
 * @returns {{ ok: true, document: import('./editDocument.js').EditDocument }
 *   | { ok: false, error: string }}
 */
export function readXmeml(source) {
  let root
  try {
    root = parseXml(source)
  } catch (err) {
    return { ok: false, error: `this is not readable XML: ${err.message}` }
  }

  if (root.name !== 'xmeml') {
    return {
      ok: false,
      error:
        root.name === 'fcpxml'
          ? 'this is FCPXML (Final Cut), not the FCP7 XML that Premiere and Resolve write'
          : `expected an <xmeml> document, found <${root.name}>`,
    }
  }

  const sequence = child(root, 'sequence')
  if (!sequence) return { ok: false, error: 'this xmeml has no <sequence> in it' }

  const doc = emptyDocument(textOf(sequence, 'name') || 'Imported sequence')
  const media = child(sequence, 'media')
  const video = child(media, 'video')
  const audio = child(media, 'audio')

  const format = child(child(video, 'format'), 'samplecharacteristics')
  doc.frameRate = rateOf(format, rateOf(sequence, 25))
  doc.width = numberOf(format, 'width', 1920)
  doc.height = numberOf(format, 'height', 1080)

  /*
   * One map for the whole document. A file defined on a video clip can be
   * referenced from an audio one — a camera file carries both — so the scope
   * has to be the document rather than the track.
   */
  const files = new Map()
  const collect = (node) => {
    if (node.name === 'file' && node.attrs.id && child(node, 'pathurl')) {
      if (!files.has(node.attrs.id)) files.set(node.attrs.id, node)
    }
    node.children.forEach(collect)
  }
  collect(sequence)

  const frame = { width: doc.width, height: doc.height }
  // xmeml writes the bottom track first, which is the order this document
  // wants. The flip to FLUX's top-first order happens in the converter.
  doc.video = children(video, 'track')
    .map((track) => readTrack(track, doc.frameRate, files, frame, doc.warnings, 'video'))
    .filter((clips) => clips.length > 0)
  doc.audio = children(audio, 'track')
    .map((track) => readTrack(track, doc.frameRate, files, frame, doc.warnings, 'audio'))
    .filter((clips) => clips.length > 0)

  /*
   * Markers are the only part of the file that says what the edit is *about* —
   * here, five named beats with comments describing each one. Nothing in FLUX
   * draws them yet, and they are carried anyway: they are the structure a
   * person or a model reads to understand the cut, and throwing them away at
   * the door would mean re-deriving it from clip names.
   */
  doc.markers = children(sequence, 'marker').map((marker) => ({
    start: numberOf(marker, 'in', 0) / doc.frameRate,
    end: numberOf(marker, 'out', numberOf(marker, 'in', 0)) / doc.frameRate,
    name: textOf(marker, 'name'),
    comment: textOf(marker, 'comment'),
  }))

  return { ok: true, document: doc }
}
