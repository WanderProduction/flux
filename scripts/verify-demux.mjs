/**
 * Exercises shared/mp4.js against real media files.
 *
 *   node scripts/verify-demux.mjs [mediaDir]
 *
 * No app, no browser: the demuxer reads bytes through a `ByteReader`, so a
 * plain file handle stands in for the ranged fetches it uses in the renderer.
 * That makes the part of the pipeline most likely to be subtly wrong the part
 * that is cheapest to check.
 *
 * And subtly wrong is the risk. A demuxer that misreads an offset does not
 * throw — it hands the decoder bytes from the middle of another frame, and the
 * failure arrives later as visual garbage or a decoder error with no obvious
 * cause. So the checks here are about the index *agreeing with the file*:
 * samples inside its bounds, timestamps that count evenly, keyframes where the
 * encoder was told to put them.
 *
 * It also covers the two modules that let an index be *kept* rather than
 * rebuilt — shared/mp4Index.js and electron/mediaCache.js — which belong here
 * for the same reason: neither imports electron, so both can be run against a
 * real file in a temp directory. The question they have to answer is the one
 * that would otherwise never be asked out loud: is a restored index the same
 * index, in every element of every array?
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { keyframeAt, readAudioTrack, readVideoTrack, sampleAt } from '../shared/mp4.js'
import { bucketCount, decodePeaks, encodePeaks, peakRange, PEAKS_PER_SECOND } from '../shared/peaks.js'
import { BYTES_PER_SAMPLE, decodeTrack, encodeTrack } from '../shared/mp4Index.js'
import {
  entryPath,
  pruneCache,
  hasDerived,
  readDerived,
  sourceToken,
  writeDerived,
} from '../electron/mediaCache.js'

const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')
/** A real camera file, for the one sample layout no fixture here can carry. */
const REAL_PCM = process.argv[3] ?? null

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    process.exitCode = 1
  }
}

/** A ByteReader over a real file, standing in for ranged fetches. */
async function openReader(file) {
  const handle = await fs.open(file, 'r')
  const { size } = await handle.stat()
  return {
    size,
    handle,
    reader: {
      size: async () => size,
      read: async (start, end) => {
        const length = end - start + 1
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
      },
    },
  }
}

async function trackOf(name) {
  const { reader, size, handle } = await openReader(path.join(MEDIA_DIR, name))
  const result = await readVideoTrack(reader)
  return { result, size, handle }
}

async function audioTrackOf(name) {
  const { reader, size, handle } = await openReader(path.join(MEDIA_DIR, name))
  const result = await readAudioTrack(reader)
  return { result, size, handle }
}

/**
 * Peaks with a known shape, for exercising the format without a decoder.
 *
 * Deliberately not real audio: what is being checked is that these exact
 * numbers survive the round trip, and generated values that are always the
 * same are a better witness to that than a decode would be.
 */
function madeUpPeaks(seconds = 3) {
  const count = bucketCount(seconds)
  const min = new Int8Array(count)
  const max = new Int8Array(count)
  for (let i = 0; i < count; i++) {
    // Something asymmetric and non-repeating, so a swapped or duplicated array
    // cannot pass.
    max[i] = (i * 37) % 128
    min[i] = -(((i * 61) % 128) >> 1)
  }
  return {
    perSecond: PEAKS_PER_SECOND,
    count,
    duration: seconds,
    channels: 2,
    sampleRate: 48000,
    min,
    max,
  }
}

/**
 * Every way two tracks differ, as text.
 *
 * A round trip that is checked field by field is only as good as the list of
 * fields, so this walks the arrays element by element and names the first
 * disagreement in each. The canary below proves it is not vacuous — a
 * comparison that silently examines nothing passes every time, which is the
 * most expensive kind of green.
 */
function trackDifferences(a, b) {
  const notes = []
  for (const field of ['codec', 'width', 'height', 'channels', 'sampleRate', 'timescale', 'count']) {
    if (a[field] !== b[field]) notes.push(`${field}: ${a[field]} vs ${b[field]}`)
  }
  if (Math.abs(a.duration - b.duration) > 1e-9) notes.push(`duration: ${a.duration} vs ${b.duration}`)

  for (const field of ['description', 'offset', 'pts', 'dts', 'bytes', 'order', 'key']) {
    const x = a[field]
    const y = b[field]
    if (!x || !y) {
      notes.push(`${field}: missing`)
      continue
    }
    if (x.constructor !== y.constructor) {
      notes.push(`${field}: ${x.constructor.name} vs ${y.constructor.name}`)
    }
    if (x.length !== y.length) {
      notes.push(`${field}: ${x.length} vs ${y.length} entries`)
      continue
    }
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        notes.push(`${field}[${i}]: ${x[i]} vs ${y[i]}`)
        break
      }
    }
  }
  return notes
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-demux-'))

