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

/** `30000/1001` -> 29.97. */
function rateOf(text) {
  const [num, den] = String(text ?? '').split('/').map(Number)
  if (!den) return num || 0
  return num / den
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

  // ── the two switches at the top of the page ───────────────────

  /** Which streams a written file actually has. */
  async function streamsOf(file) {
    const { stdout } = await run(
      tools.ffprobe,
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-print_format', 'json', '--', file],
      { maxBuffer: 8 << 20 },
    )
    const streams = (JSON.parse(stdout).streams ?? []).map((s) => s.codec_type)
    return { video: streams.includes('video'), audio: streams.includes('audio') }
  }

  await check('Video off writes a sound-only file', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `renderSettings.updateRenderSettings({ video: false, audio: true, resume: false });
         selection.setSelection(new Set([clips[0].id]));
         renderQueue.clear();
         renderQueue.add('selection');
         const job = renderQueue.getQueue()[0];
         const result = await renderQueue.start();
         const row = renderQueue.getQueue()[0];
         renderSettings.updateRenderSettings({ video: true, audio: true });
         return {
           jobVideo: job.video, jobSilent: job.silent,
           result, status: row.status, error: row.error, output: row.output,
         };`,
    )
    assert.equal(state.jobVideo, false, 'the switch did not reach the job')
    assert.equal(state.jobSilent, false, 'Video off must not also silence it')
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `the render ended as ${state.status}: ${state.error}`)
    const has = await streamsOf(state.output)
    assert.equal(has.video, false, 'the output still has a picture in it')
    assert.equal(has.audio, true, 'a sound-only render with no sound is not a render')
    console.log(`       ${path.basename(state.output)}: audio only`)
  })

  await check('Audio off writes a silent file, whatever the tracks say', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const audio = sequence.getSequence().tracks.find(t => t.kind === 'audio');
         // Audible on the timeline, so only the switch can silence it.
         sequence.setTrackMuted(audio.id, false);
         renderSettings.updateRenderSettings({ video: true, audio: false, resume: false });
         selection.setSelection(new Set([clips[0].id]));
         renderQueue.clear();
         renderQueue.add('selection');
         const job = renderQueue.getQueue()[0];
         const result = await renderQueue.start();
         const row = renderQueue.getQueue()[0];
         renderSettings.updateRenderSettings({ video: true, audio: true });
         return { jobSilent: job.silent, jobVideo: job.video, result, status: row.status, output: row.output };`,
    )
    assert.equal(state.jobSilent, true, 'the switch did not silence the job')
    assert.equal(state.jobVideo, true, 'Audio off must not also drop the picture')
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `the render ended as ${state.status}`)
    const has = await streamsOf(state.output)
    assert.equal(has.video, true, 'the picture went missing')
    assert.equal(has.audio, false, 'the output still has sound in it')
  })

  await check('turning both off is refused rather than writing an empty file', async () => {
    /*
     * The pair behaves as a choice of three states rather than two
     * independent switches, because a render with neither picture nor sound
     * is not a smaller file, it is a mistake.
     */
    const state = await evaluate(
      cdp,
      `const { renderSettings } = window.__fluxDev;
       renderSettings.updateRenderSettings({ video: true, audio: true });
       renderSettings.updateRenderSettings({ video: false });
       const afterVideoOff = { ...renderSettings.getRenderSettings() };
       renderSettings.updateRenderSettings({ audio: false });
       const afterBoth = { ...renderSettings.getRenderSettings() };
       renderSettings.updateRenderSettings({ video: true, audio: true });
       return {
         afterVideoOff: { video: afterVideoOff.video, audio: afterVideoOff.audio },
         afterBoth: { video: afterBoth.video, audio: afterBoth.audio },
       };`,
    )
    assert.deepEqual(state.afterVideoOff, { video: false, audio: true })
    assert.deepEqual(
      state.afterBoth,
      { video: true, audio: false },
      'turning the second one off should put the first back, not leave an empty render',
    )
  })

  await check('Ctrl M queues the selection and opens the Export workspace', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const { commands, view } = window.__fluxDev;
         renderSettings.updateRenderSettings({ mode: 'clips', video: true, audio: true });
         // The command, not recordView: recording the id does not move any
         // panels, so the next switch can think it is already where it is going.
         await commands.run('workspace.switch.edit');
         await new Promise(r => setTimeout(r, 400));
         renderQueue.clear();
         selection.setSelection(new Set(clips.slice(0, 3).map(c => c.id)));
         await commands.run('render.send');
         await new Promise(r => setTimeout(r, 400));
         return {
           workspace: view.getView().workspace,
           queued: renderQueue.getQueue().length,
           statuses: [...new Set(renderQueue.getQueue().map(j => j.status))],
           binding: Object.entries(window.__fluxDev.keymap.defaultKeymap)
             .find(([, id]) => id === 'render.send')?.[0] ?? null,
         };`,
    )
    assert.equal(state.binding, 'ctrl+m', `render.send is bound to ${state.binding}`)
    assert.equal(state.queued, 3, 'the selection did not reach the queue')
    assert.deepEqual(state.statuses, ['waiting'])
    assert.equal(state.workspace, 'export', 'it queued but did not go and show you')
  })

  // ── fields that follow until they are touched ─────────────────

  /**
   * Everything about a written file's streams that a field could have moved.
   *
   * The size is the **displayed** size, with any rotation applied, and that is
   * not a detail. Two files in five in this library are coded landscape with a
   * quarter-turn matrix, and an export bakes the rotation in — so an unscaled
   * export of a rotated source is coded 1080x1920 where its source is coded
   * 1920x1080, which is correct and is the whole point.
   *
   * This read coded dimensions and compared them straight across that boundary,
   * so two checks below failed on every rotated folder with "the picture
   * changed size on its own, 1080 !== 1920" while the exporter was doing
   * exactly the right thing. They passed on unrotated footage, which is how it
   * went unnoticed. `sourceFacts` in electron/render.js has always applied
   * rotation for the same reason; this is the harness catching up with it.
   */
  async function factsOf(file) {
    const { stdout } = await run(
      tools.ffprobe,
      ['-v', 'error', '-show_entries',
       'stream=codec_type,codec_name,width,height,sample_rate,channels,r_frame_rate:' +
         'stream_side_data=rotation',
       '-print_format', 'json', '--', file],
      { maxBuffer: 8 << 20 },
    )
    const streams = JSON.parse(stdout).streams ?? []
    const v = streams.find((s) => s.codec_type === 'video')
    const a = streams.find((s) => s.codec_type === 'audio')
    const spin = Number(
      (v?.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0,
    )
    // A quarter turn swaps what the viewer sees; a half turn does not.
    const turned = Math.abs(((spin % 360) + 360) % 360) % 180 === 90
    return {
      width: (turned ? v?.height : v?.width) ?? 0,
      height: (turned ? v?.width : v?.height) ?? 0,
      /** Kept so a check can say what was on disk, not just what it displays. */
      coded: { width: v?.width ?? 0, height: v?.height ?? 0, rotation: spin },
      // `30000/1001`, not a decimal — a rate is a ratio in the container.
      rate: v ? rateOf(v.r_frame_rate) : 0,
      sampleRate: a ? Number(a.sample_rate) : 0,
      channels: a?.channels ?? 0,
      audioCodec: a?.codec_name ?? null,
    }
  }

  /** Renders clips[0] once with the given settings and reads the file back. */
  const renderWith = (patch) =>
    evaluate(
      cdp,
      SEED +
        `renderSettings.updateRenderSettings({
           mode: 'clips', video: true, audio: true, resume: false,
           width: null, height: null, fps: null,
           audioBitrate: null, audioSampleRate: null, audioChannels: null,
           ...${JSON.stringify(patch)},
         });
         selection.setSelection(new Set([clips[0].id]));
         renderQueue.clear();
         renderQueue.add('selection');
         const job = renderQueue.getQueue()[0];
         const result = await renderQueue.start();
         const row = renderQueue.getQueue()[0];
         renderSettings.updateRenderSettings({
           width: null, height: null, fps: null,
           audioBitrate: null, audioSampleRate: null, audioChannels: null,
         });
         return {
           result, status: row.status, error: row.error, output: row.output,
           jobScale: job.scale ?? null, jobRate: job.frameRate ?? null,
           source: job.source,
         };`,
    )

  await check('an untouched field changes nothing about the file', async () => {
    /*
     * The baseline the next three are measured against, and a real check in
     * itself: "follow the sequence" has to mean *emit no flag*, because
     * emitting the number the source already has is not the same thing. On a
     * 44.1kHz source `-ar 48000` is a resample, and a field nobody touched
     * must not resample anything.
     */
    const state = await renderWith({})
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `ended as ${state.status}: ${state.error}`)
    assert.equal(state.jobScale, null, 'an untouched size produced a scale')
    const [out, src] = [await factsOf(state.output), await factsOf(state.source)]
    assert.equal(out.width, src.width, 'the picture changed size on its own')
    assert.equal(out.height, src.height)
    /*
     * And the rotation was baked in rather than carried over as a matrix,
     * which is the stronger claim and the one worth holding: a file that
     * merely forwarded the source's side data would have the same *displayed*
     * size and still be wrong, because the archive must not depend on a
     * player honouring a rotation flag.
     */
    if (src.coded.rotation !== 0) {
      assert.equal(
        out.coded.rotation,
        0,
        `the output still carries a ${out.coded.rotation} degree rotation matrix`,
      )
      // Upright means coded and displayed are the same thing, so the output's
      // coded shape should be the source's *displayed* shape.
      assert.deepEqual(
        { width: out.coded.width, height: out.coded.height },
        { width: src.width, height: src.height },
        `coded ${out.coded.width}x${out.coded.height}, expected the upright ` +
          `${src.width}x${src.height}`,
      )
    }
    assert.equal(
      out.sampleRate,
      src.sampleRate,
      'the sound was resampled by a field nobody touched',
    )
    assert.equal(out.channels, src.channels, 'the channels were changed on their own')
    console.log(
      `       ${src.width}x${src.height} ${src.sampleRate}Hz ${src.channels}ch — unchanged` +
        (src.coded.rotation !== 0
          ? ` (source coded ${src.coded.width}x${src.coded.height} rot ${src.coded.rotation}, baked in)`
          : ''),
    )
  })

  await check('a size that was typed is the size that comes out', async () => {
    const state = await renderWith({ width: 640, height: 360 })
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `ended as ${state.status}: ${state.error}`)
    assert.deepEqual(state.jobScale, { width: 640, height: 360 })
    const out = await factsOf(state.output)
    assert.equal(out.width, 640, `came out ${out.width} wide`)
    assert.equal(out.height, 360, `came out ${out.height} high`)
    /*
     * And the verifier agreed, which is the half that could have been missed:
     * it compares against the *source's* displayed size by default, so a job
     * that scaled would fail every check unless it is told what it asked for.
     */
    console.log(`       scaled to ${out.width}x${out.height}, and verified against it`)
  })

  await check('one dimension on its own scales nothing', async () => {
    /*
     * Half a size is not a size. Scaling to a width and the source's height
     * would deform every clip, and refusing to scale is the answer that
     * cannot be wrong — the panel says both are needed.
     */
    const state = await renderWith({ width: 640 })
    assert.equal(state.jobScale, null, 'a width with no height produced a scale')
    assert.equal(state.status, 'done')
    const [out, src] = [await factsOf(state.output), await factsOf(state.source)]
    assert.equal(out.width, src.width, 'it scaled anyway')
    assert.equal(out.height, src.height, 'the height moved on its own')
    /*
     * Named explicitly, because 640 is the number that would appear if half a
     * size were ever honoured, and asserting only "unchanged" would pass on a
     * source that happened to be 640 wide.
     */
    assert.notEqual(out.width, 640, 'the typed width was used on its own')
    console.log(`       stayed ${out.width}x${out.height} with only a width typed`)
  })

  await check('typed audio settings reach the file', async () => {
    const state = await renderWith({ audioBitrate: 320, audioSampleRate: 44100, audioChannels: 1 })
    assert.ok(state.result.ok, `start refused: ${state.result.error}`)
    assert.equal(state.status, 'done', `ended as ${state.status}: ${state.error}`)
    const out = await factsOf(state.output)
    assert.equal(out.sampleRate, 44100, `came out at ${out.sampleRate}Hz`)
    assert.equal(out.channels, 1, `came out ${out.channels} channels`)
    assert.equal(out.audioCodec, 'aac')
    console.log(`       ${out.sampleRate}Hz ${out.channels}ch aac`)
  })

  await check('a typed rate beats the frame-rate policy', async () => {
    const state = await renderWith({ frameRate: 'source', fps: 30 })
    assert.equal(state.jobRate, 30, `the job asked for ${state.jobRate}fps`)
    assert.equal(state.status, 'done', `ended as ${state.status}: ${state.error}`)
    const out = await factsOf(state.output)
    assert.ok(Math.abs(out.rate - 30) < 0.01, `came out at ${out.rate}fps`)
  })

  await check('null survives the clamps, because it is an answer', async () => {
    const state = await evaluate(
      cdp,
      `const { renderSettings } = window.__fluxDev;
       renderSettings.updateRenderSettings({ width: 1921, height: 1081, audioChannels: 99, fps: null });
       const clamped = { ...renderSettings.getRenderSettings() };
       renderSettings.updateRenderSettings({ width: null, height: null, audioChannels: null });
       const cleared = { ...renderSettings.getRenderSettings() };
       return {
         clamped: { w: clamped.width, h: clamped.height, ch: clamped.audioChannels, fps: clamped.fps },
         cleared: { w: cleared.width, h: cleared.height, ch: cleared.audioChannels },
       };`,
    )
    // Odd dimensions are not a slightly wrong size, they are a frame yuv420p
    // cannot carry — so they are rounded rather than refused.
    assert.deepEqual(state.clamped, { w: 1920, h: 1080, ch: 8, fps: null })
    assert.deepEqual(
      state.cleared,
      { w: null, h: null, ch: null },
      'clearing a field left a number behind, so nothing can go back to following',
    )
  })

  // ── the marked span ───────────────────────────────────────────

  await check('slash marks exactly the span the selected clips occupy', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const { commands, view } = window.__fluxDev;
         /*
          * The Timeline has to be on screen: its commands are registered while
          * it is mounted and disposed when it is not, which is the same rule
          * every panel follows. An earlier check leaves the app in the Export
          * workspace, where there is no Timeline — and pressing / there does
          * nothing, correctly.
          */
         await commands.run('panel.focus.timeline');
         await new Promise(r => setTimeout(r, 500));
         sequence.clearRange();
         selection.setSelection(new Set([clips[1].id, clips[2].id]));
         await commands.run('timeline.markSelection');
         const range = sequence.renderRange();
         return {
           range: { start: range.start, end: range.end, marked: range.marked },
           wanted: { start: clips[1].start, end: clips[2].start + clips[2].duration },
           whole: sequence.sequenceDuration(),
         };`,
    )
    assert.equal(state.range.marked, true, 'nothing was marked')
    assert.ok(
      Math.abs(state.range.start - state.wanted.start) < 1e-6,
      `in landed at ${state.range.start}, expected ${state.wanted.start}`,
    )
    assert.ok(
      Math.abs(state.range.end - state.wanted.end) < 1e-6,
      `out landed at ${state.range.end}, expected ${state.wanted.end}`,
    )
    assert.ok(state.range.end < state.whole, 'setup: the span should be shorter than the sequence')
  })

  await check('a marked span renders only what is inside it, trimmed to it', async () => {
    /*
     * Both halves matter and they fail differently. Clips wholly outside are
     * *dropped* — and named, so a queue that suddenly has two rows instead of
     * four has an answer on screen. A clip straddling a mark is *trimmed*,
     * which moves its source in point by the same amount: the frames before
     * the mark are not wanted, and `offset` is where the cut starts in the
     * file.
     */
    const state = await evaluate(
      cdp,
      SEED +
        `const { batchExport, sequenceExport } = window.__fluxDev;
         sequence.clearRange();
         const whole = {
           clips: batchExport.planExport('/out').jobs.length,
           seq: sequenceExport.planSequence('/out').job.duration,
         };

         // A span that starts halfway through one clip and ends halfway
         // through the next but one.
         const from = clips[1].start + clips[1].duration / 2;
         const to = clips[2].start + clips[2].duration / 2;
         sequence.setRange(from, to);

         const cut = batchExport.planExport('/out');
         const seq = sequenceExport.planSequence('/out').job;
         sequence.clearRange();

         return {
           whole,
           from, to,
           jobs: cut.jobs.length,
           outside: cut.skipped.filter(s => s.reason === 'outside').length,
           first: { duration: cut.jobs[0].duration, offset: cut.jobs[0].offset },
           source: { duration: clips[1].duration, offset: clips[1].offset },
           seqDuration: seq.duration,
           seqFirstStart: seq.video[0].start,
         };`,
    )
    const span = state.to - state.from
    assert.ok(state.whole.clips > state.jobs, 'the span did not drop anything')
    assert.ok(state.outside > 0, 'clips outside the span were dropped without being named')

    // The straddling clip keeps only its second half, and reads it from the
    // middle of the file rather than the top.
    const expectedHead = state.source.duration / 2
    assert.ok(
      Math.abs(state.first.duration - expectedHead) < 0.05,
      `the straddling clip rendered ${state.first.duration}s, expected ${expectedHead}s`,
    )
    assert.ok(
      Math.abs(state.first.offset - (state.source.offset + expectedHead)) < 0.05,
      `its source in point is ${state.first.offset}, so the trim moved the length but not the frames`,
    )

    // The composite is exactly the span, and starts at its beginning.
    assert.ok(
      Math.abs(state.seqDuration - span) < 1e-6,
      `the composite is ${state.seqDuration}s, expected ${span}s`,
    )
    assert.ok(
      Math.abs(state.seqFirstStart) < 1e-6,
      `the first cut sits at ${state.seqFirstStart}s — the in point did not become zero`,
    )
    console.log(
      `       ${state.whole.clips} clips -> ${state.jobs}, ` +
        `composite ${state.whole.seq.toFixed(2)}s -> ${state.seqDuration.toFixed(2)}s`,
    )
  })

  await check('clearing the marks renders the whole sequence again', async () => {
    const state = await evaluate(
      cdp,
      SEED +
        `const { batchExport } = window.__fluxDev;
         sequence.setRange(clips[1].start, clips[1].start + clips[1].duration);
         const marked = batchExport.planExport('/out').jobs.length;
         sequence.clearRange();
         return {
           marked,
           cleared: batchExport.planExport('/out').jobs.length,
           stillMarked: sequence.renderRange().marked,
           all: clips.length,
         };`,
    )
    assert.ok(state.marked < state.all, 'setup: the mark should have narrowed it')
    assert.equal(state.stillMarked, false, 'the marks did not clear')
    assert.equal(state.cleared, state.all, 'clearing did not bring the other clips back')
  })

  await check('the marks are an edit, so they survive a save and reopen', async () => {
    /*
     * Written into the .fluxseq rather than held in memory, because "the part
     * I am going to render" is a decision about this cut. Losing it on reopen
     * would mean marking it again every session.
     */
    const state = await evaluate(
      cdp,
      SEED +
        `const { project } = window.__fluxDev;
         sequence.setRange(clips[1].start, clips[2].start + clips[2].duration);
         const before = sequence.renderRange();
         await project.saveProject();
         const root = project.getProject().root;
         project.closeProject();
         await new Promise(r => setTimeout(r, 250));
         const opened = await project.openProject(root);
         if (!opened.ok) throw new Error(opened.error);
         await new Promise(r => setTimeout(r, 900));
         const after = sequence.renderRange();
         return {
           before: { start: before.start, end: before.end },
           after: { start: after.start, end: after.end, marked: after.marked },
         };`,
    )
    assert.equal(state.after.marked, true, 'the marks did not survive the reopen')
    assert.ok(
      Math.abs(state.after.start - state.before.start) < 1e-6 &&
        Math.abs(state.after.end - state.before.end) < 1e-6,
      `came back as ${state.after.start}–${state.after.end}, was ${state.before.start}–${state.before.end}`,
    )
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
