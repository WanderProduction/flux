/**
 * Exercises the export queue against real footage. No app, no browser.
 *
 *   node scripts/verify-queue.mjs <file> [file...]
 *
 * The queue's job is to be boring, and these are the ways it could fail to be:
 *
 *   - every job reaches a terminal state, and the counts add up to the jobs
 *   - the **log** has a row per job, with the ratio and the frame-count match
 *     on it, because that file is the only evidence the saving was real
 *   - a **second run resumes**: everything already verified is skipped, which
 *     is what makes a nine-hour batch survive being interrupted at hour eight
 *   - **cancel stops it**, promptly, and leaves no finished-looking output
 *
 * Each source is cut twice, so the `_02` suffix is exercised: two cuts of one
 * file are the common case after a razor pass and the most likely thing to
 * collide in a flat output folder.
 *
 * Writes into a temp directory and cleans up after itself.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RenderQueue, LOG_NAME } from '../electron/renderQueue.js'
import { findTools, sourceFacts } from '../electron/render.js'

const SOURCES = process.argv.slice(2)
if (SOURCES.length === 0) {
  console.error('  usage: node scripts/verify-queue.mjs <file> [file...]')
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

const OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-queue-'))

/** Two short cuts per source, named the way batchExport would name them. */
const jobs = []
for (const source of SOURCES) {
  const facts = await sourceFacts(found.ffprobe, source)
  const stem = path.basename(source, path.extname(source))
  const cut = Math.min(2, Math.max(0.5, facts.duration / 8))
  jobs.push({
    id: `${stem}-1`,
    name: path.basename(source),
    source,
    output: path.join(OUT, `${stem}.mp4`),
    offset: 0,
    duration: cut,
    sourceBytes: Math.round(facts.bytes * (cut / facts.duration)),
    wholeFile: false,
  })
  jobs.push({
    id: `${stem}-2`,
    name: path.basename(source),
    source,
    output: path.join(OUT, `${stem}_02.mp4`),
    offset: Math.min(facts.duration - cut - 0.1, cut + 1),
    duration: cut,
    sourceBytes: Math.round(facts.bytes * (cut / facts.duration)),
    wholeFile: false,
  })
}
console.log(`  ${jobs.length} cuts from ${SOURCES.length} sources -> ${OUT}\n`)

