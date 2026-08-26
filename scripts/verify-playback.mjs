/**
 * Verifies the transport: the playhead, and the picture that follows it.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-playback.mjs [mediaDir]
 *
 * Playback is the one feature where "it looks right" is not enough. A viewer
 * that shows a frame while the clock has moved on, or a clock that runs while
 * the video is paused, both look fine in a screenshot — so what is checked here
 * is that the sequence's time and the element's time stay in agreement, in
 * seconds, against a real decode of a real file.
 *
 * CLEARS the project's sequence so runs are repeatable.
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

try {
  await requireFixtures(cdp, MEDIA_DIR)
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  // One clip on V1, starting at 0. Everything below reads against it.
  const setup = await evaluate(
    cdp,
    `const { importPipeline, assets, sequence, playback } = window.__fluxDev;
     const added = await importPipeline.importFiles(
       [{ path: ${dir} + '\\\\clipA.mp4', kind: 'video' }],
       'link',
     );
     const asset = added[0] ?? assets.getAssets().find(a => a.name === 'clipA.mp4');
     const probed = await assets.ensureProbed(asset.id);
     sequence.clearSequence();
     sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
     playback.seek(0);
     await new Promise(r => setTimeout(r, 600));
     return { duration: probed.duration, clips: sequence.getSequence().clips.length };`,
  )
  assert.ok(setup.duration > 1, `fixture is too short to play: ${setup.duration}s`)

  await check('an empty sequence has nothing to play', async () => {
    // Guarded rather than left to run: a transport that "plays" a sequence with
    // no duration leaves a playhead crawling through nothing.
    const state = await evaluate(
      cdp,
      `const { sequence, playback, commands } = window.__fluxDev;
       const saved = sequence.getSequence().clips.slice();
       sequence.clearSequence();
       await commands.run('playback.toggle');
       await new Promise(r => setTimeout(r, 300));
       const playing = playback.isPlaying();
       saved.forEach(c => sequence.addClip(c));
       await new Promise(r => setTimeout(r, 200));
       return { playing, restored: sequence.getSequence().clips.length };`,
    )
    assert.equal(state.playing, false, 'play must refuse an empty sequence')
    assert.equal(state.restored, 1, 'the fixture clip should be back')
  })

  await check('the viewer shows the clip under the playhead', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.seek(0.5);
       for (let i = 0; i < 40 && !document.querySelector('video.viewer-media'); i++)
         await new Promise(r => setTimeout(r, 100));
       const v = document.querySelector('video.viewer-media');
       return { present: !!v, src: v?.getAttribute('src')?.slice(0, 11) ?? null,
                placeholder: !!document.querySelector('.viewer-placeholder') };`,
    )
    assert.equal(state.present, true, 'a video element should be on screen')
    assert.equal(state.src, 'flux-asset:', 'served over the app protocol, not file://')
    assert.equal(state.placeholder, false)
  })

  await check('playing advances the sequence clock', async () => {
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.seek(0);
       await new Promise(r => setTimeout(r, 200));
       const before = playback.getTime();
       await commands.run('playback.toggle');
       await new Promise(r => setTimeout(r, 1000));
       const after = playback.getTime();
       await commands.run('playback.toggle');
       return { before, after, elapsed: after - before };`,
    )
    assert.equal(state.before, 0)
    // Generous either side: this is a real animation frame loop on a real
    // machine, and a check that demands a stopwatch fails for reasons that have
    // nothing to do with the code.
    assert.ok(
      state.elapsed > 0.5 && state.elapsed < 1.6,
      `a second of playing moved the playhead ${state.elapsed}s`,
    )
  })

  await check('the picture keeps step with the playhead', async () => {
    // The point of the whole design: the sequence owns the clock and the
    // element is dragged along behind it. Drift here is the bug that makes an
    // editor stop trusting what the viewer shows.
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.seek(0);
       await new Promise(r => setTimeout(r, 300));
       await commands.run('playback.toggle');
       await new Promise(r => setTimeout(r, 1200));
       const v = document.querySelector('video.viewer-media');
       const sample = { time: playback.getTime(), videoTime: v.currentTime, paused: v.paused };
       await commands.run('playback.toggle');
       return sample;`,
    )
    assert.equal(state.paused, false, 'the element must actually be playing, not merely seeking')
    assert.ok(
      Math.abs(state.time - state.videoTime) < 0.15,
      `sequence at ${state.time}s, picture at ${state.videoTime}s`,
    )
  })

  await check('pausing stops both the clock and the element', async () => {
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.pause();
       playback.seek(0);
       await commands.run('playback.play');
       await new Promise(r => setTimeout(r, 500));
       await commands.run('playback.pause');
       await new Promise(r => setTimeout(r, 400));
       const stoppedAt = playback.getTime();
       await new Promise(r => setTimeout(r, 600));
       const v = document.querySelector('video.viewer-media');
       return { playing: playback.isPlaying(), stoppedAt,
                later: playback.getTime(), paused: v.paused };`,
    )
    assert.equal(state.playing, false)
    assert.equal(state.paused, true, 'the element should be paused too')
    assert.equal(state.later, state.stoppedAt, 'the playhead must not creep while paused')
  })

  await check('seeking while paused moves the picture', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.seek(2);
       for (let i = 0; i < 40; i++) {
         const v = document.querySelector('video.viewer-media');
         if (v && Math.abs(v.currentTime - 2) < 0.1) break;
         await new Promise(r => setTimeout(r, 100));
       }
       const v = document.querySelector('video.viewer-media');
       return { time: playback.getTime(), videoTime: v.currentTime };`,
    )
    assert.equal(state.time, 2)
    assert.ok(
      Math.abs(state.videoTime - 2) < 0.15,
      `the element sat at ${state.videoTime}s after seeking to 2s`,
    )
  })

  await check('playback stops at the end rather than running past it', async () => {
    const state = await evaluate(
      cdp,
      `const { playback, sequence, commands } = window.__fluxDev;
       playback.pause();
       const end = sequence.getSequence().clips
         .reduce((e, c) => Math.max(e, c.start + c.duration), 0);
       playback.seek(end - 0.35);
       await commands.run('playback.play');
       for (let i = 0; i < 60 && playback.isPlaying(); i++)
         await new Promise(r => setTimeout(r, 100));
       return { end, time: playback.getTime(), playing: playback.isPlaying() };`,
    )
    assert.equal(state.playing, false, 'it should have stopped itself')
    assert.ok(
      Math.abs(state.time - state.end) < 0.05,
      `parked at ${state.time}s, sequence ends at ${state.end}s`,
    )
  })

  await check('playing from the end starts over', async () => {
    // Pressing play on a finished sequence and having nothing happen is not
    // what a finger expects from any other player.
    const state = await evaluate(
      cdp,
      `const { playback, sequence, commands } = window.__fluxDev;
       playback.pause();
       playback.goToEnd();
       await new Promise(r => setTimeout(r, 200));
       const atEnd = playback.getTime();
       await commands.run('playback.play');
       await new Promise(r => setTimeout(r, 400));
       const time = playback.getTime();
       playback.pause();
       return { atEnd, time };`,
    )
    assert.ok(state.atEnd > 1, 'the fixture should have run to a real end time')
    assert.ok(state.time < 1, `it restarted at ${state.time}s instead of near zero`)
  })

  await check('Space is what plays, through the keymap', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       playback.seek(0);
       document.body.focus();
       window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
       await new Promise(r => setTimeout(r, 400));
       const playing = playback.isPlaying();
       window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
       await new Promise(r => setTimeout(r, 200));
       return { playing, stopped: !playback.isPlaying() };`,
    )
    assert.equal(state.playing, true, 'Space should start playback')
    assert.equal(state.stopped, true, 'and Space again should stop it')
  })

  await check('Space does not play while typing in a field', async () => {
    // A space in a search box that starts playback instead of typing is the
    // single most obvious way to make a keyboard-first app unusable.
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.pause();
       playback.seek(0);
       await commands.run('palette.open');
       for (let i = 0; i < 40 && !document.querySelector('.palette input'); i++)
         await new Promise(r => setTimeout(r, 100));
       const input = document.querySelector('.palette input');
       input.focus();
       input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
       await new Promise(r => setTimeout(r, 300));
       const playing = playback.isPlaying();
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await new Promise(r => setTimeout(r, 200));
       return { hadInput: !!input, playing };`,
    )
    assert.equal(state.hadInput, true, 'the palette should have opened')
    assert.equal(state.playing, false, 'typing a space must type a space')
  })

  await check('the timeline playhead sits where the clock says', async () => {
    const state = await evaluate(
      cdp,
      `const { playback, sequence } = window.__fluxDev;
       playback.pause();
       playback.seek(1.5);
       await new Promise(r => setTimeout(r, 300));
       // Derive the scale from the rendered clip rather than the stored zoom:
       // this then compares two things that are actually on screen.
       const block = document.querySelector('.tl-lane .clip');
       const clip = sequence.getSequence().clips[0];
       const head = document.querySelector('.tl-playhead');
       return { left: parseFloat(head.style.left), time: playback.getTime(),
                zoom: block.getBoundingClientRect().width / clip.duration };`,
    )
    assert.ok(state.zoom > 0, 'the timeline should have a zoom to measure against')
    assert.ok(
      Math.abs(state.left - state.time * state.zoom) < 1,
      `playhead at ${state.left}px, expected ${state.time * state.zoom}px`,
    )
  })

  await check('deleting the clip under the playhead pulls it back', async () => {
    // Otherwise the playhead is left floating past the end of everything, where
    // play() then refuses to move it and the transport looks broken.
    const state = await evaluate(
      cdp,
      `const { playback, sequence } = window.__fluxDev;
       playback.pause();
       playback.seek(2);
       sequence.clearSequence();
       await new Promise(r => setTimeout(r, 300));
       return { time: playback.getTime(), playing: playback.isPlaying(),
                placeholder: document.querySelector('.viewer-placeholder')?.textContent };`,
    )
    assert.equal(state.time, 0, 'the playhead should be back at the start')
    assert.equal(state.playing, false)
    assert.equal(state.placeholder, 'empty sequence', 'and the viewer should say so')
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
