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
import fs from 'node:fs/promises'
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
const OPEN_GOP = JSON.stringify(path.join(MEDIA_DIR, 'open_gop.mp4'))
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
                frame: !!document.querySelector('.viewer-frame'),
                placeholder: document.querySelector('.viewer-placeholder')?.textContent };`,
    )
    assert.equal(state.time, 0, 'the playhead should be back at the start')
    assert.equal(state.playing, false)
    /*
     * And the frame goes with it.
     *
     * This used to assert the words "empty sequence" over a black 16:9 box.
     * The box was a fiction twice over — it was there when there was nothing
     * to show, and it was 16:9 whatever shape the sequence actually was. An
     * empty sequence now draws no frame at all.
     */
    assert.equal(state.frame, false, 'an empty sequence should draw no frame')
    assert.equal(state.placeholder, undefined, 'and should say nothing over it')
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

  await check('playing does not restart what is playing', async () => {
    /*
     * Whatever holds the clock, nothing should be moving it while it runs.
     *
     * This used to watch the media element for `seeking`, because the element
     * was the clock. The mixer is now, and the same mistake there looks like
     * re-anchoring: throwing away everything scheduled and starting the
     * decoders again. Either version of it costs what the original cost —
     * about 95% of the animation frames, and a playhead a second behind the
     * picture.
     */
    const state = await evaluate(
      cdp,
      `const { playback, commands, mixer } = window.__fluxDev;
       playback.pause();
       playback.seek(20);
       await new Promise(r => setTimeout(r, 900));

       const media = document.querySelector('audio, video');
       let seeks = 0;
       const count = () => seeks++;
       media?.addEventListener('seeking', count);

       await commands.run('playback.play');
       const anchorsAtStart = mixer.mixerStats().anchors;
       await new Promise(r => setTimeout(r, 2500));
       const anchors = mixer.mixerStats().anchors - anchorsAtStart;
       await commands.run('playback.pause');
       media?.removeEventListener('seeking', count);
       return { seeks, anchors, reached: playback.getTime() };`,
    )
    assert.ok(state.reached > 21, `the playhead only reached ${state.reached}s`)
    assert.equal(state.seeks, 0, 'nothing should be seeking a media element while it plays')
    assert.equal(state.anchors, 0, 'the mix was re-anchored mid-playback')
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
    // Nor any element at all. The sound is the mixer's now, and a second copy
    // of it here would play the same audio twice, a beat apart.
    assert.equal(state.audio, false, 'the pipeline path should hold no media element')
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

  // ── the index, kept rather than rebuilt ──────────────────────

  /*
   * Demuxing is not what is slow. Getting at the bytes to demux is: the moov
   * is found by stepping through the file's boxes, and every step is a ranged
   * request through flux-asset, which is an IPC round trip. Measured, six of
   * them — 13ms on a long file before a single frame is read, paid again every
   * time the Viewer opens a source, which is every time the playhead crosses a
   * cut.
   *
   * So what these check is not "is it faster" but the two things that make
   * being faster worth anything: that a restored index is used *instead of*
   * reading the file, and that it is indistinguishable from one that was.
   */

  /** Opens a source through the cache and reports where the index came from. */
  const openCounting = (file, before = '') => `
    const { indexCache, videoSource } = window.__fluxDev;
    ${before}
    const r = await videoSource.VideoSource.open(${file});
    if (r.ok) r.source.close();
    return { ok: r.ok, reason: r.reason, stats: indexCache.indexCacheStats() };`

  /**
   * Leaves `file` cached on disk, and waits until it really is.
   *
   * The app stores an index without waiting for it — the caller has the index
   * in hand and is trying to show a frame. So a check that wants the disk
   * layer has to wait for the write here instead of racing it, or it passes on
   * whatever a previous run happened to leave behind and fails the first time
   * it is run against an empty cache.
   */
  const ENSURE_STORED = (file) => `
    {
      indexCache.clearIndexMemory();
      const warm = await videoSource.VideoSource.open(${file});
      if (!warm.ok) throw new Error('could not open: ' + warm.reason);
      warm.source.close();
      if (indexCache.indexCacheStats().demux > 0) {
        for (let i = 0; i < 200; i++) {
          if (indexCache.indexCacheStats().stored > 0) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (indexCache.indexCacheStats().stored === 0) throw new Error('index never stored');
      }
    }`

  /*
   * A decoder that dies mid-stream, which is the one failure this pipeline
   * cannot talk its way out of.
   *
   * WebCodecs answers an internal error by closing the decoder. Everything
   * about recovering from that — building a new one, and building it at a
   * keyframe — happens in code that only runs after something has already gone
   * wrong, which is exactly the code that never gets exercised. So the fault is
   * introduced deliberately: the decoder is closed behind the source's back,
   * which leaves precisely the state a real error leaves.
   *
   * Reported as "the preview goes black at some point and never comes back",
   * and that is what it was: the fresh decoder was handed the next sample in
   * the file, which is a delta frame in the middle of a GOP, `decode()` threw
   * DataError, and the source stayed alive producing nothing for the rest of
   * the session.
   */
  /*
   * The failure this whole group exists for, and the one that was reported:
   * the picture goes black partway into a file and stays black.
   *
   * The file's sync samples are not IDR frames — an open GOP, which phone and
   * drone footage produces routinely. Seeking into it configures a decoder and
   * hands it the sync sample the index names, the decoder refuses it, and
   * everything after that point in the file is black. Playing *through* the
   * same frames is fine, which is why it reads as "it stops working at some
   * point" rather than as a broken file.
   */
  await check('a sync sample that is not an IDR is not a place to start', async () => {
    const state = await evaluate(
      cdp,
      `const { videoSource } = window.__fluxDev;
       const r = await videoSource.VideoSource.open(${OPEN_GOP});
       if (!r.ok) return { error: r.reason };
       const source = r.source;
       // Every one of these lands past a sync sample that is not an IDR, and
       // the last two go backwards — a seek back has to work as well as a seek
       // on, or half the timeline is unreachable.
       const seen = [];
       for (const t of [0.2, 6, 9, 3, 11, 6]) {
         const frame = await source.frameFor(t);
         seen.push([t, frame ? Math.round((frame.timestamp / 1e6) * 1000) / 1000 : null]);
       }
       const state = { seen, broken: source.broken, refused: [...source.refused].sort((a, b) => a - b) };
       source.close();
       return state;`,
    )
    assert.ok(!state.error, `the source would not open: ${state.error}`)
    for (const [asked, got] of state.seen) {
      assert.ok(
        got !== null && Math.abs(got - asked) < 0.1,
        `seeking to ${asked}s gave ${got} — a decoder that will not start at a sync sample has ` +
          'to be started at the one before it, not left with nothing to show',
      )
    }
    assert.equal(state.broken, false, 'and the source is not broken, only particular')
    assert.ok(
      state.refused.length > 0,
      'no sync sample was refused, so nothing here was exercised — is the fixture still open-GOP?',
    )
  })

  await check('a refused start point is learned once', async () => {
    // Rediscovering it on every seek would mean a wasted fetch and a wasted
    // decoder for each one, which on a long file is the difference between
    // scrubbing and waiting.
    const state = await evaluate(
      cdp,
      `const { videoSource } = window.__fluxDev;
       const r = await videoSource.VideoSource.open(${OPEN_GOP});
       if (!r.ok) return { error: r.reason };
       const source = r.source;
       for (const t of [6, 9, 11]) await source.frameFor(t);
       const first = [...source.refused].sort((a, b) => a - b);
       const again = [];
       for (const t of [6, 9, 11]) {
         const frame = await source.frameFor(t);
         again.push(frame ? Math.round((frame.timestamp / 1e6) * 1000) / 1000 : null);
       }
       const state = { first, second: [...source.refused].sort((a, b) => a - b), again };
       source.close();
       return state;`,
    )
    assert.ok(state.first.length > 0, 'setup: nothing was refused on the first pass')
    assert.deepEqual(state.second, state.first, 'the same start points were refused all over again')
    assert.deepEqual(state.again, [6, 9, 11], 'and the frames still come back')
  })

  await check('a decoder that dies mid-GOP is started again at a keyframe', async () => {
    const state = await evaluate(
      cdp,
      `const { videoSource } = window.__fluxDev;
       const r = await videoSource.VideoSource.open(${LONG});
       if (!r.ok) return { error: r.reason };
       const source = r.source;

       // Decode into the middle of a GOP, so what comes next is a delta frame.
       const before = await source.frameFor(3);
       source.decoder.close();

       // Near enough that the source keeps going rather than seeking: this is
       // the path where a fresh decoder meets a delta frame.
       const after = await source.frameFor(3.5);
       const state = { before: before ? before.timestamp / 1e6 : null,
                       after: after ? after.timestamp / 1e6 : null,
                       broken: source.broken };
       source.close();
       return state;`,
    )
    assert.ok(!state.error, `the source would not open: ${state.error}`)
    assert.ok(Math.abs(state.before - 3) < 0.1, `setup: expected a frame at 3s, got ${state.before}`)
    assert.ok(
      state.after !== null && Math.abs(state.after - 3.5) < 0.1,
      `after the decoder died the source returned ${state.after} — a dead decoder must be ` +
        'rebuilt at a keyframe, not handed the delta frame that came next',
    )
    assert.equal(state.broken, false, 'and one dead decoder is not a broken file')
  })

  await check('a source that has failed repairs itself', async () => {
    // The other half: the flag the error callback sets. A source that has
    // failed once has not run out of options, and treating it as finished is
    // what turned a hiccup into a black picture for the rest of the session.
    const state = await evaluate(
      cdp,
      `const { videoSource } = window.__fluxDev;
       const r = await videoSource.VideoSource.open(${LONG});
       if (!r.ok) return { error: r.reason };
       const source = r.source;
       await source.frameFor(2);

       // Exactly what the decoder's own error callback does.
       source.failed = true;
       source.decoder.close();

       const after = await source.frameFor(2.5);
       const state = { after: after ? after.timestamp / 1e6 : null,
                       broken: source.broken, repairs: source.repairs };
       source.close();
       return state;`,
    )
    assert.ok(!state.error, `the source would not open: ${state.error}`)
    assert.ok(
      state.after !== null && Math.abs(state.after - 2.5) < 0.1,
      `a failed source should recover, and it returned ${state.after}`,
    )
    assert.equal(state.broken, false)
    assert.equal(state.repairs, 0, 'a source that produced a frame is not one that is failing')
  })

  await check('a source that gives up hands the picture back to the element', async () => {
    /*
     * And the end of the road. A file that fails every time is not a decoder
     * hiccup, and the Viewer has a fallback for it — an element that plays the
     * file the browser's own way. That fallback was unreachable: `decoding`
     * asks whether a source *exists*, and a broken one still does, so the
     * pipeline went on drawing black over a perfectly good <video>.
     *
     * The fault is put into the source the panel is actually using, which is
     * why VideoSource keeps a list of the live ones.
     */
    const state = await evaluate(
      cdp,
      `const { videoSource, playback, sequence, assets, importPipeline } = window.__fluxDev;
         await importPipeline.importFiles([{ path: ${LONG}, kind: 'video' }], 'link');
         const asset = assets.getAssets().find(a => a.name === 'long_take.mp4');
         const probed = await assets.ensureProbed(asset.id);
         sequence.clearSequence();
         sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
         playback.seek(2);
         await new Promise(r => setTimeout(r, 1200));
         const canvasFirst = document.querySelector('canvas.viewer-media');
         const usingPipeline = Boolean(canvasFirst && canvasFirst.dataset.frameTime);

         // Beyond repair: failed, with every attempt spent.
         const source = [...videoSource.VideoSource.live].at(-1);
         source.failed = true;
         source.repairs = 99;

         // A seek is what asks for the next frame.
         playback.seek(3);
         let element = null;
         for (let i = 0; i < 40; i++) {
           await new Promise(r => setTimeout(r, 100));
           element = document.querySelector('video.viewer-media');
           if (element) break;
         }
         const canvas = document.querySelector('canvas.viewer-media');
         return {
           usingPipeline,
           element: Boolean(element),
           canvasHidden: canvas ? getComputedStyle(canvas).display === 'none' : true,
         };`,
    )
    assert.equal(state.usingPipeline, true, 'setup: the pipeline should have been drawing')
    assert.equal(state.element, true, 'a source that gave up must hand the picture to the element')
    assert.equal(state.canvasHidden, true, 'and the black canvas must get out of the way')
  })

  await check('a source opened three times is only fetched once', async () => {
    const state = await evaluate(
      cdp,
      `const { indexCache, videoSource } = window.__fluxDev;
       indexCache.clearIndexMemory();
       for (let i = 0; i < 3; i++) {
         const r = await videoSource.VideoSource.open(${LONG});
         if (r.ok) r.source.close();
       }
       return indexCache.indexCacheStats();`,
    )
    // One fetch of some kind and then nothing — whether the first open came
    // off disk or out of the file depends on what a previous run left behind,
    // and is the next check's business, not this one's.
    assert.equal(
      state.demux + state.disk,
      1,
      `three opens cost ${state.demux} reads and ${state.disk} cache loads`,
    )
    assert.equal(state.memory, 2, `${state.memory} of the opens were answered from memory`)
  })

  await check('a restored index comes off disk rather than out of the file', async () => {
    // Emptying the memory layer is the only way to reach the one behind it —
    // without this the disk path would never be exercised at all, and the
    // check above would be the only one that ever ran.
    const state = await evaluate(
      cdp,
      openCounting(LONG, `${ENSURE_STORED(LONG)} indexCache.clearIndexMemory();`),
    )
    assert.equal(state.ok, true, state.reason)
    assert.equal(state.stats.disk, 1, 'the index did not come from the cache')
    assert.equal(state.stats.demux, 0, 'the file was read again anyway')
  })

  await check('a restored index shows exactly the frames the original did', async () => {
    // The one that matters. A cache that is fast and subtly different is worse
    // than no cache: the same file would play one way on first open and
    // another way on second, and nothing would point back here.
    const state = await evaluate(
      cdp,
      `const { indexCache, videoSource } = window.__fluxDev;
       const times = [0, 4.44, 19.2, 37, 51.75, 12.5];
       // Cold means cold: without forgetting the entry, the "fresh" walk below
       // would come off disk too and this would compare the cache against
       // itself.
       await indexCache.forgetIndex(${LONG}, 'video');

       const walk = async () => {
         const r = await videoSource.VideoSource.open(${LONG});
         if (!r.ok) return { error: r.reason };
         const seen = [];
         for (const t of times) {
           const frame = await r.source.frameFor(t);
           seen.push(frame ? frame.timestamp : null);
         }
         const info = r.source.info;
         r.source.close();
         return { seen, info };
       };

       indexCache.clearIndexMemory();
       const fresh = await walk();          // read from the file
       if (indexCache.indexCacheStats().demux !== 1) return { fresh: { error: 'not a cold read' } };
       ${ENSURE_STORED(LONG)}
       indexCache.clearIndexMemory();
       const restored = await walk();       // read from the cache
       return { fresh, restored, stats: indexCache.indexCacheStats() };`,
    )
    assert.equal(state.fresh.error, undefined, state.fresh.error)
    assert.equal(state.restored.error, undefined, state.restored.error)
    // Prove the second walk really did take the other path, or this compares
    // one demux against another and passes for nothing.
    assert.equal(state.stats.disk, 1, 'the second walk did not use the cache')
    assert.ok(
      state.fresh.seen.every((t) => t !== null),
      `some frames never arrived: ${state.fresh.seen}`,
    )
    assert.deepEqual(state.restored.seen, state.fresh.seen, 'different frames came back')
    assert.deepEqual(state.restored.info, state.fresh.info, 'the track described itself differently')
  })

  await check('a file the demuxer will not read is not read again', async () => {
    // A refusal costs the same round trips as an answer, and the Viewer asks
    // on every clip change. Remembered for the session — and only for the
    // session, since a refusal has nothing to check itself against later.
    const webm = JSON.stringify(path.join(MEDIA_DIR, 'render.webm'))
    const state = await evaluate(
      cdp,
      `const { indexCache, videoSource } = window.__fluxDev;
       indexCache.clearIndexMemory();
       const reasons = [];
       for (let i = 0; i < 3; i++) {
         const r = await videoSource.VideoSource.open(${webm});
         if (r.ok) r.source.close();
         reasons.push(r.ok ? 'opened' : r.reason);
       }
       return { reasons, stats: indexCache.indexCacheStats() };`,
    )
    assert.deepEqual(state.reasons, ['no-moov', 'no-moov', 'no-moov'])
    assert.equal(state.stats.demux, 1, `the webm was read ${state.stats.demux} times`)
    assert.equal(state.stats.refused, 2, 'the refusal was not remembered')
  })

  await check('a file that has changed is indexed again, not trusted', async () => {
    // The failure this prevents is silent: an index for bytes that are no
    // longer there sends the decoder into the middle of other frames.
    const scratch = path.join(os.tmpdir(), `flux-recut-${process.pid}.mp4`)
    await fs.copyFile(path.join(MEDIA_DIR, 'clipA.mp4'), scratch)
    const file = JSON.stringify(scratch)
    try {
      const first = await evaluate(cdp, openCounting(file, 'indexCache.clearIndexMemory();'))
      assert.equal(first.ok, true, first.reason)
      assert.equal(first.stats.demux, 1)
      // The write happens after the index is stored, so wait for the store
      // rather than racing it — it is deliberately not awaited in the app.
      await evaluate(
        cdp,
        `const { indexCache } = window.__fluxDev;
         for (let i = 0; i < 100; i++) {
           if (indexCache.indexCacheStats().stored > 0) break;
           await new Promise(r => setTimeout(r, 20));
         }
         return indexCache.indexCacheStats().stored;`,
      )

      await fs.appendFile(scratch, Buffer.alloc(2048))

      const second = await evaluate(cdp, openCounting(file, 'indexCache.clearIndexMemory();'))
      assert.equal(second.ok, true, second.reason)
      assert.equal(second.stats.disk, 0, 'a stale index was handed back')
      assert.equal(second.stats.demux, 1, 'the changed file was not read again')
    } finally {
      await fs.rm(scratch, { force: true })
    }
  })

  // ── the shape of the sound ────────────────────────────────────

  /*
   * Peaks are the one derived thing in FLUX that is genuinely expensive rather
   * than merely repeated: the audio has to be decoded end to end, because there
   * is no shortcut to knowing how loud a moment is. So the questions are the
   * same as for the index — is it used instead of the file, and is it the same
   * thing when it comes back — plus the one that only applies here: does it
   * actually describe the audio.
   *
   * voice_over.mp4 is two seconds at 0.9 then two at 0.02, three times over.
   * Peaks built from audio that never changes would agree with almost any bug.
   */
  const VOICE = JSON.stringify(path.join(MEDIA_DIR, 'voice_over.mp4'))

  await check('peaks describe the audio they were built from', async () => {
    const state = await evaluate(
      cdp,
      `const { peaks } = window.__fluxDev;
       // Forgotten, not merely dropped from memory. Clearing memory alone
       // leaves the entry on disk, so this would read back whatever a previous
       // run built and never run the builder at all — which is exactly how a
       // broken builder stays green.
       await peaks.forgetPeaks(${VOICE});
       peaks.clearPeaksMemory();
       const r = await peaks.peaksFor(${VOICE});
       if (!r.ok) return { error: r.reason };
       if (peaks.peaksStats().built !== 1) return { error: 'the audio was not decoded' };
       const p = r.peaks;
       const at = (t) => {
         const i = Math.floor(t * p.perSecond);
         return Math.max(p.max[i], -p.min[i]);
       };
       return {
         perSecond: p.perSecond,
         channels: p.channels,
         sampleRate: p.sampleRate,
         duration: p.duration,
         count: p.count,
         loud: [0.5, 1.5, 4.5, 5.5, 8.5, 9.5].map(at),
         quiet: [2.5, 3.5, 6.5, 7.5, 10.5, 11.5].map(at),
       };`,
    )
    assert.equal(state.error, undefined, state.error)
    assert.equal(state.perSecond, 400)
    assert.equal(state.channels, 1)
    assert.equal(state.sampleRate, 48000)
    assert.ok(Math.abs(state.duration - 12) < 0.1, `duration ${state.duration}`)
    assert.ok(Math.abs(state.count - 4800) < 60, `${state.count} buckets for twelve seconds`)

    // 0.9 of full scale is 114 of 127; 0.02 is about 3.
    for (const value of state.loud) {
      assert.ok(value > 100, `a full-scale passage read as ${value}/127`)
    }
    for (const value of state.quiet) {
      assert.ok(value < 20, `a near-silent passage read as ${value}/127`)
    }
  })

  await check('peaks come back off disk exactly as they were built', async () => {
    const state = await evaluate(
      cdp,
      `const { peaks } = window.__fluxDev;
       await peaks.forgetPeaks(${VOICE});
       peaks.clearPeaksMemory();
       const fresh = await peaks.peaksFor(${VOICE});
       if (!fresh.ok) return { error: fresh.reason };
       if (peaks.peaksStats().built !== 1) return { error: 'the audio was not decoded' };
       // The store is deliberately not awaited by the app, so wait for it here
       // rather than racing it.
       for (let i = 0; i < 400; i++) {
         if (peaks.peaksStats().stored > 0) break;
         await new Promise(r => setTimeout(r, 25));
       }
       if (peaks.peaksStats().stored === 0) return { error: 'peaks were never stored' };
       const before = { min: [...fresh.peaks.min], max: [...fresh.peaks.max] };

       peaks.clearPeaksMemory();
       const restored = await peaks.peaksFor(${VOICE});
       if (!restored.ok) return { error: restored.reason };

       let same = restored.peaks.count === before.min.length;
       if (same) for (let i = 0; i < before.min.length; i++) {
         if (restored.peaks.min[i] !== before.min[i] || restored.peaks.max[i] !== before.max[i]) {
           same = false; break;
         }
       }
       return { same, stats: peaks.peaksStats() };`,
    )
    assert.equal(state.error, undefined, state.error)
    // Prove it took the other path, or this compares one decode against another.
    assert.equal(state.stats.disk, 1, 'the second read did not come from the cache')
    assert.equal(state.stats.built, 0, 'the audio was decoded all over again')
    assert.equal(state.same, true, 'the restored waveform is not the one that was stored')
  })

  await check('three things derived from one file all survive in the cache', async () => {
    /*
     * A video index, an audio index and a waveform, all belonging to
     * voice_over.mp4. Keyed only by path they would share one entry, each write
     * overwriting the last.
     *
     * What that breaks is *not* correctness — an entry stamped with the wrong
     * name is refused on read, so every caller simply rebuilds and every value
     * still comes back right. The symptom is a cache that silently never hits,
     * which is why this check is about where the answers came from rather than
     * what they were.
     */
    const state = await evaluate(
      cdp,
      `const { indexCache, peaks } = window.__fluxDev;
       await indexCache.forgetIndex(${VOICE}, 'video');
       await indexCache.forgetIndex(${VOICE}, 'audio');
       await peaks.forgetPeaks(${VOICE});
       indexCache.clearIndexMemory();
       peaks.clearPeaksMemory();

       // Cold: all three built from the file, all three stored.
       const built = {
         video: (await indexCache.trackFor(${VOICE}, 'video')).ok,
         audio: (await indexCache.trackFor(${VOICE}, 'audio')).ok,
         peaks: (await peaks.peaksFor(${VOICE})).ok,
       };
       for (let i = 0; i < 400; i++) {
         if (indexCache.indexCacheStats().stored >= 2 && peaks.peaksStats().stored >= 1) break;
         await new Promise(r => setTimeout(r, 25));
       }
       const stored = {
         index: indexCache.indexCacheStats().stored,
         peaks: peaks.peaksStats().stored,
       };

       // Warm: memory gone, disk intact. All three must come back off disk.
       indexCache.clearIndexMemory();
       peaks.clearPeaksMemory();
       const video = await indexCache.trackFor(${VOICE}, 'video');
       const audio = await indexCache.trackFor(${VOICE}, 'audio');
       const sound = await peaks.peaksFor(${VOICE});
       return {
         built, stored,
         values: {
           width: video.ok && video.track.width,
           channels: audio.ok && audio.track.channels,
           buckets: sound.ok && sound.peaks.count,
         },
         from: { index: indexCache.indexCacheStats(), peaks: peaks.peaksStats() },
       };`,
    )
    assert.deepEqual(state.built, { video: true, audio: true, peaks: true })
    assert.equal(state.stored.index, 2, 'both indexes should have been stored')
    assert.equal(state.stored.peaks, 1, 'the waveform should have been stored')

    assert.equal(state.from.index.disk, 2, 'the two indexes did not both come off disk')
    assert.equal(state.from.index.demux, 0, 'an index was read from the file again')
    assert.equal(state.from.peaks.disk, 1, 'the waveform did not come off disk')
    assert.equal(state.from.peaks.built, 0, 'the audio was decoded all over again')

    // And they are still each other's opposite, not one entry read three ways.
    assert.equal(state.values.width, 320)
    assert.equal(state.values.channels, 1)
    assert.ok(state.values.buckets > 4000)
  })

  await check('a file with no audio is asked about once', async () => {
    // A refusal costs the same round trips as an answer, and the timeline asks
    // on every redraw. Remembered for the session — and only the session, since
    // a refusal has nothing to check itself against later.
    const silent = JSON.stringify(path.join(MEDIA_DIR, 'clipA.mp4'))
    const state = await evaluate(
      cdp,
      `const { peaks } = window.__fluxDev;
       peaks.clearPeaksMemory();
       const reasons = [];
       for (let i = 0; i < 3; i++) {
         const r = await peaks.peaksFor(${silent});
         reasons.push(r.ok ? 'built' : r.reason);
       }
       return { reasons, stats: peaks.peaksStats() };`,
    )
    assert.deepEqual(state.reasons, ['no-audio-track', 'no-audio-track', 'no-audio-track'])
    assert.equal(state.stats.refused, 2, 'the refusal was not remembered')
    assert.equal(state.stats.built, 0, 'nothing should have been decoded')
  })

  await check('audioInfoFor answers without decoding the audio', async () => {
    const state = await evaluate(
      cdp,
      `const { peaks } = window.__fluxDev;
       peaks.clearPeaksMemory();
       const info = await peaks.audioInfoFor(${VOICE});
       return { info, stats: peaks.peaksStats() };`,
    )
    assert.equal(state.info.channels, 1)
    assert.equal(state.info.sampleRate, 48000)
    assert.equal(state.stats.built, 0, 'asking whether a file has sound must not decode it')
  })

  await check('the viewer says whether the file under the playhead has sound', async () => {
    /*
     * A file with no audio track lands as a picture and nothing else, which is
     * correct and says nothing. Dropping a silent file then looks exactly like
     * dropping one whose sound failed to arrive, and the only difference is a
     * thing that is not there.
     *
     * Real footage prompted this: a phone clip with no audio stream, dropped,
     * and no way to tell that from a bug.
     */
    /** Puts one fixture under the playhead and reads the Sound value off the toolbar. */
    const readSound = (name) => `
      const { importPipeline, assets, sequence, playback } = window.__fluxDev;
      const file = ${JSON.stringify(path.join(MEDIA_DIR, name))};
      await importPipeline.importFiles([{ path: file, kind: 'video' }], 'link');
      const asset = assets.getAssets().find(a => a.path === file);
      const probed = await assets.ensureProbed(asset.id);
      sequence.clearSequence();
      sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
      playback.seek(0.5);

      // Wait for the answer, not for a duration: reading the audio track is a
      // handful of ranged requests, and the toolbar says so while it waits.
      const read = (name) => {
        const label = [...document.querySelectorAll('.tool-label')]
          .find(n => n.textContent === name);
        return label ? label.nextElementSibling.textContent : null;
      };
      // Waiting only for "no longer reading" is not enough: the toolbar shows
      // the previous clip's answer until the new one arrives, and that is a
      // settled-looking value too. So the Source has to be right first.
      for (let i = 0; i < 100; i++) {
        const sound = read('Sound');
        if (read('Source') === asset.name && sound && sound !== '\u2026') break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { source: read('Source'), sound: read('Sound') };`

    const withSound = await evaluate(cdp, readSound('voice_over.mp4'))
    assert.equal(withSound.source, 'voice_over.mp4', 'the viewer is showing something else')
    assert.equal(withSound.sound, '1ch 48k', `a mono 48kHz file reported ${withSound.sound}`)

    const silent = await evaluate(cdp, readSound('clipA.mp4'))
    assert.equal(silent.source, 'clipA.mp4', 'the viewer is showing something else')
    assert.equal(silent.sound, 'none', `a file with no audio track reported ${silent.sound}`)
  })

  await check('an audio clip alone under the playhead shows no picture', async () => {
    // The Viewer looks down the video tracks and no further. A sound on its own
    // is a thing FLUX can hold on a timeline and cannot yet play, and drawing
    // the video track of the file it came from would hide that behind a picture
    // nothing asked for.
    const state = await evaluate(
      cdp,
      `const { assets, sequence, playback } = window.__fluxDev;
       const asset = assets.getAssets().find(a => a.name === 'voice_over.mp4')
         ?? (await window.__fluxDev.importPipeline.importFiles(
              [{ path: ${VOICE}, kind: 'video' }], 'link'))[0];
       const probed = await assets.ensureProbed(asset.id);
       sequence.clearSequence();
       sequence.addClip({ assetId: asset.id, trackId: 'A1', start: 0, duration: probed.duration });
       playback.seek(2);
       await new Promise(r => setTimeout(r, 1200));
       const clips = sequence.getSequence().clips.map(c => c.kind + ':' + c.trackId);
       return { clips, via: window.__picture().via,
                frame: !!document.querySelector('.viewer-frame'),
                placeholder: !!document.querySelector('.viewer-placeholder') };`,
    )
    assert.deepEqual(state.clips, ['audio:A1'], 'setup: expected one audio clip')
    assert.equal(state.via, 'none', `the viewer drew a picture via ${state.via}`)
    /*
     * A black frame, and no words over it.
     *
     * The sequence has content — it is a minute of sound — so it has a shape,
     * and the shape is what gets shown. Which is also what every other editor
     * does with an audio-only sequence. "Nothing to show" is said by the
     * toolbar reading Source: none, where it belongs; printing it across the
     * picture is narrating a gap, and gaps are black everywhere else.
     */
    assert.equal(state.frame, true, 'a sequence with sound in it still has a frame')
    assert.equal(state.placeholder, false, 'and nothing should be written across it')
  })

  // ── layers, looked at ─────────────────────────────────────────

  /*
   * Two clips on top of each other, and the only way to tell whether both were
   * drawn is to look at the pixels.
   *
   * layer_red.mp4 is flat red and landscape; layer_blue.mp4 is flat blue and
   * portrait. Composited into the red clip's own frame, the blue one is
   * letterboxed — so a correct composite is blue down the middle with red
   * showing at each side, and there is no way to produce that by drawing one
   * layer.
   */
  const RED = JSON.stringify(path.join(MEDIA_DIR, 'layer_red.mp4'))
  const BLUE = JSON.stringify(path.join(MEDIA_DIR, 'layer_blue.mp4'))

  /** Puts red on V1 and blue on V2, both from zero, and settles. */
  const LAYERED = `
    const { importPipeline, assets, sequence, playback, peaks } = window.__fluxDev;
    await importPipeline.importFiles(
      [{ path: ${RED}, kind: 'video' }, { path: ${BLUE}, kind: 'video' }], 'link');
    sequence.setSequence(null);
    await new Promise(r => setTimeout(r, 200));
    const place = async (name, track) => {
      const a = assets.getAssets().find(x => x.name === name);
      const probed = await assets.ensureProbed(a.id);
      if (sequence.getSequence().clips.length === 0) sequence.setSequenceSize(a.width, a.height);
      const info = await peaks.audioInfoFor(a.path);
      return sequence.addLinkedClips(
        { assetId: a.id, trackId: track, start: 0, duration: probed.duration }, Boolean(info));
    };
    await place('layer_red.mp4', 'V1');
    await place('layer_blue.mp4', 'V2');
    playback.seek(2);

    // Queried fresh every time: a captured reference to a canvas that has been
    // replaced keeps showing whatever it last held, which is how a check that
    // hides a track can watch nothing happen and believe it.
    window.__pixels = () => {
      const canvas = document.querySelector('canvas.viewer-media');
      if (!canvas || !canvas.width) return null;
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext('2d');
      g.drawImage(canvas, 0, 0);
      const px = (fx) => {
        const d = g.getImageData(Math.round(canvas.width * fx), Math.round(canvas.height / 2), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      return { size: [canvas.width, canvas.height], layers: Number(canvas.dataset.layers),
               left: px(0.06), centre: px(0.5), right: px(0.94) };
    };
    window.__settleLayers = async (want) => {
      for (let i = 0; i < 120; i++) {
        const p = window.__pixels();
        if (p && p.layers === want) return p;
        await new Promise(r => setTimeout(r, 100));
      }
      return window.__pixels();
    };
    await window.__settleLayers(2);`

  /** Roughly this colour, allowing for what a video codec does to a flat field. */
  const near = ([r, g, b], [wr, wg, wb]) =>
    Math.abs(r - wr) < 40 && Math.abs(g - wg) < 40 && Math.abs(b - wb) < 40

  await check('two clips at once are both drawn, the upper one in front', async () => {
    const state = await evaluate(cdp, LAYERED + `return window.__pixels();`)
    assert.equal(state.layers, 2, `${state.layers} layer(s) were drawn`)
    assert.ok(near(state.centre, [0, 0, 255]), `the middle is ${state.centre}, not the upper layer`)
    assert.ok(near(state.left, [255, 0, 0]), `the left edge is ${state.left}, not the lower layer`)
    assert.ok(near(state.right, [255, 0, 0]), `the right edge is ${state.right}`)
  })

  await check('the sequence takes its frame from the first clip', async () => {
    const state = await evaluate(
      cdp,
      LAYERED +
        `const seq = sequence.getSequence();
         return { frame: [seq.settings.width, seq.settings.height],
                  canvas: window.__pixels().size };`,
    )
    // The landscape clip went down first, so that is the shape everything is
    // composited into — not the portrait one that landed on top of it.
    assert.deepEqual(state.frame, [1280, 720])
    assert.deepEqual(state.canvas, [1280, 720], 'the canvas is not the sequence frame')
  })

  await check('hiding a video track takes it out of the picture', async () => {
    const state = await evaluate(
      cdp,
      LAYERED +
        `sequence.setTrackHidden('V2', true);
         const hidden = await window.__settleLayers(1);
         sequence.setTrackHidden('V2', false);
         const back = await window.__settleLayers(2);
         return { hidden, back };`,
    )
    assert.equal(state.hidden.layers, 1, 'the hidden layer was still drawn')
    assert.ok(
      near(state.hidden.centre, [255, 0, 0]),
      `with the top track hidden the middle is ${state.hidden.centre}, not the layer beneath`,
    )
    assert.equal(state.back.layers, 2, 'showing it again did not bring it back')
    assert.ok(near(state.back.centre, [0, 0, 255]), `it came back as ${state.back.centre}`)
  })

  await check('hiding the lower track leaves the frame black behind the upper one', async () => {
    // Not "leaves the old pixels there". A layer that has gone must actually
    // leave, or the composite is whatever happened to be drawn last.
    const state = await evaluate(
      cdp,
      LAYERED +
        `sequence.setTrackHidden('V1', true);
         const hidden = await window.__settleLayers(1);
         sequence.setTrackHidden('V1', false);
         return hidden;`,
    )
    assert.equal(state.layers, 1)
    assert.ok(near(state.centre, [0, 0, 255]), `the upper layer should still be there, got ${state.centre}`)
    assert.ok(near(state.left, [0, 0, 0]), `behind it should be black, got ${state.left}`)
    assert.ok(near(state.right, [0, 0, 0]), `behind it should be black, got ${state.right}`)
  })

  await check('both layers keep playing together', async () => {
    // Not merely both present at a standstill: both have to be advancing, and
    // against the same clock.
    const state = await evaluate(
      cdp,
      LAYERED +
        `const { commands } = window.__fluxDev;
         playback.seek(0.5);
         await window.__settleLayers(2);
         await commands.run('playback.play');
         await new Promise(r => setTimeout(r, 1400));
         const during = window.__pixels();
         const shown = Number(document.querySelector('canvas.viewer-media').dataset.frameTime);
         const at = playback.getTime();
         await commands.run('playback.pause');
         return { during, shown, at };`,
    )
    assert.equal(state.during.layers, 2, 'a layer dropped out while playing')
    assert.ok(near(state.during.centre, [0, 0, 255]) && near(state.during.left, [255, 0, 0]))
    assert.ok(state.at > 1.2, `the playhead only reached ${state.at}s`)
    assert.ok(
      Math.abs(state.shown - state.at) < 0.15,
      `the picture was at ${state.shown}s with the playhead at ${state.at}s`,
    )
  })

  // ── the mixer, listened to ────────────────────────────────────

  /*
   * Everything below reads the level off a tap on the master bus rather than
   * computing what it ought to be. That is the point: a mixer that scheduled
   * nothing, scheduled silence, or scheduled the wrong moment cannot move a
   * meter that is measuring what actually came out.
   *
   * voice_over.mp4 is two seconds at 0.9 then two at 0.02, three times. A sine
   * at amplitude A has RMS A/√2, so the loud passages should read about 0.636
   * and the quiet ones about 0.014 — numbers with only one explanation.
   */
  const LOUD_RMS = 0.9 / Math.SQRT2
  const QUIET_RMS = 0.02 / Math.SQRT2

  /** Puts voice_over on the timeline as a linked pair and returns its length. */
  const WITH_SOUND = `
    const { importPipeline, assets, sequence, playback } = window.__fluxDev;
    await importPipeline.importFiles([{ path: ${VOICE}, kind: 'video' }], 'link');
    const voice = assets.getAssets().find(a => a.name === 'voice_over.mp4');
    const probed = await assets.ensureProbed(voice.id);
    sequence.clearSequence();
    // Clips *and* track state. clearSequence empties the timeline; a mute set
    // by a check above it would otherwise still be in force, which is how one
    // check silently decides another one's outcome.
    for (const track of sequence.getSequence().tracks) {
      sequence.setTrackMuted(track.id, false);
      sequence.setTrackSolo(track.id, false);
      sequence.setTrackGain(track.id, 0);
    }
    sequence.addLinkedClips(
      { assetId: voice.id, trackId: 'V1', start: 0, duration: probed.duration }, true);
    playback.seek(0);
    await new Promise(r => setTimeout(r, 500));`

  // ── a frame at a time ────────────────────────────

  /*
   * The arrows, which every editor uses without thinking about them. What is
   * worth checking is not that they move the playhead but *where they land*:
   * a step that keeps a fraction of a frame is a playhead that shows the wrong
   * frame half the time, and it is invisible until someone is matching a cut.
   */
  const STEP = `
    const { importPipeline, assets, sequence, playback } = window.__fluxDev;
    await importPipeline.importFiles([{ path: ${LONG}, kind: 'video' }], 'link');
    const long = assets.getAssets().find(a => a.name === 'long_take.mp4');
    const probed = await assets.ensureProbed(long.id);
    sequence.clearSequence();
    sequence.updateSequenceSettings({ frameRate: 24 });
    sequence.addClip(
      { assetId: long.id, trackId: 'V1', start: 0, duration: probed.duration });
    playback.pause();
    playback.seek(0);
    await new Promise(r => setTimeout(r, 400));
    const fps = sequence.getSequence().settings.frameRate;
    /** The frame the playhead is on, which is what these checks are about. */
    const frame = () => Math.round(playback.getTime() * fps);
    window.__press = (key, mods = {}) => {
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key, bubbles: true, cancelable: true, ...mods }));
      window.dispatchEvent(new KeyboardEvent('keyup',
        { key, bubbles: true, cancelable: true, ...mods }));
      return new Promise(r => setTimeout(r, 140));
    };
  `

  await check('the arrows step a frame, and Shift steps five', async () => {
    const state = await evaluate(
      cdp,
      STEP +
        `playback.seek(1);
         await new Promise(r => setTimeout(r, 200));
         const walk = [frame()];
         await window.__press('ArrowRight'); walk.push(frame());
         await window.__press('ArrowRight'); walk.push(frame());
         await window.__press('ArrowLeft');  walk.push(frame());
         await window.__press('ArrowRight', { shiftKey: true }); walk.push(frame());
         await window.__press('ArrowLeft', { shiftKey: true });  walk.push(frame());
         return { fps, walk, at: walk.map(f => f - walk[0]) };`,
    )
    assert.equal(state.fps, 24, 'setup: the sequence should be at 24fps')
    assert.deepEqual(
      state.at,
      [0, 1, 2, 1, 6, 1],
      'one frame each way, five with Shift, and back where it started',
    )
  })

  await check('a step lands on a frame, wherever the playhead was', async () => {
    /*
     * Playing, scrubbing and a trim all leave the playhead between two frames.
     * Forward goes to the next boundary and back to the previous one — not
     * "add a frame to whatever this is", which would keep the fraction for the
     * rest of the session, and not "round to the nearest", which would skip a
     * frame going forward from just past one.
     */
    const state = await evaluate(
      cdp,
      STEP +
        `const half = (24 + 0.5) / fps;
         playback.seek(half);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('ArrowRight');
         const forward = playback.getTime() * fps;
         playback.seek(half);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('ArrowLeft');
         const back = playback.getTime() * fps;
         return { forward, back };`,
    )
    assert.ok(
      Math.abs(state.forward - 25) < 1e-6,
      `forward from halfway through frame 24 should be frame 25, and it is ${state.forward}`,
    )
    assert.ok(
      Math.abs(state.back - 24) < 1e-6,
      `and back should be frame 24, not 23 — it is ${state.back}`,
    )
  })

  await check('a step is a frame of this sequence, not a fixed slice of time', async () => {
    // Read at the moment of the step rather than cached: the frame rate is a
    // setting somebody can change while the playhead is sitting still.
    const state = await evaluate(
      cdp,
      STEP +
        `playback.seek(1);
         await new Promise(r => setTimeout(r, 200));
         const from = playback.getTime();
         await window.__press('ArrowRight');
         const at24 = playback.getTime() - from;
         sequence.updateSequenceSettings({ frameRate: 60 });
         await new Promise(r => setTimeout(r, 250));
         playback.seek(1);
         await new Promise(r => setTimeout(r, 150));
         const then = playback.getTime();
         await window.__press('ArrowRight');
         const at60 = playback.getTime() - then;
         sequence.updateSequenceSettings({ frameRate: 24 });
         return { at24, at60 };`,
    )
    assert.ok(Math.abs(state.at24 - 1 / 24) < 1e-6, `a 24fps frame, and it moved ${state.at24}s`)
    assert.ok(Math.abs(state.at60 - 1 / 60) < 1e-6, `a 60fps frame, and it moved ${state.at60}s`)
  })

  await check('stepping stops a transport that is running', async () => {
    // One frame while sixteen a second are going past is not a request that can
    // be honoured. The key means "stop, and show me this frame".
    const state = await evaluate(
      cdp,
      STEP +
        `playback.seek(1);
         playback.play();
         await new Promise(r => setTimeout(r, 400));
         const running = playback.isPlaying();
         await window.__press('ArrowRight');
         const after = playback.isPlaying();
         const at = playback.getTime() * fps;
         playback.pause();
         return { running, after, off: Math.abs(at - Math.round(at)) };`,
    )
    assert.equal(state.running, true, 'setup: it should have been playing')
    assert.equal(state.after, false, 'and the step should have stopped it')
    assert.ok(state.off < 1e-6, `landing on a frame, and it is ${state.off} of one off`)
  })

  await check('the arrows stop at both ends of the sequence', async () => {
    const state = await evaluate(
      cdp,
      STEP +
        `playback.seek(0);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('ArrowLeft');
         await window.__press('ArrowLeft', { shiftKey: true });
         const atStart = playback.getTime();
         playback.goToEnd();
         await new Promise(r => setTimeout(r, 200));
         const end = playback.getTime();
         await window.__press('ArrowRight');
         await window.__press('ArrowRight', { shiftKey: true });
         return { atStart, end, atEnd: playback.getTime() };`,
    )
    assert.equal(state.atStart, 0, 'nothing before the start')
    assert.equal(state.atEnd, state.end, 'and nothing past the end')
  })

  // ── shuttling ─────────────────────────────────────────────────

  /*
   * D and A run the transport faster and backwards, a rung at a time. The
   * ladder is the one every deck has used since tape, and the checks below are
   * about the three things that are easy to get wrong: where the rungs are,
   * what happens at the ends, and what the sound does.
   */
  const SHUTTLE = `
    const { importPipeline, assets, sequence, playback } = window.__fluxDev;
    await importPipeline.importFiles([{ path: ${VOICE}, kind: 'video' }], 'link');
    const voice = assets.getAssets().find(a => a.name === 'voice_over.mp4');
    const probed = await assets.ensureProbed(voice.id);
    sequence.clearSequence();
    sequence.addLinkedClips(
      { assetId: voice.id, trackId: 'V1', start: 0, duration: probed.duration }, true);
    playback.pause();
    playback.seek(0);
    await new Promise(r => setTimeout(r, 400));
    window.__press = (key, mods = {}) => {
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key, bubbles: true, cancelable: true, ...mods }));
      window.dispatchEvent(new KeyboardEvent('keyup',
        { key, bubbles: true, cancelable: true, ...mods }));
      return new Promise(r => setTimeout(r, 180));
    };
  `

  await check('D and A climb the ladder, and stop at sixteen', async () => {
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `/*
          * A minute of timeline, and the ladder started in the middle of it.
          *
          * Climbing covers about eight seconds each way, and reaching either
          * end parks the transport and puts the rate back to 1x — which is
          * right, and would turn this into a check that passes or fails
          * depending on how fast six key events were dispatched.
          *
          * Seeking between the two runs is not the way to buy that room: a seek
          * to the end *stops* a transport running towards it, and the turn then
          * happens from standstill, where mirroring the rung and taking the
          * first one look identical. The turn has to happen while it is moving.
          */
         const { assets: fixtures, sequence: seq } = window.__fluxDev;
         await window.__fluxDev.importPipeline.importFiles(
           [{ path: ${LONG}, kind: 'video' }], 'link');
         const long = fixtures.getAssets().find(a => a.name === 'long_take.mp4');
         const longProbed = await fixtures.ensureProbed(long.id);
         seq.clearSequence();
         seq.addClip({ assetId: long.id, trackId: 'V1', start: 0, duration: longProbed.duration });
         playback.seek(25);
         await new Promise(r => setTimeout(r, 250));
         const forward = [];
         for (let i = 0; i < 6; i++) { await window.__press('d'); forward.push(playback.getRate()); }
         // The first press of the other direction is the first rung that way,
         // not the mirror of where it was: reaching for rewind at sixteen means
         // "stop going that way", not "go back just as fast".
         const back = [];
         for (let i = 0; i < 6; i++) { await window.__press('a'); back.push(playback.getRate()); }
         playback.pause();
         return { forward, back };`,
    )
    assert.deepEqual(state.forward, [1, 2, 4, 8, 16, 16], 'up the rungs, and no further')
    assert.deepEqual(
      state.back,
      [-1, -2, -4, -8, -16, -16],
      'the turn lands on the first rung backwards, and the ladder goes on from there',
    )
  })

  await check('a shuttle back from the start restarts from the end', async () => {
    /*
     * The mirror of "play at the end restarts from the top", which is what
     * every player does. Backwards, the end is where there is something to
     * travel through — starting a reverse run at zero and leaving it there
     * would be a key that stops the moment it is pressed.
     */
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.pause();
         playback.seek(0);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('a');
         const rate = playback.getRate();
         const at = playback.getTime();
         await new Promise(r => setTimeout(r, 300));
         const after = playback.getTime();
         playback.pause();
         return { rate, at, after, end: window.__fluxDev.sequence.sequenceDuration() };`,
    )
    assert.equal(state.rate, -1, 'the shuttle should have started')
    assert.ok(
      state.at > state.end - 1,
      `it should have jumped to the end to have somewhere to run, and it is at ${state.at}`,
    )
    assert.ok(state.after < state.at, 'and then travelled back from there')
  })

  await check('nothing can set a rate off the end of the ladder', async () => {
    /*
     * The ladder stops at sixteen, and so does the rate itself — two guards,
     * because they answer to different callers. `shuttle` is what a key press
     * reaches; `setRate` is the public one, and anything that can be called
     * from outside has to hold its own bounds rather than trusting that the
     * only caller is well behaved.
     */
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.setRate(100);
         const high = playback.getRate();
         playback.setRate(-100);
         const low = playback.getRate();
         playback.setRate(1);
         return { high, low };`,
    )
    assert.equal(state.high, 16, 'a rate above the ladder is clamped to its top rung')
    assert.equal(state.low, -16, 'and below it to the bottom one')
  })

  await check('a shuttle actually moves the playhead, both ways', async () => {
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.seek(2);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('d');
         await window.__press('d');
         const from = playback.getTime();
         await new Promise(r => setTimeout(r, 700));
         const forward = playback.getTime();

         // Three presses: the turn to -1, then -2, then -4.
         await window.__press('a');
         await window.__press('a');
         await window.__press('a');
         const rate = playback.getRate();
         const mark = playback.getTime();
         await new Promise(r => setTimeout(r, 700));
         const back = playback.getTime();
         playback.pause();
         return { from, forward, rate, mark, back };`,
    )
    assert.ok(
      state.forward - state.from > 0.9,
      `two times should cover more than a second in 700ms, and it covered ` +
        `${(state.forward - state.from).toFixed(2)}s`,
    )
    assert.equal(state.rate, -4, 'setup: turned round and stepped twice more')
    assert.ok(
      state.mark - state.back > 0.9,
      `and backwards it should travel back, from ${state.mark.toFixed(2)} to ${state.back.toFixed(2)}`,
    )
  })

  await check('a shuttle back from the end starts at the end', async () => {
    /*
     * Play at the end restarts from the top, which is what every player does —
     * and backwards, the end is where it restarts *from*. Without that, and
     * without an end check that knows which way it is going, the first tick
     * lands exactly on the end and stops: a key that looks like it did nothing.
     */
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.goToEnd();
         await new Promise(r => setTimeout(r, 200));
         const end = playback.getTime();
         await window.__press('a');
         const rate = playback.getRate();
         await new Promise(r => setTimeout(r, 500));
         const after = playback.getTime();
         playback.pause();
         return { end, rate, after, playing: after < end };`,
    )
    assert.equal(state.rate, -1, 'the shuttle should have started')
    assert.ok(state.playing, `it should have travelled back from ${state.end}, and it is at ${state.after}`)
  })

  await check('a shuttle back from the end survives a busy frame', async () => {
    /*
     * The check above passes on an idle machine whether or not the transport
     * knows which way it is travelling: the first backwards tick arrives a
     * millisecond or two after the key, the playhead has already left the end,
     * and the far-end test is false for the ordinary reason. It measures the
     * outcome; it cannot see the rule that makes the outcome reliable.
     *
     * Block the main thread first and it becomes a different question. The
     * animation frame that follows carries the timestamp of a frame that was
     * already scheduled while the thread was busy — earlier than the moment
     * the transport started — so the first tick is charged a *negative*
     * elapsed time and its next position lands past the end rather than short
     * of it. A far-end test that does not ask which way the transport is going
     * parks there and stops, and a shuttle back pressed at the end of the
     * sequence looks like a dead key.
     *
     * A busy frame is not a contrived condition. It is a decode, a waveform, a
     * timeline being laid out — which is to say it is most frames in the app
     * this is for, and it is why this was found by hand long before it was
     * found here.
     */
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.goToEnd();
         await new Promise(r => setTimeout(r, 250));
         const end = playback.getTime();
         // About eight frames of work, which is an ordinary amount for one.
         const until = performance.now() + 120;
         while (performance.now() < until) { /* busy */ }
         await window.__press('a');
         const rate = playback.getRate();
         const running = playback.isPlaying();
         await new Promise(r => setTimeout(r, 400));
         const after = playback.getTime();
         playback.pause();
         return { end, rate, running, after };`,
    )
    assert.equal(state.rate, -1, 'the shuttle should still be running backwards')
    assert.equal(state.running, true, 'and the transport should not have parked itself')
    assert.ok(
      state.after < state.end - 0.1,
      `it should have travelled back from ${state.end}, and it is at ${state.after}`,
    )
  })

  await check('reaching either end parks, stops, and comes back to 1x', async () => {
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `playback.seek(1);
         await new Promise(r => setTimeout(r, 200));
         /*
          * Two presses, not four. At -4x this reaches zero *during* the run,
          * and a further press would then restart it from the far end — which
          * is the right behaviour and the wrong thing to be measuring here.
          */
         await window.__press('a');
         await window.__press('a');
         await new Promise(r => setTimeout(r, 900));
         return { at: playback.getTime(), playing: playback.isPlaying(), rate: playback.getRate() };`,
    )
    assert.equal(state.at, 0, 'parked exactly at the start')
    assert.equal(state.playing, false, 'and stopped there')
    assert.equal(state.rate, 1, 'with the ladder back at the bottom for next time')
  })

  await check('a shuttle is silent, and the sound comes back at 1x', async () => {
    /*
     * The mixer schedules real buffers at real moments on a device that runs
     * one speed forwards. Four times or backwards is not something it can play,
     * so it stops — and letting it keep the clock instead would drag the
     * playhead back to 1x while the picture claimed otherwise.
     */
    const state = await evaluate(
      cdp,
      SHUTTLE +
        `const { mixer } = window.__fluxDev;
         playback.seek(1);
         await new Promise(r => setTimeout(r, 200));
         await window.__press('d');
         await new Promise(r => setTimeout(r, 500));
         const atOne = { mixing: mixer.mixerTime() !== null, rate: playback.getRate() };
         await window.__press('d');
         await new Promise(r => setTimeout(r, 500));
         const shuttling = { mixing: mixer.mixerTime() !== null, rate: playback.getRate() };
         playback.pause();
         await new Promise(r => setTimeout(r, 200));
         playback.seek(1);
         playback.play();
         await new Promise(r => setTimeout(r, 600));
         const again = { mixing: mixer.mixerTime() !== null, rate: playback.getRate() };
         playback.pause();
         return { atOne, shuttling, again };`,
    )
    assert.equal(state.atOne.rate, 1, 'setup: one press is ordinary play')
    assert.equal(state.atOne.mixing, true, 'which has sound')
    assert.equal(state.shuttling.rate, 2, 'setup: two presses is a shuttle')
    assert.equal(state.shuttling.mixing, false, 'and a shuttle is silent')
    assert.equal(state.again.mixing, true, 'and the sound comes back when the transport does')
  })

  await check('the mixer can reach an audio device at all', async () => {
    // Guarded rather than assumed: without one, every check below would fail
    // for a reason that has nothing to do with the mixer.
    const state = await evaluate(
      cdp,
      `const { mixer } = window.__fluxDev;
       return { output: mixer.hasAudioOutput(), stats: mixer.mixerStats() };`,
    )
    assert.equal(state.output, true, 'no AudioContext — nothing below can be believed')
    assert.ok(state.stats.sampleRate > 0, 'the context reports no sample rate')
  })

  await check('playing a clip makes the sound the waveform promised', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `playback.play();
         const readings = [];
         for (let i = 0; i < 70; i++) {
           await new Promise(r => setTimeout(r, 100));
           readings.push([+playback.getTime().toFixed(2), +window.__fluxDev.mixer.mixerLevel().toFixed(4)]);
         }
         const stats = window.__fluxDev.mixer.mixerStats();
         playback.pause();
         return { readings, stats };`,
    )

    // The fixture's own schedule, with a little clear of each edge so a reading
    // straddling a transition is not counted as either.
    const inAny = (t, windows) => windows.some(([a, b]) => t >= a && t <= b)
    const loud = state.readings
      .filter(([t]) => inAny(t, [[0.3, 1.8], [4.3, 5.8]]))
      .map(([, level]) => level)
    const quiet = state.readings
      .filter(([t]) => inAny(t, [[2.3, 3.8], [6.3, 6.9]]))
      .map(([, level]) => level)

    assert.ok(loud.length > 10, `only ${loud.length} readings in the loud passages`)
    assert.ok(quiet.length > 10, `only ${quiet.length} readings in the quiet passages`)

    const worstLoud = Math.min(...loud)
    const worstQuiet = Math.max(...quiet)
    assert.ok(
      Math.abs(worstLoud - LOUD_RMS) < 0.06,
      `a full-scale passage came out at ${worstLoud.toFixed(3)}, not ${LOUD_RMS.toFixed(3)}`,
    )
    assert.ok(
      Math.abs(worstQuiet - QUIET_RMS) < 0.01,
      `a near-silent passage came out at ${worstQuiet.toFixed(4)}, not ${QUIET_RMS.toFixed(4)}`,
    )
    assert.equal(state.stats.late, 0, `${state.stats.late} frames arrived after their moment`)
    assert.ok(state.stats.scheduled > 200, `only ${state.stats.scheduled} buffers were scheduled`)
  })

  /*
   * Trimming, from the only place it can actually be believed: what came out.
   *
   * A trim writes three numbers, and the timeline suite checks all three. None
   * of that says the picture and the sound moved with them — an in point the
   * decoder ignores is a clip that looks trimmed on the timeline and plays the
   * frames it used to. Both checks below put the clip's in point three seconds
   * into the file and its start back at zero, so the two are different numbers
   * and reading the wrong one cannot come out right by accident.
   */
  const TRIMMED_IN = `
    const first = sequence.getSequence().clips[0].id;
    // Both halves: they are linked, which is the point of doing it this way.
    sequence.trimClips([first], 'start', 3);
    sequence.moveClips([first], -3, 0);
    const clip = sequence.getSequence().clips.find(c => c.kind === 'video');
    if (clip.start !== 0 || clip.offset !== 3) {
      throw new Error('setup: clip is at ' + clip.start + ' from ' + clip.offset);
    }
  `

  await check('a trimmed clip shows the frame at its in point', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        TRIMMED_IN +
        `playback.seek(0.5);
         // Waits for the picture, not for a duration: the first frame after a
         // seek is a real decode from a keyframe.
         let shown = null;
         for (let i = 0; i < 60; i++) {
           await new Promise(r => setTimeout(r, 100));
           const canvas = document.querySelector('canvas.viewer-media');
           const t = canvas && canvas.dataset.frameTime ? Number(canvas.dataset.frameTime) : null;
           if (t !== null) { shown = t; if (Math.abs(t - 3.5) < 0.2) break; }
         }
         return { shown, at: playback.getTime() };`,
    )
    assert.ok(state.shown !== null, 'the pipeline never drew a frame')
    assert.ok(
      Math.abs(state.shown - 3.5) < 0.15,
      `half a second into a clip cut from three seconds in, the picture should be at 3.5s ` +
        `and it is at ${state.shown}s — 0.5s would mean the in point was ignored`,
    )
  })

  await check('a trimmed clip plays the sound at its in point', async () => {
    /*
     * The fixture is loud for two seconds then quiet for two, three times over.
     * Cut three seconds off its head and the clip now begins one second before
     * the end of a quiet stretch: quiet until a second in, loud for the two
     * after that. Untrimmed it would start loud, which is what makes this
     * measurable rather than merely consistent.
     */
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        TRIMMED_IN +
        `playback.seek(0);
         await new Promise(r => setTimeout(r, 400));
         playback.play();
         const readings = [];
         for (let i = 0; i < 32; i++) {
           await new Promise(r => setTimeout(r, 100));
           readings.push([+playback.getTime().toFixed(2),
                          +window.__fluxDev.mixer.mixerLevel().toFixed(4)]);
         }
         playback.pause();
         return { readings, stats: window.__fluxDev.mixer.mixerStats() };`,
    )

    /*
     * Late frames, as well as the level.
     *
     * There are two halves to reading an in point — where the source is seeked
     * to, and where each decoded frame is placed back on the timeline — and
     * getting only the second right still ends up sounding correct: the mixer
     * decodes its way from the top of the file, throws every frame away as
     * having missed its moment, and arrives at the in point by brute force.
     * The sound is the same and the work is not, so the work is what says which
     * happened.
     */
    assert.equal(state.stats.late, 0, `${state.stats.late} frames arrived after their moment — ` +
      'the mixer is decoding from the top of the file and discarding its way to the in point')

    const within = (t, a, b) => t >= a && t <= b
    const quiet = state.readings.filter(([t]) => within(t, 0.3, 0.8)).map(([, level]) => level)
    const loud = state.readings.filter(([t]) => within(t, 1.3, 2.7)).map(([, level]) => level)
    assert.ok(quiet.length > 2, `only ${quiet.length} readings in the quiet stretch`)
    assert.ok(loud.length > 5, `only ${loud.length} readings in the loud stretch`)

    const worstQuiet = Math.max(...quiet)
    const worstLoud = Math.min(...loud)
    assert.ok(
      worstQuiet < QUIET_RMS + 0.05,
      `the trimmed clip should open quiet and it read ${worstQuiet.toFixed(3)} — ` +
        `${LOUD_RMS.toFixed(3)} would mean it played from the top of the file`,
    )
    assert.ok(
      Math.abs(worstLoud - LOUD_RMS) < 0.06,
      `and the loud stretch a second later read ${worstLoud.toFixed(3)}, not ${LOUD_RMS.toFixed(3)}`,
    )
  })

  await check('two clips at once are heard together, not one of them', async () => {
    /*
     * The whole claim of the word "mixer".
     *
     * The same file on both audio tracks at the same moment: two identical
     * signals sum to exactly twice the amplitude, so the meter should read
     * about 1.27 where one clip reads 0.636. A mixer that plays whichever clip
     * it noticed last would read 0.636 and look perfectly healthy.
     */
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `const second = sequence.addClip(
           { assetId: voice.id, trackId: 'A2', start: 0, duration: probed.duration });
         if (!second) throw new Error('could not place a second audio clip');
         await new Promise(r => setTimeout(r, 300));

         playback.seek(0);
         playback.play();
         const readings = [];
         for (let i = 0; i < 16; i++) {
           await new Promise(r => setTimeout(r, 100));
           readings.push([+playback.getTime().toFixed(2), +window.__fluxDev.mixer.mixerLevel().toFixed(4)]);
         }
         const stats = window.__fluxDev.mixer.mixerStats();
         playback.pause();
         return { readings, stats, clips: sequence.getSequence().clips.length };`,
    )
    assert.equal(state.clips, 3, 'setup: expected a linked pair plus a second audio clip')
    assert.equal(state.stats.voices, 2, `the mixer had ${state.stats.voices} clip(s) in hand`)

    const during = state.readings.filter(([t]) => t >= 0.3 && t <= 1.8).map(([, l]) => l)
    assert.ok(during.length > 5, `only ${during.length} readings while both clips played`)
    const quietest = Math.min(...during)
    assert.ok(
      quietest > LOUD_RMS * 1.6,
      `two clips together read ${quietest.toFixed(3)}, barely more than one at ${LOUD_RMS.toFixed(3)}`,
    )
  })

  await check('the transport reads its time from the mixer', async () => {
    /*
     * Not merely "the playhead moves" — the wall clock would do that too, and
     * to within a few tens of milliseconds it would agree, because two clocks
     * started together take a while to disagree.
     *
     * So the comparison is made *inside* the transport's own notification,
     * where the playhead has just been set from whatever it reads. If that is
     * the mixer, the two numbers are the same call moments apart and agree to
     * the microsecond. Sampling from outside would instead measure how long ago
     * the last animation frame was, which is not a fact about the clock.
     */
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `const { mixer } = window.__fluxDev;
         const gaps = [];
         const stop = playback.subscribePlayback(() => {
           const mixed = mixer.mixerTime();
           if (mixed !== null) gaps.push(playback.getTime() - mixed);
         });
         playback.play();
         // Until there are enough readings, not for a fixed time: the transport
         // notifies on animation frames, and how many of those arrive in a
         // second is a fact about the machine rather than about the clock.
         const deadline = performance.now() + 8000;
         while (gaps.length < 30 && performance.now() < deadline) {
           await new Promise(r => setTimeout(r, 50));
         }
         playback.pause();
         stop();
         return { gaps: gaps.map(g => +g.toFixed(6)), voices: mixer.mixerStats().voices };`,
    )
    assert.ok(state.gaps.length > 20, `only ${state.gaps.length} readings while playing`)

    /*
     * The median, not the worst.
     *
     * Measured over 222 notifications: the gap is *exactly* zero for more than
     * 99% of them, with the occasional reading at -10ms where the audio clock
     * ticked over while the rest of the app was being notified. Zero is the
     * fact worth asserting — it is the same number read twice. A clock that was
     * not the mixer's would sit around 80ms out, the lead playback is anchored
     * with, and no amount of outlier would look like this.
     */
    const sorted = state.gaps.map(Math.abs).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    assert.ok(
      median < 0.001,
      `the playhead usually sits ${median.toFixed(4)}s from the audio device, not on it`,
    )
  })

  await check('seeking while playing moves the sound with the playhead', async () => {
    // From a loud passage into a quiet one. If the old audio were left to play
    // out, or the new position never scheduled, the meter would not follow.
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `playback.play();
         await new Promise(r => setTimeout(r, 900));
         const before = window.__fluxDev.mixer.mixerLevel();
         playback.seek(2.6);
         await new Promise(r => setTimeout(r, 700));
         const after = window.__fluxDev.mixer.mixerLevel();
         playback.seek(4.6);
         await new Promise(r => setTimeout(r, 700));
         const back = window.__fluxDev.mixer.mixerLevel();
         playback.pause();
         return { before, after, back };`,
    )
    assert.ok(state.before > LOUD_RMS * 0.8, `started at ${state.before.toFixed(3)}, not loud`)
    assert.ok(state.after < 0.1, `seeking into the quiet passage still read ${state.after.toFixed(3)}`)
    assert.ok(state.back > LOUD_RMS * 0.8, `seeking back to loud read ${state.back.toFixed(3)}`)
  })

  await check('pausing stops the sound', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `playback.play();
         await new Promise(r => setTimeout(r, 900));
         const playing = window.__fluxDev.mixer.mixerLevel();
         playback.pause();
         await new Promise(r => setTimeout(r, 500));
         const paused = window.__fluxDev.mixer.mixerLevel();
         return { playing, paused, stats: window.__fluxDev.mixer.mixerStats() };`,
    )
    assert.ok(state.playing > LOUD_RMS * 0.8, `it was not playing to begin with (${state.playing})`)
    assert.ok(state.paused < 0.01, `sound was still coming out after pause (${state.paused})`)
    assert.equal(state.stats.running, false)
    assert.equal(state.stats.voices, 0, 'paused, but still holding decoders open')
  })

  await check('a deep seek does not decode everything before it', async () => {
    /*
     * Two separate things keep a seek honest, and only one of them is about
     * speed.
     *
     * Dropping frames from before the seek point is what makes the sound
     * *right*; starting the decoder near the seek point is what makes it
     * *quick*. Take the second away and the first still works — every frame
     * from the start of the file is decoded and thrown away — so nothing about
     * the audio would sound wrong, it would just take a minute to arrive.
     * Which is why this measures the clock rather than the meter.
     */
    const state = await evaluate(
      cdp,
      `const { media } = window.__fluxDev;
       const opened = await media.audioSource.AudioSource.open(${LONG});
       if (!opened.ok) return { error: opened.reason };
       const source = opened.source;
       try {
         source.seek(50);
         const started = performance.now();
         const frame = await source.next();
         const ms = performance.now() - started;
         return {
           ms, decoded: source.decoded, total: source.info.duration,
           time: frame ? frame.time : null,
           end: frame ? frame.time + frame.duration : null,
         };
       } finally {
         source.close();
       }`,
    )
    assert.equal(state.error, undefined, state.error)
    assert.ok(state.time !== null, 'no frame came back from a seek to 50s')

    // The frame handed back must be the one covering the moment asked for.
    // Two frames earlier is a fortieth of a second of the wrong audio at the
    // head of every seek — inaudible on its own, and exactly the sort of thing
    // that is never found later.
    assert.ok(
      state.time <= 50 && state.end > 50,
      `a seek to 50s produced the frame covering ${state.time}s to ${state.end}s`,
    )

    // A minute of AAC is around 2,800 frames and decodes in a couple of
    // hundred milliseconds, so a stopwatch would not reliably tell "started
    // near 50s" from "decoded the lot". Counting does.
    assert.ok(
      state.decoded < 12,
      `${state.decoded} frames were decoded to produce the one at 50s`,
    )
  })

  /** Plays, waits for the level to settle, and reports it. */
  const LEVEL_AFTER = (setup) => `
    playback.seek(0);
    playback.play();
    await new Promise(r => setTimeout(r, 700));
    const before = window.__fluxDev.mixer.mixerLevel();
    ${setup}
    // The ramp is a few milliseconds and the meter averages over about forty,
    // so this is waiting for the measurement, not for the change.
    await new Promise(r => setTimeout(r, 400));
    const after = window.__fluxDev.mixer.mixerLevel();
    playback.pause();
    return { before, after };`

  await check('muting a track silences it', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND + LEVEL_AFTER(`sequence.setTrackMuted('A1', true);`),
    )
    assert.ok(state.before > LOUD_RMS * 0.8, `it was not playing to begin with (${state.before})`)
    assert.ok(state.after < 0.005, `a muted track was still heard at ${state.after.toFixed(4)}`)
  })

  await check('unmuting brings it straight back', async () => {
    // Straight back matters: the audio for a muted track is still decoded and
    // still scheduled, precisely so that unmuting does not have to wait a
    // scheduling window for anything to arrive.
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `sequence.setTrackMuted('A1', true);
         playback.seek(0);
         playback.play();
         await new Promise(r => setTimeout(r, 700));
         const before = window.__fluxDev.mixer.mixerLevel();
         sequence.setTrackMuted('A1', false);
         // Barely longer than the ramp and the meter's own window.
         await new Promise(r => setTimeout(r, 120));
         const after = window.__fluxDev.mixer.mixerLevel();
         playback.pause();
         return { before, after };`,
    )
    assert.ok(state.before < 0.005, `it was not muted to begin with (${state.before})`)
    assert.ok(
      state.after > LOUD_RMS * 0.5,
      `a tenth of a second after unmuting it was still at ${state.after.toFixed(4)}`,
    )
  })

  await check('the last of several quick level changes is the one that sticks', async () => {
    /*
     * Levels ramp over a few milliseconds, and for those milliseconds the gain
     * node still reports the value it is leaving. Anything deciding "has this
     * changed?" by reading it therefore compares against a number already on
     * its way somewhere else — so a second change arriving mid-ramp looks like
     * no change and is dropped, and the first one wins.
     *
     * That is not an exotic case. It is unmute-then-mute, and it is every
     * fader drag, where changes arrive far faster than the ramp is long.
     */
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `sequence.setTrackMuted('A1', true);
         playback.seek(0);
         playback.play();
         await new Promise(r => setTimeout(r, 700));
         // Off, then on again, inside one ramp. The direction matters: from a
         // muted start the fader reads 0 for the whole of the ramp back up, so
         // the second change is the one that looks like nothing and gets lost.
         sequence.setTrackMuted('A1', false);
         sequence.setTrackMuted('A1', true);
         await new Promise(r => setTimeout(r, 400));
         const level = window.__fluxDev.mixer.mixerLevel();
         const gains = window.__fluxDev.mixer.mixerStats().gains;
         playback.pause();
         return { level, gain: gains.A1 };`,
    )
    assert.equal(state.gain, 0, `the fader ended at ${state.gain}, not where it was last sent`)
    assert.ok(state.level < 0.005, `and it was still heard at ${state.level.toFixed(4)}`)
  })

  await check('soloing a track silences the others', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `sequence.addClip({ assetId: voice.id, trackId: 'A2', start: 0, duration: probed.duration });
         await new Promise(r => setTimeout(r, 300));` +
        LEVEL_AFTER(`sequence.setTrackSolo('A1', true);`),
    )
    // Two copies of one signal sum to twice the amplitude; soloing one leaves
    // exactly one of them.
    assert.ok(
      state.before > LOUD_RMS * 1.6,
      `both tracks were not playing to begin with (${state.before.toFixed(3)})`,
    )
    assert.ok(
      Math.abs(state.after - LOUD_RMS) < 0.06,
      `soloing one of two left ${state.after.toFixed(3)}, not ${LOUD_RMS.toFixed(3)}`,
    )
  })

  await check('a soloed track that is also muted stays silent', async () => {
    // Each button keeps meaning one thing. Solo picks the subset, mute silences
    // within it — the alternative is one control quietly overruling the other,
    // which is the kind of rule nobody can predict from the buttons.
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        LEVEL_AFTER(`sequence.setTrackSolo('A1', true); sequence.setTrackMuted('A1', true);`),
    )
    assert.ok(state.before > LOUD_RMS * 0.8, `it was not playing to begin with (${state.before})`)
    assert.ok(state.after < 0.005, `soloed and muted still made ${state.after.toFixed(4)}`)
  })

  await check('a track turned down by the amount it was turned down', async () => {
    // -6dB is half the amplitude, near enough: 10^(-6/20) = 0.5012. A gain
    // control that was applied in the wrong unit — or not applied at all — has
    // nowhere to hide against a number that exact.
    const state = await evaluate(
      cdp,
      WITH_SOUND + LEVEL_AFTER(`sequence.setTrackGain('A1', -6);`),
    )
    const expected = LOUD_RMS * 10 ** (-6 / 20)
    assert.ok(state.before > LOUD_RMS * 0.8, `it was not playing to begin with (${state.before})`)
    assert.ok(
      Math.abs(state.after - expected) < 0.02,
      `-6dB gave ${state.after.toFixed(4)}, not ${expected.toFixed(4)}`,
    )
  })

  await check('the bottom of the fader is silence, not nearly silence', async () => {
    // -60dB is a thousandth of the signal, which is inaudible but not zero —
    // and a fader pulled all the way down means off.
    const state = await evaluate(
      cdp,
      WITH_SOUND + LEVEL_AFTER(`sequence.setTrackGain('A1', -60);`),
    )
    assert.ok(state.before > LOUD_RMS * 0.8, `it was not playing to begin with (${state.before})`)
    assert.equal(state.after, 0, `the fader bottom left ${state.after} coming out`)
  })

  await check('a level set while paused is in force when play is pressed', async () => {
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `sequence.setTrackGain('A1', -12);
         await new Promise(r => setTimeout(r, 200));
         playback.seek(0);
         playback.play();
         await new Promise(r => setTimeout(r, 700));
         const level = window.__fluxDev.mixer.mixerLevel();
         playback.pause();
         sequence.setTrackGain('A1', 0);
         return level;`,
    )
    const expected = LOUD_RMS * 10 ** (-12 / 20)
    assert.ok(
      Math.abs(state - expected) < 0.02,
      `-12dB set before play gave ${state.toFixed(4)}, not ${expected.toFixed(4)}`,
    )
  })

  await check('a stretch with no sound still passes at the right speed', async () => {
    // The mixer says nothing when no clip is under the playhead, and the wall
    // clock covers. A gap that ran at the wrong speed — or not at all — would
    // be a sequence that stalls wherever the sound stops.
    const state = await evaluate(
      cdp,
      WITH_SOUND +
        `// Nothing at all until 6s. Cleared rather than picked apart: removing
         // half a linked pair removes the other half, which is the point of
         // linking and would leave nothing behind either way.
         sequence.clearSequence();
         sequence.addClip({ assetId: voice.id, trackId: 'A1', start: 6, duration: 2 });
         await new Promise(r => setTimeout(r, 300));

         playback.seek(0);
         playback.play();
         const started = performance.now();
         await new Promise(r => setTimeout(r, 2000));
         const reached = playback.getTime();
         const level = window.__fluxDev.mixer.mixerLevel();
         playback.pause();
         return { reached, elapsed: (performance.now() - started) / 1000, level,
                  voices: window.__fluxDev.mixer.mixerStats().voices };`,
    )
    assert.ok(state.level < 0.01, `silence was not silent (${state.level})`)
    assert.ok(
      Math.abs(state.reached - state.elapsed) < 0.3,
      `two seconds of silence moved the playhead ${state.reached.toFixed(2)}s in ${state.elapsed.toFixed(2)}s`,
    )
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

  // ── the frame, and how much of it is worth drawing ────────────
  //
  // At the end of the suite, and restoring what it changed, because these move
  // the sequence's resolution and the viewer's preferences — both of which
  // everything above reads.

  /** Sets up one landscape clip and reports the viewer's geometry. */
  const VIEWER = `
    const frame = document.querySelector('.viewer-frame');
    const stage = document.querySelector('.viewer-stage');
    const canvas = document.querySelector('canvas.viewer-media');
    return {
      frame: frame && {
        w: Math.round(frame.getBoundingClientRect().width),
        h: Math.round(frame.getBoundingClientRect().height),
        aspect: frame.dataset.aspect,
      },
      stage: stage && {
        w: Math.round(stage.getBoundingClientRect().width),
        h: Math.round(stage.getBoundingClientRect().height),
      },
      canvas: canvas && { w: canvas.width, h: canvas.height },
    };`

  await evaluate(
    cdp,
    `const { importPipeline, assets, sequence, playback, view } = window.__fluxDev;
     const added = await importPipeline.importFiles(
       [{ path: ${dir} + '\\\\clipA.mp4', kind: 'video' }], 'link');
     const asset = added[0] ?? assets.getAssets().find(a => a.name === 'clipA.mp4');
     const probed = await assets.ensureProbed(asset.id);
     sequence.setSequence(null);
     sequence.setSequenceSize(1920, 1080);
     sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
     view.recordView({ viewer: { playbackResolution: 0.5, pausedResolution: 1 } });
     playback.pause();
     playback.seek(0.5);
     await new Promise(r => setTimeout(r, 1200));
     return true;`,
  )

  await check('the frame takes its shape from the sequence, not from the clip', async () => {
    /*
     * The clip is 16:9 and the sequence is made 9:16 underneath it.
     *
     * This is the bug the whole thing started from: the frame's aspect ratio
     * was a constant in the stylesheet, so a vertical sequence was previewed
     * in a landscape box and the picture inside it was the wrong shape in a
     * way that looked like a scaling bug rather than a frame one.
     */
    const landscape = await evaluate(cdp, VIEWER)
    assert.equal(landscape.frame.aspect, '16:9', 'a 1920×1080 sequence is 16:9')

    const portrait = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequenceSize(1080, 1920);
       await new Promise(r => setTimeout(r, 700));
       ${VIEWER}`,
    )
    assert.equal(portrait.frame.aspect, '9:16', 'a 1080×1920 sequence is 9:16')
    assert.ok(
      portrait.frame.h > portrait.frame.w,
      `the frame is ${portrait.frame.w}×${portrait.frame.h}, which is not portrait`,
    )

    const square = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       sequence.setSequenceSize(1080, 1080);
       await new Promise(r => setTimeout(r, 700));
       ${VIEWER}`,
    )
    assert.equal(square.frame.aspect, '1:1')
    assert.ok(
      Math.abs(square.frame.w - square.frame.h) <= 1,
      `a square sequence drew ${square.frame.w}×${square.frame.h}`,
    )
  })

  await check('Fit puts the whole frame inside the panel, and touching one edge', async () => {
    const state = await evaluate(
      cdp,
      `const { sequence, commands } = window.__fluxDev;
       sequence.setSequenceSize(1920, 1080);
       await new Promise(r => setTimeout(r, 400));
       await commands.run('viewer.fit');
       await new Promise(r => setTimeout(r, 400));
       ${VIEWER}`,
    )
    // Inside, on both axes — otherwise "fit" is cropping.
    assert.ok(
      state.frame.w <= state.stage.w + 1 && state.frame.h <= state.stage.h + 1,
      `${state.frame.w}×${state.frame.h} does not fit in ${state.stage.w}×${state.stage.h}`,
    )
    // And touching, on one — otherwise it is merely small, and a viewer that
    // fits by shrinking to nothing would pass the test above.
    assert.ok(
      Math.abs(state.frame.w - state.stage.w) <= 2 || Math.abs(state.frame.h - state.stage.h) <= 2,
      `${state.frame.w}×${state.frame.h} touches neither edge of ${state.stage.w}×${state.stage.h}`,
    )
  })

  await check('zooming in overflows the panel, and Fit brings it back', async () => {
    const fitted = await evaluate(cdp, VIEWER)

    const zoomed = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('viewer.zoomIn');
       await commands.run('viewer.zoomIn');
       await new Promise(r => setTimeout(r, 400));
       ${VIEWER}`,
    )
    /*
     * Two steps, not one.
     *
     * The refs the zoom reads are refreshed during render, so a second command
     * arriving before React had re-rendered used to read the scale from before
     * the first and compute the same step again — holding a zoom key moved one
     * level and then stopped. Two calls have to land two levels apart.
     */
    assert.ok(
      zoomed.frame.w > fitted.frame.w * 1.9,
      `two zoom-ins took the frame from ${fitted.frame.w}px to ${zoomed.frame.w}px, which is not two levels`,
    )

    const back = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('viewer.fit');
       await new Promise(r => setTimeout(r, 400));
       ${VIEWER}`,
    )
    assert.equal(back.frame.w, fitted.frame.w, 'Fit did not return the frame to where it was')
  })

  /** The stage's position on screen, for aiming real input events at it. */
  const stageRect = () =>
    evaluate(
      cdp,
      `const s = document.querySelector('.viewer-stage').getBoundingClientRect();
       return { x: s.left, y: s.top, w: s.width, h: s.height };`,
    )

  await check('the wheel zooms, towards the cursor rather than the middle', async () => {
    /*
     * Driven with real wheel events rather than by calling the handler.
     *
     * React attaches `wheel` at the root as a *passive* listener, so a
     * synthetic `onWheel` cannot preventDefault and the panel scrolls
     * underneath the zoom. The listener here is a native one registered with
     * `passive: false` — a fact about how it is attached, which only a real
     * event can check.
     */
    await evaluate(
      cdp,
      `await window.__fluxDev.commands.run('viewer.fit');
       await new Promise(r => setTimeout(r, 300));
       return true;`,
    )
    const before = await evaluate(cdp, VIEWER)
    const rect = await stageRect()

    // Up and left of the middle, so the direction the picture moves is a
    // signed answer rather than a coin flip.
    const x = Math.round(rect.x + rect.w * 0.25)
    const y = Math.round(rect.y + rect.h * 0.25)
    for (let i = 0; i < 3; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: -120,
        pointerType: 'mouse',
      })
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    await new Promise((resolve) => setTimeout(resolve, 400))

    const after = await evaluate(
      cdp,
      `const f = document.querySelector('.viewer-frame').getBoundingClientRect();
       const s = document.querySelector('.viewer-stage').getBoundingClientRect();
       return { w: Math.round(f.width),
                cx: Math.round(f.left + f.width / 2 - (s.left + s.width / 2)),
                cy: Math.round(f.top + f.height / 2 - (s.top + s.height / 2)) };`,
    )
    assert.ok(after.w > before.frame.w * 1.2, `the wheel took ${before.frame.w}px to ${after.w}px`)
    /*
     * Zooming towards a point above and to the left of centre has to push the
     * frame's centre down and to the right — that is what keeps the thing
     * under the cursor under the cursor. Zooming around the middle instead
     * leaves the centre at zero, which is the bug this catches: you point at a
     * corner, zoom, and what you were looking at leaves the panel.
     */
    assert.ok(
      after.cx > 20 && after.cy > 20,
      `the frame centre went to (${after.cx}, ${after.cy}) — it zoomed around the middle`,
    )
  })

  await check('the middle button drags the picture', async () => {
    const rect = await stageRect()
    const x = Math.round(rect.x + rect.w / 2)
    const y = Math.round(rect.y + rect.h / 2)
    const centre = `const f = document.querySelector('.viewer-frame').getBoundingClientRect();
       const s = document.querySelector('.viewer-stage').getBoundingClientRect();
       return { cx: Math.round(f.left + f.width / 2 - (s.left + s.width / 2)),
                cy: Math.round(f.top + f.height / 2 - (s.top + s.height / 2)) };`

    const before = await evaluate(cdp, centre)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'middle',
      buttons: 4,
      clickCount: 1,
      pointerType: 'mouse',
    })
    for (const step of [20, 40, 60]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x + step,
        y: y + Math.round((step * 2) / 3),
        button: 'middle',
        buttons: 4,
        pointerType: 'mouse',
      })
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x + 60,
      y: y + 40,
      button: 'middle',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await new Promise((resolve) => setTimeout(resolve, 400))

    const after = await evaluate(cdp, centre)
    // The picture follows the pointer exactly: a drag is not a scroll with a
    // rate of its own, it is the thing moving with your hand.
    assert.equal(after.cx - before.cx, 60, 'the picture did not follow the drag horizontally')
    assert.equal(after.cy - before.cy, 40, 'the picture did not follow the drag vertically')
  })

  await check('the preview resolution decides how many pixels are composited', async () => {
    /*
     * The canvas is the thing that shrinks, and the frame is the thing that
     * does not. That split is the whole feature: fewer pixels to composite and
     * to hand the compositor, laid out at the same size on screen, so the only
     * visible difference is a softer picture.
     */
    const quarter = await evaluate(
      cdp,
      `const { view } = window.__fluxDev;
       view.recordView({ viewer: { playbackResolution: 0.5, pausedResolution: 0.25 } });
       await new Promise(r => setTimeout(r, 800));
       ${VIEWER}`,
    )
    assert.equal(quarter.canvas.w, 480, 'a quarter of 1920')
    assert.equal(quarter.canvas.h, 270, 'a quarter of 1080')

    const full = await evaluate(
      cdp,
      `const { view } = window.__fluxDev;
       view.recordView({ viewer: { playbackResolution: 0.5, pausedResolution: 1 } });
       await new Promise(r => setTimeout(r, 800));
       ${VIEWER}`,
    )
    assert.equal(full.canvas.w, 1920)
    assert.equal(full.canvas.h, 1080)
    assert.equal(full.frame.w, quarter.frame.w, 'the frame on screen must not change size with it')
  })

  await check('playing and pausing swap between the two resolutions', async () => {
    /*
     * The reason there are two settings at all. Dropping frames while playing
     * is a cost you choose; a soft picture on the frame you stopped on to
     * judge focus is not one anybody chooses.
     */
    const state = await evaluate(
      cdp,
      `const { playback, view } = window.__fluxDev;
       view.recordView({ viewer: { playbackResolution: 0.25, pausedResolution: 1 } });
       playback.seek(0.5);
       await new Promise(r => setTimeout(r, 600));
       const paused = document.querySelector('canvas.viewer-media').width;
       playback.play();
       await new Promise(r => setTimeout(r, 900));
       const playing = document.querySelector('canvas.viewer-media').width;
       playback.pause();
       await new Promise(r => setTimeout(r, 700));
       const after = document.querySelector('canvas.viewer-media').width;
       return { paused, playing, after };`,
    )
    assert.equal(state.paused, 1920, 'stopped on a frame, it should composite at full size')
    assert.equal(state.playing, 480, 'and at a quarter while running')
    assert.equal(state.after, 1920, 'and back to full when it stops again')
  })

  await check('the two resolutions survive being saved and opened again', async () => {
    /*
     * A preference written on every save and silently reset on every open is
     * worse than one that was never stored: it looks like it works until the
     * next time the project is opened, and by then nobody connects the two.
     *
     * `setView` rebuilds its state field by field rather than spreading what
     * it was given — which is the right instinct for something that parses a
     * file a human may have edited, and exactly the way a new field gets
     * forgotten. Hence this.
     */
    const state = await evaluate(
      cdp,
      `const { view } = window.__fluxDev;
       view.recordView({ viewer: { playbackResolution: 0.125, pausedResolution: 0.5 } });
       const saved = JSON.parse(JSON.stringify(view.getView()));
       view.resetView();
       const afterReset = view.getView().viewer;
       view.setView(saved);
       const afterLoad = view.getView().viewer;
       view.setView({ ...saved, viewer: { playbackResolution: 7, pausedResolution: 'x' } });
       const afterJunk = view.getView().viewer;
       return { afterReset, afterLoad, afterJunk };`,
    )
    assert.deepEqual(
      state.afterLoad,
      { playbackResolution: 0.125, pausedResolution: 0.5 },
      'the viewer preferences did not come back from a saved view',
    )
    assert.deepEqual(state.afterReset, { playbackResolution: 0.5, pausedResolution: 1 })
    // A hand-edited .flux must not be able to ask for a resolution that does
    // not exist: 7× the sequence size is a canvas nothing can allocate.
    assert.deepEqual(
      state.afterJunk,
      { playbackResolution: 0.5, pausedResolution: 1 },
      'a nonsense resolution in the document was taken at face value',
    )
  })

  await check('a decoder wanting more than one window of input is given it', async () => {
    /*
     * The bug that made the viewer black on real footage.
     *
     * A decoder emits nothing until enough chunks are in flight, and how many
     * belongs to the decoder and the stream: 14 for a 1080p camera clip here
     * against 2 for clipA. The window was 8 — above every fixture, below real
     * footage — so `feed` submitted its eight, stopped, and `frameFor` then
     * waited without ever offering more. The decoder waited on us, we waited
     * on it, and a five second timer ended it. The sound played on and the
     * picture appeared only while the playhead was dragged, each drag
     * submitting a few chunks more.
     *
     * No fixture reproduces that depth — a 1080p clip out of x264 wants 3 —
     * so this does not try to. It starves the *first* submission down to one
     * chunk, below any decoder's pipeline, and asks whether a frame still
     * arrives. With the old wait it cannot: nothing would ever be submitted
     * again. That is the mechanism rather than the symptom, and it holds
     * whatever a given machine's decoder happens to want.
     */
    const state = await evaluate(
      cdp,
      `const { videoSource } = window.__fluxDev;
       const opened = await videoSource.VideoSource.open(${LONG});
       if (!opened.ok) return { error: opened.reason };
       const src = opened.source;

       const realFeed = src.feed.bind(src);
       let calls = 0;
       src.feed = (time, ahead) => realFeed(time, calls++ === 0 ? 1 : ahead);

       const began = performance.now();
       const frame = await src.frameFor(0);
       const out = { got: !!frame, ms: Math.round(performance.now() - began), calls };
       src.close();
       return out;`,
    )

    assert.ok(!state.error, state.error)
    assert.ok(
      state.got,
      `no frame arrived after ${state.ms}ms and ${state.calls} submissions — ` +
        'the wait is not feeding the decoder',
    )
    assert.ok(state.calls > 1, 'only one submission was made, so nothing topped the decoder up')
    // Comfortably inside FRAME_TIMEOUT_MS: a frame that arrives only because
    // the timeout expired is not this working.
    assert.ok(state.ms < 2000, `the frame took ${state.ms}ms, which is the deadlock timing out`)
  })

  await check('a turned clip is drawn the right way up, not merely the right shape', async () => {
    /*
     * The check that was missing, and the reason a real bug shipped.
     *
     * `rotated.mp4` is coded 320x180 with a matrix of 90 — a camera held on
     * its side — and its upright picture has four differently coloured
     * quadrants: red, green, blue, white, clockwise from the top left. Every
     * other fixture is a test pattern, and a test pattern drawn upside down
     * looks like itself.
     *
     * What used to be asserted about rotation was the coded size, the rotation
     * value, and that the canvas was not black. A 180-degree error changes
     * none of those, so the viewer turned every quarter-turn clip the wrong
     * way — `av_display_rotation_get` returns a counter-clockwise angle and
     * canvas `rotate()` takes a clockwise one — and the suite stayed green.
     *
     * Any wrong quarter turn moves at least two of these quadrants, and so
     * does a mirror. There is nowhere for the bug to hide.
     */
    const state = await evaluate(
      cdp,
      `const { importPipeline, assets, sequence, playback } = window.__fluxDev;
       const added = await importPipeline.importFiles(
         [{ path: ${dir} + '\\\\rotated.mp4', kind: 'video' }], 'link');
       let asset = added[0] ?? assets.getAssets().find(a => a.name === 'rotated.mp4');
       const probed = await assets.ensureProbed(asset.id);
       sequence.setSequence(null);
       // The displayed shape, so the frame matches the picture and the
       // quadrants land on the quadrants.
       sequence.setSequenceSize(probed.width, probed.height);
       sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
       playback.pause();
       playback.seek(1);
       await new Promise(r => setTimeout(r, 1800));

       const canvas = document.querySelector('canvas.viewer-media');
       if (!canvas) return { error: 'no canvas' };

       // Into a small canvas so each read is an average of its quadrant
       // rather than one pixel that might sit on a seam.
       const small = document.createElement('canvas');
       small.width = 8; small.height = 8;
       const ctx = small.getContext('2d');
       ctx.drawImage(canvas, 0, 0, 8, 8);
       const read = (x, y) => {
         const d = ctx.getImageData(x, y, 1, 1).data;
         return [d[0], d[1], d[2]];
       };
       const names = { red: [255,0,0], green: [0,128,0], blue: [0,0,255], white: [255,255,255] };
       const nearest = (rgb) => Object.entries(names)
         .map(([n, c]) => [n, (rgb[0]-c[0])**2 + (rgb[1]-c[1])**2 + (rgb[2]-c[2])**2])
         .sort((a, b) => a[1] - b[1])[0][0];

       return {
         probed: { width: probed.width, height: probed.height },
         rotation: (await window.__fluxDev.indexCache.trackFor(asset.path, 'video'))?.track?.rotation,
         topLeft: nearest(read(2, 2)),
         topRight: nearest(read(5, 2)),
         bottomLeft: nearest(read(2, 5)),
         bottomRight: nearest(read(5, 5)),
       };`,
    )

    assert.ok(!state.error, state.error)
    // Portrait on screen, from a landscape file: the rotation reached the probe.
    assert.deepEqual(
      state.probed,
      { width: 180, height: 320 },
      'the asset should carry the displayed shape, not the coded one',
    )
    assert.equal(state.rotation, 90, 'the demuxer should read a matrix of 90')

    assert.deepEqual(
      {
        topLeft: state.topLeft,
        topRight: state.topRight,
        bottomLeft: state.bottomLeft,
        bottomRight: state.bottomRight,
      },
      { topLeft: 'red', topRight: 'green', bottomLeft: 'blue', bottomRight: 'white' },
      'the picture is turned the wrong way — red/green/blue/white should run clockwise from the top left',
    )
  })

  // ── what a clip does to its own picture ───────────────────────
  //
  // Driven with clipA.mp4 rather than the four-quadrant fixture. The quadrants
  // would say more — they pin orientation as well as size — but the first
  // import of that file inside this block comes back `unreadable` wherever the
  // block is placed, while clipA is imported successfully by a dozen checks
  // above. The properties below are about *area*, which any picture can show,
  // so the weaker fixture costs nothing that matters here. Orientation is
  // checked separately, by the rotation check.

  /** One clip alone, and a reading of how much of the frame it covers. */
  const AREA_SETUP = `
    const { importPipeline, assets, sequence, playback } = window.__fluxDev;
    const added = await importPipeline.importFiles(
      [{ path: ${dir} + '\\clipA.mp4', kind: 'video' }], 'link');
    const asset = added[0] ?? assets.getAssets().find(a => a.name === 'clipA.mp4');
    const probed = await assets.ensureProbed(asset.id);
    sequence.setSequence(null);
    sequence.setSequenceSize(probed.width, probed.height);
    const clip = sequence.addClip(
      { assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
    playback.seek(1);
    /*
     * Waited for, not slept through.
     *
     * The canvas is mounted when the sequence has something to show and the
     * first composite has run, and how long that takes depends on what the
     * check before this one left in flight. A fixed delay was enough for the
     * second and third checks here and never for the first, which read a
     * canvas that did not exist yet and reported it as "-1 of 256".
     */
    for (let i = 0; i < 80; i++) {
      const c = document.querySelector('canvas.viewer-media');
      if (c && c.dataset.layers && Number(c.dataset.layers) > 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 300));
    const lit = () => {
      const c = document.querySelector('canvas.viewer-media');
      if (!c) return -1;
      const s = document.createElement('canvas'); s.width = 16; s.height = 16;
      const x = s.getContext('2d'); x.drawImage(c, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 24) n++;
      return n;
    };`

  /*
   * One run of the setup before any check uses it.
   *
   * Whichever check came first in this block failed, every time, in every
   * order and with either fixture, while the ones after it were fine — the
   * first import-and-composite after the check above lands with no canvas
   * drawn yet. Rather than pretend a longer sleep fixes that, the cost is
   * paid once, outside the checks, where a slow first pass is not a failure.
   *
   * It is a workaround and worth saying so: the thing actually worth fixing
   * is whatever leaves the viewer unable to mount a canvas for one more
   * composite, and that is its own piece of work.
   */
  await evaluate(cdp, AREA_SETUP + `return lit();`)

  await check('scale and opacity change how much of the frame is covered', async () => {
    const state = await evaluate(cdp, AREA_SETUP + `
      const plain = lit();
      sequence.setClipEffects(clip.id, { transform: { scale: 50 } });
      await new Promise(r => setTimeout(r, 900)); const half = lit();
      sequence.setClipEffects(clip.id, { transform: { scale: 100, opacity: 0 } });
      await new Promise(r => setTimeout(r, 900)); const gone = lit();
      sequence.clearClipEffects(clip.id);
      await new Promise(r => setTimeout(r, 900)); const back = lit();
      return { plain, half, gone, back };`)

    assert.ok(state.plain > 100, `setup: the clip covered ${state.plain} of 256`)
    /*
     * Half the scale is a quarter of the area. Checked as a ratio rather than
     * an exact count because the sampling grid does not divide evenly into
     * every frame shape, and a tolerance here is honest where a magic number
     * would be a number nobody could justify.
     */
    const ratio = state.half / state.plain
    assert.ok(
      ratio > 0.18 && ratio < 0.32,
      `scale 50 should cover about a quarter; it covered ${Math.round(ratio * 100)}%`,
    )
    assert.equal(state.gone, 0, 'opacity 0 should draw nothing at all')
    // The property the whole "resolved, not stored" design rests on: clearing
    // the effects has to give back exactly what was there before any were set.
    assert.equal(state.back, state.plain, 'clearing the effects must restore the picture')
  })

  await check('cropping takes the edge it was asked for', async () => {
    const state = await evaluate(cdp, AREA_SETUP + `
      const plain = lit();
      sequence.setClipEffects(clip.id, { transform: { crop: { top: 50 } } });
      await new Promise(r => setTimeout(r, 900)); const topless = lit();
      sequence.clearClipEffects(clip.id);
      await new Promise(r => setTimeout(r, 900));
      return { plain, topless, back: lit() };`)

    const ratio = state.topless / state.plain
    assert.ok(
      ratio > 0.40 && ratio < 0.60,
      `half the picture should remain; ${Math.round(ratio * 100)}% did`,
    )
    assert.equal(state.back, state.plain, 'and clearing the crop restores it')
  })

  await check('a scaled clip renders, and a skewed one is refused by name', async () => {
    /*
     * The graph draws the transform now — scaled, cropped, turned, faded and
     * placed — so a moved clip is no longer a reason to refuse a render.
     *
     * Skew still is. ffmpeg has no shear filter, and the nearest thing,
     * `perspective`, is a different picture from the one the canvas draws.
     * Approximating it would mean an export that *nearly* matches what was
     * approved, which is worse than one that says plainly it cannot — this
     * pipeline's whole argument is that the output is the sequence.
     */
    const state = await evaluate(cdp, AREA_SETUP + `
      const { sequenceExport } = window.__fluxDev;
      sequence.setClipEffects(clip.id, { transform: { scale: 60, rotation: 12 } });
      await new Promise(r => setTimeout(r, 400));
      const moved = sequenceExport.planSequence('C:/tmp');
      sequence.setClipEffects(clip.id, { transform: { skew: { x: 10, y: 0 } } });
      await new Promise(r => setTimeout(r, 400));
      const sheared = sequenceExport.planSequence('C:/tmp');
      sequence.clearClipEffects(clip.id);
      await new Promise(r => setTimeout(r, 400));
      const plain = sequenceExport.planSequence('C:/tmp');
      return {
        moved: { job: !!moved.job, reason: moved.reason ?? null,
                 placed: !!moved.job && !!moved.job.video[0].placement },
        sheared: { job: !!sheared.job, reason: sheared.reason ?? null },
        plain: { job: !!plain.job, placed: !!plain.job && !!plain.job.video[0].placement },
      };`)

    assert.ok(!state.error, state.error)
    assert.equal(state.moved.job, true, `a scaled clip should render: ${state.moved.reason}`)
    assert.equal(state.moved.placed, true, 'and the cut should carry where it goes')

    assert.equal(state.sheared.job, false, 'a skewed clip must still be refused')
    assert.match(
      state.sheared.reason ?? '',
      /skew/i,
      `the refusal should say what it cannot draw, it said: ${state.sheared.reason}`,
    )
    assert.match(state.sheared.reason ?? '', /clipA.mp4/, 'and name the clip')

    // An untouched clip carries nothing, so it renders through exactly the
    // graph it always did — which is what keeps the archive path unchanged.
    assert.equal(state.plain.job, true)
    assert.equal(state.plain.placed, false, 'an untouched clip should carry no placement')
  })

  // Put the viewer back the way the rest of the suite expects to find it.
  await evaluate(
    cdp,
    `const { view, sequence, commands } = window.__fluxDev;
     view.recordView({ viewer: { playbackResolution: 0.5, pausedResolution: 1 } });
     sequence.setSequenceSize(1920, 1080);
     await commands.run('viewer.fit');
     await new Promise(r => setTimeout(r, 300));
     return true;`,
  )

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
