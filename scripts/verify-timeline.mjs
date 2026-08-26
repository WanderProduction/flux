/**
 * Verifies dragging assets from the Content Browser onto the Timeline.
 *
 * Drag and drop is synthesised with a real DataTransfer and real DragEvents
 * dispatched at the actual DOM nodes, so the app's own dragstart/dragover/drop
 * handlers run exactly as they do under a mouse. Nothing is stubbed.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-timeline.mjs [mediaDir]
 *
 * Expects fixtures in ~/flux-media-test. CLEARS the project's assets and
 * sequence so runs are repeatable.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  attach,
  createChecker,
  ensureProject,
  evaluate,
  requireFixtures,
  resetProject,
} from './cdp.mjs'

const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')
const dir = JSON.stringify(MEDIA_DIR)
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

const { check, report } = createChecker()
const cdp = await attach()

/**
 * Page-side helper: performs a full drag from a Content Browser card onto a
 * timeline lane, at a given time in seconds.
 */
const DRAG_HELPER = `
  window.__drag = async (assetName, trackIndex, atSeconds, zoom) => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.querySelector('.card-name')?.textContent === assetName);
    if (!card) throw new Error('no card named ' + assetName);

    const lane = document.querySelectorAll('.tl-lane')[trackIndex];
    if (!lane) throw new Error('no lane at index ' + trackIndex);

    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));

    const rect = lane.getBoundingClientRect();
    const clientX = rect.left + atSeconds * zoom;
    lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX }));
    lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX }));

    await new Promise(r => setTimeout(r, 700));
    return true;
  };
  return true;
`