try {
  await check('every job finishes, and the counts add up', async () => {
    const events = []
    const queue = new RenderQueue({
      jobs,
      outDir: OUT,
      concurrency: 2,
      onEvent: (event) => events.push(event.type),
    })
    const summary = await queue.run()

    assert.ok(!summary.error, `the queue refused to start: ${summary.error}`)
    assert.equal(summary.failures.length, 0, `failures: ${JSON.stringify(summary.failures)}`)
    assert.equal(summary.counts.done, jobs.length, 'not every job completed')
    assert.equal(summary.counts.waiting, 0, 'something was left waiting')
    assert.equal(summary.counts.running, 0, 'something was left running')
    assert.equal(summary.finished, true)
    assert.ok(events.includes('started') && events.includes('finished'), 'no start/finish events')
    assert.ok(events.includes('progress'), 'no progress was ever reported')

    for (const job of jobs) {
      const stat = await fs.stat(job.output)
      assert.ok(stat.size > 0, `${path.basename(job.output)} is empty`)
    }
    // No partial files anywhere.
    const left = (await fs.readdir(OUT)).filter((name) => name.endsWith('.flux-part'))
    assert.deepEqual(left, [], `partial files left behind: ${left.join(', ')}`)

    assert.ok(summary.ratio > 1, `the output is not smaller than the source (${summary.ratio})`)
    console.log(
      `       ${(summary.sourceBytes / 2 ** 20).toFixed(0)}MB -> ` +
        `${(summary.outputBytes / 2 ** 20).toFixed(1)}MB, ${summary.ratio.toFixed(1)}x smaller, ` +
        `${summary.elapsed.toFixed(1)}s for ${summary.totalSeconds.toFixed(1)}s of footage ` +
        `(${(summary.totalSeconds / summary.elapsed).toFixed(1)}x realtime)`,
    )
  })

  await check('the log has a verifiable row for every job', async () => {
    const text = await fs.readFile(path.join(OUT, LOG_NAME), 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, jobs.length + 1, 'the log does not have one row per job plus a header')

    const header = lines[0].split(',')
    for (const column of ['source', 'output_bytes', 'ratio', 'output_frames', 'expected_frames']) {
      assert.ok(header.includes(column), `the log has no ${column} column`)
    }

    const frames = header.indexOf('output_frames')
    const expected = header.indexOf('expected_frames')
    const ratio = header.indexOf('ratio')

    for (const line of lines.slice(1)) {
      // Paths are quoted and hold commas; a split is enough only because the
      // numeric columns are all after the last quoted field.
      const cells = line.split(',')
      const got = Number(cells[cells.length - header.length + frames])
      const want = Number(cells[cells.length - header.length + expected])
      assert.ok(got > 0, `a row reports no frames: ${line}`)
      assert.ok(
        Math.abs(got - want) <= 2,
        `a row's frame count does not match what was asked for: ${got} vs ${want}`,
      )
      assert.ok(
        Number(cells[cells.length - header.length + ratio]) > 0,
        `a row has no compression ratio: ${line}`,
      )
    }
  })

  await check('a second run skips what already verified', async () => {
    const queue = new RenderQueue({ jobs, outDir: OUT, concurrency: 2, resume: true })
    const summary = await queue.run()
    assert.equal(
      summary.counts.skipped,
      jobs.length,
      'a resumed run re-encoded work that was already done and verified',
    )
    assert.equal(summary.counts.done, 0, 'a resumed run should have nothing left to encode')
  })

  await check('resume off re-encodes everything', async () => {
    const queue = new RenderQueue({ jobs, outDir: OUT, concurrency: 2, resume: false })
    const summary = await queue.run()
    assert.equal(summary.counts.skipped, 0, 'resume was off but work was still skipped')
    assert.equal(summary.counts.done, jobs.length, 'not everything was re-encoded')
  })

  await check('a damaged output is re-encoded rather than skipped', async () => {
    /*
     * The canary for resume. Skipping on existence alone would permanently
     * adopt whatever a killed process left behind, and the archive would have a
     * hole in it that nothing would ever look for again.
     */
    const victim = jobs[0]
    const whole = await fs.readFile(victim.output)
    await fs.writeFile(victim.output, whole.subarray(0, Math.floor(whole.length * 0.3)))

    const queue = new RenderQueue({ jobs, outDir: OUT, concurrency: 2, resume: true })
    const summary = await queue.run()
    assert.equal(summary.counts.done, 1, 'the damaged output was not re-encoded')
    assert.equal(summary.counts.skipped, jobs.length - 1, 'the sound outputs were not skipped')
  })

  await check('cancelling stops the queue and leaves nothing half-written', async () => {
    const fresh = jobs.map((job) => ({
      ...job,
      id: `${job.id}-cancel`,
      output: job.output.replace(/\.mp4$/, '-cancel.mp4'),
      // Long enough that the cancel lands mid-encode.
      duration: Math.max(job.duration, 8),
    }))

    const queue = new RenderQueue({ jobs: fresh, outDir: OUT, concurrency: 1 })
    let cancelled = false
    queue.onEvent = (event) => {
      if (event.type === 'progress' && !cancelled) {
        cancelled = true
        queue.cancel()
      }
    }
    const summary = await queue.run()

    assert.equal(summary.cancelled, true, 'the queue did not report being cancelled')
    assert.ok(summary.counts.done < fresh.length, 'everything finished despite being cancelled')

    for (const job of fresh) {
      await assert.rejects(
        () => fs.access(`${job.output}.flux-part`),
        `${path.basename(job.output)} left a partial file behind`,
      )
    }
    console.log(
      `       stopped after ${summary.counts.done} of ${fresh.length}, ` +
        `${summary.counts.cancelled} never started`,
    )
  })
} finally {
  console.log(`\n${passed} checks passed${failed ? ` (with ${failed} failures)` : ''}`)
  await fs.rm(OUT, { recursive: true, force: true })
  if (failed) process.exitCode = 1
}
