/**
 * One shape that every way of describing an edit turns into.
 *
 * Three things want to hand FLUX a timeline: a Premiere or Resolve XML, a
 * language model deciding which takes survive, and eventually FLUX itself
 * writing one back out. Converting each of those straight into a FLUX sequence
 * would be three copies of the same awkward arithmetic — frames to seconds,
 * timeline position versus source in-point, track order, which clip is a
 * layer on top of which — and three places for it to be subtly different.
 *
 * So each reader produces an **edit document**, and exactly one converter
 * turns that into a sequence. A reader's whole job is to be right about its
 * own format; it is never also right about FLUX.
 *
 * ## Everything here is in seconds, and bottom track first
 *
 * Two conventions, both chosen because they are the ones that do not depend on
 * the file a document came from.
 *
 * **Seconds**, because frames are meaningless without the rate, and the rate
 * is exactly what interchange formats get wrong — xmeml writes `timebase 30`
 * with a separate `ntsc` flag that silently means 29.97, so the same integer
 * frame number is two different moments depending on a sibling tag. Resolving
 * that once, at the edge, is the only way the rest of the pipeline can do
 * arithmetic without asking.
 *
 * **Bottom track first**, which is xmeml's order and the order a compositor
 * draws in, and is *not* FLUX's: a sequence holds `[V2, V1]` because that is
 * the order they are drawn down the screen. The flip happens once, in the
 * converter. Getting this wrong is quiet — the render still works, it just has
 * the wrong layer on top — and it has already caught batch import once.
 *
 * ## A document is a proposal, not a sequence
 *
 * It names sources by **path**, not by asset id, because the thing that wrote
 * it had no idea what is in this project's bin. Resolving those paths to
 * assets, and saying what could not be found, is the converter's job.
 */

/**
 * @typedef {object} EditClip
 * @property {string} name
 * @property {string | null} source absolute path, or null when unresolved
 * @property {number} start seconds from the start of the sequence
 * @property {number} duration seconds of sequence it covers
 * @property {number} offset seconds into the source where it begins
 * @property {number} speed 1 is the rate it was shot
 * @property {boolean} enabled
 * @property {object} [transform] scale/position/opacity, as ClipEffects wants
 * @property {object} [audio] level and pan
 * @property {{ width: number, height: number }} [sourceSize]
 * @property {number} [sourceRate]
 * @property {string} [note] why this clip is here — carried for the agent path
 */

/**
 * @typedef {object} EditMarker
 * @property {number} start seconds
 * @property {number} end seconds; equal to start for a point marker
 * @property {string} name
 * @property {string} comment
 */

/**
 * @typedef {object} EditDocument
 * @property {string} name
 * @property {number} frameRate real frames a second — 29.97, never 30 with a flag
 * @property {number} width
 * @property {number} height
 * @property {EditClip[][]} video bottom track first
 * @property {EditClip[][]} audio
 * @property {EditMarker[]} markers
 * @property {string[]} warnings what the reader could not carry across
 */

/** A document with nothing in it, for a reader to fill. */
export function emptyDocument(name = 'Imported') {
  return {
    name,
    frameRate: 25,
    width: 1920,
    height: 1080,
    video: [],
    audio: [],
    markers: [],
    warnings: [],
  }
}

/**
 * Checks a document is self-consistent, and says what is wrong with it.
 *
 * Returns problems rather than throwing, and returns *all* of them rather than
 * the first. A model that wrote a cut list with four bad ranges in it should
 * be told about four, once — not made to discover them one round trip at a
 * time, which is the slowest possible way to converge and the one a throwing
 * validator forces.
 *
 * @param {EditDocument} doc
 * @returns {string[]} empty when the document is usable
 */
export function problemsWith(doc) {
  const problems = []
  if (!doc || typeof doc !== 'object') return ['not a document']

  if (!(doc.frameRate > 0)) problems.push(`frameRate must be positive, got ${doc.frameRate}`)
  if (!(doc.width > 0 && doc.height > 0)) {
    problems.push(`frame size must be positive, got ${doc.width}x${doc.height}`)
  }

  const tracks = [...(doc.video ?? []), ...(doc.audio ?? [])]
  if (tracks.length === 0) problems.push('the document has no tracks')

  let clips = 0
  for (const [index, track] of tracks.entries()) {
    for (const clip of track ?? []) {
      clips += 1
      const where = `${clip.name || 'a clip'} on track ${index + 1}`
      if (!(clip.duration > 0)) problems.push(`${where} has no length`)
      if (!(clip.start >= 0)) problems.push(`${where} starts before zero`)
      if (!(clip.offset >= 0)) problems.push(`${where} starts before its source does`)
      if (!(clip.speed > 0)) problems.push(`${where} has a speed of ${clip.speed}`)
      if (!clip.source) problems.push(`${where} names no source file`)
    }
  }
  if (clips === 0) problems.push('the document has no clips')

  return problems
}