try {
  // Shared reset: clears assets, the sequence, AND the Content Browser's view.
  // Running these suites back-to-back once failed purely because one left the
  // browser parked in a folder while the next assumed the project view.
  await ensureProject(cdp, VERIFY_PROJECT)
  await requireFixtures(cdp, MEDIA_DIR)
  await resetProject(cdp)

  await check('a new sequence has video tracks and no clips', async () => {
    const state = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const s = seq.getSequence();
       return { tracks: s.tracks.map(t => t.id), kinds: s.tracks.map(t => t.kind), clips: s.clips.length, fps: s.frameRate };`,
    )
    assert.deepEqual(state.tracks, ['V2', 'V1'])
    assert.deepEqual(state.kinds, ['video', 'video'])
    assert.equal(state.clips, 0)
    assert.equal(state.fps, 24)
  })

  await check('snapToFrame quantises to the frame grid', async () => {
    const result = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       return [seq.snapToFrame(1.0), seq.snapToFrame(1.019), seq.snapToFrame(1.03), seq.snapToFrame(-5)];`,
    )
    // At 24fps one frame is 1/24 = 0.041666s
    assert.equal(result[0], 1)
    assert.equal(result[1], 1) // rounds down to the nearest frame
    assert.ok(Math.abs(result[2] - 1 - 1 / 24) < 1e-9, `got ${result[2]}`)
    assert.equal(result[3], 0, 'negative time must clamp to zero')
  })

  await check('importing fixtures probes real durations', async () => {
    const info = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       assets.importAssets([
         { path: ${dir} + '\\\\clipA.mp4', kind: 'video' },
         { path: ${dir} + '\\\\shot_B.mp4', kind: 'video' },
         { path: ${dir} + '\\\\still.jpg', kind: 'image' },
       ]);
       await Promise.all(assets.getAssets().map(a => assets.ensureProbed(a.id)));
       return assets.getAssets().map(a => ({ name: a.name, duration: a.duration, w: a.width, h: a.height }));`,
    )
    const clipA = info.find((a) => a.name === 'clipA.mp4')
    assert.ok(Math.abs(clipA.duration - 4) < 0.15, `clipA should be ~4s, got ${clipA.duration}`)
    assert.equal(clipA.w, 640)
    assert.equal(clipA.h, 360)

    const still = info.find((a) => a.name === 'still.jpg')
    assert.equal(still.duration, 5, 'a still should take the default duration')
    assert.equal(still.w, 1024)
  })

  await evaluate(cdp, DRAG_HELPER)

  await check('dragging a video card onto a lane creates a clip', async () => {
    const clips = await evaluate(
      cdp,
      `await window.__drag('clipA.mp4', 1, 0, 60);
       const seq = window.__fluxDev.sequence;
       return seq.getSequence().clips.map(c => ({ track: c.trackId, start: c.start, duration: c.duration }));`,
    )
    assert.equal(clips.length, 1, 'expected exactly one clip')
    assert.equal(clips[0].track, 'V1', 'should land on the lane it was dropped on')
    assert.equal(clips[0].start, 0)
    assert.ok(Math.abs(clips[0].duration - 4) < 0.15, `clip should be source length, got ${clips[0].duration}`)
  })

  await check('the clip renders as a block sized to its duration', async () => {
    const block = await evaluate(
      cdp,
      `const until = async (fn, ms = 20000) => {
         const deadline = Date.now() + ms;
         while (Date.now() < deadline) {
           const v = fn();
           if (v) return v;
           await new Promise(r => setTimeout(r, 100));
         }
         return null;
       };
       const el = document.querySelector('.tl-lane .clip');
       // The block decodes its own thumbnail now, so wait for it rather than
       // assuming the Content Browser already put one in the cache.
       await until(() => el.querySelector('.clip-thumb'));
       return {
         label: el.querySelector('.clip-label')?.textContent,
         left: el.style.left,
         width: parseFloat(el.style.width),
         hasThumb: !!el.querySelector('.clip-thumb'),
       };`,
    )
    assert.equal(block.label, 'clipA.mp4')
    assert.equal(block.left, '0px')
    // 4s at 60px/s
    assert.ok(Math.abs(block.width - 240) < 10, `expected ~240px, got ${block.width}`)
    assert.equal(block.hasThumb, true, 'block should show the asset thumbnail')
  })

  await check('a clip has no waveform — it is a plain visual block', async () => {
    const hasWaveform = await evaluate(
      cdp,
      `return !!document.querySelector('.clip canvas, .clip .waveform, .clip svg');`,
    )
    assert.equal(hasWaveform, false)
  })

  await check('dropping onto an occupied spot slides right instead of overlapping', async () => {
    const clips = await evaluate(
      cdp,
      `await window.__drag('shot_B.mp4', 1, 1, 60);
       const seq = window.__fluxDev.sequence;
       return seq.getSequence().clips
         .filter(c => c.trackId === 'V1')
         .sort((a,b) => a.start - b.start)
         .map(c => ({ start: c.start, end: c.start + c.duration }));`,
    )
    assert.equal(clips.length, 2)
    assert.ok(
      clips[1].start >= clips[0].end - 1e-9,
      `second clip starts at ${clips[1].start} but first ends at ${clips[0].end} — they overlap`,
    )
  })

  await check('no two clips on a track ever overlap', async () => {
    const overlaps = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const byTrack = {};
       for (const c of seq.getSequence().clips) (byTrack[c.trackId] ??= []).push(c);
       let bad = 0;
       for (const list of Object.values(byTrack)) {
         list.sort((a,b) => a.start - b.start);
         for (let i = 1; i < list.length; i++)
           if (list[i].start < list[i-1].start + list[i-1].duration - 1e-9) bad++;
       }
       return bad;`,
    )
    assert.equal(overlaps, 0)
  })

  await check('a drop lands on the track it was aimed at, not the first free one', async () => {
    const clip = await evaluate(
      cdp,
      `await window.__drag('clipA.mp4', 0, 0, 60);
       const seq = window.__fluxDev.sequence;
       const v2 = seq.getSequence().clips.filter(c => c.trackId === 'V2');
       return { count: v2.length, start: v2[0]?.start };`,
    )
    assert.equal(clip.count, 1, 'V2 should have received the drop')
    assert.equal(clip.start, 0, 'V2 was empty, so it should start where dropped')
  })

  await check('the same asset can be placed more than once', async () => {
    const count = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const assets = window.__fluxDev.assets;
       const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
       return seq.getSequence().clips.filter(c => c.assetId === a.id).length;`,
    )
    assert.ok(count >= 2, `expected clipA used twice, got ${count}`)
  })

  await check('an image drops as a block with the still-image duration', async () => {
    const clip = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const before = seq.getSequence().clips.length;
       await window.__drag('still.jpg', 0, 20, 60);
       const clips = seq.getSequence().clips;
       const assets = window.__fluxDev.assets;
       const still = assets.getAssets().find(a => a.name === 'still.jpg');
       const placed = clips.find(c => c.assetId === still.id);
       return { added: clips.length - before, duration: placed?.duration };`,
    )
    assert.equal(clip.added, 1)
    assert.equal(clip.duration, 5)
  })

  await check('a drag carrying no FLUX payload is ignored', async () => {
    const result = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const before = seq.getSequence().clips.length;
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       dt.setData('text/plain', 'some text from elsewhere');
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: rect.left + 400 }));
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left + 400 }));
       await new Promise(r => setTimeout(r, 300));
       return { before, after: seq.getSequence().clips.length };`,
    )
    assert.equal(result.after, result.before, 'a foreign drag must not create a clip')
  })

  await check('selecting a clip and deleting removes it from the sequence', async () => {
    const result = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const before = seq.getSequence().clips.length;
       document.querySelector('.tl-lane .clip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
       await new Promise(r => setTimeout(r, 150));
       const selected = !!document.querySelector('.clip--selected');
       const cmds = window.__fluxDev.commands;
       await cmds.run('timeline.deleteSelected');
       await new Promise(r => setTimeout(r, 250));
       return { selected, before, after: seq.getSequence().clips.length };`,
    )
    assert.equal(result.selected, true, 'clicking a clip should select it')
    assert.equal(result.after, result.before - 1)
  })

  await check('deleting a clip leaves the asset in the project', async () => {
    const names = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       return assets.getAssets().map(a => a.name).sort();`,
    )
    assert.deepEqual(names, ['clipA.mp4', 'shot_B.mp4', 'still.jpg'])
  })

  await check('removing an asset orphans its clips rather than deleting them', async () => {
    const result = await evaluate(
      cdp,
      `const { assets, sequence: seq } = window.__fluxDev;
       const target = assets.getAssets().find(a => a.name === 'shot_B.mp4');
       const clipsUsing = seq.getSequence().clips.filter(c => c.assetId === target.id).length;
       assets.removeAssets([target.id]);
       await new Promise(r => setTimeout(r, 300));
       return {
         clipsUsing,
         stillThere: seq.getSequence().clips.filter(c => c.assetId === target.id).length,
         orphanBlocks: document.querySelectorAll('.clip--orphan').length,
       };`,
    )
    assert.ok(result.clipsUsing > 0, 'fixture should have had a clip using this asset')
    assert.equal(result.stillThere, result.clipsUsing, 'editing work must survive a bin removal')
    assert.ok(result.orphanBlocks > 0, 'orphaned clips should be visibly flagged')
  })

  await check('zoom changes block width without moving clips in time', async () => {
    const result = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const cmds = window.__fluxDev.commands;
       const before = document.querySelector('.tl-lane .clip');
       const w1 = parseFloat(before.style.width);
       const starts1 = seq.getSequence().clips.map(c => c.start);
       await cmds.run('timeline.zoomIn');
       await new Promise(r => setTimeout(r, 250));
       const w2 = parseFloat(document.querySelector('.tl-lane .clip').style.width);
       const starts2 = seq.getSequence().clips.map(c => c.start);
       await cmds.run('timeline.zoomOut');
       return { w1, w2, sameStarts: JSON.stringify(starts1) === JSON.stringify(starts2) };`,
    )
    assert.ok(result.w2 > result.w1, `zoom in should widen blocks (${result.w1} -> ${result.w2})`)
    assert.equal(result.sameStarts, true, 'zoom must not alter clip times')
  })

  await check('a saved sequence survives a reload', async () => {
    // Saved, explicitly. There is no autosave: clips only reach the document
    // when the user asks, so a reload is exactly as forgiving as the last Ctrl S.
    const before = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       return seq.getSequence().clips.map(c => [c.trackId, Math.round(c.start * 1000), Math.round(c.duration * 1000)]);`,
    )
    await evaluate(
      cdp,
      `const { store, project } = window.__fluxDev;
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       location.reload();
       return true;`,
    )
    await new Promise((r) => setTimeout(r, 2500))
    // A reload lands on the launcher; reopen before asserting persistence.
    await ensureProject(cdp, VERIFY_PROJECT)
    const after = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const seq = window.__fluxDev.sequence;
       for (let i = 0; i < 40 && !seq.isSequenceLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       return seq.getSequence().clips.map(c => [c.trackId, Math.round(c.start * 1000), Math.round(c.duration * 1000)]);`,
    )
    assert.ok(before.length > 0, 'fixture should have clips to persist')
    assert.deepEqual(after, before)
  })

  await check('clip blocks render after reload', async () => {
    const count = await evaluate(
      cdp,
      `for (let i = 0; i < 40; i++) {
         const n = document.querySelectorAll('.tl-lane .clip').length;
         if (n > 0) return n;
         await new Promise(r => setTimeout(r, 250));
       }
       return 0;`,
    )
    assert.ok(count > 0, 'restored clips should be drawn')
  })

  await check('applying a project document does not mark it unsaved', async () => {
    // The state modules notify on every change and kernel/project.ts listens to
    // mark the project dirty, so *opening* one used to claim unsaved work
    // before the user had touched anything - the asset path re-check runs just
    // after open and touches every asset.
    const result = await evaluate(
      cdp,
      `const { project, assets } = window.__fluxDev;
       const root = project.getProject().root;
       await project.saveProject();
       project.closeProject();
       await new Promise(r => setTimeout(r, 200));
       const r = await project.openProject(root);
       if (!r.ok) throw new Error(r.error);
       // Wait past the path re-check, which is async.
       await new Promise(r => setTimeout(r, 1200));
       return { dirty: project.isDirty(), assets: assets.getAssets().length };`,
    )
    assert.equal(result.dirty, false, 'a freshly opened saved project has nothing to save')
  })

  await check('editing after an open does mark it unsaved again', async () => {
    const dirty = await evaluate(
      cdp,
      `const { project, sequence, assets } = window.__fluxDev;
       const asset = assets.getAssets()[0];
       if (!asset) throw new Error('fixture project has no assets');
       sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 30, duration: 2 });
       await new Promise(r => setTimeout(r, 200));
       return project.isDirty();`,
    )
    assert.equal(dirty, true, 'a real edit must mark the project unsaved')
  })

  await check('the sequence survives save, close and reopen', async () => {
    const result = await evaluate(
      cdp,
      `const { project, sequence } = window.__fluxDev;
       const before = sequence.getSequence().clips
         .map(c => [c.trackId, Math.round(c.start * 1000), Math.round(c.duration * 1000)])
         .sort();
       await project.saveProject();
       const root = project.getProject().root;
       project.closeProject();
       await new Promise(r => setTimeout(r, 200));
       const r = await project.openProject(root);
       if (!r.ok) throw new Error(r.error);
       await new Promise(r => setTimeout(r, 500));
       const after = sequence.getSequence().clips
         .map(c => [c.trackId, Math.round(c.start * 1000), Math.round(c.duration * 1000)])
         .sort();
       return { before, after, dirty: project.isDirty() };`,
    )
    assert.ok(result.before.length > 0, 'fixture should have clips to persist')
    assert.deepEqual(result.after, result.before)
    assert.equal(result.dirty, false)
  })

  await check('the timeline reopens at the zoom it was saved at', async () => {
    // Through the panel, not the store: the zoom is React state initialised at
    // mount, so a value that round-trips through the document but never reaches
    // the component would look saved and behave as though it never was.
    const result = await evaluate(
      cdp,
      `const { project, commands, view } = window.__fluxDev;
       const widthOf = () => document.querySelector('.tl-lane .clip')?.getBoundingClientRect().width;
       const before = widthOf();
       if (!before) throw new Error('no clip on screen to measure');

       await commands.run('timeline.zoomIn');
       await commands.run('timeline.zoomIn');
       await new Promise(r => setTimeout(r, 300));
       const zoomed = widthOf();
       const savedZoom = view.getView().timeline.zoom;
       await project.saveProject();

       const root = project.getProject().root;
       project.closeProject();
       for (let i = 0; i < 40 && !document.querySelector('.launcher'); i++)
         await new Promise(r => setTimeout(r, 100));
       const r = await project.openProject(root);
       if (!r.ok) throw new Error(r.error);
       for (let i = 0; i < 40 && !document.querySelector('.tl-lane .clip'); i++)
         await new Promise(r => setTimeout(r, 100));
       await new Promise(r => setTimeout(r, 300));

       return { before, zoomed, savedZoom, after: widthOf(),
                restoredZoom: view.getView().timeline.zoom };`,
    )
    assert.ok(result.zoomed > result.before, 'zooming in should have widened the block')
    assert.equal(result.restoredZoom, result.savedZoom)
    assert.ok(
      Math.abs(result.after - result.zoomed) < 1,
      `the block came back ${result.after}px wide, not the ${result.zoomed}px it was saved at`,
    )
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
