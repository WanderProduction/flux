/**
 * Audio peaks: the shape of a waveform, without the audio.
 *
 * Drawing a waveform means knowing, for every few pixels of timeline, how loud
 * the audio got in that span. Answering that from the file would mean decoding
 * the whole track every time the timeline redraws, so it is decoded once and
 * reduced to a pair of numbers per bucket — the lowest and highest sample in
 * it. This is what Premiere's `.pek` files are, and what its "conforming"
 * progress bar is producing.
 *
 * ## The resolution is the display's, not the audio's
 *
 * PEAKS_PER_SECOND is set so that at the timeline's maximum zoom one bucket is
 * one pixel. Past that there would be nothing to see; short of it, pixels
 * combine buckets, which is exactly what drawing a waveform is. Zooming in
 * further than the peaks go would show a straight line between real samples —
 * so if the timeline's MAX_ZOOM ever rises above this, raise this with it.
 *
 * ## Why one byte per number is enough
 *
 * The limit is what the screen can show, not what the audio contains. A signed
 * byte resolves 1/127 of full scale; on a waveform drawn twenty pixels tall
 * that is a sixth of a pixel. Two bytes a bucket puts an hour of audio in under
 * 3MB, which is what makes keeping it beside the media reasonable.
 *
 * Peaks are stored *merged across channels* — the loudest of them, in each
 * direction. One waveform per clip is what the timeline draws; per-channel
 * lanes are a display FLUX does not have, and storing for it would double
 * every file for nothing.
 */

/** 'FLXP'. */
const MAGIC = 0x464c5850

/**
 * Layout and meaning. Bump on any change to either — including a change to
 * PEAKS_PER_SECOND, which changes what every stored bucket means.
 *
 *   1 — merged min/max per bucket, one signed byte each.
 */
export const FORMAT = 1

/**
 * Buckets per second of audio.
 *
 * Tied to the timeline's maximum zoom (400 pixels per second): one bucket per
 * pixel there, and fewer than one per pixel everywhere else.
 */
export const PEAKS_PER_SECOND = 400

const HEADER_BYTES = 32

/** How many buckets a given length of audio needs. */
export function bucketCount(duration, perSecond = PEAKS_PER_SECOND) {
  return Math.max(1, Math.ceil(duration * perSecond))
}

function sizeOf(count) {
  const unpadded = HEADER_BYTES + count * 2
  return unpadded + (-unpadded & 3)
}

/** Same word-at-a-time FNV-1a as the index; see shared/mp4Index.js. */
function checksum(bytes, from, to) {
  const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset + from, bytes.byteOffset + to))
  let hash = 0x811c9dc5
  for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 0x01000193)
  return hash >>> 0
}

/**
 * @typedef {object} Peaks
 * @property {number} perSecond buckets per second
 * @property {number} count
 * @property {number} duration seconds of audio these cover
 * @property {number} channels how many the source had, before merging
 * @property {number} sampleRate
 * @property {Int8Array} min lowest sample in each bucket, -127..127
 * @property {Int8Array} max highest sample in each bucket
 */

/**
 * @param {Peaks} peaks
 * @returns {Uint8Array} empty when the arrays disagree with the count, which is
 *   not something to write down and discover later.
 */
export function encodePeaks(peaks) {
  const count = peaks.count
  if (peaks.min.length !== count || peaks.max.length !== count) return new Uint8Array(0)

  const out = new Uint8Array(sizeOf(count))
  const head = new DataView(out.buffer)
  head.setUint32(0, MAGIC, true)
  head.setUint16(4, FORMAT, true)
  head.setUint16(6, peaks.channels, true)
  head.setUint32(8, count, true)
  head.setUint16(12, peaks.perSecond, true)
  head.setUint32(16, 0, true) // checksum, filled in below
  head.setUint32(20, peaks.sampleRate, true)
  head.setFloat64(24, peaks.duration, true)

  out.set(new Uint8Array(peaks.min.buffer, peaks.min.byteOffset, count), HEADER_BYTES)
  out.set(new Uint8Array(peaks.max.buffer, peaks.max.byteOffset, count), HEADER_BYTES + count)

  head.setUint32(16, checksum(out, HEADER_BYTES, out.length), true)
  return out
}

/**
 * Reads a buffer written by encodePeaks, or null if it is not one.
 *
 * Null for every failure, the same as the index: a truncated entry, a
 * resolution from before FORMAT changed, bytes that were never peaks. The
 * caller draws no waveform and asks for one to be built, which is what it would
 * have done anyway.
 *
 * @param {Uint8Array} bytes
 * @returns {Peaks | null}
 */
export function decodePeaks(bytes) {
  if (!bytes || bytes.length < HEADER_BYTES) return null
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (head.getUint32(0, true) !== MAGIC) return null
  if (head.getUint16(4, true) !== FORMAT) return null

  const count = head.getUint32(8, true)
  const perSecond = head.getUint16(12, true)
  if (count === 0 || perSecond === 0) return null
  if (bytes.length !== sizeOf(count)) return null
  if (checksum(bytes, HEADER_BYTES, bytes.length) !== head.getUint32(16, true)) return null

  return {
    perSecond,
    count,
    channels: head.getUint16(6, true),
    sampleRate: head.getUint32(20, true),
    duration: head.getFloat64(24, true),
    // Copied out rather than viewed in place, for the same two reasons as the
    // index: a view keeps the whole buffer alive, and its alignment would
    // depend on how long the header happened to be.
    min: new Int8Array(bytes.slice(HEADER_BYTES, HEADER_BYTES + count).buffer),
    max: new Int8Array(bytes.slice(HEADER_BYTES + count, HEADER_BYTES + count * 2).buffer),
  }
}

/**
 * The loudest excursion between two moments, as `[min, max]` in -1..1.
 *
 * One call per pixel column is what drawing a waveform is. Both ends are
 * clamped into the peaks, and a span that falls entirely outside them comes
 * back flat rather than undefined — a clip can be longer than its audio, and a
 * waveform that throws at the end of the sound is worse than one that stops.
 *
 * @param {Peaks} peaks
 * @param {number} from seconds
 * @param {number} to seconds
 * @returns {[number, number]}
 */
export function peakRange(peaks, from, to) {
  const first = Math.max(0, Math.floor(from * peaks.perSecond))
  // At least one bucket: a column narrower than a bucket still has to show the
  // bucket it lands in, or a zoomed-in waveform is empty.
  const last = Math.min(peaks.count - 1, Math.max(first, Math.ceil(to * peaks.perSecond) - 1))
  if (first > peaks.count - 1) return [0, 0]

  let low = 0
  let high = 0
  for (let i = first; i <= last; i++) {
    if (peaks.min[i] < low) low = peaks.min[i]
    if (peaks.max[i] > high) high = peaks.max[i]
  }
  return [low / 127, high / 127]
}
