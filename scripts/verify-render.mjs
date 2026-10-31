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
 *   - the archive keeps the **chroma** the source had, the decision reaches the
 *     ffmpeg arguments, and a 4:2:0 output written before that was true still
 *     verifies — otherwise resume re-encodes the whole archive
 *   - an **8-bit** output is still refused, because widening what the format
 *     check accepts is how a format check stops working
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
import { archiveFormat, encodeArgs } from '../shared/renderFormat.js'

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
    /*
     * Not `Main 10` as a constant any more. The archive keeps the chroma the
     * source had, so a 4:2:2 source is written Rext/yuv422p10le and everything
     * else Main 10/yuv420p10le — and this suite is usually pointed at
     * DSCF2308.MOV, which is 4:2:2, so a hardcoded pair failed here first.
     */
    const want = archiveFormat(facts.pixFmt).write
    assert.equal(result.facts.profile, want.profile)
    assert.equal(result.facts.pixFmt, want.pixFmt)

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

  await check('the archive keeps the chroma the source had', async () => {
    /*
     * The policy, and the two ways it can go wrong in opposite directions.
     *
     * Forwards: a 4:2:2 source must not be flattened, and a 4:2:0 source must
     * not be inflated into bytes carrying nothing. `archiveFormat` is asked
     * directly as well as through an encode, because a correct decision that
     * never reaches ffmpeg is the failure this guards — the format has to
     * travel from `sourceFacts` through `cutArgs` into `encodeArgs`.
     *
     * Backwards: the pair has to be read from one place. A 4:2:2 encode reports
     * profile `Rext`, so a verifier holding `Main 10` would reject output it
     * had just correctly written, and every clip would fail after a flawless
     * encode. That is why the assertion below is on the pair.
     */
    assert.deepEqual(
      archiveFormat('yuv422p10le').write,
      { profile: 'Rext', pixFmt: 'yuv422p10le' },
      '4:2:2 in should mean 4:2:2 out',
    )
    assert.deepEqual(
      archiveFormat('yuv420p').write,
      { profile: 'Main 10', pixFmt: 'yuv420p10le' },
      '4:2:0 in should stay 4:2:0 out, at ten bits',
    )
    assert.equal(
      archiveFormat(undefined).encode,
      'p010le',
      'with no source format known — the sequence render — it must stay as it was',
    )
    assert.ok(
      encodeArgs({ sourcePixFmt: 'yuv422p10le' }).includes('p210le'),
      'the decision has to reach the ffmpeg arguments, not just be made',
    )
    assert.ok(
      encodeArgs({}).includes('p010le'),
      'and with nothing passed the arguments must be what they always were',
    )

    /*
     * The outputs already in the archive were written 4:2:0 from these very
     * sources. The verifier is what `alreadyDone` asks on resume, so if it
     * stopped accepting them, opening a project would quietly condemn the whole
     * archive to a re-encode. Upgrading it is a thing to decide and run, not a
     * side effect.
     */
    const legacy = path.join(OUT_DIR, 'legacy-420.mp4')
    const asFourTwoZero = ['-pix_fmt', 'p010le']
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', String(OFFSET), '-t', String(CUT), '-i', SOURCE,
      '-c:v', 'hevc_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '26',
      '-b:v', '0', '-g', '30', ...asFourTwoZero, '-tag:v', 'hvc1', '-an',
      '-f', 'mp4', '-y', legacy,
    ]
    const { spawn } = await import('node:child_process')
    const wrote = await new Promise((resolve) => {
      const child = spawn(found.ffmpeg, args, { windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    assert.ok(wrote, 'could not write a 4:2:0 output to check the old archive against')

    const checked = await verify(
      found.ffprobe,
      { output: legacy, duration: CUT, silent: true, video: true },
      facts,
    )
    assert.ok(
      checked.ok,
      `a 4:2:0 output of this source no longer verifies, so resume would re-encode ` +
        `everything already archived: ${checked.error}`,
    )
    await fs.rm(legacy, { force: true })
    console.log(
      `       ${facts.pixFmt} source -> writes ${archiveFormat(facts.pixFmt).write.pixFmt}, ` +
        `accepts ${archiveFormat(facts.pixFmt).accept.map((o) => o.pixFmt).join(' or ')}`,
    )
  })

  await check('CANARY: an 8-bit output is rejected whatever the source', async () => {
    /*
     * Widening what the verifier accepts is how a format check stops working,
     * and it was widened for the 4:2:2 change. Ten bits is the one thing this
     * archive is not allowed to lose quietly, so it is asserted from the other
     * side: a deliberately 8-bit encode must still be refused.
     */
    const eightBit = path.join(OUT_DIR, 'eight-bit.mp4')
    const { spawn } = await import('node:child_process')
    const wrote = await new Promise((resolve) => {
      const child = spawn(
        found.ffmpeg,
        [
          '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-ss', String(OFFSET), '-t', String(CUT), '-i', SOURCE,
          '-c:v', 'hevc_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '26',
          '-b:v', '0', '-g', '30', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-an',
          '-f', 'mp4', '-y', eightBit,
        ],
        { windowsHide: true },
      )
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    assert.ok(wrote, 'could not write an 8-bit file to be rejected')

    const checked = await verify(
      found.ffprobe,
      { output: eightBit, duration: CUT, silent: true, video: true },
      facts,
    )
    assert.ok(!checked.ok, 'an 8-bit output passed the format check, so it has stopped working')
    assert.match(
      checked.error,
      /pixel format/,
      `it was rejected, but not for its format: ${checked.error}`,
    )
    await fs.rm(eightBit, { force: true })
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
