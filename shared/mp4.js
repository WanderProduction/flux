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
 * @property {number} width 0 on an audio track
 * @property {number} height 0 on an audio track
 * @property {number} channels 0 on a video track
 * @property {number} sampleRate 0 on a video track
 * @property {number} timescale ticks per second
 * @property {number} duration seconds
 * @property {number} count number of samples
 * @property {Float64Array} offset byte offset of each sample
 * @property {Uint32Array} bytes size of each sample
 * @property {Float64Array} dts decode time, seconds
 * @property {Float64Array} pts presentation time, seconds
 * @property {Uint8Array} key 1 when the sample is a sync sample
 * @property {Int32Array} order sample indices sorted by presentation time
 * @property {number} rotation degrees clockwise the picture must be turned to
 *   be upright: 0, 90, 180 or 270. Read from the tkhd matrix. The width and
 *   height above stay as *coded* — the shape the decoder hands back — so a
 *   vertical clip is 1920x1080 with a rotation of 90, and anything that needs
 *   the shape on screen asks `displaySize`.
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

/** The first sample entry in an stsd, or null. */
function firstSampleEntry(view, body) {
  // version/flags, entry count, then the entries.
  if (view.getUint32(body + 4) < 1) return null
  return readHeader(view, body + 8)
}

function parseVisualEntry(view, body, end) {
  const first = firstSampleEntry(view, body)
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

  const configEnd = Math.min(first.end, end)
  const avcC = findChild(view, configStart, configEnd, 'avcC')
  if (avcC) {
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

  const hvcC = findChild(view, configStart, configEnd, 'hvcC')
  if (hvcC) {
    const description = new Uint8Array(
      view.buffer.slice(view.byteOffset + hvcC.body, view.byteOffset + hvcC.end),
    )
    return { format, width, height, description, codec: hevcCodec(format, description) }
  }

  return { format, width, height, description: null, codec: null }
}

/**
 * A WebCodecs codec string for HEVC, read out of the hvcC record.
 *
 * Nothing about this is guessable the way `avc1.PPCCLL` is — the three bytes
 * after an avcC's version *are* the profile, compatibility and level, so that
 * string is a transcription. HEVC's is a derivation, and the field that catches
 * people is the compatibility mask: the bitstream stores flag[j] MSB-first, and
 * the codec string wants that same 32-bit word **with its bit order reversed**.
 * Main 10, whose only set flag is flag[2], is `0x20000000` in the file and the
 * single digit `4` in the string.
 *
 * Chromium's `isConfigSupported` was measured not to validate that field at all
 * — it accepts `hvc1.2.20000000.L123.90` as readily as `hvc1.2.4.L123.90` — so
 * getting the reversal wrong would not fail here. It would be worse than that:
 * a string that is wrong and accepted, carried into the index cache and printed
 * in diagnostics, which disagrees with every other tool that reads the same
 * file. The reversal is done because it is the derivation the spec defines, not
 * because this build insists on it.
 *
 * The record (ISO/IEC 14496-15 §8.3.3.1) packs profile space, tier and profile
 * into one byte, then four bytes of compatibility flags, six of constraint
 * flags, then the level:
 *
 *   hvc1.<space><profile>.<compat>.<tier><level>.<constraints>
 *
 * The prefix is the sample entry's own format rather than a literal `hvc1`.
 * `hvc1` and `hev1` differ in whether parameter sets live in the record or in
 * the stream, and a decoder told the wrong one has been handed a different
 * promise about where to find them.
 *
 * Verified against this machine's Chromium, on real camera files, by
 * scripts/verify-footage.mjs: Main, Main 10 and **Rext 4:2:2 10-bit** all
 * configure and decode through the pipeline. That last one is the profile the
 * Fujifilm cameras in this library shoot, and it is the one a reasonable
 * person would assume a browser could not touch.
 *
 * @param {string} format the sample entry type, `hvc1` or `hev1`
 * @param {Uint8Array} d the hvcC payload
 * @returns {string | null}
 */
function hevcCodec(format, d) {
  // configurationVersion, the packed profile byte, 4 compat, 6 constraint, level.
  if (d.length < 13) return null

  const profileSpace = (d[1] >> 6) & 0x3
  const tierFlag = (d[1] >> 5) & 0x1
  const profileIdc = d[1] & 0x1f
  const level = d[12]

  const compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0
  let reversed = 0
  for (let bit = 0; bit < 32; bit++) reversed = ((reversed << 1) | ((compat >>> bit) & 1)) >>> 0

  /*
   * Trailing zero constraint bytes are dropped rather than written out. Both
   * forms are legal and Chromium takes either, but the short one is what every
   * other tool prints, and a codec string that gets compared by eye against
   * ffprobe's is worth keeping identical to it.
   */
  const constraints = []
  for (let i = 6; i <= 11; i++) constraints.push(d[i])
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop()

  return [
    format,
    `${['', 'A', 'B', 'C'][profileSpace]}${profileIdc}`,
    reversed.toString(16),
    `${tierFlag ? 'H' : 'L'}${level}`,
    ...constraints.map((b) => b.toString(16).padStart(2, '0').toUpperCase()),
  ].join('.')
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
 * The display rotation a track carries, in degrees clockwise: 0, 90, 180, 270.
 *
 * Cameras do not rotate pixels. A clip shot with the body turned on its side is
 * coded exactly as the sensor read it — 1920x1080 — and the container carries a
 * 3x3 transform in `tkhd` saying how to put it back up. In this library that is
 * not an edge case: **two in five files are shot vertically**, every one of them
 * coded landscape with `rotation: 90`.
 *
 * Everything that reads a file through an element gets this for free, because
 * Chromium applies the matrix itself — which is exactly why its absence here is
 * easy to miss. `<video>` and the thumbnailer have always drawn these upright,
 * so the pictures looked right while the pipeline that bypasses the element
 * drew the same clips on their side.
 *
 * The matrix is nine 32-bit fixed-point values `{a,b,u, c,d,v, x,y,w}`. Only
 * the first two decide the angle, and the sign convention is the one ffmpeg's
 * `av_display_rotation_get` uses — `-atan2(b, a)` — so a file's rotation here
 * reads the same as `ffprobe`'s, which is the only way to check this against
 * anything.
 *
 * Scale is divided out before the angle is taken. A matrix may carry a flip or
 * a non-unit scale alongside the rotation, and `atan2` on unnormalised values
 * answers for the combination rather than for the angle.
 *
 * Anything that is not a quarter turn comes back as 0. A 37-degree display
 * matrix is legal and nothing in FLUX can honour it; rounding it to a quarter
 * turn would be a worse answer than leaving the picture as it was coded.
 */
function parseRotation(view, body) {
  const version = versionOf(view, body)
  // version/flags, then the times, track id, reserved and duration, then
  // reserved/layer/alternate_group/volume/reserved, then the matrix.
  const matrix = body + 4 + (version === 1 ? 32 : 20) + 16
  if (matrix + 36 > view.byteLength) return 0

  // 16.16 fixed point, signed.
  const a = view.getInt32(matrix) / 65536
  const b = view.getInt32(matrix + 4) / 65536
  const c = view.getInt32(matrix + 12) / 65536
  const d = view.getInt32(matrix + 16) / 65536

  const scaleA = Math.hypot(a, c)
  const scaleB = Math.hypot(b, d)
  if (scaleA === 0 || scaleB === 0) return 0

  const degrees = (-Math.atan2(b / scaleB, a / scaleA) * 180) / Math.PI
  const quarters = Math.round(degrees / 90)
  if (Math.abs(degrees - quarters * 90) > 1) return 0
  return ((quarters % 4) + 4) % 4 * 90
}

/**
 * Reads one descriptor out of an MPEG-4 descriptor chain.
 *
 * The chain inside `esds` is not boxes. Each descriptor is a tag byte then a
 * length written seven bits at a time, high bit set on every byte but the
 * last — so a length of 300 is two bytes and a length of 4 is one, and reading
 * it as a fixed field walks straight into the payload.
 */
function readDescriptor(view, at, end) {
  if (at + 2 > end) return null
  const tag = view.getUint8(at)
  let size = 0
  let cursor = at + 1
  for (let i = 0; i < 4 && cursor < end; i++) {
    const byte = view.getUint8(cursor)
    cursor += 1
    size = (size << 7) | (byte & 0x7f)
    if (!(byte & 0x80)) break
  }
  if (cursor + size > end) return null
  return { tag, body: cursor, end: cursor + size }
}

/**
 * The AudioSpecificConfig buried in an `esds`, which is what AudioDecoder wants
 * as its `description`.
 *
 * ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo, each one
 * inside the last. The optional fields in the middle are the part worth being
 * careful about: an ES_Descriptor may or may not carry a dependency id, a URL
 * and an OCR id, and skipping the wrong number of bytes lands the search for
 * the next descriptor inside this one.
 */
function parseEsds(view, body, end) {
  const es = readDescriptor(view, body + 4, end) // past version/flags
  if (!es || es.tag !== 0x03) return null

  let at = es.body + 2 // ES_ID
  const flags = view.getUint8(at)
  at += 1
  if (flags & 0x80) at += 2 // depends on another stream
  if (flags & 0x40) at += 1 + view.getUint8(at) // carries a URL
  if (flags & 0x20) at += 2 // has its own clock reference

  const config = readDescriptor(view, at, es.end)
  if (!config || config.tag !== 0x04) return null

  const objectType = view.getUint8(config.body)
  // 13 bytes of buffer size and bitrates before the specific info.
  const specific = readDescriptor(view, config.body + 13, config.end)
  if (!specific || specific.tag !== 0x05) return null

  const description = new Uint8Array(
    view.buffer.slice(view.byteOffset + specific.body, view.byteOffset + specific.end),
  )
  return { objectType, description }
}

function parseAudioEntry(view, body, end) {
  const first = firstSampleEntry(view, body)
  if (!first) return null
  /*
   * An audio sample entry is a fixed 28-byte preamble and then child boxes.
   *
   *   8   SampleEntry:      reserved[6], data_reference_index
   *   20  AudioSampleEntry: reserved[8], channelcount, samplesize,
   *                         pre_defined, reserved, samplerate (16.16)
   *
   * The sample rate here is the one to trust for anything under 65,536Hz; the
   * mdhd timescale agrees with it in every file an encoder writes, and this is
   * where the reader that needs a rate expects to find it.
   */
  const format = first.type
  const channels = view.getUint16(first.body + 16)
  const sampleRate = view.getUint16(first.body + 24)

  const esds = findChild(view, first.body + 28, Math.min(first.end, end), 'esds')
  if (!esds) return { format, channels, sampleRate, description: null, codec: null }

  const config = parseEsds(view, esds.body, esds.end)
  if (!config || config.description.length < 1) {
    return { format, channels, sampleRate, description: null, codec: null }
  }

  /*
   * `mp4a.40.2` and friends: object type indication, then the audio object
   * type from the top five bits of the AudioSpecificConfig. Chromium accepts
   * `mp4a.40.2` for plain AAC-LC and wants the real number for HE-AAC, so it
   * is read rather than assumed.
   */
  const audioObjectType = config.description[0] >> 3
  const codec = `mp4a.${config.objectType.toString(16)}.${audioObjectType}`
  return { format, channels, sampleRate, description: config.description, codec }
}

/**
 * The shape a track occupies on screen, after its rotation is applied.
 *
 * Separate from `width`/`height` rather than replacing them, because both
 * numbers are needed and for different things: the decoder must be configured
 * with the *coded* size or it refuses the stream, while every layout decision —
 * the frame a sequence takes from its first clip, how a clip is fitted into the
 * viewer — is about the size on screen. Collapsing the two is how a vertical
 * clip ends up configured as 1080x1920 and decoding nothing.
 *
 * @param {{ width: number, height: number, rotation?: number }} track
 * @returns {{ width: number, height: number }}
 */
export function displaySize(track) {
  const quarter = track.rotation === 90 || track.rotation === 270
  return quarter
    ? { width: track.height, height: track.width }
    : { width: track.width, height: track.height }
}

/**
 * Reads the index for the first video track.
 *
 * @param {ByteReader} reader
 * @returns {Promise<{ ok: true, track: VideoTrack } | { ok: false, reason: string }>}
 */
export async function readVideoTrack(reader) {
  return readTrack(reader, 'vide')
}

/**
 * Reads the index for the first audio track.
 *
 * Same sample table, different sample entry. Everything about where the
 * samples are and when they play is identical — which is the point of doing it
 * here rather than reaching for a second library: an audio track is a video
 * track with a different description box.
 *
 * @param {ByteReader} reader
 * @returns {Promise<{ ok: true, track: AudioTrack } | { ok: false, reason: string }>}
 */
export async function readAudioTrack(reader) {
  return readTrack(reader, 'soun')
}

async function readTrack(reader, handlerWanted) {
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
    if (handler !== handlerWanted) continue

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

    /*
     * A track with no tkhd is malformed, but not in a way worth refusing the
     * file over — the sample table is what playback needs and it is elsewhere.
     * No matrix means no rotation, which is the same answer as an identity one.
     */
    const tkhd = findChild(view, trak.body, trak.end, 'tkhd')
    const rotation = tkhd ? parseRotation(view, tkhd.body) : 0

    const { timescale, duration } = parseMdhd(view, mdhd.body)
    if (!timescale) return { ok: false, reason: 'malformed' }

    const stsdBox = findChild(view, stblBox.body, stblBox.end, 'stsd')
    const sttsBox = findChild(view, stblBox.body, stblBox.end, 'stts')
    const stszBox = findChild(view, stblBox.body, stblBox.end, 'stsz')
    const stscBox = findChild(view, stblBox.body, stblBox.end, 'stsc')
    if (!stsdBox || !sttsBox || !stszBox || !stscBox) return { ok: false, reason: 'malformed' }

    const stsd =
      handlerWanted === 'soun'
        ? parseAudioEntry(view, stsdBox.body, stsdBox.end)
        : parseVisualEntry(view, stsdBox.body, stsdBox.end)
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
        // Both shapes carry both pairs, one of which is zero. A track that
        // reported only its own kind's fields would make every caller ask what
        // kind it was holding before it could read anything off it.
        width: stsd.width ?? 0,
        height: stsd.height ?? 0,
        channels: stsd.channels ?? 0,
        sampleRate: stsd.sampleRate ?? 0,
        timescale,
        duration: duration / timescale,
        count,
        offset: sampleOffsets(view, stscBox, chunkOffsets, sizes, count),
        bytes: sizes,
        dts,
        pts,
        key: parseStss(view, stblBox.body, stblBox.end, count),
        order: presentationOrder(pts, count),
        rotation,
      },
    }
  }

  return { ok: false, reason: handlerWanted === 'soun' ? 'no-audio-track' : 'no-video-track' }
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
