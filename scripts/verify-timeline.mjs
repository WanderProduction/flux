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
    const before = window.__fluxDev.sequence.getSequence().clips.length;
    lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX }));
    lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX }));

    // Wait for the clip, not for a duration. A drop has to learn the asset's
    // length before it can place anything, and that is a real decode competing
    // with whatever else is decoding - the Viewer now holds a <video> of its
    // own. A fixed sleep here passed for months and then started losing that
    // race, which is exactly the failure mode the rule about conditions exists
    // to prevent.
    for (let i = 0; i < 150; i++) {
      if (window.__fluxDev.sequence.getSequence().clips.length > before) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('dropping ' + assetName + ' never produced a clip');
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

  await check('a new sequence has video above audio, and no clips', async () => {
    const state = await evaluate(
      cdp,
      `const seq = window.__fluxDev.sequence;
       const s = seq.getSequence();
       return { tracks: s.tracks.map(t => t.id), kinds: s.tracks.map(t => t.kind), clips: s.clips.length, fps: s.frameRate };`,
    )
    // The order is the stacking order: video upward because a higher layer is
    // in front, audio downward because sound only ever sums.
    assert.deepEqual(state.tracks, ['V2', 'V1', 'A1', 'A2'])
    assert.deepEqual(state.kinds, ['video', 'video', 'audio', 'audio'])
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
       // Press and release, not a synthesised 'click': selection settles on
       // pointerdown now, because a drag has to move what is already selected.
       const el = document.querySelector('.tl-lane .clip');
       const box = el.getBoundingClientRect();
       const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
       el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, ...at }));
       el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, ...at }));
       await new Promise(r => setTimeout(r, 200));
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

  // ── dropping a file that is not in the project yet ────────────

  await check('a file card carries its path, not an asset id', async () => {
    // The two payloads are what tell the Timeline whether a drop is a
    // placement or an import-then-placement.
    const types = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       // Browse to the fixtures the way a user would: Quick > Home, then in.
       const home = [...document.querySelectorAll('.cb-quick-item')]
         .find(b => b.textContent.trim() === 'Home');
       home.click();
       for (let i = 0; i < 60 && !document.querySelector('.card--folder'); i++)
         await new Promise(r => setTimeout(r, 100));
       const folder = [...document.querySelectorAll('.card--folder')]
         .find(c => c.querySelector('.card-name')?.textContent === 'flux-media-test');
       if (!folder) throw new Error('fixture folder not listed under Home');
       folder.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       for (let i = 0; i < 60; i++) {
         if (document.querySelector('.cb-crumb--current')?.textContent === 'flux-media-test') break;
         await new Promise(r => setTimeout(r, 100));
       }
       const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'shot_B.mp4');
       if (!card) throw new Error('shot_B.mp4 not on screen');
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       return [...dt.types];`,
    )
    assert.deepEqual(types, ['application/x-flux-files'])
  })

  await check('dropping an un-imported file asks how to import it', async () => {
    // The question has to reach the Timeline. It has no dialog of its own, so
    // this is really a check that the import pipeline is shared rather than
    // duplicated inside the Content Browser.
    const state = await evaluate(
      cdp,
      `const { importMode, sequence, assets } = window.__fluxDev;
       importMode.setImportMode('ask');
       sequence.clearSequence();
       assets.removeAssets(assets.getAssets()
         .filter(a => a.name === 'shot_B.mp4').map(a => a.id));
       await new Promise(r => setTimeout(r, 200));

       const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'shot_B.mp4');
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));

       for (let i = 0; i < 60 && !document.querySelector('.dialog'); i++)
         await new Promise(r => setTimeout(r, 100));
       return { dialog: !!document.querySelector('.dialog'),
                clips: sequence.getSequence().clips.length };`,
    )
    assert.equal(state.dialog, true, 'the copy-or-link question should be on screen')
    assert.equal(state.clips, 0, 'nothing is placed until the question is answered')
  })

  await check('answering it imports the file and places the clip', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence, assets } = window.__fluxDev;
       const link = [...document.querySelectorAll('.dialog button')]
         .find(b => /leave the files|origin|link/i.test(b.textContent));
       if (!link) throw new Error('no link choice in the dialog');
       link.click();

       // Two separate waits, reported separately. The import is immediate; the
       // clip needs the asset's duration, which is a real decode and can be
       // slow behind whatever else has been decoding. Collapsing them into one
       // timeout makes a slow probe look like a failed import.
       const found = (n) => assets.getAssets().find(a => a.name === n);
       for (let i = 0; i < 100 && !found('shot_B.mp4'); i++)
         await new Promise(r => setTimeout(r, 100));
       const asset = found('shot_B.mp4');

       for (let i = 0; i < 200 && sequence.getSequence().clips.length === 0; i++)
         await new Promise(r => setTimeout(r, 100));
       const clip = sequence.getSequence().clips[0];

       return { imported: !!asset, name: asset?.name, inProject: asset?.inProject ?? false,
                placed: !!clip, sameAsset: clip ? clip.assetId === asset?.id : null,
                duration: clip ? Math.round(clip.duration * 100) / 100 : null,
                dialogGone: !document.querySelector('.dialog') };`,
    )
    assert.equal(state.imported, true, 'the dropped file should now be a project asset')
    assert.equal(state.name, 'shot_B.mp4')
    assert.equal(state.inProject, false, 'Origin leaves the file where it was')
    assert.equal(state.placed, true, 'and the drop should have placed a clip')
    assert.equal(state.sameAsset, true, 'the clip should play the file that was dropped')
    assert.ok(state.duration > 0, 'the clip should be as long as the media, not a guess')
    assert.equal(state.dialogGone, true)
  })

  await check('cancelling the question imports nothing and places nothing', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence, assets, importMode } = window.__fluxDev;
       importMode.setImportMode('ask');
       sequence.clearSequence();
       const before = assets.getAssets().length;

       const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'render.webm');
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       for (let i = 0; i < 60 && !document.querySelector('.dialog'); i++)
         await new Promise(r => setTimeout(r, 100));

       document.querySelector('.dialog').dispatchEvent(
         new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await new Promise(r => setTimeout(r, 800));
       return { before, after: assets.getAssets().length,
                clips: sequence.getSequence().clips.length,
                dialogGone: !document.querySelector('.dialog') };`,
    )
    assert.equal(state.dialogGone, true, 'Escape should dismiss the question')
    assert.equal(state.after, state.before, 'cancelling must import nothing')
    assert.equal(state.clips, 0, 'and place nothing')
  })

  await check('a drop with a remembered preference skips the question', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence, assets, importMode } = window.__fluxDev;
       importMode.setImportMode('link');
       sequence.clearSequence();

       const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'render.webm');
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       for (let i = 0; i < 80 && sequence.getSequence().clips.length === 0; i++)
         await new Promise(r => setTimeout(r, 100));
       return { dialog: !!document.querySelector('.dialog'),
                clips: sequence.getSequence().clips.length,
                names: assets.getAssets().map(a => a.name).sort() };`,
    )
    assert.equal(state.dialog, false, 'a settled preference must not ask again')
    assert.equal(state.clips, 1)
    assert.ok(state.names.includes('render.webm'))
  })

  await check('a drag carrying nothing FLUX understands is refused', async () => {
    const clips = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const before = sequence.getSequence().clips.length;
       const lane = document.querySelectorAll('.tl-lane')[0];
       const dt = new DataTransfer();
       dt.setData('text/plain', 'C:/somewhere/else.mp4');
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       await new Promise(r => setTimeout(r, 500));
       return { before, after: sequence.getSequence().clips.length };`,
    )
    assert.equal(clips.after, clips.before, 'a plain-text drag is not an import')
  })

  // ── the wheel ─────────────────────────────────────────────────

  // Enough tracks to scroll past, and enough zoom to scroll along.
  await evaluate(
    cdp,
    `const { sequence, view } = window.__fluxDev;
     while (sequence.getSequence().tracks.length < 12) sequence.addTrack('video');
     // An absolute scale, not three zoomIn calls: relative steps from whatever
     // the last check left behind can land on MAX_ZOOM, where a zoom-in check
     // passes by doing nothing.
     view.recordView({ timeline: { zoom: 150 } });
     await new Promise(r => setTimeout(r, 400));

     // Dispatched at the panel root, cancelable, the way a real wheel arrives.
     window.__wheel = (opts) => {
       const root = document.querySelector('.tl');
       const box = root.getBoundingClientRect();
       const event = new WheelEvent('wheel', {
         bubbles: true, cancelable: true,
         clientX: opts.clientX ?? box.left + box.width / 2,
         clientY: box.top + box.height / 2,
         deltaY: opts.deltaY ?? 0, deltaX: opts.deltaX ?? 0,
         ctrlKey: !!opts.ctrlKey, altKey: !!opts.altKey,
       });
       return { defaultPrevented: !root.dispatchEvent(event) };
     };
     window.__lanes = () => document.querySelector('.tl-scroll');
     return true;`,
  )

  await check('the timeline has room to scroll in both directions', async () => {
    // The checks below are meaningless against content that fits: a scroll that
    // cannot move looks exactly like a handler that does not work.
    const box = await evaluate(
      cdp,
      `const l = window.__lanes();
       return { scrollW: l.scrollWidth, clientW: l.clientWidth,
                scrollH: l.scrollHeight, clientH: l.clientHeight };`,
    )
    assert.ok(box.scrollW > box.clientW, `no horizontal overflow: ${JSON.stringify(box)}`)
    assert.ok(box.scrollH > box.clientH, `no vertical overflow: ${JSON.stringify(box)}`)
  })

  await check('scrolling with no modifier travels time, not tracks', async () => {
    // The bare gesture is horizontal because a timeline is a horizontal
    // surface — the axis you move along all day should not need a modifier.
    const state = await evaluate(
      cdp,
      `const l = window.__lanes();
       l.scrollLeft = 0; l.scrollTop = 0;
       await new Promise(r => setTimeout(r, 100));
       const r = window.__wheel({ deltaY: 300 });
       await new Promise(r => setTimeout(r, 200));
       return { ...r, left: l.scrollLeft, top: l.scrollTop };`,
    )
    assert.ok(state.left > 0, 'the wheel should have moved the timeline sideways')
    assert.equal(state.top, 0, 'and must not have moved it vertically')
    assert.equal(
      state.defaultPrevented,
      true,
      'unhandled, the page would scroll underneath the timeline as well',
    )
  })

  await check('a trackpad sideways swipe travels time too', async () => {
    const left = await evaluate(
      cdp,
      `const l = window.__lanes();
       l.scrollLeft = 0;
       await new Promise(r => setTimeout(r, 100));
       window.__wheel({ deltaX: 240 });
       await new Promise(r => setTimeout(r, 200));
       return l.scrollLeft;`,
    )
    assert.ok(left > 0, 'deltaX is the only signal a two-finger swipe gives')
  })

  await check('Ctrl and scroll travels tracks, and the names come with it', async () => {
    // A name column that has drifted out of step with its tracks is worse than
    // no name column at all.
    const state = await evaluate(
      cdp,
      `const l = window.__lanes();
       l.scrollLeft = 0; l.scrollTop = 0;
       await new Promise(r => setTimeout(r, 100));
       const r = window.__wheel({ deltaY: 200, ctrlKey: true });
       // Wait for the headers to catch up, not for a duration. Scroll events
       // are delivered when Chromium feels like it, and a fixed sleep here is a
       // check that passes on a quiet machine and fails on a busy one.
       const headers = document.querySelector('.tl-header-list');
       for (let i = 0; i < 100; i++) {
         if (l.scrollTop > 0 && headers.style.transform === 'translateY(' + -l.scrollTop + 'px)') break;
         await new Promise(r => setTimeout(r, 20));
       }
       return { ...r, top: l.scrollTop, left: l.scrollLeft, transform: headers.style.transform };`,
    )
    assert.ok(state.top > 0, 'Ctrl and scroll should have moved down the tracks')
    assert.equal(state.left, 0, 'and must not have moved along time')
    assert.equal(
      state.transform,
      `translateY(${-state.top}px)`,
      'the track headers must follow the lanes exactly',
    )
    assert.equal(
      state.defaultPrevented,
      true,
      'unhandled, Ctrl and wheel is Chromium page zoom and would zoom the whole app',
    )
  })

  await check('the ruler stays put while the tracks scroll under it', async () => {
    const state = await evaluate(
      cdp,
      `const l = window.__lanes();
       l.scrollTop = 160;
       await new Promise(r => setTimeout(r, 250));
       const ruler = document.querySelector('.tl-ruler').getBoundingClientRect();
       const box = l.getBoundingClientRect();
       return { offset: Math.round(ruler.top - box.top), top: l.scrollTop };`,
    )
    assert.ok(state.top > 0, 'the timeline should be scrolled down for this to mean anything')
    assert.equal(state.offset, 0, 'a timeline you cannot read the time off is not a timeline')
  })

  await check('Alt and scroll zooms', async () => {
    const state = await evaluate(
      cdp,
      `const { view } = window.__fluxDev;
       const l = window.__lanes();
       l.scrollTop = 0;
       // Mid-range, so there is headroom in both directions to measure.
       view.recordView({ timeline: { zoom: 150 } });
       await new Promise(r => setTimeout(r, 250));
       const before = view.getView().timeline.zoom;
       const r = window.__wheel({ deltaY: -400, altKey: true });
       await new Promise(r => setTimeout(r, 300));
       const zoomedIn = view.getView().timeline.zoom;
       window.__wheel({ deltaY: 400, altKey: true });
       await new Promise(r => setTimeout(r, 300));
       return { ...r, before, zoomedIn, zoomedOut: view.getView().timeline.zoom };`,
    )
    assert.ok(state.zoomedIn > state.before, `zoom went ${state.before} -> ${state.zoomedIn}`)
    assert.ok(state.zoomedOut < state.zoomedIn, 'and the other way back out')
    assert.equal(state.defaultPrevented, true)
  })

  await check('zooming keeps the time under the pointer where it was', async () => {
    // Without an anchor the timeline slides out from under the pointer on every
    // notch, and zooming in on a cut becomes zoom-then-hunt.
    const state = await evaluate(
      cdp,
      `const { view } = window.__fluxDev;
       const l = window.__lanes();
       view.recordView({ timeline: { zoom: 150 } });
       await new Promise(r => setTimeout(r, 250));
       l.scrollLeft = 200;
       await new Promise(r => setTimeout(r, 150));
       const box = l.getBoundingClientRect();
       const offsetInView = 260;
       const timeBefore = (offsetInView + l.scrollLeft) / view.getView().timeline.zoom;

       window.__wheel({ deltaY: -500, altKey: true, clientX: box.left + offsetInView });
       await new Promise(r => setTimeout(r, 350));

       const timeAfter = (offsetInView + l.scrollLeft) / view.getView().timeline.zoom;
       return { timeBefore, timeAfter, drift: Math.abs(timeAfter - timeBefore) };`,
    )
    assert.ok(state.timeBefore > 0, 'the pointer should be over real time to begin with')
    assert.ok(
      state.drift < 0.02,
      `the time under the pointer moved ${state.drift}s while zooming`,
    )
  })

  await check('a new track lands on top, where it can be seen', async () => {
    // Tracks are drawn in order and the first covers the others, so a video
    // track added underneath everything would be invisible the moment anything
    // is on V1 — which reads as the command having done nothing.
    const state = await evaluate(
      cdp,
      `const { sequence, commands } = window.__fluxDev;
       const before = sequence.getSequence().tracks.map(t => t.id);
       await commands.run('timeline.addTrack');
       await new Promise(r => setTimeout(r, 250));
       const after = sequence.getSequence().tracks.map(t => t.id);
       return { before, after,
                headers: [...document.querySelectorAll('.track-name')].map(e => e.textContent) };`,
    )
    assert.equal(state.after.length, state.before.length + 1)
    assert.ok(!state.before.includes(state.after[0]), 'the new track should be first')
    assert.deepEqual(state.headers, state.after, 'and the header column should agree')
  })

  await check('the last track cannot be removed', async () => {
    // A sequence with no tracks has nowhere to drop, and the timeline would be
    // a panel you cannot use with no way back.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 200));
       // Down to one by hand: a sequence handed in with no audio tracks is
       // repaired on the way in, so this state has to be reached the way a user
       // would reach it.
       let guard = 0;
       while (sequence.getSequence().tracks.length > 1 && guard++ < 20) {
         sequence.removeTrack(sequence.getSequence().tracks.at(-1).id);
       }
       const only = sequence.getSequence().tracks[0].id;
       const refused = sequence.removeTrack(only);
       return { refused, tracks: sequence.getSequence().tracks.length };`,
    )
    assert.equal(state.refused, false)
    assert.equal(state.tracks, 1)
  })

  // ── moving clips ──────────────────────────────────────────────

  /**
   * Two clips on V1 at a known scale: A at 0 for 4s, B `gap` seconds after it.
   *
   * The gap is a parameter because the checks below need two very different
   * ones. A wide gap leaves room to measure a plain move without the overlap
   * rule intervening. A narrow one — wider than a frame, narrower than the snap
   * tolerance — is the only window in which snapping is distinguishable from
   * the overlap rule producing the same answer by accident.
   */
  const seedClips = (gap) => `
    const { assets, sequence, view } = window.__fluxDev;
    sequence.setSequence(null);
    view.recordView({ timeline: { zoom: 60 } });
    const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
    const b = assets.getAssets().find(x => x.name === 'shot_B.mp4');
    if (!a || !b) throw new Error('fixtures not imported');
    const pa = await assets.ensureProbed(a.id), pb = await assets.ensureProbed(b.id);
    sequence.addClip({ assetId: a.id, trackId: 'V1', start: 0, duration: pa.duration });
    sequence.addClip({ assetId: b.id, trackId: 'V1', start: pa.duration + ${gap}, duration: pb.duration });
    await new Promise(r => setTimeout(r, 400));
  `

  await evaluate(
    cdp,
    `window.__clips = () => window.__fluxDev.sequence.getSequence().clips
       .slice().sort((p, q) => p.start - q.start)
       .map(c => [c.trackId, Math.round(c.start * 1000) / 1000]);

     /** Press a clip, travel, release — on the window, as a real pointer does. */
     window.__dragClip = async (index, dx, dy, opts = {}) => {
       const el = [...document.querySelectorAll('.tl-lane .clip')][index];
       if (!el) throw new Error('no clip at index ' + index);
       const box = el.getBoundingClientRect();
       const x = box.left + Math.min(24, box.width / 2), y = box.top + box.height / 2;
       const mk = (type, px, py) => new PointerEvent(type, {
         bubbles: true, cancelable: true, button: 0, pointerId: 7,
         clientX: px, clientY: py, altKey: !!opts.altKey, shiftKey: !!opts.shiftKey,
       });
       el.dispatchEvent(mk('pointerdown', x, y));
       for (let i = 1; i <= 4; i++) {
         window.dispatchEvent(mk('pointermove', x + (dx * i) / 4, y + (dy * i) / 4));
         await new Promise(r => setTimeout(r, 25));
       }
       window.dispatchEvent(mk('pointerup', x + dx, y + dy));
       await new Promise(r => setTimeout(r, 300));
       return window.__clips();
     };
     return true;`,
  )

  await check('dragging a clip sideways moves it in time', async () => {
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const before = window.__clips();
         // Alt off the snapping, so this measures the drag and nothing else.
         const after = await window.__dragClip(0, 60, 0, { altKey: true });
         return { before, after };`,
    )
    assert.deepEqual(state.before[0], ['V1', 0])
    assert.deepEqual(state.after[0], ['V1', 1], 'a 60px drag at 60px/s is one second')
    assert.deepEqual(state.after[1], state.before[1], 'the other clip should not have moved')
  })

  await check('dragging a clip up and down moves it between tracks', async () => {
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const up = await window.__dragClip(0, 0, -46, { altKey: true });
         const down = await window.__dragClip(0, 0, 46, { altKey: true });
         return { up, down, tracks: window.__fluxDev.sequence.getSequence().tracks.map(t => t.id) };`,
    )
    // V1 is the lower of the two video tracks, so "up" is V2.
    assert.deepEqual(state.tracks, ['V2', 'V1', 'A1', 'A2'])
    assert.equal(state.up[0][0], 'V2', 'dragging up should have changed track')
    assert.equal(state.down[0][0], 'V1', 'and dragging back down should undo it')
  })

  await check('a video clip cannot be dragged down onto an audio track', async () => {
    // Clamped, not refused: the drag should still do the part of itself that
    // can be done rather than snapping back for a reason nothing on screen
    // explains.
    //
    // The floor is the bottom of the *video* band, not the bottom of the track
    // list. There are audio tracks below V1 now, and a picture landing on one
    // would be a clip whose kind and track disagree — which every other rule
    // in sequence.ts assumes cannot happen.
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const down = await window.__dragClip(0, 60, 300, { altKey: true });
         return down;`,
    )
    assert.equal(state[0][0], 'V1', 'V1 is the last video track, so it stays there')
    assert.equal(state[0][1], 1, 'and the horizontal part of the drag still happened')
  })

  await check('a clip cannot be dragged before the start of the sequence', async () => {
    const state = await evaluate(
      cdp,
      seedClips(4) + `return await window.__dragClip(0, -600, 0, { altKey: true });`,
    )
    assert.equal(state[0][1], 0, 'the sequence starts at zero and so does the clip')
  })

  await check('a press that barely moves selects instead of dragging', async () => {
    // Without a threshold, selecting a clip is a coin toss: a click always
    // carries a pixel or two, and every one of them would nudge the edit.
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const before = window.__clips();
         const after = await window.__dragClip(0, 2, 1);
         return { before, after, selected: document.querySelectorAll('.clip--selected').length };`,
    )
    assert.deepEqual(state.after, state.before, 'nothing should have moved')
    assert.equal(state.selected, 1, 'but the clip should be selected')
  })

  await check('dragging into a neighbour closes the gap rather than leaping past it', async () => {
    // The midpoint rule. Short of the neighbour's centre butts up against it;
    // a nudge must not catapult the clip to the far side of the track.
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `const seq = window.__fluxDev.sequence;
         const dragged = seq.getSequence().clips.slice().sort((p, q) => p.start - q.start)[0];
         await window.__dragClip(0, 120, 0, { altKey: true });
         const now = seq.getSequence().clips.slice().sort((p, q) => p.start - q.start);
         const moved = now.find(c => c.id === dragged.id);
         const neighbour = now.find(c => c.id !== dragged.id);
         return {
           // Identity, not order. Sliding right lands the clip flush against
           // its neighbour too — on the far side of it — so "they are touching"
           // is true under both rules and tells us nothing.
           stayedBefore: moved.start < neighbour.start,
           flush: Math.abs(moved.start + moved.duration - neighbour.start) < 1e-6,
           movedForward: moved.start > 0,
         };`,
    )
    assert.equal(state.stayedBefore, true, 'a nudge must not catapult the clip past its neighbour')
    assert.equal(state.flush, true, 'it should end up flush against it')
    assert.equal(state.movedForward, true, 'and it should have moved toward it, not stayed put')
  })

  await check('dragging decisively across a neighbour reorders them', async () => {
    // The other half of the midpoint rule, and the whole point of being able to
    // drag at all: past the centre means past the clip.
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `const clips = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         const target = clips[1].start + clips[1].duration - 0.5;
         const after = await window.__dragClip(0, Math.round(target * 60), 0, { altKey: true });
         const now = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         const byName = now.map(c => c.assetId);
         return { after, first: byName[0] === clips[1].assetId,
                  overlap: now[1].start < now[0].start + now[0].duration - 1e-9 };`,
    )
    assert.equal(state.first, true, 'the clip that was second should now be first')
    assert.equal(state.overlap, false, 'and they must not be sitting on top of each other')
  })

  await check('a move never leaves two clips overlapping', async () => {
    const overlaps = await evaluate(
      cdp,
      `const byTrack = {};
       for (const c of window.__fluxDev.sequence.getSequence().clips) (byTrack[c.trackId] ??= []).push(c);
       let bad = 0;
       for (const list of Object.values(byTrack)) {
         list.sort((a, b) => a.start - b.start);
         for (let i = 1; i < list.length; i++) {
           if (list[i].start < list[i - 1].start + list[i - 1].duration - 1e-9) bad++;
         }
       }
       return bad;`,
    )
    assert.equal(overlaps, 0)
  })

  await check('snapping closes a gap too small to close by hand', async () => {
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `// A fifth of a second of gap; nudge the second clip 6px left, which
         // lands it short. Snapping should take it the rest of the way.
         await window.__dragClip(1, -6, 0);
         const now = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         return { gap: now[1].start - (now[0].start + now[0].duration) };`,
    )
    assert.ok(Math.abs(state.gap) < 1e-6, `left a gap of ${state.gap}s`)
  })

  await check('holding Alt leaves the gap exactly where it was put', async () => {
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `await window.__dragClip(1, -6, 0, { altKey: true });
         const now = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         return { gapFrames: (now[1].start - (now[0].start + now[0].duration)) * 24 };`,
    )
    assert.ok(state.gapFrames > 1, `Alt should have left a gap, got ${state.gapFrames} frames`)
  })

  await check('a multi-selection travels together, keeping its shape', async () => {
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const els = [...document.querySelectorAll('.tl-lane .clip')];
         const press = (el, opts) => {
           const b = el.getBoundingClientRect();
           const at = { clientX: b.left + 5, clientY: b.top + 5 };
           el.dispatchEvent(new PointerEvent('pointerdown',
             { bubbles: true, cancelable: true, button: 0, pointerId: 3, ...at, ...opts }));
           window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, ...at }));
         };
         press(els[0], {});
         press(els[1], { shiftKey: true });
         await new Promise(r => setTimeout(r, 250));
         const selected = document.querySelectorAll('.clip--selected').length;
         const before = window.__clips();
         const after = await window.__dragClip(0, 120, 0, { altKey: true });
         return { selected, before, after };`,
    )
    assert.equal(state.selected, 2, 'shift should have added the second clip to the selection')
    assert.equal(state.after[0][1] - state.before[0][1], 2, 'the first clip moved two seconds')
    assert.equal(
      state.after[1][1] - state.before[1][1],
      2,
      'and so did the second — the gap between them is part of the edit',
    )
  })

  await check('the playhead can be dragged by its handle', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       playback.seek(1);
       await new Promise(r => setTimeout(r, 250));
       const handle = document.querySelector('.tl-playhead-handle');
       if (!handle) throw new Error('the playhead has no handle to grab');
       const box = handle.getBoundingClientRect();
       const y = box.top + 60;
       handle.dispatchEvent(new PointerEvent('pointerdown',
         { bubbles: true, cancelable: true, clientX: box.left + 3, clientY: y }));
       window.dispatchEvent(new PointerEvent('pointermove',
         { bubbles: true, clientX: box.left + 123, clientY: y }));
       window.dispatchEvent(new PointerEvent('pointerup',
         { bubbles: true, clientX: box.left + 123, clientY: y }));
       await new Promise(r => setTimeout(r, 250));
       return { time: playback.getTime() };`,
    )
    assert.ok(
      Math.abs(state.time - 3) < 0.05,
      `dragging 120px at 60px/s from 1s should reach 3s, reached ${state.time}s`,
    )
  })

  await check('the playhead line does not swallow clicks meant for a clip', async () => {
    // It lies over every lane. If the whole line were grabbable, the clip
    // underneath it would be unselectable at exactly the time you are looking
    // at.
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `const { playback } = window.__fluxDev;
         const el = [...document.querySelectorAll('.tl-lane .clip')][0];
         const box = el.getBoundingClientRect();
         // Park the playhead over the middle of the clip, then press there.
         playback.seek(2);
         await new Promise(r => setTimeout(r, 250));
         const head = document.querySelector('.tl-playhead').getBoundingClientRect();
         const x = head.left + 40;
         el.dispatchEvent(new PointerEvent('pointerdown',
           { bubbles: true, cancelable: true, button: 0, pointerId: 5,
             clientX: x, clientY: box.top + box.height / 2 }));
         window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5 }));
         await new Promise(r => setTimeout(r, 200));
         return { selected: document.querySelectorAll('.clip--selected').length,
                  time: playback.getTime() };`,
    )
    assert.equal(state.selected, 1, 'pressing beside the playhead should select the clip')
    assert.equal(state.time, 2, 'and must not have scrubbed')
  })

  // ── sound, and the shape of it ────────────────────────────────

  /*
   * A file with audio lands as two clips: the picture on a video track and the
   * sound on an audio track, linked. What "linked" means is the whole of these
   * checks — they move together, they are selected together, and deleting one
   * deletes the other. Losing a take's sound by dragging its picture is not an
   * edit anyone means to make.
   *
   * voice_over.mp4 is the fixture with anything to say here: two seconds loud,
   * two seconds near-silent, three times over. A waveform drawn from audio that
   * never changes cannot show whether it is following the audio at all.
   */

  /*
   * The drag helper and voice_over.mp4 both have to be put back before this
   * section can run. A check above deliberately reloads the page, which takes
   * every page-side helper with it, and the fixture with the interesting audio
   * is not one the earlier checks import.
   */
  await evaluate(cdp, DRAG_HELPER)
  await evaluate(
    cdp,
    `const assets = window.__fluxDev.assets;
     if (!assets.getAssets().some(a => a.name === 'voice_over.mp4')) {
       assets.importAssets([{ path: ${dir} + '\\voice_over.mp4', kind: 'video' }]);
     }
     await Promise.all(assets.getAssets().map(a => assets.ensureProbed(a.id)));
     await new Promise(r => setTimeout(r, 300));
     return assets.getAssets().map(a => a.name);`,
  )

  /** Drops one fixture onto a lane by index and returns the sequence's clips. */
  const dropOne = (name, laneIndex, atSeconds = 0) => `
    const { sequence, view } = window.__fluxDev;
    sequence.setSequence(null);
    view.recordView({ timeline: { zoom: 60 } });
    await new Promise(r => setTimeout(r, 200));
    await window.__drag(${JSON.stringify(name)}, ${laneIndex}, ${atSeconds}, 60);
    await new Promise(r => setTimeout(r, 300));
  `

  await check('a file with sound lands as a picture and a sound, linked', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const clips = window.__fluxDev.sequence.getSequence().clips;
         return clips.map(c => ({ track: c.trackId, kind: c.kind, start: c.start, link: c.linkId }));`,
    )
    assert.equal(state.length, 2, `expected a pair, got ${state.length}`)
    const video = state.find((c) => c.kind === 'video')
    const audio = state.find((c) => c.kind === 'audio')
    assert.ok(video && audio, 'one of each')
    assert.equal(video.track, 'V1')
    assert.equal(audio.track, 'A1')
    assert.ok(video.link && video.link === audio.link, 'the two halves must share a link')
    assert.equal(audio.start, video.start, 'a pair that starts at two moments is a sync error')
  })

  await check('a file with no sound lands alone', async () => {
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `const clips = window.__fluxDev.sequence.getSequence().clips;
         return clips.map(c => ({ kind: c.kind, link: c.linkId ?? null }));`,
    )
    assert.deepEqual(state, [{ kind: 'video', link: null }])
  })

  await check('dragging the picture takes the sound with it', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const before = window.__clips();
         await window.__dragClip(0, 120, 0, { altKey: true });
         return { before, after: window.__clips() };`,
    )
    // Both halves, both at zero, before anything moves. Compared as sets: the
    // order two clips at the same moment come back in is not a rule, and
    // writing a check that depends on it would make it one by accident.
    assert.deepEqual(
      state.before.map((row) => row[0]).sort(),
      ['A1', 'V1'],
      state.before.join(' '),
    )
    assert.deepEqual(state.before.map((row) => row[1]), [0, 0])
    const starts = state.after.map((row) => row[1])
    assert.deepEqual(starts, [2, 2], `the pair ended up at ${starts.join(' and ')}`)
    assert.deepEqual(
      state.after.map((row) => row[0]).sort(),
      ['A1', 'V1'],
      'and neither half changed track',
    )
  })

  await check('moving one half of a pair moves both, whoever asks', async () => {
    /*
     * The panel expands a press through the link before it drags anything, so
     * the drag above would pass with or without the rule in the kernel. This is
     * the rule itself: anything that moves a clip — a command, a ripple edit,
     * something not written yet — gets it, because it is a fact about the
     * sequence rather than a courtesy of the panel that happens to be in front.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const video = sequence.getSequence().clips.find(c => c.kind === 'video');
         sequence.moveClips([video.id], 1.5, 0);
         await new Promise(r => setTimeout(r, 200));
         return sequence.getSequence().clips
           .map(c => ({ kind: c.kind, start: Math.round(c.start * 1000) / 1000 }));`,
    )
    assert.equal(state.length, 2)
    for (const clip of state) {
      assert.equal(clip.start, 1.5, `the ${clip.kind} half ended up at ${clip.start}s`)
    }
  })

  await check('dragging the picture down cannot strand it below its own sound', async () => {
    // The bands again, from the audio side: the pair is on V1 and A1, and a
    // drag downward has to be refused by the video half rather than quietly
    // pushing the audio to A2 on its own.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `await window.__dragClip(0, 0, 46, { altKey: true });
         return window.__fluxDev.sequence.getSequence().clips
           .map(c => c.kind + ':' + c.trackId).sort();`,
    )
    assert.deepEqual(state, ['audio:A1', 'video:V1'])
  })

  await check('pressing either half shows both selected', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const audio = [...document.querySelectorAll('.clip--audio')][0];
         if (!audio) throw new Error('no audio clip on screen');
         const box = audio.getBoundingClientRect();
         audio.dispatchEvent(new PointerEvent('pointerdown',
           { bubbles: true, cancelable: true, button: 0, pointerId: 7,
             clientX: box.left + 20, clientY: box.top + box.height / 2 }));
         window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
         await new Promise(r => setTimeout(r, 200));
         return document.querySelectorAll('.clip--selected').length;`,
    )
    assert.equal(state, 2, 'pressing the sound should light the picture too')
  })

  await check('deleting the picture deletes the sound', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const video = sequence.getSequence().clips.find(c => c.kind === 'video');
         const removed = sequence.removeClips([video.id]);
         return { removed, left: sequence.getSequence().clips.length };`,
    )
    assert.equal(state.removed, 2, 'removing one half must remove both')
    assert.equal(state.left, 0)
  })

  await check('dropped on an audio track, a file arrives as its sound alone', async () => {
    const state = await evaluate(
      cdp,
      // Lane 2 is A1: the lanes are drawn in track order, V2 V1 A1 A2.
      dropOne('voice_over.mp4', 2) +
        `return window.__fluxDev.sequence.getSequence().clips
           .map(c => c.kind + ':' + c.trackId);`,
    )
    assert.deepEqual(state, ['audio:A1'])
  })

  await check('a file with no sound is refused by an audio track', async () => {
    // Not laid down as a silent block: an audio clip that can never make a
    // noise is not something the timeline should be able to contain.
    const state = await evaluate(
      cdp,
      `const { sequence, view } = window.__fluxDev;
       sequence.setSequence(null);
       view.recordView({ timeline: { zoom: 60 } });
       await new Promise(r => setTimeout(r, 200));
       const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'clipA.mp4');
       const lane = document.querySelectorAll('.tl-lane')[2];
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('drop',
         { dataTransfer: dt, bubbles: true, clientX: rect.left + 10 }));
       await new Promise(r => setTimeout(r, 1200));
       return sequence.getSequence().clips.length;`,
    )
    assert.equal(state, 0, 'a silent file has nothing to put on an audio track')
  })

  await check('a sequence saved before audio tracks existed opens with them', async () => {
    // Older projects open, work, and save forward. The clips in one have no
    // kind, which is not wrong, only older — and the only answer that can be
    // right is the kind of the track they are already on.
    const state = await evaluate(
      cdp,
      `const { assets, sequence } = window.__fluxDev;
       const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
       sequence.setSequence({
         name: 'Old', frameRate: 24,
         tracks: [{ id: 'V2', kind: 'video', name: 'V2' }, { id: 'V1', kind: 'video', name: 'V1' }],
         clips: [{ id: 'c1', assetId: a.id, trackId: 'V1', start: 0, duration: 4 }],
       });
       await new Promise(r => setTimeout(r, 300));
       const s = sequence.getSequence();
       return { tracks: s.tracks.map(t => t.id), kinds: s.clips.map(c => c.kind) };`,
    )
    assert.deepEqual(state.tracks, ['V2', 'V1', 'A1', 'A2'])
    assert.deepEqual(state.kinds, ['video'])
  })

  // ── level, mute and solo ──────────────────────────────────────

  /** Puts every audio track back to unity and unmuted. */
  const PLAIN_TRACKS = `
    const { sequence } = window.__fluxDev;
    for (const track of sequence.getSequence().tracks) {
      sequence.setTrackMuted(track.id, false);
      sequence.setTrackSolo(track.id, false);
      sequence.setTrackGain(track.id, 0);
    }
    await new Promise(r => setTimeout(r, 100));`

  await check('a new track is at unity, unmuted and unsoloed', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 200));
       return sequence.getSequence().tracks
         .map(t => ({ id: t.id, gain: t.gain, muted: t.muted, solo: t.solo }));`,
    )
    for (const track of state) {
      assert.equal(track.gain, 0, `${track.id} starts at ${track.gain}dB`)
      assert.equal(track.muted, false)
      assert.equal(track.solo, false)
    }
  })

  await check('solo picks the subset and mute silences within it', async () => {
    // The rule, stated as the truth table it is. Each button keeps meaning one
    // thing rather than one quietly overriding the other.
    const state = await evaluate(
      cdp,
      PLAIN_TRACKS +
        `const audible = () => sequence.getSequence().tracks
           .filter(t => t.kind === 'audio')
           .map(t => t.id + ':' + (sequence.isTrackAudible(t) ? 'on' : 'off'))
           .join(' ');
         const rows = { plain: audible() };
         sequence.setTrackMuted('A1', true);
         rows.mutedA1 = audible();
         sequence.setTrackMuted('A1', false);
         sequence.setTrackSolo('A2', true);
         rows.soloA2 = audible();
         sequence.setTrackSolo('A1', true);
         rows.soloBoth = audible();
         sequence.setTrackMuted('A1', true);
         rows.soloBothMutedA1 = audible();
         return rows;`,
    )
    assert.equal(state.plain, 'A1:on A2:on')
    assert.equal(state.mutedA1, 'A1:off A2:on')
    assert.equal(state.soloA2, 'A1:off A2:on', 'soloing one track must silence the others')
    assert.equal(state.soloBoth, 'A1:on A2:on', 'soloing both is the same as soloing neither')
    assert.equal(
      state.soloBothMutedA1,
      'A1:off A2:on',
      'a soloed track that is also muted must stay silent',
    )
  })

  await check('a level cannot be pushed past the ends of the fader', async () => {
    const state = await evaluate(
      cdp,
      PLAIN_TRACKS +
        `const set = (db) => { sequence.setTrackGain('A1', db);
           return sequence.getSequence().tracks.find(t => t.id === 'A1').gain; };
         return { low: set(-500), high: set(500), nan: set(NaN), fine: set(-6.5) };`,
    )
    assert.equal(state.low, -60, 'the bottom of the fader')
    assert.equal(state.high, 12, 'and the top')
    assert.equal(state.nan, 0, 'a level that is not a number is unity, not silence')
    assert.equal(state.fine, -6.5, 'and anything in between is kept as it was set')
  })

  await check('a track saved before it had a level opens at unity', async () => {
    // Older projects again: no level is not the same as a level of zero, and
    // reading it as silence would open someone's project mute.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence({
         name: 'Old', frameRate: 24,
         tracks: [{ id: 'V1', kind: 'video', name: 'V1' },
                  { id: 'A1', kind: 'audio', name: 'A1' }],
         clips: [],
       });
       await new Promise(r => setTimeout(r, 200));
       return sequence.getSequence().tracks
         .map(t => ({ id: t.id, gain: t.gain, muted: t.muted, solo: t.solo }));`,
    )
    const a1 = state.find((track) => track.id === 'A1')
    assert.ok(a1, 'the audio track should have survived')
    assert.equal(a1.gain, 0)
    assert.equal(a1.muted, false)
    assert.equal(a1.solo, false)
  })

  await check('the header shows a track that something else has soloed as silent', async () => {
    // Muted and "silenced by another track's solo" are different states with
    // the same outcome, so the row dims for either while the M button keeps
    // showing only what it is itself doing.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const read = () => [...document.querySelectorAll('.tl-header--audio')].map(h => ({
         name: h.querySelector('.track-name').textContent,
         silent: h.querySelector('.track-controls').className.includes('--silent'),
         muteOn: h.querySelector('.track-toggle').className.includes('--on'),
       }));
       const plain = read();
       sequence.setTrackSolo('A2', true);
       await new Promise(r => setTimeout(r, 250));
       const soloed = read();
       sequence.setTrackSolo('A2', false);
       await new Promise(r => setTimeout(r, 250));
       return { plain, soloed };`,
    )
    assert.deepEqual(
      state.plain.map((row) => row.silent),
      [false, false],
      'nothing should read as silent to begin with',
    )
    const a1 = state.soloed.find((row) => row.name === 'A1')
    const a2 = state.soloed.find((row) => row.name === 'A2')
    assert.equal(a1.silent, true, 'A1 is silenced by A2 being soloed')
    assert.equal(a1.muteOn, false, 'but it is not muted, and must not claim to be')
    assert.equal(a2.silent, false, 'the soloed track is the one being heard')
  })

  await check('clicking M and S in the header changes the track', async () => {
    // Through the DOM, because a control nobody can reach is not a control.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const header = [...document.querySelectorAll('.tl-header--audio')]
         .find(h => h.querySelector('.track-name').textContent === 'A1');
       const [mute, solo] = header.querySelectorAll('.track-toggle');
       mute.click();
       await new Promise(r => setTimeout(r, 150));
       const afterMute = sequence.getSequence().tracks.find(t => t.id === 'A1');
       solo.click();
       await new Promise(r => setTimeout(r, 150));
       const afterSolo = sequence.getSequence().tracks.find(t => t.id === 'A1');
       mute.click();
       solo.click();
       await new Promise(r => setTimeout(r, 150));
       const afterAgain = sequence.getSequence().tracks.find(t => t.id === 'A1');
       return {
         afterMute: { muted: afterMute.muted, solo: afterMute.solo },
         afterSolo: { muted: afterSolo.muted, solo: afterSolo.solo },
         afterAgain: { muted: afterAgain.muted, solo: afterAgain.solo },
       };`,
    )
    assert.deepEqual(state.afterMute, { muted: true, solo: false })
    assert.deepEqual(state.afterSolo, { muted: true, solo: true })
    assert.deepEqual(state.afterAgain, { muted: false, solo: false }, 'both must toggle back off')
  })

  await check('dragging the level readout rides the level', async () => {
    // A fader is a gesture. Dragged through the same window listeners a real
    // pointer drives, for the reason the clip drag gives at length.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const header = [...document.querySelectorAll('.tl-header--audio')]
         .find(h => h.querySelector('.track-name').textContent === 'A1');
       const readout = header.querySelector('.track-gain');
       const box = readout.getBoundingClientRect();
       const x = box.left + box.width / 2, y = box.top + box.height / 2;

       readout.dispatchEvent(new PointerEvent('pointerdown',
         { bubbles: true, cancelable: true, button: 0, pointerId: 9, clientX: x, clientY: y }));
       for (const dx of [10, 20, 40]) {
         window.dispatchEvent(new PointerEvent('pointermove',
           { bubbles: true, pointerId: 9, clientX: x - dx, clientY: y }));
       }
       window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
       await new Promise(r => setTimeout(r, 200));
       const dragged = sequence.getSequence().tracks.find(t => t.id === 'A1').gain;
       const shown = readout.textContent;

       readout.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       await new Promise(r => setTimeout(r, 200));
       const reset = sequence.getSequence().tracks.find(t => t.id === 'A1').gain;
       return { dragged, shown, reset };`,
    )
    // Forty pixels left at a quarter of a decibel each.
    assert.equal(state.dragged, -10, `dragging left gave ${state.dragged}dB`)
    assert.equal(state.shown, '-10.0', `the readout said ${state.shown}`)
    assert.equal(state.reset, 0, 'double-click should put it back to unity')
  })

  // ── the waveform ──────────────────────────────────────────────

  /**
   * The inked height of one column of a waveform canvas, in backing pixels.
   *
   * Reading the pixels rather than the peaks. What is being checked is that the
   * drawing follows the audio, and a check that asked the same array the
   * drawing came from would pass whether or not anything was ever drawn.
   */
  const COLUMN = `
    window.__waveColumn = (atSeconds) => {
      const canvases = document.querySelectorAll('canvas.clip-wave');
      // Exactly one, or this is measuring whichever happened to be first in the
      // document — a precondition the check silently assumed until a run where
      // it was not true sent an afternoon after the wrong bug.
      if (canvases.length !== 1) throw new Error(canvases.length + ' waveforms on screen, expected 1');
      const canvas = canvases[0];
      const clip = canvas.closest('.clip');
      const duration = Number(clip.title.match(/([\\d.]+)s/)[1]);
      const x = Math.min(canvas.width - 1, Math.round((atSeconds / duration) * canvas.width));
      const data = canvas.getContext('2d').getImageData(x, 0, 1, canvas.height).data;
      let top = -1, bottom = -1;
      for (let y = 0; y < canvas.height; y++) {
        if (data[y * 4 + 3] > 8) { if (top < 0) top = y; bottom = y; }
      }
      return top < 0 ? 0 : bottom - top + 1;
    };
    /** What the waveform was drawn from, so a wrong picture can be told from wrong data. */
    window.__wavePeaks = () => {
      const canvas = document.querySelector('canvas.clip-wave');
      const clip = canvas?.closest('.clip');
      const assets = window.__fluxDev.assets.getAssets();
      const name = clip?.querySelector('.clip-label')?.textContent;
      const asset = assets.find(a => a.name === name);
      const peaks = asset ? window.__fluxDev.peaks.cachedPeaks(asset.path) : null;
      if (!peaks) return { name, peaks: null };
      const at = (t) => {
        const i = Math.floor(t * peaks.perSecond);
        return Math.max(peaks.max[i], -peaks.min[i]);
      };
      return { name, title: clip?.title,
               envelope: [0.5,1.5,2.5,3.5,4.5,5.5,6.5,7.5,8.5,9.5,10.5,11.5].map(at) };
    };
    return true;`
  await evaluate(cdp, COLUMN)

  const withWaveform = `
    const { sequence, view } = window.__fluxDev;
    sequence.setSequence(null);
    view.recordView({ timeline: { zoom: 60 } });
    await new Promise(r => setTimeout(r, 200));
    await window.__drag('voice_over.mp4', 1, 0, 60);
    for (let i = 0; i < 300; i++) {
      if (document.querySelector('canvas.clip-wave')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 400));
  `

  await check('a clip with sound draws a waveform', async () => {
    const state = await evaluate(
      cdp,
      withWaveform +
        `const canvas = document.querySelector('canvas.clip-wave');
         return { present: !!canvas, width: canvas?.width ?? 0, height: canvas?.height ?? 0 };`,
    )
    assert.equal(state.present, true, 'no waveform was ever drawn')
    assert.ok(state.width > 100, `the canvas is ${state.width} backing pixels wide`)
    assert.ok(state.height > 8, `and ${state.height} tall`)
  })

  await check('the waveform follows the audio, loud and quiet', async () => {
    // The fixture is two seconds at 0.9 then two at 0.02, three times over. If
    // the drawing is reading the peaks, that pattern has to be visible in the
    // pixels — and if it is drawing a band of its own, it cannot be.
    const state = await evaluate(
      cdp,
      withWaveform +
        `return {
           columns: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]
             .map(t => window.__waveColumn(t)),
           source: window.__wavePeaks(),
         };`,
    )

    /*
     * The peaks the drawing was made from, first.
     *
     * Two quite different things look identical in a column of pixels: a
     * waveform that ignores its peaks, and a waveform faithfully drawing peaks
     * that are themselves wrong. Naming which one it is here is the difference
     * between a minute and an afternoon — the cache outlives the code that
     * filled it, so a bad build from an earlier run can still be on disk long
     * after the reason for it is gone.
     */
    const from = state.source
    assert.ok(from.envelope, `no peaks in hand for ${from.name} (${from.title})`)
    const loudSource = [0, 1, 4, 5, 8, 9].map((i) => from.envelope[i])
    const quietSource = [2, 3, 6, 7, 10, 11].map((i) => from.envelope[i])
    assert.ok(
      Math.min(...loudSource) > 100 && Math.max(...quietSource) < 20,
      `the peaks themselves do not match the fixture — loud ${loudSource.join(',')}, ` +
        `quiet ${quietSource.join(',')}. The drawing is not what is wrong here.`,
    )

    const loud = [0, 1, 4, 5, 8, 9].map((i) => state.columns[i])
    const quiet = [2, 3, 6, 7, 10, 11].map((i) => state.columns[i])
    assert.ok(
      Math.min(...loud) > Math.max(...quiet) * 3,
      `loud columns ${loud.join(',')} are not clearly taller than quiet ones ${quiet.join(',')}`,
    )
    assert.ok(Math.min(...quiet) >= 1, 'silence should still draw a line, not a gap')
    assert.ok(
      Math.min(...loud) > 10,
      `a full-scale passage should nearly fill the clip, not ${Math.min(...loud)}px`,
    )
  })

  await check('a clip with no sound draws no waveform', async () => {
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `await new Promise(r => setTimeout(r, 800));
         return document.querySelectorAll('canvas.clip-wave').length;`,
    )
    assert.equal(state, 0)
  })

  await check('a linked pair survives a save and a reload', async () => {
    // The promise the project format makes: everything on the timeline comes
    // back. A pair that reloads as two unrelated clips would still look right
    // and would come apart the first time one of them was dragged.
    const before = await evaluate(
      cdp,
      withWaveform +
        `const { store, project } = window.__fluxDev;
         const clips = sequence.getSequence().clips
           .map(c => [c.kind, c.trackId, Math.round(c.start * 1000), !!c.linkId]);
         const saved = await project.saveProject();
         if (!saved.ok) throw new Error('save failed: ' + saved.error);
         await store.flushStores();
         location.reload();
         return clips;`,
    )
    assert.equal(before.length, 2, 'setup: expected a pair to save')

    await new Promise((r) => setTimeout(r, 2500))
    await ensureProject(cdp, VERIFY_PROJECT)
    const after = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const seq = window.__fluxDev.sequence;
       for (let i = 0; i < 40 && !seq.isSequenceLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       const clips = seq.getSequence().clips;
       const links = new Set(clips.map(c => c.linkId));
       return {
         clips: clips.map(c => [c.kind, c.trackId, Math.round(c.start * 1000), !!c.linkId]),
         oneLink: links.size === 1 && !links.has(undefined),
       };`,
    )
    assert.deepEqual(after.clips, before, 'the pair did not come back as it went in')
    assert.equal(after.oneLink, true, 'the two halves are no longer linked to each other')
  })

  await check('levels and mutes survive a save and a reload', async () => {
    const before = await evaluate(
      cdp,
      `const { sequence, store, project } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 200));
       sequence.setTrackGain('A1', -7.5);
       sequence.setTrackMuted('A2', true);
       sequence.setTrackSolo('A1', true);
       await new Promise(r => setTimeout(r, 200));
       const state = sequence.getSequence().tracks
         .map(t => [t.id, t.gain, t.muted, t.solo]);
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       location.reload();
       return state;`,
    )

    await new Promise((r) => setTimeout(r, 2500))
    await ensureProject(cdp, VERIFY_PROJECT)
    const after = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const seq = window.__fluxDev.sequence;
       for (let i = 0; i < 40 && !seq.isSequenceLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       return seq.getSequence().tracks.map(t => [t.id, t.gain, t.muted, t.solo]);`,
    )
    assert.deepEqual(after, before, 'the mixer settings did not come back as they went in')

    // And leave the tracks plain, so nothing below inherits a mute.
    await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       for (const track of sequence.getSequence().tracks) {
         sequence.setTrackMuted(track.id, false);
         sequence.setTrackSolo(track.id, false);
         sequence.setTrackGain(track.id, 0);
       }
       return true;`,
    )
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
