/**
 * An MP4 demuxer: enough of ISO/IEC 14496-12 to feed WebCodecs.
 *
 * ## Why this exists
 *
 * `VideoDecoder` decodes; it does not demux. It takes `EncodedVideoChunk`s —
 * one compressed frame each, with a timestamp and a keyframe flag — and it has
 * no idea what an mp4 is. Something has to open the container, read the sample
 * table, and say "frame 412 is 9,113 bytes at offset 1,048,576, it is not a
 * keyframe, and it belongs at 16.48 seconds". That is this file.
 *
 * It is also what makes *seeking* possible at all. Inter-frame codecs only
 * decode forward from a keyframe, so seeking to 16.48s means finding the last
 * keyframe at or before it and decoding through. Without a sample table you
 * cannot find that keyframe, which is exactly why every NLE builds an index
 * when it imports a file.
 *
 * ## What it reads, and what it does not
 *
 * Progressive mp4 with a single `moov` — the shape a camera, a phone or an
 * ffmpeg export produces. Deliberately *not* handled, and each returns a reason
 * rather than a wrong answer:
 *
 *   - fragmented mp4 (`moof`) — streaming layout, a different index entirely
 *   - edit lists (`elst`) that do anything but start at zero
 *   - anything but a single video track's samples
 *
 * A caller that gets `null` falls back to whatever it did before. A demuxer
 * that guesses produces frames from the wrong offsets, which is not a decode
 * error — it is silent visual garbage.
 *
 * ## Bytes come from a reader
 *
 * Nothing here opens a file. It asks a `ByteReader` for ranges, so the same
 * code runs in the renderer over `flux-asset://` (which serves ranges — see
 * electron/assetServer.js) and in a plain Node harness reading from disk. The
 * parsing is then testable against real files with no app running at all.
 */

/**
 * @typedef {object} ByteReader
 * @property {() => Promise<number>} size total bytes
 * @property {(start: number, end: number) => Promise<Uint8Array>} read
 *   inclusive of both ends, the way an HTTP byte range is
 */

/**
 * @typedef {object} VideoTrack
 * @property {string} codec WebCodecs codec string, e.g. `avc1.64001f`
 * @property {Uint8Array} description the avcC record VideoDecoder needs
 * @property {number} width
 * @property {number} height
 * @property {number} timescale ticks per second
 * @property {number} duration seconds
 * @property {number} count number of samples
 * @property {Float64Array} offset byte offset of each sample
 * @property {Uint32Array} bytes size of each sample
 * @property {Float64Array} dts decode time, seconds
 * @property {Float64Array} pts presentation time, seconds
 * @property {Uint8Array} key 1 when the sample is a sync sample
 * @property {Int32Array} order sample indices sorted by presentation time
 */

const MAX_BOX_SCAN = 4096

/** Reads a box header at `at`, returning its type, total size and body start. */
function readHeader(view, at) {
  if (at + 8 > view.byteLength) return null
  let size = view.getUint32(at)
  const type = String.fromCharCode(
    view.getUint8(at + 4),
    view.getUint8(at + 5),
    view.getUint8(at + 6),
    view.getUint8(at + 7),
  )
  let body = at + 8
  if (size === 1) {
    if (at + 16 > view.byteLength) return null
    // 64-bit size. getBigUint64 would be exact but a Number is good to 8EB,
    // which is comfortably past any file a disk will hold.
    size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
    body = at + 16
  }
  if (size < body - at) return null
  return { type, size, body, end: at + size }
}

/**
 * Walks the top level of the file looking for `moov`.
 *
 * It may be at the front (a "faststart" file) or behind the media data (what
 * most encoders write by default), so this steps box to box rather than
 * assuming. Only the 16-byte header of each box is read; `mdat` is stepped
 * over, never fetched.
 *
 * @param {ByteReader} reader
 * @returns {Promise<{ start: number, size: number } | null>}
 */
async function findMoov(reader) {
  const total = await reader.size()
  let at = 0

  for (let box = 0; box < MAX_BOX_SCAN && at < total; box++) {
    const head = await reader.read(at, Math.min(at + 15, total - 1))
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const header = readHeader(view, 0)
    if (!header) return null
    if (header.type === 'moov') return { start: at, size: header.size }
    // A box claiming to reach past the end of the file is a broken file, and
    // stepping by it would loop or run off the end.
    if (header.size <= 0 || at + header.size > total) return null
    at += header.size
  }
  return null
}

