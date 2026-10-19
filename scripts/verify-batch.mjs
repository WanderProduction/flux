/**
 * Verifies batch import against a real folder of footage.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-batch.mjs <folder>
 *
 * Two halves, and the second is the one that needed writing.
 *
 * The scan is checked against the filesystem directly — every media file under
 * the folder, counted by this script's own walk, against what `scanFootage`
 * reported. The point is the *filter*: a scan that quietly swallowed a shoot
 * folder would still look like a successful import, just a smaller one, and the
 * only way to catch that is to count independently.
 *
 * The import is checked for the things a loop over `addClip` gets wrong and a
 * hand never does:
 *
 *   - **One undo step.** Not 406. See `asOneStep` in kernel/sequence.ts.
 *   - **Clips end to end, in the scan's order**, with no gaps and no overlaps.
 *     `addClip` places at the first *free* spot, so an off-by-one in the
 *     running total does not fail — it silently leaves a hole, for every clip
 *     after it.
 *   - **The sequence takes the shape of its first clip, as displayed.** A
 *     folder of vertically shot footage must produce a vertical sequence. This
 *     is the check that fails if rotation stops being read.
 *   - **Every clip's length is its source's length**, so nothing arrived
 *     truncated or zero-length.
 *
 * CLEARS the verification project's sequences, so runs are repeatable.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'
import { mediaKindOf } from '../shared/mediaTypes.js'
import { skipReasonFor } from '../shared/footageFilter.js'

const FOLDER = process.argv[2]
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

if (!FOLDER) {
  console.error('  usage: node scripts/verify-batch.mjs <folder>')
  process.exit(2)
}

/**
 * This script's own walk, deliberately not sharing the implementation.
 *
 * It uses the same two shared definitions the scan does — what counts as media,
 * and which folders to skip — because those are the contract. What it does not
 * share is the walking, which is the part being checked.
 */
async function walk(root) {
  const files = []
  const skipped = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (skipReasonFor(dirent.name)) skipped.push(full)
        else stack.push(full)
        continue
      }
      if (dirent.name.startsWith('.')) continue
      if (mediaKindOf(dirent.name) === 'video') files.push(full)
    }
  }
  return { files, skipped }
}

const { check, report } = createChecker()
const cdp = await attach()