/**
 * Reads the compact form a language model writes.
 *
 * ## Why this exists rather than having the model write XML
 *
 * Token cost, and it is not close. The sample Premiere sequence this was built
 * against is 450 lines for nine clips — about fifty lines each. A two hundred
 * cut reel in that form is ten thousand lines, and the model would have to
 * emit every tag of it without one mistake. The same two hundred cuts here are
 * two hundred short objects.
 *
 * It is also the difference between a format a model can be *right* about and
 * one it can only be lucky about. There is nothing to close, nothing to nest,
 * and every field is a number or a string.
 *
 *     {
 *       "name": "Oleg reel 10",
 *       "frameRate": 30, "width": 1080, "height": 1920,
 *       "sources": ["E:/FOOTAGE/.../talking_01.mp4", "..."],
 *       "video": [
 *         [ {"src": 0, "in": 12.4, "out": 18.9, "why": "clean, facing camera"},
 *           {"src": 0, "in": 31.0, "out": 36.2} ]
 *       ]
 *     }
 *
 * **`src` is an index into `sources`**, not a path. A reel cut from one
 * interview repeats the same path on every cut, and at a couple of hundred
 * cuts that is most of the document — paths here are long, and on this
 * material they are also non-ASCII. An index is two characters.
 *
 * **Cuts are laid end to end unless they say otherwise.** `in`/`out` are
 * points in the *source*; `at` is where the cut lands on the timeline, and
 * omitting it means "straight after the last one". Almost every cut list is a
 * sequence of takes in order, so the common case writes nothing.
 *
 * `why` is carried through to the clip as a note. It costs a few tokens and it
 * is the only record of what the model was thinking when it kept something.
 *
 * @param {object} source parsed JSON, not a string
 * @returns {{ ok: true, document: EditDocument } | { ok: false, problems: string[] }}
 */
export function readCutList(source) {
  if (!source || typeof source !== 'object') return { ok: false, problems: ['not an object'] }

  const paths = Array.isArray(source.sources) ? source.sources : []
  if (paths.length === 0) return { ok: false, problems: ['no sources listed'] }

  const problems = []
  const doc = emptyDocument(source.name || 'Cut list')
  doc.frameRate = Number(source.frameRate) || 25
  doc.width = Number(source.width) || 1920
  doc.height = Number(source.height) || 1080

  const readTrack = (cuts, kind, index) => {
    const out = []
    let at = 0
    for (const [n, cut] of (cuts ?? []).entries()) {
      const where = `${kind} track ${index + 1}, cut ${n + 1}`
      const path = paths[cut.src]
      if (path === undefined) {
        problems.push(`${where}: src ${cut.src} is not in sources`)
        continue
      }
      const start = cut.at === undefined ? at : Number(cut.at)
      const inPoint = Number(cut.in ?? 0)
      const outPoint = Number(cut.out)
      if (!Number.isFinite(outPoint)) {
        problems.push(`${where}: no out point`)
        continue
      }
      const duration = outPoint - inPoint
      if (!(duration > 0)) {
        problems.push(`${where}: out (${outPoint}) is not after in (${inPoint})`)
        continue
      }
      out.push({
        name: cut.name || pathName(path),
        source: path,
        start,
        duration,
        offset: inPoint,
        speed: Number(cut.speed) || 1,
        enabled: cut.enabled !== false,
        ...(cut.why ? { note: String(cut.why) } : {}),
      })
      at = start + duration
    }
    return out
  }

  doc.video = (source.video ?? []).map((track, i) => readTrack(track, 'video', i))
  doc.audio = (source.audio ?? []).map((track, i) => readTrack(track, 'audio', i))
  doc.markers = (source.markers ?? []).map((marker) => ({
    start: Number(marker.at ?? marker.start) || 0,
    end: Number(marker.to ?? marker.end ?? marker.at ?? marker.start) || 0,
    name: String(marker.name ?? ''),
    comment: String(marker.comment ?? ''),
  }))

  problems.push(...problemsWith(doc))
  return problems.length > 0 ? { ok: false, problems } : { ok: true, document: doc }
}

/** The last segment of a path, whichever separator it uses. */
export function pathName(filePath) {
  const parts = String(filePath).split(/[\\/]+/)
  return parts[parts.length - 1] || String(filePath)
}

/**
 * How long the document runs, in seconds.
 *
 * The furthest any clip reaches, not the sum of their lengths: tracks overlap
 * by definition and a gap is still time.
 */
export function documentLength(doc) {
  let end = 0
  for (const track of [...(doc.video ?? []), ...(doc.audio ?? [])]) {
    for (const clip of track ?? []) end = Math.max(end, clip.start + clip.duration)
  }
  return end
}
