/**
 * Verifies the render queue inside the running app.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-render-queue.mjs <folder>
 *
 * The queue is add-then-start, which buys one property worth checking hard: a
 * queued job is a **snapshot**, so editing or deleting the clip it came from
 * afterwards cannot change or break what was queued. Everything else here is
 * ordinary bookkeeping; that is the bit that would ruin an archive quietly.
 *
 *   - adding the selection queues exactly the selected clips, and nothing else
 *   - adding the same clip twice replaces its row rather than queueing it
 *     again, so pressing Add when unsure does not render it to the same
 *     filename twice
 *   - **deleting a queued clip leaves its job intact and renderable**
 *   - **razoring a queued clip does not retroactively change its job**
 *   - Start renders only what is waiting, and the files appear
 *   - a stretched clip renders rather than being refused, at the rate asked for
 *
 * ## The timeline decides what is in the file, not an export option
 *
 * The second group of checks is about that. A hidden video track is not
 * exported; a clip whose sound is on a muted — or un-soloed — track is written
 * with no audio stream at all. Both are read back off the files rather than
 * taken from the plan, because "the planner said silent" and "the file has no
 * audio" are different claims and only the second one is the archive.
 *
 * One of them is a resume canary. Mute a track and render again with resume
 * on: the clip must be **re-encoded**, not skipped. Without the verifier
 * knowing what the sound was supposed to be, a file with audio passes every
 * other check, the queue skips it, and the archive keeps whatever the first
 * run happened to produce — permanently, and silently.
 *
 * CLEARS the verification project's sequences and queue.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'
import { findTools } from '../electron/render.js'

const run = promisify(execFile)

const FOLDER = process.argv[2]
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

if (!FOLDER) {
  console.error('  usage: node scripts/verify-render-queue.mjs <folder>')
  process.exit(2)
}

const { check, report } = createChecker()
const cdp = await attach()
const OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-rq-'))

const tools = await findTools()
if (!tools.ok) {
  console.error(`  FAIL ${tools.error}`)
  process.exit(1)
}

/** Whether a written file carries any sound. Asked of the file, not the plan. */
async function hasSound(file) {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type',
     '-print_format', 'json', '--', file],
    { maxBuffer: 8 << 20 },
  )
  return (JSON.parse(stdout).streams ?? []).length > 0
}

/**
 * Video clips that have a linked audio half, as a page-side helper.
 *
 * Track state can only speak for a clip that has a link: the mute lives on the
 * audio track, and the video clip reaches it through `linkId`. A clip placed
 * by hand with `addClip` has none, so it is deliberately unaffected — and a
 * check that asserted "every job goes silent" would fail on one of those for a
 * reason that is the documented behaviour rather than a bug.
 */
const LINKED = `
  const linkedIds = () => new Set(
    sequence.getSequence().clips
      .filter(c => c.kind === 'video' && c.linkId)
      .map(c => c.id),
  );
`