try {
  // ── the long fixture, which is the one with anything to say ───

  const long = await trackOf('long_take.mp4')
  assert.equal(long.result.ok, true, `long_take.mp4 was refused: ${long.result.reason}`)
  const track = long.result.track

  await check('reads the codec, size and duration the encoder was given', () => {
    // ffmpeg was asked for 640x360, 25fps, 60s, H.264 at level 3.0.
    assert.equal(track.codec, 'avc1.64001e')
    assert.equal(track.width, 640)
    assert.equal(track.height, 360)
    assert.ok(Math.abs(track.duration - 60) < 0.05, `duration was ${track.duration}`)
    assert.equal(track.count, 1500, '60 seconds at 25fps')
  })

  await check('the decoder configuration comes back intact', () => {
    // An avcC record: version 1, then profile / compatibility / level, then the
    // NAL length size. VideoDecoder refuses the file outright without it.
    assert.ok(track.description.length > 8, 'no avcC payload')
    assert.equal(track.description[0], 1, 'configurationVersion')
    assert.equal(track.description[1], 0x64, 'High profile')
    assert.equal(track.description[3], 0x1e, 'level 3.0')
    assert.equal(track.description[4] & 3, 3, 'four-byte NAL lengths')
  })

  await check('every sample lies inside the file', () => {
    // The check that catches a misread chunk table, which is the failure that
    // otherwise arrives as garbage frames much later.
    for (let i = 0; i < track.count; i++) {
      assert.ok(track.offset[i] >= 0, `sample ${i} starts at ${track.offset[i]}`)
      assert.ok(
        track.offset[i] + track.bytes[i] <= long.size,
        `sample ${i} runs to ${track.offset[i] + track.bytes[i]} of ${long.size}`,
      )
      assert.ok(track.bytes[i] > 0, `sample ${i} is empty`)
    }
  })

  await check('samples do not overlap each other', () => {
    const order = [...Array(track.count).keys()].sort((a, b) => track.offset[a] - track.offset[b])
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1]
      const here = order[i]
      assert.ok(
        track.offset[prev] + track.bytes[prev] <= track.offset[here],
        `sample ${prev} runs into ${here}`,
      )
    }
  })

  await check('the first frame presented is at zero', () => {
    // B-frames push every composition time forward; an encoder writes an edit
    // list to cancel it. Without that correction every clip is a couple of
    // frames late against its own timeline.
    let earliest = Infinity
    for (let i = 0; i < track.count; i++) earliest = Math.min(earliest, track.pts[i])
    assert.equal(earliest, 0, `the earliest frame is at ${earliest}s`)
  })

  await check('presentation times count evenly through the file', () => {
    const sorted = [...track.pts].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1]
      assert.ok(Math.abs(gap - 0.04) < 1e-6, `frame ${i} is ${gap}s after the one before it`)
    }
  })

  await check('the fixture really does reorder frames', () => {
    // If it did not, the ordering index below would be untested and every
    // lookup would pass by accident. ffmpeg's default settings use B-frames.
    let outOfOrder = 0
    for (let i = 1; i < track.count; i++) if (track.pts[i] < track.pts[i - 1]) outOfOrder++
    assert.ok(
      outOfOrder > 0,
      'no frame is presented before one decoded earlier — the reordering paths are untested',
    )
  })

  await check('keyframes are where the encoder was told to put them', () => {
    let keys = 0
    for (let i = 0; i < track.count; i++) keys += track.key[i]
    // -g 50 at 25fps: one every two seconds.
    assert.equal(keys, 30, `found ${keys} keyframes`)
    assert.equal(track.key[track.order[0]], 1, 'the first frame shown must be a keyframe')
  })

  await check('sampleAt finds the frame covering a moment, not the one before it', () => {
    for (const time of [0, 0.5, 12.34, 37, 59.9]) {
      const index = sampleAt(track, time)
      assert.ok(track.pts[index] <= time + 1e-9, `${time}s picked a frame at ${track.pts[index]}s`)
      // Nothing between the frame picked and the time asked for.
      for (let i = 0; i < track.count; i++) {
        assert.ok(
          !(track.pts[i] <= time + 1e-9 && track.pts[i] > track.pts[index] + 1e-9),
          `${time}s picked ${track.pts[index]}s when ${track.pts[i]}s was closer`,
        )
      }
    }
  })

  await check('keyframeAt lands on a keyframe at or before the moment', () => {
    for (const time of [0, 1, 15.5, 37, 59.99]) {
      const index = keyframeAt(track, time)
      assert.equal(track.key[index], 1, `${time}s started decoding at a non-keyframe`)
      assert.ok(track.pts[index] <= time + 1e-9, `${time}s started after itself`)
      // And it is the *nearest* one, or every seek pays for extra decoding.
      const target = sampleAt(track, time)
      for (let i = 0; i < track.count; i++) {
        assert.ok(
          !(track.key[i] && track.pts[i] > track.pts[index] && track.pts[i] <= track.pts[target]),
          `${time}s could have started at ${track.pts[i]}s instead of ${track.pts[index]}s`,
        )
      }
    }
  })

  await check('a seek never has to decode more than one group of pictures', () => {
    let worst = 0
    for (let time = 0; time < 59; time += 0.37) {
      const from = keyframeAt(track, time)
      const to = sampleAt(track, time)
      worst = Math.max(worst, to - from)
    }
    assert.ok(worst <= 50, `a seek needed ${worst} frames of run-up`)
  })

  await long.handle.close()

  /*
   * An open GOP: sync samples that are not IDR frames.
   *
   * `stss` says "you may begin decoding here", and for H.264 that is a weaker
   * promise than "this is an IDR". An open GOP marks I-frames whose GOP refers
   * back across the boundary, and a decoder that has just been configured will
   * refuse to start on one — which is a black picture from that point in the
   * file onward, and is what a real phone recording did.
   *
   * This is a fixture check rather than a demuxer check. Nothing in the index
   * is wrong: ffprobe reads exactly the same sync samples, because both are
   * reading `stss`. What it guards is the *fixture* — the checks in
   * verify-playback that exercise the recovery are worthless if a future
   * encoder quietly starts emitting IDRs here, and they would still pass.
   */
  await check('open_gop.mp4 has sync samples that are not IDR frames', async () => {
    const { result, handle } = await trackOf('open_gop.mp4')
    assert.equal(result.ok, true, `refused: ${result.reason}`)
    const track = result.track

    /** The NAL types in a sample, read through its 4-byte length prefixes. */
    const nalsOf = async (i) => {
      const buffer = Buffer.alloc(Math.min(track.bytes[i], 4096))
      await handle.read(buffer, 0, buffer.length, track.offset[i])
      const types = []
      let at = 0
      while (at + 4 < buffer.length) {
        const length = buffer.readUInt32BE(at)
        types.push(buffer[at + 4] & 0x1f)
        at += 4 + length
      }
      return types
    }

    const sync = []
    for (let i = 0; i < track.count; i++) if (track.key[i]) sync.push(i)
    assert.ok(sync.length > 2, `only ${sync.length} sync samples to work with`)

    // 5 is an IDR slice, 1 is a non-IDR slice. The first sample of a playable
    // file is always the former; in this fixture the rest are the latter.
    assert.ok((await nalsOf(sync[0])).includes(5), 'the first sample should be an IDR')
    for (const i of sync.slice(1)) {
      const types = await nalsOf(i)
      assert.ok(
        !types.includes(5) && types.includes(1),
        `sample ${i} is marked as a sync sample and is an IDR after all (${types.join(',')}) — ` +
          'the fixture no longer has an open GOP, so the checks that rely on it prove nothing',
      )
    }
    await handle.close()
  })

  // ── the short fixtures ────────────────────────────────────────

  for (const [name, frames] of [
    ['clipA.mp4', 96],
    ['shot_B.mp4', 72],
  ]) {
    await check(`${name} reads as a whole track`, async () => {
      const { result, size, handle } = await trackOf(name)
      assert.equal(result.ok, true, `refused: ${result.reason}`)
      assert.equal(result.track.count, frames)
      const last = result.track.count - 1
      assert.ok(result.track.offset[last] + result.track.bytes[last] <= size)
      await handle.close()
    })
  }

  // ── the index, written down and read back ────────────────────

  const encoded = encodeTrack(track)

  await check('an index survives being written down and read back', () => {
    const restored = decodeTrack(encoded)
    assert.ok(restored, 'the index did not decode at all')
    const differences = trackDifferences(track, restored)
    assert.deepEqual(differences, [], differences.join('; '))
  })

  await check('CANARY: the round trip check would notice one changed value', () => {
    // Without this, "no differences" could just as well mean "nothing was
    // compared", and a comparison that examines nothing passes forever. One
    // value is disturbed in each array, including the two added last.
    for (const [field, at] of [
      ['pts', 700],
      ['dts', 42],
      ['offset', 3],
      ['order', 12],
      ['key', 1],
      ['bytes', 900],
      ['description', 2],
    ]) {
      const restored = decodeTrack(encoded)
      restored[field][at] += 1
      const differences = trackDifferences(track, restored)
      assert.ok(
        differences.some((note) => note.startsWith(`${field}[`)),
        `a changed ${field} went unnoticed: ${differences.join('; ') || 'nothing reported'}`,
      )
    }
  })

  await check('a restored index answers lookups exactly as the original', () => {
    // The check above is about the bytes; this is about what they mean. A
    // restored index that seeks differently is worse than no cache at all.
    const restored = decodeTrack(encoded)
    for (let time = 0; time < 60; time += 0.19) {
      assert.equal(sampleAt(restored, time), sampleAt(track, time), `sampleAt(${time})`)
      assert.equal(keyframeAt(restored, time), keyframeAt(track, time), `keyframeAt(${time})`)
    }
  })

  await check('an index costs the bytes the format says it does', () => {
    // 33 bytes a frame is the number the design rests on: it is why this is
    // not JSON, and why a 256MB budget is hundreds of hours of footage.
    assert.equal(BYTES_PER_SAMPLE, 33)
    const overhead = encoded.length - track.count * BYTES_PER_SAMPLE
    assert.ok(overhead < 128, `${overhead} bytes of overhead for ${track.count} samples`)
  })

  await check('a truncated index is refused rather than half-read', () => {
    // The realistic damage: a write torn by a crash. Half an index believed is
    // a sample table that runs off the end of its own arrays.
    for (const cut of [1, 39, 40, encoded.length - 4, encoded.length - 1]) {
      assert.equal(decodeTrack(encoded.slice(0, cut)), null, `${cut} bytes decoded`)
    }
  })

  await check('an index written by a different format version is refused', () => {
    // The kill switch. When the demuxer changes what it puts in these arrays,
    // every entry written before that has to stop being believed at once.
    const stale = encoded.slice()
    stale[4] += 1
    assert.equal(decodeTrack(stale), null)
  })

  await check('a single flipped byte in an index is caught', () => {
    // Not a torn write — rot. The length is right, the header is right, and
    // one offset now points into the middle of another frame. Which is not a
    // decode error; it is a picture of nothing, hours later, with no cause.
    for (const at of [64, Math.floor(encoded.length / 2), encoded.length - 5]) {
      const rotten = encoded.slice()
      rotten[at] ^= 0x40
      assert.equal(decodeTrack(rotten), null, `a changed byte at ${at} was believed`)
    }
  })

  await check('random bytes are not mistaken for an index', () => {
    const junk = new Uint8Array(encoded.length)
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) % 256
    assert.equal(decodeTrack(junk), null)
    assert.equal(decodeTrack(new Uint8Array(0)), null)
    assert.equal(decodeTrack(null), null)
  })

  // ── the audio track ───────────────────────────────────────────

  await check('the audio track reads as its own whole track', async () => {
    // The same sample table with a different description box, which is the
    // whole reason this lives in the demuxer rather than in a second library.
    const { result, size, handle } = await audioTrackOf('voice_over.mp4')
    assert.equal(result.ok, true, `refused: ${result.reason}`)
    const audio = result.track

    assert.equal(audio.codec, 'mp4a.40.2', 'AAC-LC, read from the AudioSpecificConfig')
    assert.equal(audio.channels, 1)
    assert.equal(audio.sampleRate, 48000)
    assert.ok(Math.abs(audio.duration - 12) < 0.1, `duration was ${audio.duration}`)
    assert.ok(audio.count > 400, `only ${audio.count} audio samples for twelve seconds`)

    for (let i = 0; i < audio.count; i++) {
      assert.ok(audio.bytes[i] > 0, `audio sample ${i} is empty`)
      assert.ok(
        audio.offset[i] + audio.bytes[i] <= size,
        `audio sample ${i} runs past the end of the file`,
      )
    }
    await handle.close()
  })

  await check('the AudioSpecificConfig is the one the decoder needs', async () => {
    // Two bytes that say AAC-LC at 48kHz mono. Reading them from the wrong
    // offset inside the esds descriptor chain gives a decoder that configures
    // and then produces silence, or nothing.
    const { result, handle } = await audioTrackOf('voice_over.mp4')
    const description = result.track.description
    assert.ok(description.length >= 2, 'no AudioSpecificConfig')
    assert.equal(description[0] >> 3, 2, 'audio object type: AAC-LC')
    // Sampling frequency index sits in the next four bits: 3 is 48000.
    assert.equal(((description[0] & 7) << 1) | (description[1] >> 7), 3)
    await handle.close()
  })

  await check('the audio and video tracks of one file do not overlap', async () => {
    // Both are read out of the same stbl machinery, and a handler match that
    // fell through to the wrong trak would give two indexes into one stream —
    // which decodes as garbage rather than failing.
    const video = await trackOf('voice_over.mp4')
    const audio = await audioTrackOf('voice_over.mp4')
    const spans = []
    for (let i = 0; i < video.result.track.count; i++) {
      spans.push([video.result.track.offset[i], video.result.track.bytes[i], 'v'])
    }
    for (let i = 0; i < audio.result.track.count; i++) {
      spans.push([audio.result.track.offset[i], audio.result.track.bytes[i], 'a'])
    }
    spans.sort((a, b) => a[0] - b[0])
    let mixed = 0
    for (let i = 1; i < spans.length; i++) {
      assert.ok(
        spans[i - 1][0] + spans[i - 1][1] <= spans[i][0],
        `a ${spans[i - 1][2]} sample runs into an ${spans[i][2]} one`,
      )
      if (spans[i][2] !== spans[i - 1][2]) mixed += 1
    }
    // And they really are interleaved, or "fetch while contiguous" would never
    // have been wrong and this proves nothing.
    assert.ok(mixed > 10, `the two streams are barely interleaved (${mixed} crossings)`)
    await video.handle.close()
    await audio.handle.close()
  })

  await check('a file with no audio says so rather than guessing', async () => {
    const { result, handle } = await audioTrackOf('clipA.mp4')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-audio-track')
    await handle.close()
  })

  await check('a file with no video says so rather than returning its audio', async () => {
    // The handler match is what keeps these apart; without it the audio trak
    // would satisfy a request for video and the decoder would be handed AAC.
    const { reader, handle } = await openReader(path.join(MEDIA_DIR, 'render.webm'))
    const result = await readAudioTrack(reader)
    assert.equal(result.ok, false)
    await handle.close()
  })

  // ── peaks, written down and read back ─────────────────────────

  const madeUp = madeUpPeaks()
  const packed = encodePeaks(madeUp)

  await check('peaks survive being written down and read back', () => {
    const back = decodePeaks(packed)
    assert.ok(back, 'the peaks did not decode at all')
    for (const field of ['perSecond', 'count', 'channels', 'sampleRate']) {
      assert.equal(back[field], madeUp[field], field)
    }
    assert.ok(Math.abs(back.duration - madeUp.duration) < 1e-9, 'duration')
    assert.deepEqual([...back.min], [...madeUp.min], 'min')
    assert.deepEqual([...back.max], [...madeUp.max], 'max')
  })

  await check('CANARY: the peaks round trip would notice one changed bucket', () => {
    for (const field of ['min', 'max']) {
      const back = decodePeaks(packed)
      back[field][7] += 1
      let noticed = false
      for (let i = 0; i < madeUp.count; i++) {
        if (back[field][i] !== madeUp[field][i]) noticed = true
      }
      assert.ok(noticed, `a changed ${field} bucket went unnoticed`)
    }
  })

  await check('peaks cost two bytes a bucket', () => {
    // The number the whole design rests on: an hour of audio in under 3MB is
    // what makes keeping this beside the media reasonable at all.
    const overhead = packed.length - madeUp.count * 2
    assert.ok(overhead < 64, `${overhead} bytes of overhead for ${madeUp.count} buckets`)
    assert.equal(PEAKS_PER_SECOND, 400, 'one bucket per pixel at the timeline maximum zoom')
  })

  await check('damaged peaks are refused rather than drawn', () => {
    for (const cut of [1, 31, packed.length - 1]) {
      assert.equal(decodePeaks(packed.slice(0, cut)), null, `${cut} bytes decoded`)
    }
    const version = packed.slice()
    version[4] += 1
    assert.equal(decodePeaks(version), null, 'a different format version was believed')

    for (const at of [40, Math.floor(packed.length / 2), packed.length - 3]) {
      const rotten = packed.slice()
      rotten[at] ^= 0x40
      assert.equal(decodePeaks(rotten), null, `a changed byte at ${at} was believed`)
    }

    const junk = new Uint8Array(packed.length)
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) % 256
    assert.equal(decodePeaks(junk), null)
    assert.equal(decodePeaks(null), null)
  })

  await check('a column of waveform reads the loudest thing in its span', () => {
    // What drawing a waveform is, once per pixel. Compared against a plain
    // scan of the same buckets, because the binary-search-free version of this
    // is the only one obviously right.
    const peaks = madeUpPeaks(2)
    for (const [from, to] of [
      [0, 0.01],
      [0.5, 0.75],
      [1.234, 1.235],
      [0, 2],
    ]) {
      const first = Math.floor(from * peaks.perSecond)
      const last = Math.min(peaks.count - 1, Math.max(first, Math.ceil(to * peaks.perSecond) - 1))
      let low = 0
      let high = 0
      for (let i = first; i <= last; i++) {
        low = Math.min(low, peaks.min[i])
        high = Math.max(high, peaks.max[i])
      }
      assert.deepEqual(peakRange(peaks, from, to), [low / 127, high / 127], `${from}..${to}`)
    }
  })

  await check('a span narrower than a bucket still shows the bucket it lands in', () => {
    // Zoomed past the resolution of the peaks, every column would otherwise
    // come back empty and the waveform would vanish exactly when it is being
    // looked at most closely.
    const peaks = madeUpPeaks(1)
    peaks.max[10] = 100
    const [, high] = peakRange(peaks, 10 / peaks.perSecond, 10.001 / peaks.perSecond)
    assert.ok(Math.abs(high - 100 / 127) < 1e-9, `got ${high}`)
  })

  await check('a clip longer than its audio ends flat rather than throwing', () => {
    // Clips and their sound are not always the same length, and a waveform that
    // threw at the end of the sound would take the timeline with it.
    const peaks = madeUpPeaks(1)
    assert.deepEqual(peakRange(peaks, 5, 6), [0, 0])
    assert.deepEqual(peakRange(peaks, -1, -0.5), peakRange(peaks, 0, 1 / peaks.perSecond))
  })

  // ── the cache on disk ─────────────────────────────────────────

  const cacheDir = path.join(tmp, 'media-cache')
  /** What a demuxed video sample table is filed under. See media/indexCache.ts. */
  const INDEX = 'video-index'

  /** A copy of a fixture, because these checks change files to see what happens. */
  async function subject(name) {
    const file = path.join(tmp, name)
    await fs.copyFile(path.join(MEDIA_DIR, 'clipA.mp4'), file)
    return file
  }

  await check('an index written for a file comes back for that file', async () => {
    const file = await subject('kept.mp4')
    const token = await sourceToken(file)
    assert.ok(token, 'no token for a file that exists')

    const written = await writeDerived(cacheDir, file, INDEX, token, encoded)
    assert.equal(written.ok, true, written.reason)

    const back = await readDerived(cacheDir, file, INDEX, token)
    assert.ok(back, 'nothing came back')
    assert.deepEqual([...back], [...encoded], 'the bytes changed on the way through')
  })

  await check('a file with nothing cached for it gets nothing', async () => {
    const file = await subject('never-indexed.mp4')
    assert.equal(await readDerived(cacheDir, file, INDEX, await sourceToken(file)), null)
  })

  await check('an index is refused once the file it describes has changed', async () => {
    // The failure this prevents is silent: an index for bytes that are no
    // longer there feeds the decoder offsets into a file of a different shape.
    const file = await subject('edited.mp4')
    const before = await sourceToken(file)
    await writeDerived(cacheDir, file, INDEX, before, encoded)
    assert.ok(await readDerived(cacheDir, file, INDEX, before), 'setup: nothing to invalidate')

    await fs.appendFile(file, Buffer.alloc(16))
    const after = await sourceToken(file)
    assert.notEqual(after, before, 'the file changed but its identity did not')
    assert.equal(await readDerived(cacheDir, file, INDEX, after), null)
  })

  await check('an index built from bytes that changed underneath it is not stored', async () => {
    // A recording still running, or a copy still going: read at one length and
    // stamped with the length it had reached by the time the entry was
    // written, which would then look current forever.
    const file = await subject('growing.mp4')
    const token = await sourceToken(file)
    await fs.appendFile(file, Buffer.alloc(4096))

    const written = await writeDerived(cacheDir, file, INDEX, token, encoded)
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'stale')
    assert.equal(await readDerived(cacheDir, file, INDEX, await sourceToken(file)), null)
  })

  await check('asking whether an index is there agrees with reading it', async () => {
    /*
     * `hasDerived` is a second implementation of the same validation — it
     * checks the magic, the format, the token, the path and the name, and it
     * does so without reading the payload. Two implementations of one rule is
     * how a cache starts lying: the readiness strip believes `hasDerived`, and
     * a disagreement would colour a clip as banked when the next open rebuilds
     * it from scratch. So the two are asked the same questions here.
     */
    const file = await subject('agreeing.mp4')
    const token = await sourceToken(file)

    // Nothing stored yet.
    assert.equal(await hasDerived(cacheDir, file, INDEX, token), false)
    assert.equal(await readDerived(cacheDir, file, INDEX, token), null)

    // Stored, and under the right identity.
    assert.equal((await writeDerived(cacheDir, file, INDEX, token, encoded)).ok, true)
    assert.equal(await hasDerived(cacheDir, file, INDEX, token), true)
    assert.ok(await readDerived(cacheDir, file, INDEX, token))

    // The wrong token, the wrong name: both must be refused by both.
    assert.equal(await hasDerived(cacheDir, file, INDEX, token + 'x'), false)
    assert.equal(await readDerived(cacheDir, file, INDEX, token + 'x'), null)
    assert.equal(await hasDerived(cacheDir, file, 'not-the-index', token), false)
    assert.equal(await readDerived(cacheDir, file, 'not-the-index', token), null)

    // And once the file underneath has changed.
    await fs.appendFile(file, Buffer.alloc(16))
    const after = await sourceToken(file)
    assert.equal(await hasDerived(cacheDir, file, INDEX, after), false)
    assert.equal(await readDerived(cacheDir, file, INDEX, after), null)
  })

  await check('a half-written entry is not reported as being there', async () => {
    // A crash mid-write leaves a file whose declared payload is longer than
    // what is on disk. `readDerived` rejects it on the length check; so must
    // the cheap question, which never reads the payload at all.
    const file = await subject('truncated.mp4')
    const token = await sourceToken(file)
    assert.equal((await writeDerived(cacheDir, file, INDEX, token, encoded)).ok, true)

    const at = entryPath(cacheDir, file, INDEX)
    const whole = await fs.readFile(at)
    await fs.writeFile(at, whole.subarray(0, whole.length - 8))

    assert.equal(await hasDerived(cacheDir, file, INDEX, token), false)
    assert.equal(await readDerived(cacheDir, file, INDEX, token), null)
  })

  await check('a file that is gone has no identity and stores nothing', async () => {
    const missing = path.join(tmp, 'not-here.mp4')
    assert.equal(await sourceToken(missing), null)
    const written = await writeDerived(cacheDir, missing, INDEX, '1:2', encoded)
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'source-missing')
  })

  await check('a directory is not treated as a file with an index', async () => {
    assert.equal(await sourceToken(tmp), null)
  })

  await check('an empty index is not written at all', async () => {
    const file = await subject('empty-index.mp4')
    const token = await sourceToken(file)
    const written = await writeDerived(cacheDir, file, INDEX, token, new Uint8Array(0))
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'nothing-to-write')
    assert.equal(await readDerived(cacheDir, file, INDEX, token), null)
  })

  await check('a torn cache entry is ignored, not believed', async () => {
    const file = await subject('torn.mp4')
    const token = await sourceToken(file)
    await writeDerived(cacheDir, file, INDEX, token, encoded)

    const entry = entryPath(cacheDir, file, INDEX)
    const raw = await fs.readFile(entry)
    await fs.writeFile(entry, raw.subarray(0, raw.length - 64))
    assert.equal(await readDerived(cacheDir, file, INDEX, token), null)
  })

  await check('a rotted payload is caught by the index, not passed off as one', async () => {
    // The layering, and why there are two checks and not one: the cache says
    // whether an entry is for the right bytes, mp4Index says whether the bytes
    // are intact. Neither alone would notice this.
    const file = await subject('rotted.mp4')
    const token = await sourceToken(file)
    await writeDerived(cacheDir, file, INDEX, token, encoded)

    const entry = entryPath(cacheDir, file, INDEX)
    const raw = await fs.readFile(entry)
    raw[raw.length - 200] ^= 0x08
    await fs.writeFile(entry, raw)

    const back = await readDerived(cacheDir, file, INDEX, token)
    assert.ok(back, 'the envelope should still be intact — otherwise this proves nothing')
    assert.equal(decodeTrack(back), null, 'a rotted index was handed back as good')
  })

  await check('the cache keeps what is used and drops what is not', async () => {
    const pruneDir = path.join(tmp, 'prune-cache')

    /*
     * Deliberately uneven entry sizes.
     *
     * An entry stores its identity token as text — `size:mtimeMs` — so an
     * mtime with a longer decimal part makes a longer entry. A filesystem with
     * nanosecond timestamps produces that spread by itself; Windows hands six
     * files copied in a burst one coarse timestamp and makes them all equal,
     * which is how a budget that assumed equal sizes passed here for months
     * and failed on Linux.
     *
     * Setting the mtimes explicitly means every platform exercises the uneven
     * case, so the assumption cannot quietly come back.
     */
    const second = Math.floor(Date.now() / 1000) - 3600
    const fractions = [0, 0.0761946, 0.1, 0.1234567, 0.5, 0.25]

    const files = []
    for (let i = 0; i < 6; i++) {
      const file = await subject(`prune-${i}.mp4`)
      await fs.utimes(file, second + fractions[i], second + fractions[i])
      const token = await sourceToken(file)
      await writeDerived(pruneDir, file, INDEX, token, encoded)
      files.push({ file, token })
    }

    // Age them all, oldest last, so that "recently written" and "recently
    // used" disagree — otherwise this would pass under either rule.
    const old = Date.now() - 86_400_000
    for (const [i, { file }] of files.entries()) {
      const when = new Date(old + i * 1000)
      await fs.utimes(entryPath(pruneDir, file, INDEX), when, when)
    }

    // Reach for the two oldest, which is what has to save them.
    const kept = [files[0], files[1]]
    for (const { file, token } of kept) {
      assert.ok(await readDerived(pruneDir, file, INDEX, token), 'setup: no entry to use')
      // readIndex touches the entry without waiting for it, so wait for the
      // touch here rather than sleeping and hoping.
      for (let i = 0; i < 100; i++) {
        const stat = await fs.stat(entryPath(pruneDir, file, INDEX))
        if (stat.mtimeMs > old + 60_000) break
        await new Promise((r) => setTimeout(r, 10))
      }
      const stat = await fs.stat(entryPath(pruneDir, file, INDEX))
      assert.ok(stat.mtimeMs > old + 60_000, `${path.basename(file)} was not marked as used`)
    }

    /*
     * A budget of exactly the two entries that have to survive.
     *
     * Not `one entry × 2`, which is what this used to say and which assumes
     * every entry is the same size. They are not. An entry carries its
     * identity token as text — `size:mtimeMs` — and `mtimeMs` is a float whose
     * decimal part is as long as the filesystem's precision makes it. On
     * Windows the six copies land on one coarse timestamp and every entry
     * comes out the same length, so the assumption held locally and on the
     * Windows runner. On Linux, nanosecond timestamps give each copy a
     * different fraction and the entries differ by a few bytes.
     *
     * Then a budget measured from the *first* entry is a few bytes short of
     * holding the first two, the second is dropped to make room, and a smaller
     * day-old entry is kept in its place — still two kept and four removed, so
     * only the final assertion notices. Which is exactly how it failed: once,
     * on Linux, reading `prune-1.mp4 was dropped`.
     *
     * Summing the survivors is also a tighter statement of the rule: with
     * room for precisely those two, anything else kept would be a real fault
     * rather than slack in the budget.
     */
    const sizeOf = async ({ file }) => (await fs.stat(entryPath(pruneDir, file, INDEX))).size
    const budget = (await Promise.all(kept.map(sizeOf))).reduce((a, b) => a + b, 0)

    const result = await pruneCache(pruneDir, budget)
    assert.equal(result.kept, 2, `kept ${result.kept}`)
    assert.equal(result.removed, 4, `removed ${result.removed}`)
    assert.ok(result.bytes <= budget, `held ${result.bytes} bytes against a budget of ${budget}`)

    for (const { file, token } of kept) {
      assert.ok(await readDerived(pruneDir, file, INDEX, token), `${path.basename(file)} was dropped`)
    }
  })

  await check('pruning a cache that does not exist is not an error', async () => {
    assert.deepEqual(await pruneCache(path.join(tmp, 'never-made'), 1024), {
      kept: 0,
      removed: 0,
      bytes: 0,
    })
  })

  // ── uncompressed audio ────────────────────────────────────────

  /**
   * The same conversion kernel/media/audioSource.ts does, which is the point:
   * if the two ever disagree this check is measuring the wrong thing, and the
   * numbers below are chosen so that it would say so — a divisor, sign or
   * byte-order mistake all move the peak or the tone.
   */
  function pcmFloats(bytes, pcm) {
    const { bits, channels, float, bigEndian, signed } = pcm
    const width = bits >> 3
    const stride = width * channels
    const frames = Math.floor(bytes.length / stride)
    const planes = Array.from({ length: channels }, () => new Float32Array(frames))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const little = !bigEndian
    const scale = 1 / 2 ** (bits - 1)
    for (let f = 0; f < frames; f++) {
      const row = f * stride
      for (let c = 0; c < channels; c++) {
        const at = row + c * width
        let v
        if (float) v = bits === 64 ? view.getFloat64(at, little) : view.getFloat32(at, little)
        else if (bits === 8) v = signed ? (view.getInt8(at) + 0.5) / 127.5 : (view.getUint8(at) - 128) / 128
        else if (bits === 16) v = view.getInt16(at, little) * scale
        else if (bits === 24) {
          const a = view.getUint8(at), b = view.getUint8(at + 1), d = view.getUint8(at + 2)
          const raw = little ? a | (b << 8) | (d << 16) : d | (b << 8) | (a << 16)
          v = ((raw << 8) >> 8) * scale
        } else v = view.getInt32(at, little) * scale
        planes[c][f] = v
      }
    }
    return planes
  }

  /** Peak, RMS and the tone's frequency from zero crossings, over ~1s. */
  async function soundOf(name, limitSeconds = 1) {
    const { reader, handle } = await openReader(path.join(MEDIA_DIR, name))
    try {
      const index = await readAudioTrack(reader)
      if (!index.ok) return { ok: false, reason: index.reason }
      const track = index.track
      if (!track.pcm) return { ok: false, reason: 'not-pcm' }

      const blocks = []
      let frames = 0
      for (let i = 0; i < track.count && frames < track.sampleRate * limitSeconds; i++) {
        const bytes = await reader.read(track.offset[i], track.offset[i] + track.bytes[i] - 1)
        const planes = pcmFloats(bytes, track.pcm)
        blocks.push(planes[0])
        frames += planes[0].length
      }
      const all = new Float32Array(frames)
      let at = 0
      for (const b of blocks) {
        all.set(b.subarray(0, Math.min(b.length, frames - at)), at)
        at += b.length
      }
      let peak = 0
      let sum = 0
      for (const v of all) {
        peak = Math.max(peak, Math.abs(v))
        sum += v * v
      }
      let crossings = 0
      for (let i = 1; i < all.length; i++) if (all[i - 1] < 0 !== all[i] < 0) crossings++
      return {
        ok: true,
        track,
        peak,
        rms: Math.sqrt(sum / all.length),
        hz: (crossings / 2) * (track.sampleRate / all.length),
      }
    } finally {
      await handle.close()
    }
  }

  const PCM_FIXTURES = [
    ['pcm_sowt.mov', { bits: 16, float: false, bigEndian: false }],
    ['pcm_twos.mov', { bits: 16, float: false, bigEndian: true }],
    ['pcm_in24.mov', { bits: 24, float: false, bigEndian: false }],
    ['pcm_fl32.mov', { bits: 32, float: true, bigEndian: false }],
  ]

  for (const [name, want] of PCM_FIXTURES) {
    await check(`${name} is read as ${want.bits}-bit ${want.float ? 'float' : 'integer'}`, async () => {
      const got = await soundOf(name)
      assert.equal(got.ok, true, `refused: ${got.reason}`)
      assert.equal(got.track.pcm.bits, want.bits)
      assert.equal(got.track.pcm.float, want.float)
      assert.equal(
        got.track.pcm.bigEndian,
        want.bigEndian,
        'the endianness is wrong — `in24` and `fl32` carry a wave/enda box that overrides their name',
      )
      // The codec string and description are null on purpose: nothing to
      // configure, because the samples are the audio.
      assert.equal(got.track.codec, null)
      assert.equal(got.track.description, null)
    })
  }

  await check('every uncompressed layout decodes to the same tone at the same level', async () => {
    /*
     * The check that makes the four above worth having. One 440Hz tone encoded
     * four ways must come back as one 440Hz tone — so a wrong divisor (quiet),
     * a wrong sign (loud) or a wrong byte order (noise) shows up as whichever
     * layout disagrees with the other three. None of those throws, and none of
     * them looks wrong on a waveform.
     */
    const results = []
    for (const [name] of PCM_FIXTURES) {
      const got = await soundOf(name)
      assert.equal(got.ok, true, `${name} refused: ${got.reason}`)
      results.push({ name, ...got })
    }
    for (const r of results) {
      assert.ok(
        Math.abs(r.hz - 440) < 22,
        `${r.name} decoded a ${r.hz.toFixed(0)}Hz tone, expected 440Hz`,
      )
      assert.ok(r.peak > 0.01, `${r.name} decoded silence`)
      assert.ok(r.peak <= 1.0001, `${r.name} decoded ${r.peak.toFixed(3)}, which is past full scale`)
    }
    const peaks = results.map((r) => r.peak)
    const spread = Math.max(...peaks) - Math.min(...peaks)
    assert.ok(
      spread < 0.02,
      `the four layouts decoded to different levels (${peaks.map((p) => p.toFixed(3)).join(', ')})`,
    )
    console.log(
      `       ${results.map((r) => `${r.name.slice(4, 8)} ${r.peak.toFixed(3)}`).join('  ')} ` +
        `@ ${results[0].hz.toFixed(0)}Hz`,
    )
  })

  await check('an uncompressed track is indexed by packet, not by frame', async () => {
    /*
     * The reason this feature is not simply "accept lpcm". At 48kHz a frame is
     * a sample, so a per-frame index of a seven-second clip is 336,336 entries
     * at 33 bytes each — 11MB for seven seconds, and over a gigabyte for one
     * shoot folder. Packets of 4096 frames make it a few hundred entries.
     */
    const got = await soundOf('pcm_sowt.mov')
    assert.equal(got.ok, true)
    const { track } = got
    const framesTotal = Math.round(track.duration * track.sampleRate)
    assert.ok(
      track.count < framesTotal / 100,
      `${track.count} index entries for ${framesTotal} frames — this is indexed per frame`,
    )
    // Every packet stands alone, which is what makes a seek exact.
    assert.ok([...track.key].every((k) => k === 1), 'a PCM packet was marked as a delta frame')
    // Contiguous and in order: packet n ends where packet n+1 begins, within a
    // chunk, and timestamps count evenly.
    for (let i = 1; i < track.count; i++) {
      assert.ok(track.pts[i] > track.pts[i - 1], 'packet timestamps do not increase')
    }
    const last = track.count - 1
    assert.ok(
      track.pts[last] + track.bytes[last] / (((track.pcm.bits >> 3) * track.channels) * track.sampleRate)
        <= track.duration + 0.05,
      'the packets run past the end of the track',
    )
  })

  await check('a camera lpcm track reads as what the camera recorded', async () => {
    /*
     * The one layout no fixture here can carry. ffmpeg writes `sowt`, `twos`,
     * `in24` and `fl32`; QuickTime and the Fujifilm bodies in this archive
     * write **`lpcm` with a version 2 sample description**, which is a
     * different structure entirely — rate as a float64, channels and depth as
     * their own fields, and an explicit flags word instead of the type name
     * implying the format.
     *
     * Reading a v2 entry with the v0 offsets, which is what FLUX did before
     * this existed, yields 3 channels at 1Hz. It did not crash; it reported
     * `unsupported-codec` and every clip landed on the timeline silent.
     *
     *   node scripts/verify-demux.mjs <mediaDir> <a real .MOV>
     */
    if (!REAL_PCM) {
      console.log('       (no real file given — pass one as the second argument)')
      return
    }
    const { reader, handle } = await openReader(REAL_PCM)
    try {
      const index = await readAudioTrack(reader)
      assert.equal(index.ok, true, `refused: ${index.reason}`)
      const { track } = index
      assert.ok(track.pcm, 'the track was read, but not as uncompressed audio')
      assert.ok(track.channels >= 1 && track.channels <= 8, `${track.channels} channels`)
      assert.ok(
        track.sampleRate >= 8000 && track.sampleRate <= 192000,
        `${track.sampleRate}Hz is not a rate a camera records at — v2 fields read at v0 offsets`,
      )
      assert.ok([8, 16, 24, 32, 64].includes(track.pcm.bits), `${track.pcm.bits} bits`)

      // And it decodes to something that is audio rather than noise. A wrong
      // sign or byte order here reads as near-full-scale on every sample.
      const blocks = []
      let frames = 0
      for (let i = 0; i < track.count && frames < track.sampleRate; i++) {
        const bytes = await reader.read(track.offset[i], track.offset[i] + track.bytes[i] - 1)
        const planes = pcmFloats(bytes, track.pcm)
        blocks.push(planes[0])
        frames += planes[0].length
      }
      let peak = 0
      let loud = 0
      let total = 0
      for (const b of blocks) {
        for (const v of b) {
          const m = Math.abs(v)
          if (m > peak) peak = m
          if (m > 0.9) loud += 1
          total += 1
        }
      }
      assert.ok(peak > 0.0005, `the first second decoded as silence (peak ${peak})`)
      assert.ok(peak <= 1.0001, `decoded past full scale (peak ${peak})`)
      /*
       * Noise is the shape a sign or endianness mistake makes: samples spread
       * across the whole range rather than clustered near zero. Real room
       * audio spends almost none of its time above 0.9.
       */
      assert.ok(
        loud / total < 0.02,
        `${((loud / total) * 100).toFixed(1)}% of samples are near full scale — this is noise, not audio`,
      )
      console.log(
        `       ${path.basename(REAL_PCM)}: ${track.pcm.bits}-bit ` +
          `${track.pcm.bigEndian ? 'BE' : 'LE'} ${track.channels}ch ${track.sampleRate}Hz, ` +
          `${track.count} packets, peak ${peak.toFixed(3)}`,
      )
    } finally {
      await handle.close()
    }
  })

  // ── things it must refuse rather than guess at ────────────────

  await check('a webm is refused, not misread as mp4', async () => {
    const { result, handle } = await trackOf('render.webm')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-moov')
    await handle.close()
  })

  await check('a truncated file is refused, not partly believed', async () => {
    const { result, handle } = await trackOf('corrupt.mp4')
    assert.equal(result.ok, false)
    await handle.close()
  })

  await check('random bytes are refused without throwing', async () => {
    const junk = path.join(tmp, 'junk.mp4')
    const bytes = Buffer.alloc(4096)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 256
    await fs.writeFile(junk, bytes)
    const { reader, handle } = await openReader(junk)
    const result = await readVideoTrack(reader)
    assert.equal(result.ok, false)
    await handle.close()
  })

  await check('an empty file is refused without throwing', async () => {
    const empty = path.join(tmp, 'empty.mp4')
    await fs.writeFile(empty, Buffer.alloc(0))
    const { reader, handle } = await openReader(empty)
    const result = await readVideoTrack(reader)
    assert.equal(result.ok, false)
    await handle.close()
  })

  await check('an mp4 header with nothing behind it is refused', async () => {
    // A box that claims more bytes than the file holds. Stepping by its size
    // would walk off the end, or loop.
    const lying = path.join(tmp, 'lying.mp4')
    const bytes = Buffer.alloc(64)
    bytes.writeUInt32BE(0x7fffffff, 0)
    bytes.write('ftyp', 4)
    await fs.writeFile(lying, bytes)
    const { reader, handle } = await openReader(lying)
    const result = await readVideoTrack(reader)
    assert.equal(result.ok, false)
    await handle.close()
  })
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
