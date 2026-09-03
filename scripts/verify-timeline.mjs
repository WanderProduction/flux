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
       return { tracks: s.tracks.map(t => t.id), kinds: s.tracks.map(t => t.kind), clips: s.clips.length, fps: s.settings.frameRate };`,
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
    /*
     * The seed checks itself.
     *
     * addClip refuses a duration it cannot believe, and a probe that came back
     * empty leaves one clip where the check below expects two — which then
     * fails as though the behaviour under test were broken. Seen once as
     * exactly that: a move check reporting a clip at the wrong place, because
     * the clip it was talking about had never been added. A setup that failed
     * should say so in those words.
     */
    {
      const seeded = sequence.getSequence().clips;
      if (seeded.length !== 2) {
        throw new Error('setup: seedClips produced ' + seeded.length + ' clips, not 2 (durations '
          + pa.duration + ', ' + pb.duration + ')');
      }
    }
  `

  await evaluate(
    cdp,
    `window.__clips = () => window.__fluxDev.sequence.getSequence().clips
       .slice().sort((p, q) => p.start - q.start)
       .map(c => [c.trackId, Math.round(c.start * 1000) / 1000]);

     /**
      * Snapping is a mode now — Alt while dragging duplicates — so a check
      * that wants a raw distance turns the mode off around the gesture rather
      * than holding a key. Restored afterwards: a mode left off would silently
      * change what every check below is measuring.
      */
     window.__withoutSnapping = async (run) => {
       const { view } = window.__fluxDev;
       const was = view.getView().timeline.snapping !== false;
       // Waits for the panel to have *taken* the mode, not for a duration. The
       // toolbar button is the observable state, and sixty milliseconds is a
       // check that passes on a quiet machine and snaps an edge on a busy one.
       const settle = async (want) => {
         for (let i = 0; i < 60; i++) {
           const button = [...document.querySelectorAll('.cb-btn')]
             .find(b => b.textContent.trim() === 'Snap');
           if (button && button.className.includes('cb-btn--on') === want) return;
           await new Promise(r => setTimeout(r, 50));
         }
         throw new Error('the timeline never took snapping = ' + want);
       };
       view.recordView({ timeline: { snapping: false } });
       await settle(false);
       try { return await run(); }
       finally {
         view.recordView({ timeline: { snapping: was } });
         await settle(was);
       }
     };

     /** Press a clip, travel, release — on the window, as a real pointer does. */
     window.__dragClip = async (index, dx, dy, opts = {}) => {
       if (opts.noSnap) return window.__withoutSnapping(
         () => window.__dragClip(index, dx, dy, { ...opts, noSnap: false }));
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
         const after = await window.__dragClip(0, 60, 0, { noSnap: true });
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
        `const up = await window.__dragClip(0, 0, -46, { noSnap: true });
         const down = await window.__dragClip(0, 0, 46, { noSnap: true });
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
        `const down = await window.__dragClip(0, 60, 300, { noSnap: true });
         return down;`,
    )
    assert.equal(state[0][0], 'V1', 'V1 is the last video track, so it stays there')
    assert.equal(state[0][1], 1, 'and the horizontal part of the drag still happened')
  })

  await check('a clip cannot be dragged before the start of the sequence', async () => {
    const state = await evaluate(
      cdp,
      seedClips(4) + `return await window.__dragClip(0, -600, 0, { noSnap: true });`,
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
         await window.__dragClip(0, 120, 0, { noSnap: true });
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
         const after = await window.__dragClip(0, Math.round(target * 60), 0, { noSnap: true });
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

  await check('with snapping off, the gap stays exactly where it was put', async () => {
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `await window.__dragClip(1, -6, 0, { noSnap: true });
         const now = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         return { gapFrames: (now[1].start - (now[0].start + now[0].duration)) * 24 };`,
    )
    assert.ok(
      state.gapFrames > 1,
      `snapping off should have left a gap, got ${state.gapFrames} frames`,
    )
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
         const after = await window.__dragClip(0, 120, 0, { noSnap: true });
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

  /*
   * A silent file used to land as picture alone with nothing said about it,
   * which is indistinguishable from the audio half of the app being broken —
   * and that is exactly how it was reported. These three checks are the app
   * saying which: on the card before the drag, and on the timeline after the
   * drop, in different words for "there is no sound" and "FLUX cannot read the
   * sound that is there".
   */
  await check('a file with no sound says so on its card, before it is dragged', async () => {
    const state = await evaluate(
      cdp,
      `const badgeOn = (name) => {
         const card = [...document.querySelectorAll('.card')]
           .find(c => c.querySelector('.card-name')?.textContent === name);
         if (!card) throw new Error('no card named ' + name);
         const badge = card.querySelector('.card-badge--silent');
         return badge ? badge.textContent.trim() : null;
       };
       // The badge is asked for asynchronously - six ranged reads - so wait for
       // the answer rather than for a duration.
       for (let i = 0; i < 40 && badgeOn('clipA.mp4') === null; i++)
         await new Promise(r => setTimeout(r, 250));
       return {
         silent: badgeOn('clipA.mp4'),
         foreign: badgeOn('foreign_audio.mp4'),
         sounded: badgeOn('voice_over.mp4'),
       };`,
    )
    assert.equal(state.silent, 'no audio', 'a file with no soundtrack should say so')
    assert.equal(state.foreign, 'audio ?', 'audio FLUX cannot read is a different answer')
    assert.equal(state.sounded, null, 'and a file with sound says nothing at all')
  })

  await check('a silent file explains itself when it drops', async () => {
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `return {
           notice: document.querySelector('.tl-notice')?.textContent ?? null,
           clips: window.__fluxDev.sequence.getSequence().clips.length,
         };`,
    )
    assert.equal(state.clips, 1, 'the picture still lands')
    assert.ok(state.notice, 'a drop that placed no sound has to say why')
    assert.ok(
      state.notice.includes('clipA.mp4') && state.notice.includes('no soundtrack'),
      `the notice should name the file and the reason, got: ${state.notice}`,
    )
  })

  await check('audio FLUX cannot read is not called silence', async () => {
    // The difference is the whole point of saying anything: one is a fact about
    // the footage and the other is a fact about FLUX, and telling someone the
    // second is the first sends them looking for a fault in their own file.
    const state = await evaluate(
      cdp,
      dropOne('foreign_audio.mp4', 1) +
        `return document.querySelector('.tl-notice')?.textContent ?? null;`,
    )
    assert.ok(state, 'a file whose audio cannot be read has to say so')
    assert.ok(
      state.includes('cannot read') && state.includes('ac-3'),
      `the notice should name what stopped it, got: ${state}`,
    )
    assert.ok(!state.includes('no soundtrack'), 'and must not claim the file is silent')
  })

  await check('sound with nowhere to go gets a track of its own', async () => {
    /*
     * Both audio tracks busy at the moment the picture lands. The sound cannot
     * slide along to the next gap - that would put it out of sync with its own
     * picture - so the only answer that keeps the pair together is a new track,
     * which is what every NLE does. It used to be dropped silently.
     */
    const state = await evaluate(
      cdp,
      `const { assets, sequence, view } = window.__fluxDev;
       sequence.setSequence(null);
       view.recordView({ timeline: { zoom: 60 } });
       await new Promise(r => setTimeout(r, 200));

       // Lane 2 is A1: this both imports the fixture and fills A1 from zero.
       await window.__drag('voice_over.mp4', 2, 0, 60);
       await new Promise(r => setTimeout(r, 300));
       const laid = sequence.getSequence().clips[0];
       sequence.addClip({ assetId: laid.assetId, trackId: 'A2', start: 0, duration: laid.duration });

       // Lane 0 is V2, which is empty, so the picture lands at zero and the
       // sound has to be at zero with it.
       await window.__drag('voice_over.mp4', 0, 0, 60);
       await new Promise(r => setTimeout(r, 300));

       const seq = sequence.getSequence();
       return {
         tracks: seq.tracks.map(t => t.id),
         clips: seq.clips.map(c => ({ track: c.trackId, kind: c.kind, start: c.start, link: c.linkId ?? null })),
         notice: document.querySelector('.tl-notice')?.textContent ?? null,
       };`,
    )
    assert.ok(state.tracks.includes('A3'), `a track should have been made, got ${state.tracks}`)
    const video = state.clips.find((c) => c.kind === 'video')
    const made = state.clips.find((c) => c.track === 'A3')
    assert.ok(video && made, 'the pair should both exist')
    assert.equal(made.start, video.start, 'a pair that starts at two moments is a sync error')
    assert.ok(made.link && made.link === video.link, 'and the two halves must share a link')
    assert.equal(state.notice, null, 'nothing to explain: the sound was placed')
  })

  await check('dragging the picture takes the sound with it', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const before = window.__clips();
         await window.__dragClip(0, 120, 0, { noSnap: true });
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
         return { clips: sequence.getSequence().clips
                    .map(c => ({ kind: c.kind, start: Math.round(c.start * 1000) / 1000 })),
                  // A move is quantised to the sequence's own frame grid, and
                  // the sequence takes its rate from the footage — so what the
                  // distance lands on is the grid's business, not this check's.
                  expected: Math.round(sequence.snapDelta(1.5) * 1000) / 1000 };`,
    )
    assert.equal(state.clips.length, 2)
    for (const clip of state.clips) {
      assert.equal(
        clip.start,
        state.expected,
        `the ${clip.kind} half ended up at ${clip.start}s, not ${state.expected}s`,
      )
    }
  })

  await check('a pair blocked on one track does not come apart', async () => {
    /*
     * The tracks are different, so what blocks one half need not block the
     * other — and the moment that happens the picture and its sound move by
     * different amounts and the take is out of sync.
     *
     * Found on real footage rather than imagined: two clips end to end on V1,
     * drag the first one right, and the audio track was clear so the sound slid
     * three seconds while the picture, blocked by its neighbour, did not move
     * at all. Nothing said so; the pair simply arrived in two pieces.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `// A second clip immediately after it on V1, and nothing on A1.
         const { assets } = window.__fluxDev;
         const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
         const probed = await assets.ensureProbed(a.id);
         const pair = sequence.getSequence().clips.find(c => c.kind === 'video');
         sequence.addClip({ assetId: a.id, trackId: 'V1',
                            start: pair.start + pair.duration, duration: probed.duration });
         await new Promise(r => setTimeout(r, 200));

         const before = sequence.getSequence().clips
           .filter(c => c.linkId).map(c => [c.kind, c.start]);
         sequence.moveClips([pair.id], 3, 0);
         await new Promise(r => setTimeout(r, 200));
         const after = sequence.getSequence().clips
           .filter(c => c.linkId).map(c => [c.kind, c.start]);
         return { before, after,
                  blocked: sequence.getSequence().clips.filter(c => !c.linkId).length };`,
    )
    assert.equal(state.blocked, 1, 'setup: expected one clip in the way')
    assert.equal(state.after.length, 2, 'the pair should still be a pair')

    const moved = state.after.map(([kind, start], i) => start - state.before[i][1])
    assert.ok(
      Math.abs(moved[0] - moved[1]) < 1e-6,
      `the picture moved ${moved[0]}s and its sound moved ${moved[1]}s`,
    )
  })

  await check('a pair whose sound will not fit does not move at all', async () => {
    // The other way round from the check above: the picture is free to go and
    // the sound is not. A pair that will not fit somewhere should refuse to go
    // there — which is a thing you can see and undo, unlike silently arriving
    // in two pieces.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const pair = sequence.getSequence().clips.find(c => c.kind === 'video');
         // Something on A1 just past the pair, and nothing at all on V1.
         const blocker = sequence.addClip(
           { assetId: sequence.getSequence().clips.find(c => c.kind === 'audio').assetId,
             trackId: 'A1', start: 14, duration: 4 });
         if (!blocker || blocker.start !== 14) throw new Error('setup: blocker at ' + blocker?.start);
         await new Promise(r => setTimeout(r, 200));

         sequence.moveClips([pair.id], 3, 0);
         await new Promise(r => setTimeout(r, 200));
         return sequence.getSequence().clips
           .filter(c => c.linkId).map(c => [c.kind, Math.round(c.start * 1000) / 1000]);`,
    )
    assert.deepEqual(
      state.sort(),
      [['audio', 0], ['video', 0]].sort(),
      'the picture went somewhere its sound could not follow',
    )
  })

  await check('a pair with room moves the whole way, both halves', async () => {
    // The other side of it: being careful about the blocked case must not have
    // made the ordinary one refuse.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const pair = sequence.getSequence().clips.find(c => c.kind === 'video');
         sequence.moveClips([pair.id], 2.5, 0);
         await new Promise(r => setTimeout(r, 200));
         return { clips: sequence.getSequence().clips.map(c => [c.kind, Math.round(c.start * 1000) / 1000]),
                  expected: Math.round(sequence.snapDelta(2.5) * 1000) / 1000 };`,
    )
    assert.deepEqual(
      state.clips.sort(),
      [['audio', state.expected], ['video', state.expected]].sort(),
      'with nothing in the way both halves should travel the full distance',
    )
  })

  await check('dragging the sound takes the picture with it, blocked or not', async () => {
    // Whichever half is grabbed decides, and the other follows it exactly.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const pair = sequence.getSequence().clips.find(c => c.kind === 'audio');
         sequence.moveClips([pair.id], 1.5, 0);
         await new Promise(r => setTimeout(r, 200));
         return { clips: sequence.getSequence().clips.map(c => [c.kind, Math.round(c.start * 1000) / 1000]),
                  expected: Math.round(sequence.snapDelta(1.5) * 1000) / 1000 };`,
    )
    assert.deepEqual(
      state.clips.sort(),
      [['audio', state.expected], ['video', state.expected]].sort(),
      'grabbing the sound should move the picture the same distance',
    )
  })

  await check('dragging the picture down cannot strand it below its own sound', async () => {
    // The bands again, from the audio side: the pair is on V1 and A1, and a
    // drag downward has to be refused by the video half rather than quietly
    // pushing the audio to A2 on its own.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `await window.__dragClip(0, 0, 46, { noSnap: true });
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

  await check('a video track has an eye, and it toggles', async () => {
    // One button where an audio track has three: video has no level to ride and
    // nothing to solo against. A layer is in the picture or it is not.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const header = [...document.querySelectorAll('.tl-header')]
         .find(h => h.querySelector('.track-name').textContent === 'V2');
       const eye = header.querySelector('.track-toggle--eye');
       if (!eye) throw new Error('no eye on a video track');
       const audioControls = [...document.querySelectorAll('.tl-header--audio')][0]
         .querySelectorAll('.track-toggle').length;

       eye.click();
       await new Promise(r => setTimeout(r, 150));
       const off = sequence.getSequence().tracks.find(t => t.id === 'V2');
       eye.click();
       await new Promise(r => setTimeout(r, 150));
       const on = sequence.getSequence().tracks.find(t => t.id === 'V2');
       return { hiddenAfterFirst: off.hidden, hiddenAfterSecond: on.hidden,
                videoButtons: header.querySelectorAll('.track-toggle').length,
                audioButtons: audioControls };`,
    )
    assert.equal(state.hiddenAfterFirst, true, 'clicking the eye should hide the track')
    assert.equal(state.hiddenAfterSecond, false, 'and clicking it again should show it')
    assert.equal(state.videoButtons, 1, 'a video track has one control')
    assert.equal(state.audioButtons, 2, 'an audio track has mute and solo')
  })

  await check('a track saved before it could be hidden opens visible', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence({
         name: 'Old', frameRate: 24,
         tracks: [{ id: 'V1', kind: 'video', name: 'V1' }],
         clips: [],
       });
       await new Promise(r => setTimeout(r, 250));
       const s = sequence.getSequence();
       return { hidden: s.tracks.map(t => t.hidden), frame: [s.settings.width, s.settings.height] };`,
    )
    assert.ok(
      state.hidden.every((h) => h === false),
      'an older project must not open with its tracks switched off',
    )
    // And a sequence saved before it had a size gets a real one rather than a
    // frame with no pixels in it.
    assert.deepEqual(state.frame, [1920, 1080])
  })

  await check('the sequence frame survives a save and a reload', async () => {
    const before = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 200));
       sequence.updateSequenceSettings({ width: 1280, height: 720 });
       sequence.setTrackHidden('V2', true);
       await new Promise(r => setTimeout(r, 200));
       const s = sequence.getSequence();
       return { frame: [s.settings.width, s.settings.height],
                hidden: s.tracks.map(t => [t.id, t.hidden]) };`,
    )
    assert.deepEqual(before.frame, [1280, 720])

    const after = await evaluate(
      cdp,
      `const { sequence, store, project } = window.__fluxDev;
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       const files = await window.flux.project.listSequences(project.getProject().root);
       const s = files.find(one => one.id === sequence.getActiveSequenceId());
       if (!s) throw new Error('the active sequence was not written');
       return { frame: [s.settings.width, s.settings.height],
                hidden: s.tracks.map(t => [t.id, t.hidden]) };`,
    )
    assert.deepEqual(after, before, 'the frame and the hidden tracks did not reach the file')

    await evaluate(
      cdp,
      `window.__fluxDev.sequence.setTrackHidden('V2', false); return true;`,
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

  // ── linking, and cutting the link ─────────────────────────────

  /*
   * A pair moves as one until someone says otherwise. Ctrl+Space is that
   * someone, and everything below drives it the way a hand does: a real key
   * event at the window, through the keymap, into the command.
   */
  await evaluate(
    cdp,
    `window.__toggleLink = () => window.dispatchEvent(
       new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));

     window.__clickClip = (index, opts = {}) => {
       const el = [...document.querySelectorAll('.tl-lane .clip')][index];
       if (!el) throw new Error('no clip at index ' + index);
       const box = el.getBoundingClientRect();
       const at = { clientX: box.left + Math.min(30, box.width / 2),
                    clientY: box.top + box.height / 2 };
       el.dispatchEvent(new PointerEvent('pointerdown',
         { bubbles: true, cancelable: true, button: 0, pointerId: 51, shiftKey: !!opts.shift, ...at }));
       window.dispatchEvent(new PointerEvent('pointerup',
         { bubbles: true, cancelable: true, button: 0, pointerId: 51, ...at }));
     };

     window.__links = () => window.__fluxDev.sequence.getSequence().clips
       .slice().sort((a, b) => a.kind.localeCompare(b.kind))
       .map(c => [c.kind, Math.round(c.start * 1000) / 1000, c.linkId ? 'linked' : 'loose']);

     window.__selected = () => document.querySelectorAll('.clip--selected').length;
     window.__chains = () => document.querySelectorAll('.clip-link').length;
     return true;`,
  )

  await check('ctrl+tab cuts a pair apart', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         const before = { links: window.__links(), chains: window.__chains(), selected: window.__selected() };
         window.__toggleLink();
         await new Promise(r => setTimeout(r, 300));
         return { before, after: { links: window.__links(), chains: window.__chains(),
                                   selected: window.__selected(),
                                   notice: document.querySelector('.tl-notice')?.textContent ?? null } };`,
    )
    assert.deepEqual(
      state.before.links.map((row) => row[2]),
      ['linked', 'linked'],
      'setup: the drop should have produced a linked pair',
    )
    assert.equal(state.before.chains, 2, 'and both halves should say so')
    assert.deepEqual(
      state.after.links.map((row) => row[2]),
      ['loose', 'loose'],
      'both halves must come apart, not just the one that was pressed',
    )
    assert.equal(state.after.chains, 0, 'and stop claiming to be linked')
    assert.equal(state.after.selected, 2, 'both stay selected, so a second press ties them back')
    assert.ok(
      state.after.notice?.includes('Unlinked'),
      `the change is invisible until something is dragged, so it has to be said: ${state.after.notice}`,
    )
  })

  await check('once apart, each half moves on its own', async () => {
    /*
     * The point of the whole feature. The picture goes two seconds later and
     * the sound stays exactly where it was — deliberately out of sync, which is
     * an edit rather than an accident.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         window.__toggleLink();
         await new Promise(r => setTimeout(r, 300));

         // A press keeps the group so it can be dragged; letting go without
         // dragging means "this one". Both are still selected from the unlink.
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         const selected = window.__selected();
         const video = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--video'));
         await window.__dragClip(video, 120, 0, { noSnap: true });
         return { selected, links: window.__links() };`,
    )
    assert.equal(state.selected, 1, 'clicking one of two loose clips should leave one selected')
    const video = state.links.find((row) => row[0] === 'video')
    const audio = state.links.find((row) => row[0] === 'audio')
    assert.equal(video[1], 2, 'the picture should have moved two seconds')
    assert.equal(audio[1], 0, 'and the sound should have stayed exactly where it was')
  })

  await check('ctrl+tab ties two clips back together', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         window.__toggleLink();
         await new Promise(r => setTimeout(r, 250));
         window.__toggleLink();
         await new Promise(r => setTimeout(r, 250));
         const linked = { links: window.__links(), chains: window.__chains(),
                          notice: document.querySelector('.tl-notice')?.textContent ?? null };
         const video = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--video'));
         await window.__dragClip(video, 120, 0, { noSnap: true });
         return { linked, moved: window.__links() };`,
    )
    assert.deepEqual(
      state.linked.links.map((row) => row[2]),
      ['linked', 'linked'],
      'a second press should tie them back together',
    )
    assert.equal(state.linked.chains, 2)
    assert.ok(state.linked.notice?.includes('Linked'), state.linked.notice)
    assert.deepEqual(
      state.moved.map((row) => row[1]),
      [2, 2],
      'and once linked again they travel together',
    )
  })

  await check('cutting a link takes the other half with it, whoever asks', async () => {
    // Asked for by the picture's id alone. The panel expands a press through
    // the link before it does anything, so a gesture cannot tell whether the
    // rule is in the kernel — and everything else that edits a sequence needs
    // it to be.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const video = sequence.getSequence().clips.find(c => c.kind === 'video');
         const result = sequence.toggleLink([video.id]);
         await new Promise(r => setTimeout(r, 200));
         return { result, links: window.__links() };`,
    )
    assert.equal(state.result, 'unlinked')
    assert.deepEqual(
      state.links.map((row) => row[2]),
      ['loose', 'loose'],
      'the half nobody named must come apart too, or it points at a link with nobody in it',
    )
  })

  await check('a clip on its own has nothing to link to', async () => {
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         window.__toggleLink();
         await new Promise(r => setTimeout(r, 300));
         return { links: window.__links(),
                  notice: document.querySelector('.tl-notice')?.textContent ?? null };`,
    )
    assert.deepEqual(state.links.map((row) => row[2]), ['loose'], 'nothing should have been linked')
    assert.ok(
      state.notice?.includes('nothing to link to'),
      `a command that did nothing has to say why: ${state.notice}`,
    )
  })

  await check('pressing one clip of a group and letting go means that one', async () => {
    /*
     * The rule that makes an unlinked pair usable. A press has to keep the
     * whole group or a group could never be dragged; a release without a drag
     * is where "I meant this one" and "I meant all of these" separate.
     */
    const state = await evaluate(
      cdp,
      seedClips(4) +
        `// Two clips, selected by shift-clicking, since there is no select-all.
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         window.__clickClip(1, { shift: true });
         await new Promise(r => setTimeout(r, 150));
         const both = window.__selected();
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 200));
         return { both, after: window.__selected() };`,
    )
    assert.equal(state.both, 2, 'setup: shift-clicking should have selected two clips')
    assert.equal(state.after, 1, 'and pressing one of them without dragging means that one')
  })

  // ── trimming ──────────────────────────────────────────────────

  /*
   * A trim is a gesture, so it is checked as one: the handle is pressed, the
   * pointer travels, and the pointer comes up — through the same window
   * listeners a hand drives. Calling the kernel directly would leave the whole
   * question of whether an edge can be grabbed at all unchecked, which is where
   * the feature actually lives.
   */
  const TRIM_HELPERS = `
     const r3 = (n) => Math.round(n * 1000) / 1000;
     // Defined here as well: a reload takes every helper with it, and the trim
     // checks are the ones that run after one.
     window.__withoutSnapping = window.__withoutSnapping ?? (async (run) => {
       const { view } = window.__fluxDev;
       const was = view.getView().timeline.snapping !== false;
       // Waits for the panel to have *taken* the mode, not for a duration. The
       // toolbar button is the observable state, and sixty milliseconds is a
       // check that passes on a quiet machine and snaps an edge on a busy one.
       const settle = async (want) => {
         for (let i = 0; i < 60; i++) {
           const button = [...document.querySelectorAll('.cb-btn')]
             .find(b => b.textContent.trim() === 'Snap');
           if (button && button.className.includes('cb-btn--on') === want) return;
           await new Promise(r => setTimeout(r, 50));
         }
         throw new Error('the timeline never took snapping = ' + want);
       };
       view.recordView({ timeline: { snapping: false } });
       await settle(false);
       try { return await run(); }
       finally {
         view.recordView({ timeline: { snapping: was } });
         await settle(was);
       }
     });
     window.__shape = () => window.__fluxDev.sequence.getSequence().clips
       .slice().sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind))
       .map(c => ({ track: c.trackId, kind: c.kind, start: r3(c.start), dur: r3(c.duration),
                    off: r3(c.offset), src: r3(c.sourceDuration) }));

     window.__grabTrim = (index, edge, opts = {}) => {
       const el = [...document.querySelectorAll('.tl-lane .clip')][index];
       if (!el) throw new Error('no clip at index ' + index);
       const handle = el.querySelector('.clip-handle--' + edge);
       if (!handle) throw new Error('no ' + edge + ' handle on clip ' + index);
       const box = handle.getBoundingClientRect();
       const x = box.left + box.width / 2, y = box.top + box.height / 2;
       const mk = (type, px) => new PointerEvent(type, {
         bubbles: true, cancelable: true, button: 0, pointerId: 8,
         clientX: px, clientY: y, altKey: !!opts.altKey,
       });
       handle.dispatchEvent(mk('pointerdown', x));
       return {
         el,
         move: async (dx) => {
           window.dispatchEvent(mk('pointermove', x + dx));
           await new Promise(r => setTimeout(r, 60));
         },
         up: async (dx) => {
           window.dispatchEvent(mk('pointerup', x + dx));
           await new Promise(r => setTimeout(r, 300));
         },
       };
     };

     window.__trimClip = async (index, edge, dx, opts = {}) => {
       if (opts.noSnap) return window.__withoutSnapping(
         () => window.__trimClip(index, edge, dx, { ...opts, noSnap: false }));
       const grab = window.__grabTrim(index, edge, opts);
       for (let i = 1; i <= 4; i++) await grab.move((dx * i) / 4);
       await grab.up(dx);
       return window.__shape();
     };
     return true;`
  await evaluate(cdp, TRIM_HELPERS)

  /** One clip on V1, its whole file, at 60px per second. */
  const seedTrim = `
    const { assets, sequence, view } = window.__fluxDev;
    sequence.setSequence(null);
    view.recordView({ timeline: { zoom: 60 } });
    const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
    const probed = await assets.ensureProbed(a.id);
    sequence.addClip({ assetId: a.id, trackId: 'V1', start: 0, duration: probed.duration });
    await new Promise(r => setTimeout(r, 400));
  `

  await check('dragging the tail in shortens the clip and leaves its head alone', async () => {
    const state = await evaluate(
      cdp,
      seedTrim +
        `const before = window.__shape();
         // Alt off the snapping, so this measures the drag and nothing else.
         const after = await window.__trimClip(0, 'end', -120, { noSnap: true });
         return { before: before[0], after: after[0] };`,
    )
    assert.equal(
      state.after.dur,
      Math.round((state.before.dur - 2) * 1000) / 1000,
      'a 120px drag at 60px/s is two seconds off the tail',
    )
    assert.equal(state.after.start, state.before.start, 'the head must not move')
    assert.equal(state.after.off, 0, 'nor may the in point')
    assert.equal(state.after.src, state.before.src, 'the file is still as long as it was')
  })

  await check('dragging the head in takes the in point with it', async () => {
    /*
     * The difference between a trim and a slip, in three numbers. The frames
     * still in the clip do not move on the timeline: start goes forward, the in
     * point goes forward by the same amount, and the tail stays exactly where
     * it was. Anything else is a different edit wearing a trim's handle.
     */
    const state = await evaluate(
      cdp,
      seedTrim +
        `const before = window.__shape();
         const after = await window.__trimClip(0, 'start', 120, { noSnap: true });
         return { before: before[0], after: after[0] };`,
    )
    assert.equal(state.after.start, state.before.start + 2, 'the head moved two seconds in')
    assert.equal(state.after.off, state.before.off + 2, 'and it took the in point with it')
    assert.equal(
      Math.round((state.after.start + state.after.dur) * 1000) / 1000,
      Math.round((state.before.start + state.before.dur) * 1000) / 1000,
      'the tail must not move: the frames left in the clip stay where they were',
    )
  })

  await check('an edge stops at the end of the file', async () => {
    // An untrimmed clip is already playing every frame there is. Dragging its
    // tail further does nothing, rather than inventing footage.
    const state = await evaluate(
      cdp,
      seedTrim +
        `const before = window.__shape();
         const after = await window.__trimClip(0, 'end', 600, { noSnap: true });
         return { before: before[0], after: after[0] };`,
    )
    assert.deepEqual(state.after, state.before)
  })

  await check('a trimmed edge can be pulled back out, and no further', async () => {
    const state = await evaluate(
      cdp,
      seedTrim +
        `const trimmed = await window.__trimClip(0, 'start', 120, { noSnap: true });
         const back = await window.__trimClip(0, 'start', -120, { noSnap: true });
         const further = await window.__trimClip(0, 'start', -120, { noSnap: true });
         return { trimmed: trimmed[0], back: back[0], further: further[0] };`,
    )
    assert.equal(state.trimmed.off, 2, 'setup: the head should be two seconds in')
    assert.equal(state.back.off, 0, 'and it comes all the way back')
    assert.equal(state.back.start, 0)
    assert.deepEqual(state.further, state.back, 'there is nothing before the first frame')
  })

  await check('a clip cannot be trimmed away to nothing', async () => {
    // One frame, not zero: a clip is a thing that plays, and a zero-length one
    // is an invisible object that still has to be found to be deleted.
    const state = await evaluate(
      cdp,
      seedTrim +
        `const after = await window.__trimClip(0, 'start', 4000, { noSnap: true });
         return { clip: after[0], fps: window.__fluxDev.sequence.getSequence().settings.frameRate };`,
    )
    assert.equal(state.clip.dur, Math.round((1 / state.fps) * 1000) / 1000, 'one frame is the floor')
    assert.ok(state.clip.dur > 0)
  })

  await check('an edge stops at its neighbour', async () => {
    /*
     * Trimming is not moving: nothing slides out of the way and nothing is
     * overwritten. The tail here has two seconds of file left and one second of
     * room, and the room is what decides it.
     */
    const state = await evaluate(
      cdp,
      seedTrim +
        `await window.__trimClip(0, 'end', -120, { noSnap: true });
         const b = assets.getAssets().find(x => x.name === 'shot_B.mp4');
         const pb = await assets.ensureProbed(b.id);
         sequence.addClip({ assetId: b.id, trackId: 'V1', start: 3, duration: pb.duration });
         await new Promise(r => setTimeout(r, 300));
         const after = await window.__trimClip(0, 'end', 300, { noSnap: true });
         return after[0];`,
    )
    assert.equal(state.dur, 3, 'the tail should stop where the next clip begins')
    assert.equal(state.start, 0)
  })

  await check('trimming the picture trims the sound with it', async () => {
    // The same rule as moving: a pair is one thing to the hand. Two halves
    // trimmed by different amounts is a sync error that looks like an edit.
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const before = window.__shape();
         const video = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--video'));
         const after = await window.__trimClip(video, 'end', -120, { noSnap: true });
         return { before, after };`,
    )
    assert.equal(state.after.length, 2, 'setup: expected a pair')
    for (const kind of ['video', 'audio']) {
      const was = state.before.find((c) => c.kind === kind)
      const now = state.after.find((c) => c.kind === kind)
      assert.equal(
        now.dur,
        Math.round((was.dur - 2) * 1000) / 1000,
        `the ${kind} half should have lost the same two seconds`,
      )
    }
  })

  await check('trimming one half of a pair trims both, whoever asks', async () => {
    /*
     * The panel expands a press through the link before it trims anything, so
     * the gesture above would pass with or without the rule in the kernel —
     * exactly as it does for moving. This is the rule itself, asked for by id:
     * anything that trims a clip gets it, because it is a fact about the
     * sequence rather than a courtesy of the panel that happens to be in front.
     *
     * Both directions, because a link is not directional. Trimming the sound
     * has to take the picture with it as surely as the other way round.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const half = (kind) => sequence.getSequence().clips.find(c => c.kind === kind);
         const before = window.__shape();
         sequence.trimClips([half('video').id], 'end', -2);
         const afterVideo = window.__shape();
         sequence.trimClips([half('audio').id], 'start', 1);
         return { before, afterVideo, afterAudio: window.__shape() };`,
    )
    const of = (shape, kind) => shape.find((c) => c.kind === kind)
    for (const kind of ['video', 'audio']) {
      assert.equal(
        Math.round((of(state.afterVideo, kind).dur - of(state.before, kind).dur) * 1000) / 1000,
        -2,
        `asked through the picture, the ${kind} half should have lost two seconds`,
      )
      assert.equal(
        Math.round((of(state.afterAudio, kind).off - of(state.afterVideo, kind).off) * 1000) / 1000,
        1,
        `asked through the sound, the ${kind} half's in point should have moved a second`,
      )
    }
  })

  await check('a pair is trimmed by what the tighter half allows', async () => {
    /*
     * The limits of a pair are intersected before anything moves, and this is
     * the case that says so: the video track is clear, and the sound's track is
     * not. Trimming to each half's own limit would put the picture two seconds
     * past its own sound — a sync error produced by an edit that looked like it
     * worked.
     *
     * Asked for by the picture's id alone, for the reason above: the limits
     * have to be gathered through the link by whatever is doing the trimming.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const video = sequence.getSequence().clips.find(c => c.kind === 'video');
         // Four seconds off the tail of both, so there is file left to pull out.
         sequence.trimClips([video.id], 'end', -4);
         const audio = sequence.getSequence().clips.find(c => c.kind === 'audio');
         // ...and two seconds of room on the audio track, and only there.
         sequence.addClip({ assetId: audio.assetId, trackId: 'A1',
                            start: audio.start + audio.duration + 2, duration: 3 });
         await new Promise(r => setTimeout(r, 300));
         const before = window.__shape();
         sequence.trimClips([video.id], 'end', 4);
         await new Promise(r => setTimeout(r, 200));
         return { before, after: window.__shape() };`,
    )
    const grew = (shape, kind) => shape.find((c) => c.kind === kind && c.start === 0)
    for (const kind of ['video', 'audio']) {
      const was = grew(state.before, kind)
      const now = grew(state.after, kind)
      assert.equal(
        Math.round((now.dur - was.dur) * 1000) / 1000,
        2,
        `the ${kind} half should have gained the two seconds the sound had room for, ` +
          `not the four the drag asked for`,
      )
    }
  })

  await check('a trim is not committed until the pointer comes up', async () => {
    /*
     * The block on screen follows the pointer while the clip in the sequence
     * stays as it was, which is what makes an abandoned trim need no undoing.
     * Both halves are checked here: a preview that does not move is a dead
     * handle, and a sequence that moves early is an edit nobody committed.
     */
    const state = await evaluate(
      cdp,
      seedTrim +
        `const el = document.querySelector('.tl-lane .clip');
         const widthBefore = el.getBoundingClientRect().width;
         const grab = window.__grabTrim(0, 'end', { noSnap: true });
         await grab.move(-120);
         const mid = {
           width: grab.el.getBoundingClientRect().width,
           dur: window.__shape()[0].dur,
         };
         await grab.up(-120);
         return { widthBefore, mid, after: window.__shape()[0].dur };`,
    )
    assert.ok(
      Math.abs(state.mid.width - (state.widthBefore - 120)) < 2,
      `the block should be 120px narrower mid-drag, it is ${state.mid.width} against ${state.widthBefore}`,
    )
    assert.equal(
      state.mid.dur,
      Math.round((state.widthBefore / 60) * 1000) / 1000,
      'the sequence must still hold the untrimmed clip',
    )
    assert.equal(
      state.after,
      Math.round(((state.widthBefore - 120) / 60) * 1000) / 1000,
      'and the trim lands on release',
    )
  })

  await check('the waveform is drawn from the new in point', async () => {
    /*
     * The fixture is loud for two seconds, then quiet for two, three times
     * over. Trim two seconds off its head and the clip now begins in the quiet
     * stretch — so the first column of the waveform has to change. A drawing
     * that ignored the in point would look identical, and would be showing
     * sound the clip no longer plays.
     */
    const state = await evaluate(
      cdp,
      withWaveform +
        `const loudFirst = window.__waveColumn(0.5);
         const audio = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--audio'));
         await window.__trimClip(audio, 'start', 120, { noSnap: true });
         await new Promise(r => setTimeout(r, 400));
         return {
           loudFirst,
           quietFirst: window.__waveColumn(0.5),
           loudAgain: window.__waveColumn(2.5),
           off: window.__shape().find(c => c.kind === 'audio').off,
         };`,
    )
    assert.equal(state.off, 2, 'setup: the audio should be two seconds in')
    assert.ok(state.loudFirst > 8, `setup: the untrimmed clip starts loud (${state.loudFirst}px)`)
    assert.ok(
      state.quietFirst < state.loudFirst / 2,
      `the trimmed clip starts in the quiet stretch, but its first column is ${state.quietFirst}px ` +
        `against ${state.loudFirst}px before the trim`,
    )
    assert.ok(
      state.loudAgain > state.quietFirst * 2,
      'and the loud stretch that follows it is still drawn loud',
    )
  })

  await check('a clip saved before trimming existed plays its whole file', async () => {
    // Nothing about such a clip was wrong, only older: it played the file from
    // the top, so that is what it reads back as — and it can be trimmed from
    // there like any other.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence({
         id: 'vintage', name: 'Vintage', createdAt: 1000, settings: { frameRate: 25 },
         tracks: [{ id: 'V1', kind: 'video', name: 'V1' }, { id: 'A1', kind: 'audio', name: 'A1' }],
         clips: [{ id: 'old', assetId: 'a1', trackId: 'V1', start: 0, duration: 5, kind: 'video' }],
       });
       await new Promise(r => setTimeout(r, 250));
       const clip = sequence.getSequence().clips[0];
       return { off: clip.offset, src: clip.sourceDuration, dur: clip.duration };`,
    )
    assert.equal(state.off, 0, 'it started at the top of its file')
    assert.equal(state.src, 5, 'and it was the whole of it')
    assert.equal(state.dur, 5)
  })

  // ── selecting ─────────────────────────────────────────────────

  /*
   * Every selection gesture on a timeline is a rectangle: a click is one with
   * no width, a range is the one between two clips, and a rubber band is one
   * drawn by hand. The checks below drive all three through real pointer
   * events, and read the answer off the *screen* — a clip is selected when it
   * looks selected.
   */
  await evaluate(
    cdp,
    `window.__lanes = () => [...document.querySelectorAll('.tl-lane')];
     window.__laneOf = (trackId) => {
       const rows = window.__fluxDev.sequence.getSequence().tracks;
       return window.__lanes()[rows.findIndex(t => t.id === trackId)];
     };
     /** The clip on a track, as an element. One per track in these checks. */
     window.__clipOn = (trackId) => [...document.querySelectorAll('.tl-lane .clip')]
       .find(el => window.__laneOf(trackId).contains(el));

     /** What is selected, as track:name, so a failure names the clips. */
     window.__picked = () => {
       const rows = window.__fluxDev.sequence.getSequence().tracks;
       return [...document.querySelectorAll('.clip--selected')].map(el => {
         const lane = window.__lanes().findIndex(l => l.contains(el));
         return (rows[lane]?.id ?? '?') + ':' + el.querySelector('.clip-label')?.textContent;
       }).sort();
     };

     window.__pressClip = (trackId, mods = {}) => {
       const el = window.__clipOn(trackId);
       if (!el) throw new Error('no clip on ' + trackId);
       const box = el.getBoundingClientRect();
       const at = { clientX: box.left + 20, clientY: box.top + box.height / 2 };
       el.dispatchEvent(new PointerEvent('pointerdown',
         { bubbles: true, cancelable: true, button: 0, pointerId: 81, ...at, ...mods }));
       window.dispatchEvent(new PointerEvent('pointerup',
         { bubbles: true, cancelable: true, button: 0, pointerId: 81, ...at }));
       return new Promise(r => setTimeout(r, 180));
     };

     /** Press empty lane, optionally sweep, release. Returns the band's size. */
     window.__sweep = async (fromTrack, toTrack, fromX, toX, mods = {}) => {
       const from = window.__laneOf(fromTrack).getBoundingClientRect();
       const to = window.__laneOf(toTrack).getBoundingClientRect();
       const a = { clientX: from.left + fromX, clientY: from.top + from.height / 2 };
       const b = { clientX: from.left + toX, clientY: to.top + to.height / 2 };
       window.__laneOf(fromTrack).dispatchEvent(new PointerEvent('pointerdown',
         { bubbles: true, cancelable: true, button: 0, pointerId: 82, ...a, ...mods }));
       let band = null;
       for (let i = 1; i <= 5; i++) {
         window.dispatchEvent(new PointerEvent('pointermove', {
           bubbles: true, cancelable: true, button: 0, pointerId: 82,
           clientX: a.clientX + (b.clientX - a.clientX) * i / 5,
           clientY: a.clientY + (b.clientY - a.clientY) * i / 5,
         }));
         await new Promise(r => setTimeout(r, 40));
         const el = document.querySelector('.tl-marquee');
         if (el) { const r2 = el.getBoundingClientRect(); band = { w: Math.round(r2.width), h: Math.round(r2.height) }; }
       }
       const picked = window.__picked();
       window.dispatchEvent(new PointerEvent('pointerup',
         { bubbles: true, cancelable: true, button: 0, pointerId: 82, ...b }));
       await new Promise(r => setTimeout(r, 180));
       return { band, duringSweep: picked, after: window.__picked(),
                bandGone: !document.querySelector('.tl-marquee') };
     };
     return true;`,
  )

  /**
   * A pair on V1/A1 from zero, a picture on V2 from two, more sound on A2 from
   * three. Four tracks, four clips, every one overlapping the others in time —
   * which is what makes a rectangle a different answer from a list.
   */
  const seedSelect = `
    const { assets, sequence, view } = window.__fluxDev;
    const voice = assets.getAssets().find(x => x.name === 'voice_over.mp4');
    const other = assets.getAssets().find(x => x.name === 'clipA.mp4');
    const pv = await assets.ensureProbed(voice.id), po = await assets.ensureProbed(other.id);
    sequence.setSequence(null);
    view.recordView({ timeline: { zoom: 40 } });
    await new Promise(r => setTimeout(r, 200));
    sequence.addLinkedClips(
      { assetId: voice.id, trackId: 'V1', start: 0, duration: pv.duration }, true);
    sequence.addClip({ assetId: other.id, trackId: 'V2', start: 2, duration: po.duration });
    sequence.addClip({ assetId: voice.id, trackId: 'A2', start: 3, duration: 4 });
    await new Promise(r => setTimeout(r, 500));
    {
      const seeded = sequence.getSequence().clips;
      if (seeded.length !== 4) throw new Error('setup: ' + seeded.length + ' clips, not 4');
    }
  `

  await check('clicking a clip selects it, and clicking it again lets it go', async () => {
    // The answer to "how do I deselect this" that nobody has to be taught.
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V1');
         const first = window.__picked();
         await window.__pressClip('V1');
         return { first, second: window.__picked() };`,
    )
    assert.deepEqual(
      state.first,
      ['A1:voice_over.mp4', 'V1:voice_over.mp4'],
      'a click takes the clip and its other half',
    )
    assert.deepEqual(state.second, [], 'and a second click lets both go')
  })

  await check('clicking empty timeline lets go of everything', async () => {
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V1');
         const before = window.__picked();
         // Far right of the A2 lane, where nothing is.
         const swept = await window.__sweep('A2', 'A2', 900, 900);
         return { before, after: swept.after, band: swept.band };`,
    )
    assert.equal(state.before.length, 2, 'setup: something should have been selected')
    assert.deepEqual(state.after, [], 'a click away from everything is how you let go')
    assert.equal(state.band, null, 'and a press that goes nowhere draws no rubber band')
  })

  await check('ctrl-clicking adds one clip at a time, and takes it back out', async () => {
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V1');
         await window.__pressClip('V2', { ctrlKey: true });
         const added = window.__picked();
         await window.__pressClip('V2', { ctrlKey: true });
         return { added, removed: window.__picked() };`,
    )
    assert.deepEqual(state.added, ['A1:voice_over.mp4', 'V1:voice_over.mp4', 'V2:clipA.mp4'])
    assert.deepEqual(
      state.removed,
      ['A1:voice_over.mp4', 'V1:voice_over.mp4'],
      'ctrl on something already in the selection takes it out again',
    )
  })

  await check('shift-clicking selects the rectangle from the anchor to here', async () => {
    /*
     * The gesture this was asked for. Anchor on the picture on V1, shift-click
     * the sound two tracks below it: the picture, its own sound, and whatever
     * else lies under that stretch of time down to the track clicked.
     *
     * V2 is *not* in it, and that is the point of a rectangle rather than a
     * bag: V2 sits above the anchor, so a range reaching downward does not
     * touch it. Reaching up from A2 would.
     */
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V1');
         await window.__pressClip('A2', { shiftKey: true });
         const down = window.__picked();
         await window.__pressClip('A2');
         await window.__pressClip('V2', { shiftKey: true });
         return { down, up: window.__picked() };`,
    )
    assert.deepEqual(
      state.down,
      ['A1:voice_over.mp4', 'A2:voice_over.mp4', 'V1:voice_over.mp4'],
      'reaching down from V1 to A2 should take everything between them, and not V2',
    )
    assert.deepEqual(
      state.up,
      ['A1:voice_over.mp4', 'A2:voice_over.mp4', 'V1:voice_over.mp4', 'V2:clipA.mp4'],
      'and reaching up from A2 to V2 should take all four',
    )
  })

  await check('a range keeps its anchor, so it can be re-aimed', async () => {
    // Shift-clicking twice extends the same range rather than dragging one end
    // along behind the pointer — which is what makes overshooting recoverable.
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V1');
         await window.__pressClip('A2', { shiftKey: true });
         const far = window.__picked();
         await window.__pressClip('A1', { shiftKey: true });
         return { far, near: window.__picked() };`,
    )
    assert.equal(state.far.length, 3, `setup: expected three, got ${state.far.join(' ')}`)
    assert.deepEqual(
      state.near,
      ['A1:voice_over.mp4', 'V1:voice_over.mp4'],
      'a second shift-click should re-aim from the same anchor, not from the last target',
    )
  })

  await check('sweeping a rubber band selects what it touches', async () => {
    /*
     * Live while it is dragged, because a sweep that only shows its result on
     * release is a sweep you cannot aim. And touching counts: the band below
     * covers the middle of every clip it crosses and none of them entirely.
     */
    const state = await evaluate(
      cdp,
      seedSelect +
        `return await window.__sweep('V2', 'A2', 130, 260);`,
    )
    assert.ok(state.band, 'no rubber band was ever drawn')
    assert.ok(state.band.w > 100 && state.band.h > 100, `the band is ${JSON.stringify(state.band)}`)
    assert.deepEqual(
      state.duringSweep,
      ['A1:voice_over.mp4', 'A2:voice_over.mp4', 'V1:voice_over.mp4', 'V2:clipA.mp4'],
      'a band across all four rows should have caught all four clips, mid-sweep',
    )
    assert.deepEqual(state.after, state.duringSweep, 'and releasing must not change its mind')
    assert.equal(state.bandGone, true, 'the band goes when the pointer does')
  })

  await check('a sweep with ctrl held adds to what was already selected', async () => {
    const state = await evaluate(
      cdp,
      seedSelect +
        `await window.__pressClip('V2');
         const before = window.__picked();
         // Across the audio rows only, over the stretch where both of them
         // have something: the sound on A2 runs from three seconds to seven.
         const swept = await window.__sweep('A1', 'A2', 130, 200, { ctrlKey: true });
         return { before, after: swept.after };`,
    )
    assert.deepEqual(state.before, ['V2:clipA.mp4'])
    assert.deepEqual(
      state.after,
      ['A1:voice_over.mp4', 'A2:voice_over.mp4', 'V1:voice_over.mp4', 'V2:clipA.mp4'],
      'ctrl should keep what was selected and add what the band caught — and the ' +
        'sound it caught brings its own picture with it',
    )
  })

  await check('pausing selects what the playhead landed on, when asked to', async () => {
    /*
     * Off by default: a transport that quietly changes the selection every time
     * it stops would be a surprise. On, it is the gesture of playing until it
     * looks right, stopping, and reaching for that clip.
     *
     * Alt+A here rather than Alt+F4, which Windows spends on closing the
     * window before a page can see it. Both are bound; only one can be checked.
     */
    const state = await evaluate(
      cdp,
      seedSelect +
        `const { playback } = window.__fluxDev;
         playback.seek(0);
         await new Promise(r => setTimeout(r, 150));

         // Off: pausing leaves the selection alone.
         playback.play();
         await new Promise(r => setTimeout(r, 700));
         playback.pause();
         await new Promise(r => setTimeout(r, 300));
         const off = { picked: window.__picked(), mode: view.getView().timeline.autoSelect ?? false };

         window.dispatchEvent(new KeyboardEvent('keydown',
           { key: 'a', altKey: true, bubbles: true, cancelable: true }));
         await new Promise(r => setTimeout(r, 250));
         const notice = document.querySelector('.tl-notice')?.textContent ?? null;

         // On: pausing inside the pair selects the pair.
         playback.seek(0);
         await new Promise(r => setTimeout(r, 150));
         playback.play();
         await new Promise(r => setTimeout(r, 700));
         playback.pause();
         await new Promise(r => setTimeout(r, 400));
         const on = { picked: window.__picked(), at: playback.getTime(),
                      mode: view.getView().timeline.autoSelect };

         // And back off, so nothing below inherits the mode.
         window.dispatchEvent(new KeyboardEvent('keydown',
           { key: 'a', altKey: true, bubbles: true, cancelable: true }));
         await new Promise(r => setTimeout(r, 200));
         return { off, on, notice, restored: view.getView().timeline.autoSelect };`,
    )
    assert.equal(state.off.mode, false, 'the mode should start off')
    assert.deepEqual(state.off.picked, [], 'and pausing should have selected nothing')
    assert.equal(state.on.mode, true, 'Alt+A should have turned it on')
    assert.ok(state.notice?.includes('Auto select on'), state.notice)
    assert.ok(state.on.at > 0.3, `the playhead only reached ${state.on.at}s`)
    assert.deepEqual(
      state.on.picked,
      ['A1:voice_over.mp4', 'V1:voice_over.mp4'],
      'pausing inside the pair should select the pair — the clip the Viewer is showing',
    )
    assert.equal(state.restored, false, 'and the mode toggles back off')
  })

  // ── copying, pasting and duplicating ──────────────────────────

  /*
   * Three ways to get a second copy of something, and they are the same
   * machinery underneath: a snapshot of the clips, placed somewhere with new
   * ids and new links. What differs is where "somewhere" comes from — the
   * playhead, or the end of an Alt-drag.
   */
  await evaluate(
    cdp,
    `window.__key = (key, mods = {}) => window.dispatchEvent(
       new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
     return true;`,
  )

  await check('ctrl+c then ctrl+v puts a copy down at the playhead', async () => {
    const state = await evaluate(
      cdp,
      // Two clips with room between them: the playhead can only be moved
      // inside the sequence, so pasting *at* it needs a sequence long enough to
      // have somewhere free to land — and a gap wide enough to take the copy,
      // or this would be checking the slide rule instead.
      seedClips(8) +
        `const { playback } = window.__fluxDev;
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         window.__key('c', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 150));
         playback.seek(4.5);
         await new Promise(r => setTimeout(r, 150));
         window.__key('v', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 350));
         return { clips: window.__shape(), selected: window.__selected(),
                  notice: document.querySelector('.tl-notice')?.textContent ?? null };`,
    )
    assert.equal(state.clips.length, 3, 'there should be a third clip now')
    const pasted = state.clips.find((clip) => clip.start === 4.5)
    assert.ok(pasted, `nothing landed at the playhead: ${JSON.stringify(state.clips)}`)
    assert.equal(pasted.track, 'V1', 'a copy lands on the track it came from')
    assert.equal(pasted.dur, state.clips[0].dur, 'and it is the same length')
    assert.equal(state.selected, 1, 'the copy is what is selected, so the next drag moves it')
    assert.ok(state.notice?.includes('Pasted'), state.notice)
  })

  await check('a pasted pair is linked to itself, not to what it came from', async () => {
    /*
     * Two pairs sharing one link id would mean dragging the copy moved the
     * original, which is the kind of bug that shows up an hour later in
     * somebody's edit rather than here.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const { playback } = window.__fluxDev;
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         window.__key('c', { ctrlKey: true });
         playback.seek(14);
         await new Promise(r => setTimeout(r, 150));
         window.__key('v', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 400));
         const clips = sequence.getSequence().clips;
         const links = clips.map(c => c.linkId ?? null);
         // Drag one half of the copy: its own partner must follow, and the
         // originals must not move at all.
         const before = clips.map(c => Math.round(c.start * 1000) / 1000);
         const copyVideo = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--video') && el.className.includes('clip--selected'));
         await window.__dragClip(copyVideo, 60, 0, { noSnap: true });
         return { count: clips.length, links,
                  after: sequence.getSequence().clips.map(c => Math.round(c.start * 1000) / 1000),
                  before };`,
    )
    assert.equal(state.count, 4, 'a pair pasted should be two more clips')
    const groups = new Set(state.links)
    assert.equal(groups.size, 2, `expected two link groups, got ${JSON.stringify(state.links)}`)
    assert.ok(!state.links.includes(null), 'both pairs should still be linked')

    /*
     * The originals are the two at zero and must not have moved; the copies are
     * the other two and must have moved *together*. Compared as a shape rather
     * than against fixed numbers: where the paste landed depends on how long
     * the fixture is, and hard-coding that would make this a check about
     * voice_over.mp4 rather than about linking.
     */
    const stayed = state.after.filter((start) => start === 0)
    assert.equal(stayed.length, 2, `the originals moved: ${JSON.stringify(state.after)}`)
    const copies = state.after.filter((start) => start !== 0)
    assert.equal(copies.length, 2, JSON.stringify(state.after))
    assert.equal(copies[0], copies[1], `the halves of the copy came apart: ${JSON.stringify(copies)}`)
    const was = state.before.filter((start) => start !== 0)
    assert.ok(
      copies[0] > was[0],
      `the copy should have moved, from ${was[0]} to ${copies[0]}`,
    )
  })

  await check('pasting where something already sits slides the copy past it', async () => {
    // The drop rule, not the move rule: these clips are new, and sliding right
    // is the only outcome that neither loses a frame nor moves what is already
    // placed. The whole group slides as one, or a pasted pair lands out of sync.
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `const { playback } = window.__fluxDev;
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         window.__key('c', { ctrlKey: true });
         // Straight back onto itself.
         playback.seek(0);
         await new Promise(r => setTimeout(r, 150));
         window.__key('v', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 350));
         return { clips: window.__shape(),
                  notice: document.querySelector('.tl-notice')?.textContent ?? null };`,
    )
    assert.equal(state.clips.length, 2)
    const [first, second] = state.clips
    assert.equal(first.start, 0, 'the original stays where it was')
    assert.equal(
      second.start,
      first.dur,
      `the copy should butt up after it, and it landed at ${second.start}`,
    )
    assert.ok(state.notice?.includes('slid'), `the slide has to be said: ${state.notice}`)
  })

  await check('alt-dragging a clip leaves the original and places a copy', async () => {
    const state = await evaluate(
      cdp,
      dropOne('clipA.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         // Alt held for the whole gesture, which is what a hand does.
         await window.__dragClip(0, 360, 0, { altKey: true });
         return { clips: window.__shape(), selected: window.__selected(),
                  notice: document.querySelector('.tl-notice')?.textContent ?? null };`,
    )
    assert.equal(state.clips.length, 2, 'an alt-drag should have made a second clip')
    assert.equal(state.clips[0].start, 0, 'the original must stay exactly where it was')
    assert.equal(state.clips[1].start, 6, 'and the copy lands where the drag ended')
    assert.equal(state.selected, 1, 'the copy is selected, not the clip it came from')
    assert.ok(state.notice?.includes('Duplicated'), state.notice)
  })

  await check('an alt-drag does not disturb what was copied', async () => {
    /*
     * Alt-dragging something must not throw away whatever was copied a minute
     * ago. Small, and infuriating exactly once.
     *
     * Two *different* clips, and they are different lengths — clipA runs four
     * seconds and shot_B three. Copying one and duplicating the other is the
     * only arrangement where a clipboard quietly overwritten by the drag can be
     * told apart from one left alone: the length of what finally pastes says
     * which clip was in it. Written first with one clip for both halves, where
     * a canary that clobbered the clipboard with the very clip already in it
     * changed nothing observable and sailed through.
     */
    const state = await evaluate(
      cdp,
      seedClips(8) +
        `const { playback } = window.__fluxDev;
         // clipA, at zero, is the one that goes to the clipboard.
         window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         window.__key('c', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 150));
         const copied = sequence.clipboardCount();
         const lengths = window.__shape().map(c => c.dur);

         // shot_B, further along, is the one that gets duplicated.
         await window.__dragClip(1, 180, 0, { altKey: true });
         await new Promise(r => setTimeout(r, 200));

         // The end of everything, which is as far as a playhead goes.
         playback.goToEnd();
         await new Promise(r => setTimeout(r, 150));
         const at = playback.getTime();
         window.__key('v', { ctrlKey: true });
         await new Promise(r => setTimeout(r, 350));
         return { copied, at, lengths, after: sequence.clipboardCount(),
                  clips: window.__shape() };`,
    )
    assert.equal(state.copied, 1, 'setup: one clip should have been copied')
    assert.ok(
      state.lengths[0] !== state.lengths[1],
      `setup: the two fixtures must differ in length, got ${state.lengths.join(' and ')}`,
    )
    assert.equal(state.after, 1, 'the alt-drag emptied the clipboard')
    assert.equal(state.clips.length, 4, 'two originals, a duplicate, and a paste')

    const pasted = state.clips.find((clip) => clip.start === state.at)
    assert.ok(pasted, `nothing pasted at the playhead (${state.at}): ${JSON.stringify(state.clips)}`)
    assert.equal(
      pasted.dur,
      state.lengths[0],
      'what pasted is the clip that was copied, not the one that was alt-dragged',
    )
  })

  await check('a duplicated pair changes track together or not at all', async () => {
    /*
     * The same rule as moving one. Alt-dragging a pair upward from V1 and A1
     * cannot lift the picture to V2 while the sound stays on A1 — A1 is already
     * the top audio track, so there is no room, and the shift is limited by
     * whichever half has least. A pair that changed track in halves would be a
     * pair that arrived in two pieces.
     *
     * Found on screen rather than reasoned about: the first version clamped
     * each clip on its own, and the copy landed with its picture a track up and
     * its sound where it started.
     */
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `window.__clickClip(0);
         await new Promise(r => setTimeout(r, 150));
         const video = [...document.querySelectorAll('.tl-lane .clip')]
           .findIndex(el => el.className.includes('clip--video'));
         // Up one track and along, with Alt held: a duplicate.
         await window.__dragClip(video, 120, -46, { altKey: true });
         return window.__shape();`,
    )
    assert.equal(state.length, 4, `expected two pairs, got ${JSON.stringify(state)}`)
    const tracks = state.map((clip) => clip.track).sort()
    assert.deepEqual(
      tracks,
      ['A1', 'A1', 'V1', 'V1'],
      `the copy should have stayed on the same tracks, and it is on ${tracks.join(' ')}`,
    )
    const copies = state.filter((clip) => clip.start > 0)
    assert.equal(copies.length, 2, 'both halves should have been copied')
    assert.equal(copies[0].start, copies[1].start, 'and they must land at the same moment')
  })

  await check('copying a picture copies its sound', async () => {
    const state = await evaluate(
      cdp,
      dropOne('voice_over.mp4', 1) +
        `const video = sequence.getSequence().clips.find(c => c.kind === 'video');
         return sequence.copyClips([video.id]);`,
    )
    assert.equal(state, 2, 'a linked half named on its own still copies the pair')
  })

  await check('snapping is a mode, and the toolbar says which', async () => {
    /*
     * It became a mode when Alt was given to duplicate-drag, and a mode you
     * cannot see the state of is worse than a key you have to hold.
     */
    const state = await evaluate(
      cdp,
      seedClips(0.2) +
        `const button = [...document.querySelectorAll('.cb-btn')]
           .find(b => b.textContent.trim() === 'Snap');
         if (!button) throw new Error('no snapping control in the toolbar');
         const on = button.className.includes('cb-btn--on');
         // The paint, not just the class. A mode nobody can see the state of is
         // worse than a key you have to hold — and a class name that no rule
         // matches looks identical from here. (Seen exactly that way: a stale
         // stylesheet left the button unlit while every check still passed.)
         const litBg = getComputedStyle(button).backgroundColor;
         window.__key('s');
         await new Promise(r => setTimeout(r, 200));
         const afterKey = {
           button: button.className.includes('cb-btn--on'),
           view: window.__fluxDev.view.getView().timeline.snapping,
           bg: getComputedStyle(button).backgroundColor,
         };
         // And with it off, a drag that would have snapped leaves its gap.
         await window.__dragClip(1, -6, 0);
         const clips = window.__fluxDev.sequence.getSequence().clips
           .slice().sort((p, q) => p.start - q.start);
         const gapFrames = (clips[1].start - (clips[0].start + clips[0].duration)) * 24;
         button.click();
         await new Promise(r => setTimeout(r, 200));
         return { on, litBg, afterKey, gapFrames,
                  backOn: button.className.includes('cb-btn--on') };`,
    )
    assert.equal(state.on, true, 'snapping should start on')
    assert.equal(state.afterKey.button, false, 'pressing S should turn it off')
    assert.equal(state.afterKey.view, false, 'and record it, so the project opens as it was left')
    assert.notEqual(
      state.litBg,
      state.afterKey.bg,
      `on and off look identical (${state.litBg}) — the mode is not visible`,
    )
    assert.ok(state.gapFrames > 1, `with snapping off the gap should survive, got ${state.gapFrames}`)
    assert.equal(state.backOn, true, 'and the button toggles it back')
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

  await check('a trimmed clip survives a save and a reload', async () => {
    // Put back after the reloads above, which take every page-side helper with
    // them.
    await evaluate(cdp, TRIM_HELPERS)
    const before = await evaluate(
      cdp,
      seedTrim +
        `const { store, project } = window.__fluxDev;
         await window.__trimClip(0, 'start', 60, { noSnap: true });
         await window.__trimClip(0, 'end', -60, { noSnap: true });
         const shape = window.__shape();
         /*
          * The setup is checked here rather than after the reload, and the
          * difference is not tidiness. An assertion that fails between
          * location.reload() and the re-open below leaves the app sitting at
          * the launcher with no project, and every check after this one then
          * fails for that reason instead of its own — including the top-level
          * setup between them, which takes the whole run down with no summary.
          * Found exactly that way, by a canary whose real failure was invisible
          * behind it.
          */
         if (Math.abs(shape[0].off - 1) > 1e-6) {
           throw new Error('setup: expected a clip trimmed at both ends, got ' + JSON.stringify(shape[0]));
         }
         const saved = await project.saveProject();
         if (!saved.ok) throw new Error('save failed: ' + saved.error);
         await store.flushStores();
         location.reload();
         return shape;`,
    )

    await new Promise((r) => setTimeout(r, 2500))
    await ensureProject(cdp, VERIFY_PROJECT)
    const after = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const seq = window.__fluxDev.sequence;
       for (let i = 0; i < 40 && !seq.isSequenceLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       const r3 = (n) => Math.round(n * 1000) / 1000;
       return seq.getSequence().clips.map(c => ({ track: c.trackId, kind: c.kind, start: r3(c.start),
         dur: r3(c.duration), off: r3(c.offset), src: r3(c.sourceDuration) }));`,
    )
    assert.deepEqual(after, before, 'a trim that does not survive a save is not an edit')
  })

  await check('a link that was cut stays cut across a save and a reload', async () => {
    // The linked case has its own check above. This is the other state, and it
    // is the one that is stored as an *absence* — a field that is not there.
    // Absences are exactly what a format quietly reinstates.
    const before = await evaluate(
      cdp,
      `const { assets, sequence, store, project, view } = window.__fluxDev;
       sequence.setSequence(null);
       view.recordView({ timeline: { zoom: 60 } });
       await new Promise(r => setTimeout(r, 200));
       const a = assets.getAssets().find(x => x.name === 'voice_over.mp4');
       const probed = await assets.ensureProbed(a.id);
       sequence.addLinkedClips(
         { assetId: a.id, trackId: 'V1', start: 0, duration: probed.duration }, true);
       const video = sequence.getSequence().clips.find(c => c.kind === 'video');
       if (sequence.toggleLink([video.id]) !== 'unlinked') throw new Error('setup: nothing was unlinked');
       // Apart, and in different places, so a reload that re-paired them by
       // position rather than by what was stored would be visible.
       sequence.moveClips([video.id], 2, 0);
       await new Promise(r => setTimeout(r, 200));
       const shape = sequence.getSequence().clips
         .map(c => [c.kind, Math.round(c.start * 1000) / 1000, c.linkId ? 'linked' : 'loose']);
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       location.reload();
       return shape;`,
    )

    await new Promise((r) => setTimeout(r, 2500))
    await ensureProject(cdp, VERIFY_PROJECT)
    const after = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const seq = window.__fluxDev.sequence;
       for (let i = 0; i < 40 && !seq.isSequenceLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       return seq.getSequence().clips
         .map(c => [c.kind, Math.round(c.start * 1000) / 1000, c.linkId ? 'linked' : 'loose']);`,
    )
    assert.deepEqual(
      after.map((row) => row[2]),
      ['loose', 'loose'],
      'a pair that was cut apart came back tied together',
    )
    assert.deepEqual(after.sort(), before.sort(), 'and both halves came back where they were left')
  })

  // ── sequences, and the tabs ───────────────────────────────────

  /*
   * A project holds several sequences and exactly one is being edited. The tab
   * strip is the only place that changes which — which is what makes it safe
   * for every editing function in kernel/sequence.ts to work on "the active
   * one" without asking.
   */

  // A check above reloads the page, which takes every page-side helper with it.
  await evaluate(cdp, DRAG_HELPER)
  await evaluate(
    cdp,
    // The path is built here rather than joined inside the template: a
    // backslash has to survive both this file's template literal and the
    // page's, and one of the two eats it.
    `const assets = window.__fluxDev.assets;
     const file = ${JSON.stringify(path.join(MEDIA_DIR, 'layer_red.mp4'))};
     if (!assets.getAssets().some(a => a.path === file)) {
       assets.importAssets([{ path: file, kind: 'video' }]);
     }
     await Promise.all(assets.getAssets().map(a => assets.ensureProbed(a.id)));
     await new Promise(r => setTimeout(r, 300));
     return true;`,
  )

  const tabNames = () =>
    evaluate(
      cdp,
      `return [...document.querySelectorAll('.seq-tab')]
         .map(t => ({ name: t.textContent.replace(/\u00d7$/, '').trim(),
                      active: t.className.includes('--active') }));`,
    )

  await check('a project starts with one sequence, and it has a tab', async () => {
    const tabs = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 300));
       return { model: sequence.listSequences().map(s => s.name),
                tabs: [...document.querySelectorAll('.seq-tab')].length,
                plus: Boolean(document.querySelector('.seq-tab-add')) };`,
    )
    assert.equal(tabs.model.length, 1)
    assert.equal(tabs.tabs, 1, 'one tab per sequence')
    assert.equal(tabs.plus, true, 'and a way to make another')
  })

  await check('the + button adds a sequence and switches to it', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 300));
       const before = sequence.getActiveSequenceId();
       document.querySelector('.seq-tab-add').click();
       await new Promise(r => setTimeout(r, 300));
       return { names: sequence.listSequences().map(s => s.name),
                switched: sequence.getActiveSequenceId() !== before,
                clips: sequence.getSequence().clips.length };`,
    )
    assert.deepEqual(state.names, ['Sequence 1', 'Sequence 2'])
    assert.equal(state.switched, true, 'a new sequence is the one you are now editing')
    assert.equal(state.clips, 0, 'and it starts empty')
  })

  await check('each sequence keeps its own clips', async () => {
    // The whole point of several: an edit lands in the one on screen and
    // nowhere else.
    const state = await evaluate(
      cdp,
      `const { assets, sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
       const probed = await assets.ensureProbed(a.id);

       const first = sequence.getActiveSequenceId();
       sequence.addClip({ assetId: a.id, trackId: 'V1', start: 0, duration: probed.duration });
       const second = sequence.createSequence({ name: 'Other' });
       sequence.addClip({ assetId: a.id, trackId: 'V1', start: 3, duration: probed.duration });

       const onSecond = sequence.getSequence().clips.map(c => c.start);
       sequence.activateSequence(first);
       await new Promise(r => setTimeout(r, 200));
       const onFirst = sequence.getSequence().clips.map(c => c.start);
       sequence.activateSequence(second.id);
       const backOnSecond = sequence.getSequence().clips.map(c => c.start);
       return { onFirst, onSecond, backOnSecond,
                counts: sequence.listSequences().map(s => s.clips.length) };`,
    )
    assert.deepEqual(state.onFirst, [0], 'the first sequence kept its own clip')
    assert.deepEqual(state.onSecond, [3])
    assert.deepEqual(state.backOnSecond, [3], 'and switching away and back changed nothing')
    assert.deepEqual(state.counts, [1, 1])
  })

  await check('switching tabs keeps unsaved edits', async () => {
    // Switching is not a commit. An edit that vanished because you looked at
    // something else would be the worst kind of loss — silent, and blamed on
    // yourself.
    const state = await evaluate(
      cdp,
      `const { assets, sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
       const probed = await assets.ensureProbed(a.id);
       const first = sequence.getActiveSequenceId();
       sequence.addClip({ assetId: a.id, trackId: 'V1', start: 0, duration: probed.duration });
       const second = sequence.createSequence({ name: 'Scratch' });
       sequence.activateSequence(first);
       // Edit the first one *after* the second exists, then look away.
       sequence.setTrackMuted('A1', true);
       sequence.activateSequence(second.id);
       sequence.activateSequence(first);
       await new Promise(r => setTimeout(r, 200));
       return sequence.getSequence().tracks.find(t => t.id === 'A1').muted;`,
    )
    assert.equal(state, true, 'an edit made before switching away must still be there')
  })

  await check('clicking a tab switches sequence', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       sequence.createSequence({ name: 'Second' });
       await new Promise(r => setTimeout(r, 250));
       const tabs = [...document.querySelectorAll('.seq-tab')];
       tabs[0].click();
       await new Promise(r => setTimeout(r, 250));
       const firstActive = sequence.getSequence().name;
       tabs[1].click();
       await new Promise(r => setTimeout(r, 250));
       return { firstActive, secondActive: sequence.getSequence().name };`,
    )
    assert.equal(state.firstActive, 'Sequence 1')
    assert.equal(state.secondActive, 'Second')
  })

  await check('the last sequence cannot be closed', async () => {
    // Same rule as the last track: a project with no sequence has no timeline,
    // and that is a state with no way back out of it.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const only = sequence.getActiveSequenceId();
       const refused = sequence.removeSequence(only);
       return { refused: refused === null, left: sequence.listSequences().length,
                closeButtons: document.querySelectorAll('.seq-tab-close').length };`,
    )
    assert.equal(state.refused, true)
    assert.equal(state.left, 1)
    assert.equal(state.closeButtons, 0, 'and there is no button offering to')
  })

  await check('closing a sequence leaves another one open', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const second = sequence.createSequence({ name: 'Doomed' });
       sequence.removeSequence(second.id);
       await new Promise(r => setTimeout(r, 250));
       return { names: sequence.listSequences().map(s => s.name),
                active: sequence.getSequence().name };`,
    )
    assert.deepEqual(state.names, ['Sequence 1'])
    assert.equal(state.active, 'Sequence 1', 'closing the open one must land on another')
  })

  await check('a sequence can be renamed from its tab', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const tab = document.querySelector('.seq-tab');
       tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       await new Promise(r => setTimeout(r, 200));
       const input = tab.querySelector('.seq-tab-name');
       if (!input) throw new Error('double-click did not offer a name to type');
       input.focus();
       // React's onBlur is delegated from focusout, which bubbles; a plain
       // 'blur' event does not, so setting the value and calling blur() is what
       // a person clicking away actually produces.
       const setter = Object.getOwnPropertyDescriptor(
         window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, 'Director cut');
       input.dispatchEvent(new Event('input', { bubbles: true }));
       input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
       await new Promise(r => setTimeout(r, 300));
       return sequence.listSequences().map(s => s.name);`,
    )
    assert.deepEqual(state, ['Director cut'])
  })

  await check('an empty sequence takes its settings from the first footage dropped on it', async () => {
    /*
     * Premiere asks; FLUX takes the answer from the footage, because the
     * question can only be answered by looking at the footage and nobody has
     * been shown any sequence settings to answer it with.
     *
     * layer_red.mp4 is 1280x720 at 25fps with mono 44.1kHz sound — none of
     * which is the default, so every field here is evidence.
     */
    const state = await evaluate(
      cdp,
      `const { assets, sequence, view } = window.__fluxDev;
       if (!assets.getAssets().some(a => a.name === 'layer_red.mp4')) {
         assets.importAssets([{ path: ${dir} + '\\\\layer_red.mp4', kind: 'video' }]);
         await Promise.all(assets.getAssets().map(a => assets.ensureProbed(a.id)));
       }
       sequence.setSequence(null);
       view.recordView({ timeline: { zoom: 60 } });
       await new Promise(r => setTimeout(r, 400));
       const before = sequence.getSequence().settings;
       await window.__drag('layer_red.mp4', 1, 0, 60);
       await new Promise(r => setTimeout(r, 600));
       const after = sequence.getSequence().settings;
       return {
         before: [before.width, before.height, before.frameRate],
         after: [after.width, after.height, after.frameRate],
         audio: after.audio,
       };`,
    )
    assert.deepEqual(state.before, [1920, 1080, 24], 'the default, before anything was dropped')
    assert.deepEqual(state.after, [1280, 720, 25], `it became ${state.after.join('x')}`)
    assert.deepEqual(state.audio, { sampleRate: 44100, channels: 1 })
  })

  await check('a sequence with an edit keeps its settings when more is dropped in', async () => {
    // Only the *first* clip decides. Changing the frame under someone halfway
    // through would reframe and re-time every shot at once.
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const before = sequence.getSequence().settings;
       await window.__drag('clipA.mp4', 1, 8, 60);
       await new Promise(r => setTimeout(r, 500));
       const after = sequence.getSequence().settings;
       return { before: [before.width, before.height], after: [after.width, after.height],
                clips: sequence.getSequence().clips.length };`,
    )
    assert.ok(state.clips >= 2, 'setup: the second clip should have landed')
    assert.deepEqual(state.after, state.before, 'the frame moved when it should not have')
  })

  await check('sequence settings can be changed, and the timeline follows', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       sequence.updateSequenceSettings({ frameRate: 30, width: 3840, height: 2160 });
       await new Promise(r => setTimeout(r, 250));
       const shown = [...document.querySelectorAll('.tool-value')].map(e => e.textContent);
       return { settings: sequence.getSequence().settings, shown };`,
    )
    assert.equal(state.settings.frameRate, 30)
    assert.equal(state.settings.width, 3840)
    assert.ok(state.shown.includes('30 fps'), `the toolbar shows ${state.shown.join(' ')}`)
    assert.ok(state.shown.includes('3840×2160'))
  })

  await check('settings that make no sense are refused, not stored', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       sequence.updateSequenceSettings({ width: 0, height: -5, frameRate: NaN });
       const s = sequence.getSequence().settings;
       return [s.width, s.height, s.frameRate];`,
    )
    assert.deepEqual(state, [1920, 1080, 24], 'a frame with no pixels in it is not a frame')
  })

  await check('every sequence in the project is written to its own file', async () => {
    const state = await evaluate(
      cdp,
      `const { assets, sequence, project, store } = window.__fluxDev;
       sequence.setSequence(null);
       await new Promise(r => setTimeout(r, 250));
       const a = assets.getAssets().find(x => x.name === 'clipA.mp4');
       const probed = await assets.ensureProbed(a.id);
       sequence.addClip({ assetId: a.id, trackId: 'V1', start: 0, duration: probed.duration });
       sequence.renameSequence(sequence.getActiveSequenceId(), 'Reel one');
       sequence.createSequence({ name: 'Reel two' });
       sequence.addClip({ assetId: a.id, trackId: 'V1', start: 2, duration: probed.duration });

       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();

       const root = project.getProject().root;
       const onDisk = await window.flux.project.listSequences(root);
       return {
         files: onDisk.map(s => ({ name: s.name, clips: s.clips.length, media: s.media.length })),
         active: sequence.getSequence().name,
       };`,
    )
    const byName = Object.fromEntries(state.files.map((one) => [one.name, one]))
    assert.ok(byName['Reel one'], `only found ${state.files.map((f) => f.name).join(', ')}`)
    assert.ok(byName['Reel two'])
    assert.equal(byName['Reel one'].clips, 1)
    assert.equal(byName['Reel two'].clips, 1)
    assert.equal(byName['Reel one'].media, 1, 'the media a clip refers to travels with it')
  })

  await check('the sequences come back, and so does the one that was open', async () => {
    const before = await evaluate(
      cdp,
      `const { sequence, project, store } = window.__fluxDev;
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       const state = { names: sequence.listSequences().map(s => s.name).sort(),
                       active: sequence.getSequence().name,
                       clips: sequence.getSequence().clips.length };
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
       return { names: seq.listSequences().map(s => s.name).sort(),
                active: seq.getSequence().name,
                clips: seq.getSequence().clips.length };`,
    )
    assert.deepEqual(after.names, before.names, 'the sequences did not all come back')
    assert.equal(after.active, before.active, 'the one that was open should be the one that opens')
    assert.equal(after.clips, before.clips)
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