/** Lays a handful of clips down so every check below has something to act on. */
const SEED = LINKED + `
  const { batchImport, sequence, selection, renderQueue, renderSettings } = window.__fluxDev;
  renderQueue.clear();
  const planned = await batchImport.planBatch(${JSON.stringify(FOLDER)});
  if (!planned.ok) throw new Error('planBatch: ' + planned.error);
  await batchImport.runBatch(planned.plan);
  renderSettings.updateRenderSettings({ outDir: ${JSON.stringify(OUT)}, concurrency: 2 });

  const active = sequence.getSequence();
  const track = active.tracks.slice().reverse().find(t => t.kind === 'video');
  const clips = active.clips
    .filter(c => c.trackId === track.id)
    .slice()
    .sort((a, b) => a.start - b.start);
`

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  await check('adding the selection queues exactly what is selected', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const wanted = clips.slice(0, Math.min(3, clips.length)).map(c => c.id);
         selection.setSelection(new Set(wanted));
         const result = renderQueue.add('selection');
         const queued = renderQueue.getQueue();
         return {
           result,
           queuedIds: queued.map(j => j.id),
           wanted,
           statuses: [...new Set(queued.map(j => j.status))],
           outputs: queued.map(j => j.output.split(/[\\\\/]/).pop()),
         };`,
    )
    assert.deepEqual(state.queuedIds, state.wanted, 'the queue does not match the selection')
    assert.equal(state.result.added, state.wanted.length)
    assert.deepEqual(state.statuses, ['waiting'], 'everything added should be waiting')
    assert.equal(new Set(state.outputs).size, state.wanted.length, 'two jobs were given the same output name')
  })

  await check('adding the same clips again replaces their rows rather than doubling them', async () => {
    const state = await evaluate(
      cdp,
      `const { renderQueue } = window.__fluxDev;
       const before = renderQueue.getQueue().length;
       const result = renderQueue.add('selection');
       return { before, after: renderQueue.getQueue().length, result };`,
    )
    assert.equal(state.after, state.before, 'the queue grew when it should have been updated')
    assert.equal(state.result.added, 0)
    assert.equal(state.result.replaced, state.before)
  })

  await check('deleting a queued clip leaves its job intact', async () => {
    /*
     * The property the whole snapshot design exists for. If a job were a
     * reference to a clip, this is where the queue would lose a row — or worse,
     * keep one that resolves to nothing and fails at render time, hours later.
     */
    const state = await evaluate(
      cdp,
      `const { sequence, renderQueue } = window.__fluxDev;
       const queued = renderQueue.getQueue();
       const victim = queued[0];
       const snapshot = { source: victim.source, offset: victim.offset, duration: victim.duration };
       sequence.removeClips([victim.id]);
       await new Promise(r => setTimeout(r, 200));
       const still = renderQueue.getQueue().find(j => j.id === victim.id);
       return {
         snapshot,
         survived: Boolean(still),
         unchanged: still
           ? still.source === snapshot.source &&
             still.offset === snapshot.offset &&
             still.duration === snapshot.duration
           : false,
         clipGone: !sequence.getSequence().clips.some(c => c.id === victim.id),
       };`,
    )
    assert.equal(state.clipGone, true, 'setup: the clip should have been deleted')
    assert.equal(state.survived, true, 'deleting the clip took its queued job with it')
    assert.equal(state.unchanged, true, 'the queued job changed when its clip was deleted')
  })

  await check('razoring a queued clip does not rewrite its job', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence, renderQueue } = window.__fluxDev;
       const queued = renderQueue.getQueue().filter(j =>
         sequence.getSequence().clips.some(c => c.id === j.id));
       const victim = queued[0];
       const clip = sequence.getSequence().clips.find(c => c.id === victim.id);
       const before = { offset: victim.offset, duration: victim.duration };
       sequence.splitClips(clip.start + clip.duration / 2, [clip.id]);
       await new Promise(r => setTimeout(r, 200));
       const after = renderQueue.getQueue().find(j => j.id === victim.id);
       return { before, after: after ? { offset: after.offset, duration: after.duration } : null };`,
    )
    assert.ok(state.after, 'the job vanished when its clip was razored')
    assert.deepEqual(state.after, state.before, 'the razor retroactively changed a queued job')
  })

  await check('a stretched clip queues and renders at the rate asked for', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `// The LAST clip. A batch import butts clips end to end, so every other
         // one has a neighbour blocking its tail and the stretch is simply
         // refused — allowedStretch returns 0 and nothing happens.
         const target = clips[clips.length - 1];
         // Dragging the tail out by the clip's own length doubles its time on
         // the timeline over the same span of source, which is half speed.
         sequence.stretchClips([target.id], 'end', target.duration);
         await new Promise(r => setTimeout(r, 200));
         const stretched = sequence.getSequence().clips.find(c => c.id === target.id);
         selection.setSelection(new Set([target.id]));
         renderQueue.clear();
         renderQueue.add('selection');
         const job = renderQueue.getQueue()[0];
         return {
           clipSpeed: stretched ? stretched.speed : null,
           jobSpeed: job ? job.speed : null,
           jobRate: job ? job.frameRate : null,
           sequenceRate: sequence.getSequence().settings.frameRate,
           render: await renderQueue.start(),
           status: renderQueue.getQueue()[0].status,
           output: renderQueue.getQueue()[0].output,
         };`,
    )
    if (state.clipSpeed === null || Math.abs(state.clipSpeed - 1) < 1e-9) {
      console.log('       (the stretch did not take — skipping)')
      return
    }
    assert.equal(state.jobSpeed, state.clipSpeed, 'the job did not carry the clip speed')
    assert.equal(
      state.jobRate,
      state.sequenceRate,
      'a stretched clip must force a rate, or setpts produces a 100fps file',
    )
    assert.ok(state.render.ok, `the stretched clip would not render: ${state.render.error}`)
    assert.equal(state.status, 'done', 'the stretched clip did not finish')
    console.log(`       ${state.clipSpeed.toFixed(2)}x rendered at ${state.jobRate}fps`)
  })

  await check('Start renders what is waiting, and the files appear', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `selection.setSelection(new Set(clips.slice(0, 2).map(c => c.id)));
         renderQueue.clear();
         renderQueue.add('selection');
         const result = await renderQueue.start();
         const queued = renderQueue.getQueue();
         return {
           result,
           statuses: queued.map(j => j.status),
           outputs: queued.map(j => j.output.split(/[\\\\/]/).pop()),
           ratios: queued.map(j => j.ratio ?? null),
         };`,
    )
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    // 'skipped' is a pass: resume found a verified file an earlier check in
    // this run already wrote, which is the behaviour, not a failure.
    for (const status of state.statuses) {
      assert.ok(
        status === 'done' || status === 'skipped',
        `a job ended as ${status}`,
      )
    }

    const written = (await fs.readdir(OUT)).filter((n) => n.endsWith('.mp4'))
    for (const name of state.outputs) {
      assert.ok(written.includes(name), `${name} is not in the output folder`)
      const stat = await fs.stat(path.join(OUT, name))
      assert.ok(stat.size > 0, `${name} is empty`)
    }
    // Only an encoded job has a ratio. A skipped one was already on disk from
    // an earlier check in this run, and never measured anything.
    for (const [i, ratio] of state.ratios.entries()) {
      if (state.statuses[i] !== 'done') continue
      assert.ok(ratio && ratio > 0, 'an encoded job reported no compression ratio')
    }
    console.log(
      `       ${state.outputs.length} rendered: ${state.outputs.join(', ')} ` +
        `(${state.ratios.map((r) => `${r.toFixed(1)}x`).join(', ')})`,
    )
  })

  // ── the timeline decides what is in the file ──────────────────

  await check('a hidden video track is not exported, and leaves no hole in the naming', async () => {
    /*
     * Two clips of one source — one on V1, one on V2 — would be `X.mp4` and
     * `X_02.mp4`. Hiding V2 must leave the survivor as `X.mp4`, not promote it
     * to `X_02.mp4` with nothing called `X.mp4` beside it. A gap in the
     * numbering reads as a failed export rather than as a track you chose not
     * to render, which is why hidden clips are dropped before naming.
     */
    const state = await evaluate(
      cdp,
      SEED +
        // SEED already destructured sequence/selection/renderQueue/renderSettings.
        `const { batchExport } = window.__fluxDev;
         const out = renderSettings.getRenderSettings().outDir;
         const first = clips[0];
         const v2 = sequence.addTrack('video');
         sequence.addClip({
           assetId: first.assetId, trackId: v2.id, start: first.start,
           duration: first.duration, offset: first.offset,
           sourceDuration: first.sourceDuration,
         });
         await new Promise(r => setTimeout(r, 150));

         const shown = batchExport.planExport(out);
         sequence.setTrackHidden(v2.id, true);
         await new Promise(r => setTimeout(r, 150));
         const hidden = batchExport.planExport(out);

         const named = (plan) => plan.jobs.map(j => j.output.split(/[\\\\/]/).pop());
         return {
           shownCount: shown.jobs.length,
           hiddenCount: hidden.jobs.length,
           shownNames: named(shown),
           hiddenNames: named(hidden),
           refused: hidden.skipped.filter(s => s.reason === 'hidden'),
         };`,
    )
    assert.equal(
      state.hiddenCount,
      state.shownCount - 1,
      'hiding a track did not take its clip out of the export',
    )
    assert.equal(state.refused.length, 1, 'the hidden clip was not named as refused')
    assert.match(state.refused[0].detail, /hidden/, 'the refusal does not say why')
    // Every name that survived is a name that existed before, unchanged.
    for (const name of state.hiddenNames) {
      assert.ok(
        state.shownNames.includes(name),
        `${name} is a name that only appeared once a track was hidden — the numbering shifted`,
      )
    }
    assert.equal(
      new Set(state.hiddenNames).size,
      state.hiddenNames.length,
      'two jobs were given the same output name',
    )
    console.log(`       ${state.shownCount} visible -> ${state.hiddenCount}, 1 refused as hidden`)
  })

  await check('a muted track writes a file with no sound at all', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const { batchExport } = window.__fluxDev;
         const target = clips[0];
         const audio = sequence.getSequence().tracks.find(t => t.kind === 'audio');
         sequence.setTrackMuted(audio.id, true);
         await new Promise(r => setTimeout(r, 150));

         const plan = batchExport.planExport(renderSettings.getRenderSettings().outDir);
         selection.setSelection(new Set([target.id]));
         renderQueue.clear();
         renderQueue.add('selection');
         const job = renderQueue.getQueue()[0];
         const result = await renderQueue.start();
         sequence.setTrackMuted(audio.id, false);
         return {
           allSilent: plan.jobs.filter(j => linkedIds().has(j.id)).every(j => j.silent === true),
           jobSilent: job ? job.silent : null,
           result,
           status: renderQueue.getQueue()[0].status,
           output: renderQueue.getQueue()[0].output,
         };`,
    )
    assert.equal(state.allSilent, true, 'muting a track did not mark its clips silent')
    assert.equal(state.jobSilent, true, 'the queued job did not carry it')
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `the muted clip ended as ${state.status}`)
    assert.equal(
      await hasSound(state.output),
      false,
      'the file still has an audio stream, so the mute reached the plan and not the encoder',
    )
    console.log(`       ${path.basename(state.output)} written with no audio stream`)
  })

  await check('solo on one track silences the clips of the others', async () => {
    /*
     * Not a separate rule, and that is the thing worth checking: solo and mute
     * both go through `isTrackAudible`, so a track nobody touched falls silent
     * because something *else* was soloed.
     */
    const state = await evaluate(
      cdp,
      SEED +
        `const { batchExport } = window.__fluxDev;
         const out = renderSettings.getRenderSettings().outDir;
         const second = sequence.addTrack('audio');
         await new Promise(r => setTimeout(r, 150));
         const linked = linkedIds();
         const silentOf = (which) => batchExport.planExport(out).jobs
           .filter(j => which.has(j.id) === true)
           .map(j => j.silent);

         const before = silentOf(linked);
         sequence.setTrackSolo(second.id, true);
         await new Promise(r => setTimeout(r, 150));
         const after = silentOf(linked);
         /* A clip with no linked audio has no track state to obey, so it must
            come through a solo completely untouched. */
         const loose = batchExport.planExport(out).jobs
           .filter(j => !linked.has(j.id))
           .map(j => j.silent);
         sequence.setTrackSolo(second.id, false);
         return { before, after, loose };`,
    )
    assert.ok(state.before.length > 0, 'setup: expected some linked clips')
    assert.ok(
      state.before.every((silent) => silent === false),
      'setup: nothing should be silent before the solo',
    )
    assert.ok(
      state.after.every((silent) => silent === true),
      'soloing an empty track did not silence the linked clips on A1',
    )
    assert.ok(
      state.loose.every((silent) => silent === false),
      'a clip with no linked audio was silenced by a solo it has no connection to',
    )
    console.log(
      `       ${state.after.length} linked clips silenced, ${state.loose.length} unlinked untouched`,
    )
  })

  await check('CANARY: muting after a render re-encodes rather than resuming past it', async () => {
    /*
     * The check the verifier's sound assertion exists for. Render a clip with
     * its audio, mute the track, render again with resume ON.
     *
     * A file with sound passes every other check the verifier makes — size,
     * rate, frame count, profile, pixel format — so without knowing what the
     * sound was *supposed* to be, `alreadyDone` says yes, the queue reports
     * "skipped", and the archive silently keeps the first run's output forever.
     */
    const first = await evaluate(
      cdp,
      SEED +
        // SEED is in scope; nothing new to pull off the handle here.
        `const target = clips[0];
         const audio = sequence.getSequence().tracks.find(t => t.kind === 'audio');
         sequence.setTrackMuted(audio.id, false);
         selection.setSelection(new Set([target.id]));

         /* Resume OFF for the baseline, because earlier checks in this run
            have already written this very path — a skip here would leave the
            canary with nothing to have changed. */
         renderSettings.updateRenderSettings({ resume: false });
         renderQueue.clear();
         renderQueue.add('selection');
         const result = await renderQueue.start();
         const row = renderQueue.getQueue()[0];
         return {
           result, status: row.status, output: row.output,
           id: target.id, track: audio.id, silent: row.silent,
         };`,
    )
    assert.ok(first.result.ok, `the baseline render refused: ${first.result.error}`)
    assert.equal(first.status, 'done', `the baseline ended as ${first.status}`)
    assert.equal(first.silent, false, 'setup: the baseline should not be silent')
    /*
     * The baseline has to actually have sound, or the canary proves nothing: a
     * source with no audio would produce a silent file at both ends and the
     * check would pass without the verifier having done anything.
     */
    if (!(await hasSound(first.output))) {
      console.log('       (the source has no sound — the canary cannot mean anything)')
      return
    }

    const second = await evaluate(
      cdp,
      `const { sequence, selection, renderQueue, renderSettings } = window.__fluxDev;
       // Resume ON now. One thing changes on the timeline, nothing else.
       renderSettings.updateRenderSettings({ resume: true });
       sequence.setTrackMuted(${JSON.stringify(first.track)}, true);
       await new Promise(r => setTimeout(r, 200));
       selection.setSelection(new Set([${JSON.stringify(first.id)}]));
       renderQueue.clear();
       renderQueue.add('selection');
       const result = await renderQueue.start();
       const row = renderQueue.getQueue()[0];
       sequence.setTrackMuted(${JSON.stringify(first.track)}, false);
       return { result, status: row.status, output: row.output, silent: row.silent };`,
    )
    assert.equal(second.output, first.output, 'setup: both runs should target one path')
    assert.equal(second.silent, true, 'the mute did not reach the second job')
    assert.notEqual(
      second.status,
      'skipped',
      'resume skipped a clip whose sound had changed — the verifier is not checking audio',
    )
    assert.equal(second.status, 'done', `the second render ended as ${second.status}`)
    assert.equal(
      await hasSound(second.output),
      false,
      'the re-render left the old file, sound and all, in place',
    )
    console.log('       baseline had sound; after the mute it re-encoded and has none')
  })

  await check('the queue survives being saved and read back', async () => {
    const state = await evaluate(
      cdp,
      `const { renderQueue, project } = window.__fluxDev;
       const before = renderQueue.getQueue().map(j => ({ id: j.id, status: j.status, output: j.output }));
       await project.saveProject();
       // Round-trip through the file the project just wrote.
       const stored = await window.flux.project.readQueue(project.getProject().root);
       return { before, stored: stored.jobs.map(j => ({ id: j.id, status: j.status, output: j.output })) };`,
    )
    assert.deepEqual(state.stored, state.before, 'the queue did not survive the round trip')
  })
} finally {
  report()
  await fs.rm(OUT, { recursive: true, force: true })
  cdp.close()
}
