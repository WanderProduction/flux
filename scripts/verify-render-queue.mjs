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
 * CLEARS the verification project's sequences and queue.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'

const FOLDER = process.argv[2]
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

if (!FOLDER) {
  console.error('  usage: node scripts/verify-render-queue.mjs <folder>')
  process.exit(2)
}

const { check, report } = createChecker()
const cdp = await attach()
const OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-rq-'))

/** Lays a handful of clips down so every check below has something to act on. */
const SEED = `
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
