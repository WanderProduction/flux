/**
 * Exercises electron/render.js against real footage. No app, no browser.
 *
 *   node scripts/verify-render.mjs <sourceFile> [outDir]
 *
 * This is the harness for the half of the exporter that can be silently wrong.
 * The encode either runs or it does not; what needs checking is everything
 * around it:
 *
 *   - a cut comes out the length and frame count it was asked for
 *   - a **rotated** source comes out upright, and the verifier accepts it
 *     rather than failing it for changing shape
 *   - a corrupted output is **rejected**, which is the canary: a verifier that
 *     passes everything is indistinguishable from no verifier at all
 *   - a cancelled encode leaves no finished-looking file behind
 *   - `alreadyDone` says yes only to an output that actually verifies
 *
 * Writes into a temp directory and cleans up after itself. Reads the source
 * file and never writes near it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  alreadyDone,
  checkEncoder,
  encodeCut,
  findTools,
  sourceFacts,
  verify,
} from '../electron/render.js'

const SOURCE = process.argv[2]
const OUT_DIR =
  process.argv[3] ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'flux-render-')))

if (!SOURCE) {
  console.error('  usage: node scripts/verify-render.mjs <sourceFile> [outDir]')
  process.exit(2)
}

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    failed++
  }
}

const found = await findTools()
if (!found.ok) {
  console.error(`  FAIL ${found.error}`)
  process.exit(1)
}
console.log(`  ${found.version}`)

const encoder = await checkEncoder()
if (!encoder.ok) {
  console.error(`  FAIL ${encoder.error}`)
  process.exit(1)
}

const facts = await sourceFacts(found.ffprobe, SOURCE)
console.log(
  `  ${path.basename(SOURCE)}: ${facts.coded.width}x${facts.coded.height} ` +
    `rot ${facts.rotation} -> displays ${facts.display.width}x${facts.display.height}, ` +
    `${facts.frameRate.toFixed(3)}fps, ${facts.duration.toFixed(2)}s, ` +
    `${(facts.bytes / 2 ** 20).toFixed(0)}MB\n`,
)

/** A cut short enough to encode quickly, but long enough to span keyframes. */
const CUT = Math.min(4, Math.max(1, facts.duration / 4))
const OFFSET = Math.min(2, Math.max(0, facts.duration - CUT - 0.1))