/** Every direct child box of a container, as {type, start, end} into `bytes`. */
function children(view, from, to) {
  const found = []
  let at = from
  while (at + 8 <= to) {
    const header = readHeader(view, at)
    if (!header || header.end > to || header.size <= 0) break
    found.push({ type: header.type, body: header.body, end: header.end })
    at = header.end
  }
  return found
}

function findChild(view, from, to, type) {
  return children(view, from, to).find((box) => box.type === type) ?? null
}

/** Full boxes lead with a version byte and three flag bytes. */
function versionOf(view, body) {
  return view.getUint8(body)
}

function parseStsd(view, body, end) {
  // version/flags, entry count, then the entries.
  const entries = view.getUint32(body + 4)
  if (entries < 1) return null

  const first = readHeader(view, body + 8)
  if (!first) return null
  /*
   * A visual sample entry is a fixed 78-byte preamble and then child boxes.
   *
   *   8   SampleEntry:       reserved[6], data_reference_index
   *   70  VisualSampleEntry: pre_defined, reserved, pre_defined[3], width,
   *                          height, resolutions, reserved, frame_count,
   *                          compressorname[32], depth, pre_defined
   *
   * Counting the 70 from the wrong end lands the search for avcC eight bytes
   * early, inside the compressor name, where it finds nothing — and the file
   * comes back as an unsupported codec when the codec was fine all along.
   */
  const format = first.type
  const configStart = first.body + 78
  const width = view.getUint16(first.body + 24)
  const height = view.getUint16(first.body + 26)

  const avcC = findChild(view, configStart, Math.min(first.end, end), 'avcC')
  if (!avcC) return { format, width, height, description: null, codec: null }

  const description = new Uint8Array(
    view.buffer.slice(view.byteOffset + avcC.body, view.byteOffset + avcC.end),
  )
  const hex = (n) => n.toString(16).padStart(2, '0')
  const codec =
    description.length >= 4
      ? `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`
      : null
  return { format, width, height, description, codec }
}

/** stts: run-length encoded per-sample decode durations. */
function parseStts(view, body, count) {
  const deltas = new Float64Array(count)
  const runs = view.getUint32(body + 4)
  let sample = 0
  let at = body + 8
  for (let run = 0; run < runs && sample < count; run++) {
    const runCount = view.getUint32(at)
    const delta = view.getUint32(at + 4)
    at += 8
    for (let i = 0; i < runCount && sample < count; i++) deltas[sample++] = delta
  }
  return deltas
}

/** ctts: composition offsets, so presentation order can differ from decode. */
function parseCtts(view, body, count) {
  const offsets = new Float64Array(count)
  const version = versionOf(view, body)
  const runs = view.getUint32(body + 4)
  let sample = 0
  let at = body + 8
  for (let run = 0; run < runs && sample < count; run++) {
    const runCount = view.getUint32(at)
    // Version 1 offsets are signed; version 0 are nominally unsigned but
    // encoders have always written negatives into them.
    const offset = version === 1 ? view.getInt32(at + 4) : view.getInt32(at + 4)
    at += 8
    for (let i = 0; i < runCount && sample < count; i++) offsets[sample++] = offset
  }
  return offsets
}

function parseStsz(view, body) {
  const uniform = view.getUint32(body + 4)
  const count = view.getUint32(body + 8)
  const sizes = new Uint32Array(count)
  if (uniform !== 0) {
    sizes.fill(uniform)
    return { count, sizes }
  }
  for (let i = 0; i < count; i++) sizes[i] = view.getUint32(body + 12 + i * 4)
  return { count, sizes }
}

/**
 * stsc + stco/co64 -> a byte offset for every sample.
 *
 * Samples are grouped into chunks, and the chunk table says only where each
 * *chunk* starts. Walking it is the only way to get a per-sample offset, which
 * is the whole point of the index.
 */
function sampleOffsets(view, stsc, chunkOffsets, sizes, count) {
  const runs = view.getUint32(stsc.body + 4)
  const offsets = new Float64Array(count)

  let sample = 0
  for (let run = 0; run < runs && sample < count; run++) {
    const at = stsc.body + 8 + run * 12
    const firstChunk = view.getUint32(at)
    const perChunk = view.getUint32(at + 4)
    const nextFirstChunk =
      run + 1 < runs ? view.getUint32(stsc.body + 8 + (run + 1) * 12) : chunkOffsets.length + 1

    for (let chunk = firstChunk; chunk < nextFirstChunk && sample < count; chunk++) {
      if (chunk - 1 >= chunkOffsets.length) break
      let at2 = chunkOffsets[chunk - 1]
      for (let i = 0; i < perChunk && sample < count; i++) {
        offsets[sample] = at2
        at2 += sizes[sample]
        sample++
      }
    }
  }
  return offsets
}

