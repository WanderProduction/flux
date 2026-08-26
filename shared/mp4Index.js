/**
 * The sample table, as bytes.
 *
 * shared/mp4.js turns an mp4 into an index — where every frame is, how big it
 * is, when it is shown, whether it is a keyframe. This turns that index into a
 * buffer and back, so it can be kept instead of rebuilt.
 *
 * ## Why a binary format
 *
 * The project document is JSON on purpose (see projectFormat.js): it is the
 * user's work, and it has to be readable by a human and diffable by git. This
 * is the opposite kind of data. It is *derived* — thrown away and rebuilt from
 * the file at no cost but time — and it is six typed arrays with one entry per
 * frame. A twenty-minute clip at 30fps has 36,000 of them. As JSON that is
 * megabytes of decimal digits to write, parse and re-pack into typed arrays;
 * as raw array bytes it is 1.1MB that loads in one read with no parsing at all.
 *
 * ## Everything, or nothing
 *
 * The decoded track has to be indistinguishable from a freshly demuxed one.
 * Not "close enough" — a cached index that drops a field or rounds a timestamp
 * gives a file that plays one way on first open and another way on second, and
 * that is a bug nobody would think to look for here. So the round trip is
 * exact, and scripts/verify-demux.mjs checks every array element for element
 * against the real thing.
 *
 * ## Why there is a checksum
 *
 * Because of what this data is. A wrong byte in `offset` does not fail — it
 * sends the decoder to the middle of another frame, and that surfaces later as
 * garbage or a decoder error with nothing pointing back here. The same
 * hazard the demuxer has, except written to disk, where it survives restarts
 * and gets handed back with confidence every time.
 *
 * The length check below catches the common damage (a write torn by a crash,
 * a truncated file); the checksum catches the rest. It runs a word at a time
 * over the payload, which costs about a third of a millisecond on a
 * 36,000-frame index — small next to the round trips this is here to avoid.
 *
 * ## The version is a kill switch
 *
 * FORMAT covers the layout *and* the meaning of what mp4.js puts in the arrays.
 * If the demuxer starts computing timestamps differently, every cached index
 * from before that change is wrong — not unreadable, wrong, which is worse.
 * Bumping FORMAT rejects all of them in one move, and rebuilding costs
 * milliseconds. Change how mp4.js fills a field, bump this.
 */

/** 'FLXI'. */
const MAGIC = 0x464c5849

/**
 * Layout and meaning. Bump on any change to either.
 *
 *   1 — offset/bytes/dts/pts/key/order, presentation times shifted to zero.
 *   2 — channel count and sample rate, so an audio track's index is as
 *       complete as a video track's.
 */
export const FORMAT = 2

/**
 * Fixed part of the header; the codec string and avcC record follow it.
 *
 *    0  u32  magic
 *    4  u16  format
 *    6  u8   endianness of the arrays below
 *    7  u8   reserved
 *    8  u32  sample count
 *   12  u16  width
 *   14  u16  height
 *   16  u32  timescale
 *   20  u16  codec string length
 *   22  u16  avcC length
 *   24  u32  checksum of everything past this header
 *   28  u16  channel count (0 on a video track)
 *   30  u16  reserved
 *   32  f64  duration, seconds
 *   40  u32  sample rate (0 on a video track)
 *   44  u32  reserved
 */
const HEADER_BYTES = 48

/** 1 on a little-endian machine, which is what the array bytes below are in. */
function nativeEndian() {
  return new Uint8Array(new Uint16Array([1]).buffer)[0]
}

/**
 * The arrays, in the order they are written, with the constructor to read each
 * back. One list so encode and decode cannot disagree about it.
 */
const SECTIONS = [
  ['offset', Float64Array],
  ['pts', Float64Array],
  ['dts', Float64Array],
  ['bytes', Uint32Array],
  ['order', Int32Array],
  ['key', Uint8Array],
]

/** Bytes one sample costs in this format — 33, and the reason it is worth it. */
export const BYTES_PER_SAMPLE = SECTIONS.reduce((n, [, Type]) => n + Type.BYTES_PER_ELEMENT, 0)

/**
 * Total size of an index, padded so the checksummed region is a whole number
 * of words. Encode and decode both compute it, which is what makes the length
 * check exact rather than approximate.
 */
function sizeOf(count, codecLength, descriptionLength) {
  const unpadded = HEADER_BYTES + codecLength + descriptionLength + count * BYTES_PER_SAMPLE
  return unpadded + (-unpadded & 3)
}

