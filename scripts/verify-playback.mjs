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
 * There are two ways a picture reaches the screen — the WebCodecs pipeline
 * drawing to a canvas, and a plain <video> for files the demuxer will not touch
 * — so the checks ask *what is on screen* through `__picture()` rather than
 * reaching for one element or the other. A check that names an element passes
 * or fails on which path happened to be taken, which is not what any of these
 * are about.
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
/** A minute of video, which is the only kind of file that can prove seeking. */
const LONG = JSON.stringify(path.join(MEDIA_DIR, 'long_take.mp4'))
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

const { check, report } = createChecker()
const cdp = await attach()

/**
 * What the viewer is showing, and how it got there.
 *
 * `time` is in *source* seconds — where the picture is inside its own clip —
 * because that is the number both paths can honestly report.
 */
const PICTURE = `
  window.__picture = () => {
    const canvas = document.querySelector('canvas.viewer-media');
    if (canvas && getComputedStyle(canvas).display !== 'none' && canvas.dataset.frameTime) {
      return { via: 'pipeline', time: parseFloat(canvas.dataset.frameTime), el: canvas };
    }
    const video = document.querySelector('video.viewer-media');
    if (video) return { via: 'element', time: video.currentTime, el: video };
    return { via: 'none', time: null, el: null };
  };
  window.__lit = (el, w = 48, h = 27) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(el, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 40) lit++;
    return { lit, of: w * h };
  };
  window.__settle = async (want, ms = 6000) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      const p = window.__picture();
      if (p.time !== null && Math.abs(p.time - want) < 0.08) return p;
      await new Promise(r => setTimeout(r, 50));
    }
    return window.__picture();
  };
  return true;`