function parseChunkOffsets(view, stbl, stblEnd) {
  const stco = findChild(view, stbl, stblEnd, 'stco')
  if (stco) {
    const count = view.getUint32(stco.body + 4)
    const out = new Float64Array(count)
    for (let i = 0; i < count; i++) out[i] = view.getUint32(stco.body + 8 + i * 4)
    return out
  }
  const co64 = findChild(view, stbl, stblEnd, 'co64')
  if (!co64) return null
  const count = view.getUint32(co64.body + 4)
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const at = co64.body + 8 + i * 8
    out[i] = view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4)
  }
  return out
}

function parseStss(view, stbl, stblEnd, count) {
  const key = new Uint8Array(count)
  const stss = findChild(view, stbl, stblEnd, 'stss')
  if (!stss) {
    // No sync table means every sample is a sync sample — all-intra material.
    key.fill(1)
    return key
  }
  const entries = view.getUint32(stss.body + 4)
  for (let i = 0; i < entries; i++) {
    const sample = view.getUint32(stss.body + 8 + i * 4) - 1 // stss is 1-based
    if (sample >= 0 && sample < count) key[sample] = 1
  }
  return key
}

function parseMdhd(view, body) {
  const version = versionOf(view, body)
  if (version === 1) {
    return {
      timescale: view.getUint32(body + 20),
      duration: view.getUint32(body + 24) * 2 ** 32 + view.getUint32(body + 28),
    }
  }
  return { timescale: view.getUint32(body + 12), duration: view.getUint32(body + 16) }
}

/**
 * Reads the index for the first video track.
 *
 * @param {ByteReader} reader
 * @returns {Promise<{ ok: true, track: VideoTrack } | { ok: false, reason: string }>}
 */