/**
 * FNV-1a, a word at a time.
 *
 * Not a cryptographic hash and not trying to be — nothing here is adversarial,
 * the question is only whether these bytes are the bytes that were written.
 * Reading 32 bits at a time is what keeps it off the critical path; byte-wise
 * over a megabyte would cost more than the lookup it is protecting.
 */
function checksum(bytes, from, to) {
  const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to))
  let hash = 0x811c9dc5
  for (let i = 0; i < words.length; i++) {
    hash = Math.imul(hash ^ words[i], 0x01000193)
  }
  return hash >>> 0
}

/**
 * @param {import('./mp4.js').VideoTrack} track
 * @returns {Uint8Array} empty when the track is inconsistent — an array whose
 *   length disagrees with the sample count is not something to write down and
 *   discover later. Callers treat an empty result as "nothing to store".
 */
export function encodeTrack(track) {
  const codec = new TextEncoder().encode(track.codec)
  const description = track.description
  const count = track.count

  const out = new Uint8Array(sizeOf(count, codec.length, description.length))
  const head = new DataView(out.buffer)

  // The header is read with an explicit endianness so a mismatched cache is
  // recognised rather than misread; the arrays after it are native, and the
  // byte below is what makes that safe.
  head.setUint32(0, MAGIC, true)
  head.setUint16(4, FORMAT, true)
  head.setUint8(6, nativeEndian())
  head.setUint8(7, 0)
  head.setUint32(8, count, true)
  head.setUint16(12, track.width, true)
  head.setUint16(14, track.height, true)
  head.setUint32(16, track.timescale, true)
  head.setUint16(20, codec.length, true)
  head.setUint16(22, description.length, true)
  head.setUint16(28, track.channels ?? 0, true)
  head.setFloat64(32, track.duration, true)
  head.setUint32(40, track.sampleRate ?? 0, true)

  let at = HEADER_BYTES
  out.set(codec, at)
  at += codec.length
  out.set(description, at)
  at += description.length

  for (const [name, Type] of SECTIONS) {
    const array = track[name]
    if (array.length !== count) return new Uint8Array(0)
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at)
    at += array.byteLength
  }

  head.setUint32(24, checksum(out, HEADER_BYTES, out.length), true)
  return out
}

/**
 * Reads a buffer written by encodeTrack, or null if it is not one.
 *
 * Null covers every way this can go wrong — a truncated file, a version from
 * before a demuxer change, bytes that were never an index at all. The caller
 * demuxes instead, which is what it would have done anyway. A cache that
 * *throws* on a bad entry turns a stale file into a viewer that shows nothing.
 *
 * Each array is copied out rather than viewed in place. Two reasons, both
 * mattering more than the copy costs: a view keeps the whole buffer alive for
 * as long as the track is held, and a view can only be constructed when its
 * byte offset happens to be aligned to its element size — which depends on how
 * long the codec string is, and would fail on some files and not others.
 *
 * @param {Uint8Array} bytes
 * @returns {import('./mp4.js').VideoTrack | null}
 */
export function decodeTrack(bytes) {
  if (!bytes || bytes.length < HEADER_BYTES) return null
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (head.getUint32(0, true) !== MAGIC) return null
  if (head.getUint16(4, true) !== FORMAT) return null
  if (head.getUint8(6) !== nativeEndian()) return null

  const count = head.getUint32(8, true)
  const codecLength = head.getUint16(20, true)
  const descriptionLength = head.getUint16(22, true)
  if (count === 0 || codecLength === 0 || descriptionLength === 0) return null

  if (bytes.length !== sizeOf(count, codecLength, descriptionLength)) return null
  if (checksum(bytes, HEADER_BYTES, bytes.length) !== head.getUint32(24, true)) return null

  let at = HEADER_BYTES
  const codec = new TextDecoder().decode(bytes.subarray(at, at + codecLength))
  at += codecLength
  const description = bytes.slice(at, at + descriptionLength)
  at += descriptionLength

  const track = {
    codec,
    description,
    width: head.getUint16(12, true),
    height: head.getUint16(14, true),
    channels: head.getUint16(28, true),
    sampleRate: head.getUint32(40, true),
    timescale: head.getUint32(16, true),
    duration: head.getFloat64(32, true),
    count,
  }

  for (const [name, Type] of SECTIONS) {
    const length = count * Type.BYTES_PER_ELEMENT
    track[name] = new Type(bytes.slice(at, at + length).buffer)
    at += length
  }

  return track
}
