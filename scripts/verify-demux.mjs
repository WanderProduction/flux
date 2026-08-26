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

import { keyframeAt, readVideoTrack, sampleAt } from '../shared/mp4.js'
import { BYTES_PER_SAMPLE, decodeTrack, encodeTrack } from '../shared/mp4Index.js'
import {
  entryPath,
  pruneCache,
  readIndex,
  sourceToken,
  writeIndex,
} from '../electron/mediaCache.js'

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
  for (const field of ['codec', 'width', 'height', 'timescale', 'count']) {
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

  // ── the cache on disk ─────────────────────────────────────────

  const cacheDir = path.join(tmp, 'media-cache')

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

    const written = await writeIndex(cacheDir, file, token, encoded)
    assert.equal(written.ok, true, written.reason)

    const back = await readIndex(cacheDir, file, token)
    assert.ok(back, 'nothing came back')
    assert.deepEqual([...back], [...encoded], 'the bytes changed on the way through')
  })

  await check('a file with nothing cached for it gets nothing', async () => {
    const file = await subject('never-indexed.mp4')
    assert.equal(await readIndex(cacheDir, file, await sourceToken(file)), null)
  })

  await check('an index is refused once the file it describes has changed', async () => {
    // The failure this prevents is silent: an index for bytes that are no
    // longer there feeds the decoder offsets into a file of a different shape.
    const file = await subject('edited.mp4')
    const before = await sourceToken(file)
    await writeIndex(cacheDir, file, before, encoded)
    assert.ok(await readIndex(cacheDir, file, before), 'setup: nothing to invalidate')

    await fs.appendFile(file, Buffer.alloc(16))
    const after = await sourceToken(file)
    assert.notEqual(after, before, 'the file changed but its identity did not')
    assert.equal(await readIndex(cacheDir, file, after), null)
  })

  await check('an index built from bytes that changed underneath it is not stored', async () => {
    // A recording still running, or a copy still going: read at one length and
    // stamped with the length it had reached by the time the entry was
    // written, which would then look current forever.
    const file = await subject('growing.mp4')
    const token = await sourceToken(file)
    await fs.appendFile(file, Buffer.alloc(4096))

    const written = await writeIndex(cacheDir, file, token, encoded)
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'stale')
    assert.equal(await readIndex(cacheDir, file, await sourceToken(file)), null)
  })

  await check('a file that is gone has no identity and stores nothing', async () => {
    const missing = path.join(tmp, 'not-here.mp4')
    assert.equal(await sourceToken(missing), null)
    const written = await writeIndex(cacheDir, missing, '1:2', encoded)
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'source-missing')
  })

  await check('a directory is not treated as a file with an index', async () => {
    assert.equal(await sourceToken(tmp), null)
  })

  await check('an empty index is not written at all', async () => {
    const file = await subject('empty-index.mp4')
    const token = await sourceToken(file)
    const written = await writeIndex(cacheDir, file, token, new Uint8Array(0))
    assert.equal(written.ok, false)
    assert.equal(written.reason, 'nothing-to-write')
    assert.equal(await readIndex(cacheDir, file, token), null)
  })

  await check('a torn cache entry is ignored, not believed', async () => {
    const file = await subject('torn.mp4')
    const token = await sourceToken(file)
    await writeIndex(cacheDir, file, token, encoded)

    const entry = entryPath(cacheDir, file)
    const raw = await fs.readFile(entry)
    await fs.writeFile(entry, raw.subarray(0, raw.length - 64))
    assert.equal(await readIndex(cacheDir, file, token), null)
  })

  await check('a rotted payload is caught by the index, not passed off as one', async () => {
    // The layering, and why there are two checks and not one: the cache says
    // whether an entry is for the right bytes, mp4Index says whether the bytes
    // are intact. Neither alone would notice this.
    const file = await subject('rotted.mp4')
    const token = await sourceToken(file)
    await writeIndex(cacheDir, file, token, encoded)

    const entry = entryPath(cacheDir, file)
    const raw = await fs.readFile(entry)
    raw[raw.length - 200] ^= 0x08
    await fs.writeFile(entry, raw)

    const back = await readIndex(cacheDir, file, token)
    assert.ok(back, 'the envelope should still be intact — otherwise this proves nothing')
    assert.equal(decodeTrack(back), null, 'a rotted index was handed back as good')
  })

  await check('the cache keeps what is used and drops what is not', async () => {
    const pruneDir = path.join(tmp, 'prune-cache')
    const files = []
    for (let i = 0; i < 6; i++) {
      const file = await subject(`prune-${i}.mp4`)
      const token = await sourceToken(file)
      await writeIndex(pruneDir, file, token, encoded)
      files.push({ file, token })
    }

    // Age them all, oldest last, so that "recently written" and "recently
    // used" disagree — otherwise this would pass under either rule.
    const old = Date.now() - 86_400_000
    for (const [i, { file }] of files.entries()) {
      const when = new Date(old + i * 1000)
      await fs.utimes(entryPath(pruneDir, file), when, when)
    }

    // Reach for the two oldest, which is what has to save them.
    const kept = [files[0], files[1]]
    for (const { file, token } of kept) {
      assert.ok(await readIndex(pruneDir, file, token), 'setup: no entry to use')
      // readIndex touches the entry without waiting for it, so wait for the
      // touch here rather than sleeping and hoping.
      for (let i = 0; i < 100; i++) {
        const stat = await fs.stat(entryPath(pruneDir, file))
        if (stat.mtimeMs > old + 60_000) break
        await new Promise((r) => setTimeout(r, 10))
      }
      const stat = await fs.stat(entryPath(pruneDir, file))
      assert.ok(stat.mtimeMs > old + 60_000, `${path.basename(file)} was not marked as used`)
    }

    const entrySize = (await fs.stat(entryPath(pruneDir, files[0].file))).size
    const result = await pruneCache(pruneDir, entrySize * 2 + 1)
    assert.equal(result.kept, 2, `kept ${result.kept}`)
    assert.equal(result.removed, 4, `removed ${result.removed}`)
    assert.ok(result.bytes <= entrySize * 2 + 1, `held ${result.bytes} bytes`)

    for (const { file, token } of kept) {
      assert.ok(await readIndex(pruneDir, file, token), `${path.basename(file)} was dropped`)
    }
  })

  await check('pruning a cache that does not exist is not an error', async () => {
    assert.deepEqual(await pruneCache(path.join(tmp, 'never-made'), 1024), {
      kept: 0,
      removed: 0,
      bytes: 0,
    })
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