export async function readVideoTrack(reader) {
  const moov = await findMoov(reader)
  if (!moov) return { ok: false, reason: 'no-moov' }

  const bytes = await reader.read(moov.start, moov.start + moov.size - 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const head = readHeader(view, 0)
  if (!head || head.type !== 'moov') return { ok: false, reason: 'no-moov' }

  const top = children(view, head.body, Math.min(head.end, bytes.byteLength))
  if (top.some((box) => box.type === 'mvex')) return { ok: false, reason: 'fragmented' }

  for (const trak of top.filter((box) => box.type === 'trak')) {
    const mdia = findChild(view, trak.body, trak.end, 'mdia')
    if (!mdia) continue
    const hdlr = findChild(view, mdia.body, mdia.end, 'hdlr')
    if (!hdlr) continue
    const handler = String.fromCharCode(
      view.getUint8(hdlr.body + 8),
      view.getUint8(hdlr.body + 9),
      view.getUint8(hdlr.body + 10),
      view.getUint8(hdlr.body + 11),
    )
    if (handler !== 'vide') continue

    /*
     * An edit list remaps the media's timeline onto the track's. The one
     * encoders write is a single entry compensating for B-frame composition
     * offsets, which the normalisation below handles without reading it. More
     * than one entry means the track is genuinely cut up in time, and
     * pretending otherwise would put every frame at the wrong moment.
     */
    const edts = findChild(view, trak.body, trak.end, 'edts')
    if (edts) {
      const elst = findChild(view, edts.body, edts.end, 'elst')
      if (elst && view.getUint32(elst.body + 4) > 1) {
        return { ok: false, reason: 'edit-list' }
      }
    }

    const mdhd = findChild(view, mdia.body, mdia.end, 'mdhd')
    const minf = findChild(view, mdia.body, mdia.end, 'minf')
    if (!mdhd || !minf) return { ok: false, reason: 'malformed' }
    const stblBox = findChild(view, minf.body, minf.end, 'stbl')
    if (!stblBox) return { ok: false, reason: 'malformed' }

    const { timescale, duration } = parseMdhd(view, mdhd.body)
    if (!timescale) return { ok: false, reason: 'malformed' }

    const stsdBox = findChild(view, stblBox.body, stblBox.end, 'stsd')
    const sttsBox = findChild(view, stblBox.body, stblBox.end, 'stts')
    const stszBox = findChild(view, stblBox.body, stblBox.end, 'stsz')
    const stscBox = findChild(view, stblBox.body, stblBox.end, 'stsc')
    if (!stsdBox || !sttsBox || !stszBox || !stscBox) return { ok: false, reason: 'malformed' }

    const stsd = parseStsd(view, stsdBox.body, stsdBox.end)
    if (!stsd) return { ok: false, reason: 'malformed' }
    if (!stsd.description || !stsd.codec) {
      return { ok: false, reason: `unsupported-codec:${stsd.format}` }
    }

    const { count, sizes } = parseStsz(view, stszBox.body)
    if (count === 0) return { ok: false, reason: 'no-samples' }

    const chunkOffsets = parseChunkOffsets(view, stblBox.body, stblBox.end)
    if (!chunkOffsets) return { ok: false, reason: 'malformed' }

    const deltas = parseStts(view, sttsBox.body, count)
    const cttsBox = findChild(view, stblBox.body, stblBox.end, 'ctts')
    const composition = cttsBox ? parseCtts(view, cttsBox.body, count) : null

    const dts = new Float64Array(count)
    const pts = new Float64Array(count)
    let running = 0
    let earliest = Infinity
    for (let i = 0; i < count; i++) {
      dts[i] = running / timescale
      pts[i] = (running + (composition ? composition[i] : 0)) / timescale
      if (pts[i] < earliest) earliest = pts[i]
      running += deltas[i]
    }

    /*
     * Shift so the first frame presented is at zero.
     *
     * With B-frames the first sample decoded is not the first shown, so its
     * composition offset pushes every timestamp forward — here by two frames.
     * Encoders write a one-entry edit list to cancel exactly that, and this is
     * the same correction arrived at from the sample table instead. Without it
     * every clip is a couple of frames late against its own timeline, which is
     * the kind of error that only shows up as a sync problem much later.
     */
    if (earliest !== 0 && Number.isFinite(earliest)) {
      for (let i = 0; i < count; i++) pts[i] -= earliest
    }

    return {
      ok: true,
      track: {
        codec: stsd.codec,
        description: stsd.description,
        width: stsd.width,
        height: stsd.height,
        timescale,
        duration: duration / timescale,
        count,
        offset: sampleOffsets(view, stscBox, chunkOffsets, sizes, count),
        bytes: sizes,
        dts,
        pts,
        key: parseStss(view, stblBox.body, stblBox.end, count),
        order: presentationOrder(pts, count),
      },
    }
  }

  return { ok: false, reason: 'no-video-track' }
}

/**
 * Sample indices sorted by presentation time.
 *
 * Decode order is not presentation order the moment a file has B-frames: a
 * P-frame is decoded before the B-frames that sit between it and the previous
 * one, so walking the sample table in order gives timestamps that jump forward
 * and back. Anything looking a time up needs this instead, and building it once
 * turns every lookup into a binary search.
 */
function presentationOrder(pts, count) {
  const order = new Int32Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  // Int32Array.prototype.sort is numeric, but the comparator is what puts the
  // *indices* in the order of the times they point at.
  return order.sort((a, b) => pts[a] - pts[b])
}

/**
 * The last sample presented at or before `time`, or 0.
 *
 * @param {VideoTrack} track
 * @param {number} time seconds
 * @returns {number} position within `track.order`
 */
function positionAt(track, time) {
  const { order, pts } = track
  let low = 0
  let high = order.length - 1
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (pts[order[mid]] <= time) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/**
 * The sample to start decoding from in order to show `time`.
 *
 * The last sync sample at or before it: an inter-frame codec cannot decode a
 * frame without the ones it refers back to, so a seek is always "rewind to a
 * keyframe, then decode forward".
 *
 * @param {VideoTrack} track
 * @param {number} time seconds
 * @returns {number} sample index
 */
export function keyframeAt(track, time) {
  // Back through *presentation* order to the nearest sync sample. Keyframes
  // are never reordered, so the one found is also the right place to start
  // feeding the decoder in decode order.
  for (let at = positionAt(track, time); at >= 0; at--) {
    const sample = track.order[at]
    if (track.key[sample]) return sample
  }
  return 0
}

/**
 * The sample presented at `time`, or the last one before it.
 * @param {VideoTrack} track
 * @param {number} time seconds
 * @returns {number} sample index
 */
export function sampleAt(track, time) {
  return track.order[positionAt(track, time)]
}