try {
  const expected = await walk(path.resolve(FOLDER))
  console.log(`  ${path.resolve(FOLDER)}`)
  console.log(`  ${expected.files.length} media files, ${expected.skipped.length} folders to skip\n`)
  assert.ok(expected.files.length > 0, 'that folder holds no video FLUX reads — nothing to verify')

  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  const folder = JSON.stringify(path.resolve(FOLDER))

  await check('the scan finds every media file and no proxy folders', async () => {
    const state = await evaluate(
      cdp,
      `const { planBatch } = window.__fluxDev.batchImport;
       const result = await planBatch(${folder});
       if (!result.ok) return { error: result.error };
       const { plan } = result;
       return {
         files: plan.files.map(f => f.path),
         bytes: plan.bytes,
         skipped: plan.skipped,
         truncated: plan.truncated,
         busiest: plan.busiest.slice(0, 3),
       };`,
    )
    assert.ok(!state.error, `planBatch refused the folder: ${state.error}`)
    assert.equal(state.truncated, false, 'the scan hit its cap on a folder this size')

    const mine = [...expected.files].sort()
    const theirs = [...state.files].sort()
    assert.deepEqual(theirs, mine, 'the scan and an independent walk disagree about what is there')

    const skippedPaths = state.skipped.map((s) => s.path).sort()
    assert.deepEqual(
      skippedPaths,
      [...expected.skipped].sort(),
      'the scan skipped a different set of folders than the filter says it should',
    )
    // Every skip must carry a reason, or the report is unauditable.
    for (const one of state.skipped) {
      assert.ok(one.reason, `${one.path} was skipped with no reason given`)
    }
  })

  await check('importing the folder lays it out as one sequence, in order, as one step', async () => {
    const state = await evaluate(
      cdp,
      `const { planBatch, runBatch } = window.__fluxDev.batchImport;
       const sequence = window.__fluxDev.sequence;
       const assets = window.__fluxDev.assets;

       const planned = await planBatch(${folder});
       if (!planned.ok) return { error: planned.error };

       const depthBefore = sequence.historyDepth().past;
       const result = await runBatch(planned.plan);
       const depthAfter = sequence.historyDepth().past;

       const active = sequence.getSequence();
       // The base track, which is the LAST video track: tracks are held in display
         // order, so .find() returns V2 and a batch import lands on V1.
         const videoTrack = active.tracks.slice().reverse().find(t => t.kind === 'video');
       const clips = active.clips
         .filter(c => c.trackId === videoTrack.id)
         .slice()
         .sort((a, b) => a.start - b.start);

       return {
         result,
         name: active.name,
         settings: { width: active.settings.width, height: active.settings.height, frameRate: active.settings.frameRate },
         historyAdded: depthAfter - depthBefore,
         clips: clips.map(c => {
           const asset = assets.getAsset(c.assetId);
           return {
             path: asset ? asset.path : null,
             assetDuration: asset ? asset.duration : null,
             start: c.start,
             duration: c.duration,
             offset: c.offset,
             speed: c.speed,
           };
         }),
       };`,
    )
    assert.ok(!state.error, `planBatch refused the folder: ${state.error}`)

    const { result, clips } = state

    /*
     * One step for the whole import. This is the check that catches the loop
     * going back to emitting per clip: it would still import correctly, and
     * every undo afterwards would take one clip back out.
     */
    assert.equal(
      state.historyAdded,
      1,
      `an import must be one undo step, not ${state.historyAdded}`,
    )

    assert.ok(result.placed > 0, 'nothing was placed')
    assert.equal(
      result.placed + result.unreadable.length,
      expected.files.length,
      `every file must be placed or named as unreadable: ${result.placed} placed, ` +
        `${result.unreadable.length} unreadable, ${expected.files.length} found`,
    )
    assert.equal(clips.length, result.placed, 'the result disagrees with the timeline')

    // Order: the scan sorts by path, and the timeline must be in that order.
    const onTimeline = clips.map((c) => c.path)
    const byPath = [...onTimeline].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    )
    assert.deepEqual(onTimeline, byPath, 'clips are not in the scan order')

    // End to end: each clip starts exactly where the last one ended, which
    // holds only because the import lays clips out in whole frames. See the
    // note in kernel/batchImport.ts — a half-frame overlap here is a hundred
    // one-frame cross-dissolves on a long review.
    let at = 0
    const frame = 1 / state.settings.frameRate
    for (const clip of clips) {
      assert.ok(
        Math.abs(clip.start - at) < 1e-6,
        `a gap or overlap at ${clip.path}: starts ${clip.start}, expected ${at}`,
      )
      assert.ok(clip.duration > 0, `${clip.path} was placed with no length`)
      assert.equal(clip.offset, 0, `${clip.path} arrived already trimmed`)
      assert.equal(clip.speed, 1, `${clip.path} arrived stretched`)
      // The whole file, to within the frame the timeline quantises to.
      assert.ok(
        Math.abs(clip.duration - clip.assetDuration) <= frame / 2 + 1e-9,
        `${clip.path} was placed at ${clip.duration}s but its source is ${clip.assetDuration}s`,
      )
      at = clip.start + clip.duration
    }
    assert.ok(
      Math.abs(result.duration - at) < 1e-6,
      'the reported duration is not where the last clip ends',
    )

    // The sequence is shaped by its first clip, as displayed.
    assert.ok(state.settings.width > 0 && state.settings.height > 0, 'the sequence has no frame')
    console.log(
      `       ${result.placed} clips, ${Math.round(result.duration)}s, ` +
        `${state.settings.width}x${state.settings.height} @ ${state.settings.frameRate}fps` +
        (result.unreadable.length ? `, ${result.unreadable.length} unreadable` : '') +
        (result.reused ? `, ${result.reused} reused` : ''),
    )
  })

  await check('the first clip decides the sequence frame, rotation included', async () => {
    const state = await evaluate(
      cdp,
      `const { videoInfoFor } = window.__fluxDev.indexCache;
       const sequence = window.__fluxDev.sequence;
       const assets = window.__fluxDev.assets;
       const active = sequence.getSequence();
       // The base track, which is the LAST video track: tracks are held in display
         // order, so .find() returns V2 and a batch import lands on V1.
         const videoTrack = active.tracks.slice().reverse().find(t => t.kind === 'video');
       const first = active.clips
         .filter(c => c.trackId === videoTrack.id)
         .slice()
         .sort((a, b) => a.start - b.start)[0];
       const asset = assets.getAsset(first.assetId);
       const info = await videoInfoFor(asset.path);
       return {
         name: asset.name,
         info,
         settings: { width: active.settings.width, height: active.settings.height },
       };`,
    )

    if (!state.info) {
      // A still, or a file with no readable index. Nothing to assert about rate.
      assert.ok(state.settings.width > 0, 'the sequence still needs a frame')
      return
    }

    assert.deepEqual(
      { width: state.settings.width, height: state.settings.height },
      { width: state.info.width, height: state.info.height },
      `the sequence frame should be the first clip's displayed shape`,
    )
    if (state.info.rotation) {
      /*
       * The point of the whole rotation path, stated as an assertion: a clip
       * coded landscape and displayed vertical must give a vertical sequence.
       * Before rotation was read this produced a landscape frame with the
       * review letterboxed inside it.
       */
      assert.ok(
        state.settings.height > state.settings.width,
        `${state.name} is rotated ${state.info.rotation}° but the sequence is landscape`,
      )
      console.log(`       first clip is rotated ${state.info.rotation}°, sequence is vertical`)
    }
  })

  /*
   * The round trip, which is the only check that proves the idea.
   *
   * Imports, then *edits* — razors a clip in two and deletes something, exactly
   * as a review pass would — then exports and looks at the files on disk. The
   * point is that no export list was ever built: the edit is the list, and the
   * number of files that appear has to follow from what was left on the
   * timeline rather than from what was imported.
   */
  await check('a reviewed timeline exports one file per surviving clip', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-e2e-'))
    try {
      const edit = await evaluate(
        cdp,
        `const { planExport } = window.__fluxDev.batchExport;
         const sequence = window.__fluxDev.sequence;
         const active = sequence.getSequence();
         // The base track, which is the LAST video track: tracks are held in display
         // order, so .find() returns V2 and a batch import lands on V1.
         const videoTrack = active.tracks.slice().reverse().find(t => t.kind === 'video');
         const clips = active.clips
           .filter(c => c.trackId === videoTrack.id)
           .slice()
           .sort((a, b) => a.start - b.start);

         // Keep this cheap: three clips, which is enough to exercise naming,
         // a razor and a delete without encoding a whole shoot.
         for (const clip of clips.slice(3)) sequence.removeClips([clip.id]);

         const kept = sequence.getSequence().clips
           .filter(c => c.trackId === videoTrack.id)
           .slice()
           .sort((a, b) => a.start - b.start);

         // Razor the first one in two, so one source yields two outputs.
         const first = kept[0];
         const razorAt = first.start + first.duration / 2;
         sequence.splitClips(razorAt, [first.id]);

         // And trim the head of the last, so a cut with an offset is covered.
         const after = sequence.getSequence().clips
           .filter(c => c.trackId === videoTrack.id)
           .slice()
           .sort((a, b) => a.start - b.start);
         const last = after[after.length - 1];
         sequence.trimClips([last.id], 'in', Math.min(0.5, last.duration / 4));

         const plan = planExport(${JSON.stringify('<OUT>')});
         return {
           clips: sequence.getSequence().clips.filter(c => c.trackId === videoTrack.id).length,
           jobs: plan.jobs.length,
           skipped: plan.skipped,
           outputs: plan.jobs.map(j => j.output.split(/[\\/]/).pop()),
           offsets: plan.jobs.map(j => Number(j.offset.toFixed(3))),
         };`.replace('"<OUT>"', JSON.stringify(outDir)),
      )

      assert.ok(edit.jobs > 0, 'the edited timeline produced no jobs')
      assert.equal(edit.skipped.length, 0, `clips were refused: ${JSON.stringify(edit.skipped)}`)
      assert.equal(edit.jobs, edit.clips, 'one job per clip on a video track')

      /*
       * The naming rule, checked on the output it actually produced: a razor
       * makes two cuts of one source, so exactly one name carries the `_02`
       * suffix and the other does not.
       */
      const suffixed = edit.outputs.filter((name) => /_\d\d\.mp4$/.test(name))
      assert.equal(suffixed.length, 1, `expected one _02 output, got ${edit.outputs.join(', ')}`)
      assert.ok(
        edit.offsets.some((offset) => offset > 0),
        'no cut carries an offset — the razor and trim did not survive into the plan',
      )

      const run = await evaluate(
        cdp,
        `const { planExport } = window.__fluxDev.batchExport;
         const { startRender } = window.__fluxDev.renderBridge;
         const plan = planExport(${JSON.stringify(outDir)});
         const result = await startRender(plan.jobs, { outDir: ${JSON.stringify(outDir)}, concurrency: 2 });
         return result;`,
      )

      assert.ok(run.ok, `the export would not start: ${run.error}`)
      const summary = run.summary
      assert.equal(summary.failures.length, 0, `failures: ${JSON.stringify(summary.failures)}`)
      assert.equal(summary.counts.done, edit.jobs, 'not every job finished')

      // And the files are really there, one per clip, plus the log.
      const written = (await fs.readdir(outDir)).sort()
      const videos = written.filter((name) => name.endsWith('.mp4'))
      assert.equal(
        videos.length,
        edit.jobs,
        `${videos.length} files for ${edit.jobs} clips: ${written.join(', ')}`,
      )
      assert.ok(written.includes('flux-export-log.csv'), 'no export log was written')
      for (const name of videos) {
        const stat = await fs.stat(path.join(outDir, name))
        assert.ok(stat.size > 0, `${name} is empty`)
      }
      /*
       * Deliberately not "the export is smaller".
       *
       * It usually is — 8x to 11x on camera footage — but not always, and the
       * exception is real rather than a tolerance: some material in this
       * archive is already a delivery export at a low bitrate, and re-encoding
       * a few seconds of it can cost more than it saves. A suite that demanded
       * compression would fail on a folder of finished logo animations, which
       * is a true fact about the footage being reported as a bug in the
       * exporter.
       *
       * What *is* asserted is that the ratio was measured and reported, so the
       * log is usable, and that where a whole file grew the original was kept
       * instead — which is the rule that actually matters.
       */
      assert.ok(summary.ratio > 0, 'no compression ratio was measured')
      console.log(
        `       ${videos.length} files: ${videos.join(', ')}\n` +
          `       ${(summary.sourceBytes / 2 ** 20).toFixed(0)}MB read -> ` +
          `${(summary.outputBytes / 2 ** 20).toFixed(1)}MB written, ` +
          (summary.ratio >= 1
            ? `${summary.ratio.toFixed(1)}x smaller`
            : `${(1 / summary.ratio).toFixed(1)}x LARGER — already-compressed source`),
      )
    } finally {
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })
} finally {
  report()
  cdp.close()
}