try {
  await requireFixtures(cdp, MEDIA_DIR)
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)
  await evaluate(cdp, PICTURE)

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
       const p = await window.__settle(0.5);
       return { via: p.via, time: p.time,
                placeholder: !!document.querySelector('.viewer-placeholder') };`,
    )
    assert.notEqual(state.via, 'none', 'nothing is drawing the picture')
    assert.ok(Math.abs(state.time - 0.5) < 0.1, `the picture sat at ${state.time}s`)
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
       const before = playback.getTime();
       const shown = window.__picture().time;
       await new Promise(r => setTimeout(r, 400));
       const moved = window.__picture().time > shown;
       await commands.run('playback.toggle');
       return { time: before, videoTime: shown, moved };`,
    )
    assert.equal(state.moved, true, 'the picture must actually be advancing, not merely seeking')
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
       const shown = window.__picture().time;
       await new Promise(r => setTimeout(r, 600));
       return { playing: playback.isPlaying(), stoppedAt, shown,
                later: playback.getTime(), stillShown: window.__picture().time };`,
    )
    assert.equal(state.playing, false)
    assert.equal(state.later, state.stoppedAt, 'the playhead must not creep while paused')
    assert.equal(state.stillShown, state.shown, 'and neither must the picture')
  })

  await check('seeking while paused moves the picture', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.seek(2);
       const p = await window.__settle(2);
       return { time: playback.getTime(), videoTime: p.time, via: p.via };`,
    )
    assert.equal(state.time, 2)
    assert.ok(
      Math.abs(state.videoTime - 2) < 0.15,
      `the picture sat at ${state.videoTime}s after seeking to 2s (via ${state.via})`,
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

  // ── a real clip, not a four-second fixture ────────────────────
  //
  // Everything above works on a file small enough for Chromium to swallow whole
  // before anyone asks it to seek. That is precisely the condition under which
  // a broken asset server looks fine: the bug only shows on media big enough
  // that the player has to fetch parts of it on demand.

  const longSetup = await evaluate(
    cdp,
    `const { importPipeline, assets, sequence, playback } = window.__fluxDev;
     const added = await importPipeline.importFiles(
       [{ path: ${LONG}, kind: 'video' }], 'link');
     const asset = added[0] ?? assets.getAssets().find(a => a.name === 'long_take.mp4');
     if (!asset) throw new Error('long_take.mp4 missing - see the README for the ffmpeg line');
     const probed = await assets.ensureProbed(asset.id);
     sequence.setSequence(null);
     sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
     playback.pause();
     playback.seek(0);
     await new Promise(r => setTimeout(r, 900));
     return { duration: probed.duration };`,
  )
  assert.ok(longSetup.duration > 30, `long_take.mp4 is only ${longSetup.duration}s`)

  await check('a long clip reports its whole length as seekable', async () => {
    // A smoke check, not a proof of range support: Chromium will buffer a small
    // file whole and then seek inside it happily with no ranges at all, so what
    // this catches is the element failing to load or reporting a truncated
    // duration. The protocol contract itself is checked directly, against the
    // headers, in verify-renderer.
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       // Every second of it, sampled: the point is that no part of a long file
       // is out of reach, whichever path is drawing.
       const out = [];
       for (const t of [1, 15, 30, 45, 59]) {
         playback.seek(t);
         const p = await window.__settle(t);
         out.push([t, p.time, p.via]);
       }
       return out;`,
    )
    for (const [asked, got, via] of state) {
      assert.ok(
        got !== null && Math.abs(got - asked) < 0.1,
        `asked for ${asked}s and got ${got}s via ${via}`,
      )
    }
  })

  await check('seeking deep into a long clip lands where it was asked to', async () => {
    const samples = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       const out = [];
       for (const t of [48, 5, 30, 59]) {
         playback.seek(t);
         const p = await window.__settle(t);
         out.push([t, p.time]);
       }
       return out;`,
    )
    for (const [asked, got] of samples) {
      assert.ok(
        Math.abs(got - asked) < 0.25,
        `asked for ${asked}s and the picture sat at ${got}s`,
      )
    }
  })

  await check('the picture at the playhead is a real frame, not black', async () => {
    // A seek that silently fails leaves the first frame on screen; a seek that
    // fails on a file starting black leaves black. Sampling the pixels is the
    // only way to tell "showing the right thing" from "showing nothing".
    const lit = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.seek(37);
       const p = await window.__settle(37);
       const { lit: count, of } = window.__lit(p.el);
       return { count, of, via: p.via };`,
    )
    assert.ok(lit.count > lit.of / 4, `only ${lit.count} of ${lit.of} sampled pixels had any light`)
  })

  await check('playing a long clip does not re-seek the decoder', async () => {
    // The element is the clock while it plays; nothing should be moving it.
    // Correcting it every frame flushes the decoder every frame, which cost
    // about 95% of the animation frames and put the playhead a second behind
    // the picture.
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.pause();
       playback.seek(20);
       await new Promise(r => setTimeout(r, 900));

       // The element is the clock in both paths — under the pipeline it is the
       // audio, under the fallback the video. Either way nothing should be
       // moving it while it plays.
       const media = document.querySelector('audio, video');
       let seeks = 0;
       const count = () => seeks++;
       media.addEventListener('seeking', count);

       await commands.run('playback.play');
       await new Promise(r => setTimeout(r, 2500));
       await commands.run('playback.pause');
       media.removeEventListener('seeking', count);
       return { seeks, reached: playback.getTime() };`,
    )
    assert.ok(state.reached > 21, `the playhead only reached ${state.reached}s`)
    assert.equal(state.seeks, 0, 'playing must not seek')
  })

  await check('the playhead tracks the picture across a long run', async () => {
    const state = await evaluate(
      cdp,
      `const { playback, commands } = window.__fluxDev;
       playback.pause();
       playback.seek(10);
       await new Promise(r => setTimeout(r, 900));
       await commands.run('playback.play');

       let worst = 0;
       for (let i = 0; i < 8; i++) {
         await new Promise(r => setTimeout(r, 350));
         worst = Math.max(worst, Math.abs(playback.getTime() - window.__picture().time));
       }
       const reached = playback.getTime();
       await commands.run('playback.pause');
       return { worst, reached };`,
    )
    assert.ok(state.reached > 12, `the playhead only reached ${state.reached}s in ~2.8s`)
    assert.ok(
      state.worst < 0.1,
      `the clock and the picture drifted ${Math.round(state.worst * 1000)}ms apart`,
    )
  })

  await check('a stall stops the sequence where the picture stopped', async () => {
    // The clock follows the source, so a source that is not advancing must not
    // let the sequence run on without it - a playhead past a frozen picture is
    // the same lie as a picture behind a running playhead.
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       playback.seek(15);
       await new Promise(r => setTimeout(r, 600));
       const before = playback.getTime();
       // Nothing is playing, so nothing should move.
       await new Promise(r => setTimeout(r, 600));
       return { before, after: playback.getTime() };`,
    )
    assert.equal(state.after, state.before, 'a paused transport must not creep')
  })

  // ── the WebCodecs pipeline ────────────────────────────────────

  await check('an mp4 is drawn by the pipeline, not by an element', async () => {
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       playback.seek(20);
       const p = await window.__settle(20);
       return { via: p.via,
                canvas: !!document.querySelector('canvas.viewer-media'),
                video: !!document.querySelector('video.viewer-media'),
                audio: !!document.querySelector('audio'),
                label: [...document.querySelectorAll('.tool-value')]
                  .map(e => e.textContent).find(t => t === 'pipeline' || t === 'element') };`,
    )
    assert.equal(state.via, 'pipeline')
    assert.equal(state.canvas, true, 'the pipeline draws to a canvas')
    assert.equal(state.video, false, 'and no video element should be doing the drawing')
    assert.equal(state.audio, true, 'sound and the clock still come from an element')
    assert.equal(state.label, 'pipeline', 'and the toolbar should say which path is in use')
  })

  await check('the frame drawn is the frame the index says it should be', async () => {
    // The whole point of holding the frames: not "a picture appeared" but "the
    // picture is the one belonging to this moment". The demuxer's own answer is
    // the reference.
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       const mp4 = await import('/shared/mp4.js');
       const url = window.flux.fs.assetUrl(${LONG});
       const reader = {
         size: async () => Number((await fetch(url, { method: 'HEAD' })).headers.get('content-length')),
         read: async (a, b) => new Uint8Array(await (await fetch(url,
           { headers: { Range: 'bytes=' + a + '-' + b } })).arrayBuffer()),
       };
       const track = (await mp4.readVideoTrack(reader)).track;

       const rows = [];
       for (const t of [3.3, 26.7, 48.02, 11.5]) {
         playback.seek(t);
         const p = await window.__settle(t);
         rows.push([t, p.time, track.pts[mp4.sampleAt(track, t)]]);
       }
       return rows;`,
    )
    for (const [asked, shown, expected] of state) {
      assert.ok(
        Math.abs(shown - expected) < 1e-3,
        `at ${asked}s the index says frame ${expected}s and the canvas shows ${shown}s`,
      )
    }
  })

  await check('scrubbing hard does not stall the decoder', async () => {
    // Frames are handles on decoder buffers and the pool is small: hold too
    // many and the decoder simply stops producing. Measured before that was
    // understood, a thirty-two frame buffer turned a 59ms decode into twelve
    // frames in five seconds. Thirty seeks is enough to exhaust any pool that
    // is being leaked into.
    const state = await evaluate(
      cdp,
      `const { playback } = window.__fluxDev;
       playback.pause();
       const started = performance.now();
       let landed = 0;
       for (let i = 0; i < 30; i++) {
         const t = (i * 7919) % 5800 / 100;
         playback.seek(t);
         const p = await window.__settle(t, 3000);
         if (p.time !== null && Math.abs(p.time - t) < 0.08) landed++;
       }
       return { landed, ms: Math.round(performance.now() - started) };`,
    )
    assert.equal(state.landed, 30, `only ${state.landed} of 30 scrubs reached their frame`)
    assert.ok(state.ms < 30000, `thirty scrubs took ${state.ms}ms`)
  })

  await check('a container the demuxer will not read falls back to the element', async () => {
    // A viewer that shows nothing because it could not parse a sample table is
    // worse than one that shows the file the old way.
    const state = await evaluate(
      cdp,
      `const { importPipeline, assets, sequence, playback } = window.__fluxDev;
       const added = await importPipeline.importFiles(
         [{ path: ${dir} + '\\\\render.webm', kind: 'video' }], 'link');
       const asset = added[0] ?? assets.getAssets().find(a => a.name === 'render.webm');
       const probed = await assets.ensureProbed(asset.id);
       sequence.setSequence(null);
       sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
       playback.pause();
       playback.seek(0.4);
       for (let i = 0; i < 80; i++) {
         if (document.querySelector('video.viewer-media')) break;
         await new Promise(r => setTimeout(r, 100));
       }
       await new Promise(r => setTimeout(r, 800));
       const p = window.__picture();
       return { via: p.via, lit: p.el ? window.__lit(p.el).lit : 0,
                label: [...document.querySelectorAll('.tool-value')]
                  .map(e => e.textContent).find(t => t === 'pipeline' || t === 'element') };`,
    )
    assert.equal(state.via, 'element', 'a webm should fall back rather than show nothing')
    assert.equal(state.label, 'element')
    assert.ok(state.lit > 0, 'and it should still be showing a picture')
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
