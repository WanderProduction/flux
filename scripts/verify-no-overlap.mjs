/**
 * Hunts for clips that end up on top of each other.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-no-overlap.mjs [runs] [seed]
 *
 * The reported symptom is "sometimes": ripple delete leaves clips colliding,
 * and dragging one onto a cut point makes it vanish. Sometimes is what a fuzz
 * loop is for — this drives real editing operations in a seeded random order
 * and checks two invariants after **every single one**:
 *
 *   1. **No two clips on one track overlap.** A track is a lane; two clips in
 *      it at the same moment is not a picture anyone asked for, and it is the
 *      state the user is describing.
 *   2. **No clip disappears except when something removed it.** A move is not
 *      a delete. The count before and after is checked against what the
 *      operation was allowed to change.
 *
 * It reports the *first* violation with the exact operation sequence that
 * produced it, so the repro is minimisable rather than a story about an
 * afternoon.
 *
 * Seeded, so a failing run is re-runnable: the seed is printed on every run
 * and can be passed back as the second argument.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'

const RUNS = Number(process.argv[2]) || 300
const SEED = Number(process.argv[3]) || Math.floor(Math.random() * 1e9)
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')
const FIXTURE = path.join(os.homedir(), 'flux-media-test', 'clipA.mp4')

const { check, report } = createChecker()
const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

console.log(`  seed ${SEED}, ${RUNS} operations\n`)

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  await check('no operation leaves two clips on one track overlapping', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence, assets, importPipeline } = window.__fluxDev;

       // A tiny seeded PRNG, so a failing run can be replayed exactly.
       let state = ${SEED} >>> 0;
       const rand = () => {
         state ^= state << 13; state >>>= 0;
         state ^= state >> 17;
         state ^= state << 5;  state >>>= 0;
         return state / 4294967296;
       };
       const pick = (list) => list[Math.floor(rand() * list.length)];

       const added = await importPipeline.importFiles(
         [{ path: ${JSON.stringify(FIXTURE)}, kind: 'video' }], 'link');
       const asset = added[0] ?? assets.getAssets().find(a => a.path === ${JSON.stringify(FIXTURE)});
       const probed = await assets.ensureProbed(asset.id);

       sequence.clearSequence();
       const video = sequence.getSequence().tracks.filter(t => t.kind === 'video');
       const lanes = video.map(t => t.id);

       // Eight clips across two tracks, butted and staggered, so there is
       // something for a ripple to close and something for a drag to collide
       // with.
       let at = 0;
       for (let i = 0; i < 8; i++) {
         sequence.addClip({
           assetId: asset.id,
           trackId: lanes[i % lanes.length],
           start: at,
           duration: probed.duration,
         });
         if (i % lanes.length === lanes.length - 1) at += probed.duration;
       }

       /** Two clips on one track sharing any time at all. */
       const overlapsIn = (clips) => {
         const byTrack = new Map();
         for (const clip of clips) {
           if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, []);
           byTrack.get(clip.trackId).push(clip);
         }
         const found = [];
         for (const [trackId, lane] of byTrack) {
           const sorted = lane.slice().sort((a, b) => a.start - b.start);
           for (let i = 1; i < sorted.length; i++) {
             const previous = sorted[i - 1];
             const current = sorted[i];
             const into = previous.start + previous.duration - current.start;
             // A strictly positive overlap. Touching exactly is correct and
             // is what butted clips do.
             if (into > 1e-9) {
               found.push({
                 trackId,
                 by: into,
                 a: { id: previous.id, start: previous.start, duration: previous.duration },
                 b: { id: current.id, start: current.start, duration: current.duration },
               });
             }
           }
         }
         return found;
       };

       const history = [];
       for (let step = 0; step < ${RUNS}; step++) {
         /*
          * Topped up rather than drained. Removal is part of the mix and the
          * bug needs neighbours to collide with, so without this the loop
          * empties the timeline after sixty operations and proves nothing.
          */
         if (sequence.getSequence().clips.length < 6) {
           const lane = pick(lanes);
           const end = sequence.getSequence().clips
             .filter(c => c.trackId === lane)
             .reduce((e, c) => Math.max(e, c.start + c.duration), 0);
           sequence.addClip({ assetId: asset.id, trackId: lane, start: end, duration: probed.duration });
         }
         const before = sequence.getSequence().clips;
         if (before.length === 0) break;
         const subject = pick(before);
         const frame = 1 / sequence.getSequence().settings.frameRate;

         // The operations a hand actually performs on a timeline.
         const moves = ['move', 'move', 'move', 'move', 'ripple', 'ripple', 'split', 'trim', 'remove'];
         const op = pick(moves);
         let detail = { op, clip: subject.id };

         if (op === 'move') {
           // Deliberately including landings exactly on a neighbour's edge,
           // which is the "drag it to a cut point" the report names.
           const others = before.filter(c => c.id !== subject.id);
           const edges = others.flatMap(c => [c.start, c.start + c.duration]);
           const target = edges.length && rand() < 0.7
             ? pick(edges)
             : Math.max(0, subject.start + (rand() - 0.5) * 4);
           const delta = target - subject.start;
           const lane = rand() < 0.25 ? pick(lanes) : subject.trackId;
           detail = { ...detail, delta, toTrack: lane };
           sequence.moveClips([subject.id], delta, lane === subject.trackId ? 0 : 1);
         } else if (op === 'ripple') {
           sequence.rippleDeleteClips([subject.id]);
         } else if (op === 'split') {
           const at = subject.start + subject.duration * (0.2 + rand() * 0.6);
           detail = { ...detail, at };
           sequence.splitClips(at, [subject.id]);
         } else if (op === 'trim') {
           const edge = rand() < 0.5 ? 'start' : 'end';
           const delta = (rand() - 0.5) * subject.duration;
           detail = { ...detail, edge, delta };
           sequence.trimClips([subject.id], edge, delta);
         } else {
           sequence.removeClips([subject.id]);
         }

         history.push(detail);
         const after = sequence.getSequence().clips;
         const bad = overlapsIn(after);
         if (bad.length > 0) {
           return {
             failed: true,
             step,
             op: detail,
             overlaps: bad,
             // Only the tail: the whole history is rarely needed and is long.
             recent: history.slice(-6),
             clips: after.length,
           };
         }

         // A move must never lose a clip.
         if (op === 'move' && after.length !== before.length) {
           return {
             failed: true,
             step,
             op: detail,
             vanished: before.length - after.length,
             recent: history.slice(-6),
           };
         }
       }
       return { failed: false, steps: history.length, clips: sequence.getSequence().clips.length };`,
    )

    if (result.failed) {
      const where = result.overlaps
        ? `overlap by ${result.overlaps[0].by.toFixed(6)}s on ${result.overlaps[0].trackId}`
        : `${result.vanished} clip(s) vanished on a move`
      assert.fail(
        `${where} at step ${result.step}\n` +
          `       operation: ${JSON.stringify(result.op)}\n` +
          `       detail:    ${JSON.stringify(result.overlaps ?? {})}\n` +
          `       recent:    ${JSON.stringify(result.recent)}\n` +
          `       replay:    node scripts/verify-no-overlap.mjs ${RUNS} ${SEED}`,
      )
    }
    console.log(`       ${result.steps} operations, ${result.clips} clips left, no overlap`)
  })

  await check('what is drawn does not overlap either', async () => {
    /*
     * The model invariant above can hold while the picture still shows clips
     * on top of each other, because a block's width is not its duration: it
     * has a floor, so that a clip too short to see is still clickable. Short
     * clips at a low zoom are therefore drawn wider than they are, and
     * consecutive ones run into each other.
     *
     * This measures the actual rectangles the browser laid out, per lane.
     */
    const result = await evaluate(
      cdp,
      `const { sequence, assets, importPipeline, commands } = window.__fluxDev;
       await commands.run('panel.focus.timeline');

       const added = await importPipeline.importFiles(
         [{ path: ${JSON.stringify(FIXTURE)}, kind: 'video' }], 'link');
       const asset = added[0] ?? assets.getAssets().find(a => a.path === ${JSON.stringify(FIXTURE)});
       await assets.ensureProbed(asset.id);

       sequence.clearSequence();
       const lane = sequence.getSequence().tracks.slice().reverse().find(t => t.kind === 'video');

       // Short clips, butted exactly: the frame grid makes every start an
       // exact multiple, so the MODEL is beyond reproach here.
       const rate = sequence.getSequence().settings.frameRate;
       const short = 2 / rate;
       let at = 0;
       for (let i = 0; i < 12; i++) {
         sequence.addClip({ assetId: asset.id, trackId: lane.id, start: at, duration: short });
         at += short;
       }

       /*
        * Zoomed out with the real lever.
        *
        * recordView does NOT reach the panel: its zoom is useState read once
        * at mount. Setting it there and then measuring measures whatever zoom
        * happened to be in effect, which is how a first attempt at this check
        * reported an overlap that had nothing to do with the zoom it named.
        */
       for (let i = 0; i < 14; i++) await commands.run('timeline.zoomOut');
       await new Promise(r => setTimeout(r, 700));

       const placed = sequence.getSequence().clips
         .filter(c => c.trackId === lane.id)
         .sort((a, b) => a.start - b.start);

       // The model, restated here so a failure cannot be blamed on it.
       let modelOverlap = 0;
       for (let i = 1; i < placed.length; i++) {
         const into = placed[i - 1].start + placed[i - 1].duration - placed[i].start;
         if (into > 1e-9) modelOverlap++;
       }

       const blocks = [...document.querySelectorAll('[data-clip-id]')]
         .map(el => ({ id: el.dataset.clipId, box: el.getBoundingClientRect() }))
         .filter(b => placed.some(c => c.id === b.id))
         .sort((a, b) => a.box.left - b.box.left);

       let drawnOverlap = 0;
       let worst = 0;
       for (let i = 1; i < blocks.length; i++) {
         const into = blocks[i - 1].box.right - blocks[i].box.left;
         if (into > 0.5) { drawnOverlap++; worst = Math.max(worst, into); }
       }

       const zoom = blocks.length > 1
         ? (blocks[1].box.left - blocks[0].box.left) / short
         : 0;
       return {
         zoom: Math.round(zoom * 100) / 100,
         clipSeconds: short,
         wouldBePx: Math.round(short * zoom * 100) / 100,
         clips: placed.length,
         drawnBlocks: blocks.length,
         modelOverlap,
         drawnOverlap,
         worstPx: Math.round(worst * 100) / 100,
         widths: blocks.slice(0, 3).map(b => Math.round(b.box.width * 100) / 100),
       };`,
    )

    console.log(
      `       ${result.clips} clips of ${result.clipSeconds.toFixed(3)}s at zoom ${result.zoom}: ` +
        `${result.wouldBePx.toFixed(2)}px of duration drawn as ${result.widths[0]}px`,
    )
    assert.equal(result.modelOverlap, 0, 'the model itself overlaps — a different bug')
    assert.equal(
      result.drawnOverlap,
      0,
      `${result.drawnOverlap} drawn blocks overlap, worst by ${result.worstPx}px, ` +
        `while the model has none`,
    )
  })

} finally {
  report()
  cdp.close()
}