try {
  await check('a cut comes out the length, rate and format it was asked for', async () => {
    const job = {
      source: SOURCE,
      output: path.join(OUT_DIR, 'cut.mp4'),
      offset: OFFSET,
      duration: CUT,
      sourceBytes: facts.bytes,
      wholeFile: false,
    }
    const result = await encodeCut({ job })
    assert.ok(result.ok, `encode failed at ${result.stage}: ${result.error}`)
    assert.equal(result.keptOriginal, false, 'a trim has no original to keep')

    // The assertions the verifier makes, restated here so this fails loudly
    // rather than relying on the thing under test to police itself.
    assert.equal(result.facts.frameRate.toFixed(3), facts.frameRate.toFixed(3), 'rate changed')
    assert.equal(result.facts.width, facts.display.width, 'width is not the displayed width')
    assert.equal(result.facts.height, facts.display.height, 'height is not the displayed height')
    assert.equal(result.facts.profile, 'Main 10')
    assert.equal(result.facts.pixFmt, 'yuv420p10le')

    const wanted = Math.round(CUT * facts.frameRate)
    assert.ok(
      Math.abs(result.facts.frames - wanted) <= 2,
      `${result.facts.frames} frames, expected about ${wanted}`,
    )
    console.log(
      `       ${(result.sourceBytes / 2 ** 20).toFixed(0)}MB source -> ` +
        `${(result.bytes / 2 ** 20).toFixed(1)}MB for ${CUT.toFixed(1)}s ` +
        `(${((result.bytes * 8) / CUT / 1e6).toFixed(1)} Mbps), ` +
        `${result.facts.frames} frames @ ${result.facts.frameRate.toFixed(3)}fps`,
    )
  })

  await check('a rotated source comes out upright rather than failing verification', async () => {
    if (facts.rotation === 0) {
      console.log('       (source is not rotated — nothing to check here)')
      return
    }
    const probe = await sourceFacts(found.ffprobe, path.join(OUT_DIR, 'cut.mp4'))
    assert.equal(probe.rotation, 0, 'the output still carries a rotation flag')
    assert.equal(
      probe.coded.width,
      facts.display.width,
      'the output is not coded at the displayed width — rotation was not baked in',
    )
    assert.ok(
      probe.coded.height > probe.coded.width,
      'a 90-degree source should produce a taller-than-wide output',
    )
    console.log(
      `       coded ${facts.coded.width}x${facts.coded.height} + rot ${facts.rotation} ` +
        `became ${probe.coded.width}x${probe.coded.height} + rot 0`,
    )
  })

  await check('CANARY: a damaged output is rejected, not passed', async () => {
    /*
     * Without this the suite proves nothing. A verifier that accepts anything
     * passes every check above, and the one failure it exists to catch — an
     * output that looks healthy and is not — would sail through.
     *
     * The damage is a truncation, which is the realistic one: it is what a
     * killed process, a full disk or a torn write leaves behind, and it keeps a
     * valid header so a naive check still sees a playable file.
     */
    const whole = await fs.readFile(path.join(OUT_DIR, 'cut.mp4'))
    const truncated = path.join(OUT_DIR, 'truncated.mp4')
    await fs.writeFile(truncated, whole.subarray(0, Math.floor(whole.length * 0.4)))

    const checked = await verify(
      found.ffprobe,
      { source: SOURCE, output: truncated, offset: OFFSET, duration: CUT },
      facts,
    )
    assert.equal(checked.ok, false, 'a truncated output was accepted as verified')
    console.log(`       rejected: ${checked.error}`)
  })

  await check('CANARY: a frame-rate conform is rejected', async () => {
    /*
     * The exact failure from the test run that produced renderFormat.js: an
     * export that silently resampled 50fps to 29.97 and looked perfectly
     * healthy. Reproduced here on purpose, because it is the one error this
     * entire verification step was built for.
     */
    if (Math.abs(facts.frameRate - 29.97) < 0.1) {
      console.log('       (source is already ~29.97fps — nothing to conform to)')
      return
    }
    const conformed = path.join(OUT_DIR, 'conformed.mp4')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(
      found.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(OFFSET), '-i', SOURCE, '-t', String(CUT),
        '-r', '30000/1001',
        '-c:v', 'hevc_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '26', '-b:v', '0',
        '-pix_fmt', 'p010le', '-tag:v', 'hvc1', '-an', '-y', conformed,
      ],
      { maxBuffer: 8 << 20 },
    )
    const checked = await verify(
      found.ffprobe,
      { source: SOURCE, output: conformed, offset: OFFSET, duration: CUT },
      facts,
    )
    assert.equal(checked.ok, false, 'a rate-conformed output was accepted as verified')
    assert.match(checked.error, /frame rate|frames/, `rejected for the wrong reason: ${checked.error}`)
    console.log(`       rejected: ${checked.error}`)
  })

  await check('alreadyDone says yes to a verified output and no to a damaged one', async () => {
    const good = {
      source: SOURCE,
      output: path.join(OUT_DIR, 'cut.mp4'),
      offset: OFFSET,
      duration: CUT,
    }
    assert.equal(await alreadyDone(good), true, 'a verified output should be skippable')

    const bad = { ...good, output: path.join(OUT_DIR, 'truncated.mp4') }
    assert.equal(await alreadyDone(bad), false, 'a truncated output must not be skipped')

    const missing = { ...good, output: path.join(OUT_DIR, 'never-written.mp4') }
    assert.equal(await alreadyDone(missing), false, 'a missing output must not be skipped')
  })

  await check('a cancelled encode leaves nothing that looks finished', async () => {
    const controller = new AbortController()
    const job = {
      source: SOURCE,
      output: path.join(OUT_DIR, 'cancelled.mp4'),
      offset: 0,
      duration: Math.max(facts.duration, 10),
      sourceBytes: facts.bytes,
      wholeFile: false,
    }
    // Aborted as soon as ffmpeg reports any progress, so the kill lands
    // mid-encode rather than before the process has started.
    const running = encodeCut({
      job,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    // A very short source may finish before the first stats line.
    setTimeout(() => controller.abort(), 1500)
    const result = await running

    assert.equal(result.ok, false, 'a cancelled encode reported success')
    assert.equal(result.cancelled, true, `cancelled encode reported ${result.stage}`)
    await assert.rejects(
      () => fs.access(job.output),
      'a cancelled encode left a file at the final path',
    )
    await assert.rejects(
      () => fs.access(`${job.output}.flux-part`),
      'a cancelled encode left its partial file behind',
    )
  })
} finally {
  console.log(`\n${passed} checks passed${failed ? ` (with ${failed} failures)` : ''}`)
  if (!process.argv[3]) await fs.rm(OUT_DIR, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
