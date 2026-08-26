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
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { keyframeAt, readVideoTrack, sampleAt } from '../shared/mp4.js'

const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')

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
