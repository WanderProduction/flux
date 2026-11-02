/**
 * Stills on the timeline, and the two ends of a sequence.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-still-layers.mjs
 *
 * A still is the first clip in FLUX whose source has no end, and that single
 * fact is what every check here is about. Footage is bounded by its file: a
 * tail cannot be pulled past the last frame, and the whole trim arithmetic is
 * built on `sourceDuration`. One picture has nothing to run out of, so it can
 * be held for a frame or for an hour — which means the only things that may
 * stop an edge are the neighbour, one frame, and the end of what a sequence is
 * allowed to be.
 *
 * So the sequence ceiling is checked here too, in the same run, deliberately.
 * The two features arrived together because they are the same question asked
 * from both sides: without a ceiling, an edge that no file bounds is an edge
 * with no bound at all.
 *
 * What is measured rather than asserted from memory:
 *
 *   - **the browser's own layout limit.** `MAX_ELEMENT_PX` in the Timeline
 *     panel is a number taken from the engine, and a constant nobody checks is
 *     a constant that quietly stops being true. It is read back from a real
 *     element here, because the failure it guards against is silent: an
 *     element given more width than the engine allows does not error, it is
 *     simply laid out at a different width than the ruler beside it.
 *   - **that a still is actually composited.** Not "a clip exists" — that the
 *     canvas reports a layer drawn with the playhead over it, and two layers
 *     with footage underneath. A still that lands on the timeline and draws
 *     nothing is the bug this feature would otherwise ship with.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'
import { sequenceArgs } from '../shared/sequenceGraph.js'
import { MAX_SEQUENCE_SECONDS, makeSettings } from '../shared/sequenceFormat.js'

const MEDIA = path.join(os.homedir(), 'flux-media-test')
const STILL = path.join(MEDIA, 'still.jpg')
const FOOTAGE = path.join(MEDIA, 'clipA.mp4')
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

/** The limit the Timeline panel claims. Read back from the engine below. */
const CLAIMED_ELEMENT_PX = 33_554_428

const { check, report } = createChecker()

/*
 * The graph and the settings are plain modules, so they are checked without
 * the app. Worth doing first: if `-loop 1` is not in the arguments then
 * nothing the app does with a still matters, and a failure here is a one-line
 * repro rather than a story about a browser.
 */
await check('the render graph loops a still instead of reading a stream', async () => {
  const job = {
    kind: 'sequence',
    id: 'j1',
    name: 'stills',
    output: 'C:\\out\\stills.mp4',
    width: 1920,
    height: 1080,
    frameRate: 30,
    duration: 12,
    video: [
      { id: 'c1', source: STILL, start: 0, duration: 7, offset: 0, speed: 1, still: true },
      { id: 'c2', source: FOOTAGE, start: 7, duration: 5, offset: 2, speed: 1 },
    ],
    audio: [],
    sourceBytes: 0,
  }

  const { args } = sequenceArgs(job)
  const text = args.join(' ')

  // The still's input, as one piece: loop, the sequence's rate, its length.
  assert.ok(
    text.includes(`-loop 1 -framerate 30.000000 -t 7.000000 -i ${STILL}`),
    `the still is not looped — its input reads:\n       ${text}`,
  )
  /*
   * No seek on the still. A still's offset is meaningless, and `-ss` into a
   * looped single image produces an input with nothing in it — so this is the
   * check that a still is not quietly treated as a very short video.
   */
  const stillInput = text.slice(0, text.indexOf(`-i ${STILL}`))
  assert.ok(!stillInput.includes('-ss'), 'the still is being seeked into')

  // And the footage beside it is untouched: a still must not change what a
  // sequence of ordinary clips renders as.
  assert.ok(
    text.includes(`-ss 2.000000 -t 5.000000 -i ${FOOTAGE}`),
    'the footage input changed shape',
  )
  assert.ok(!text.includes(`-loop 1 -framerate 30.000000 -t 5.000000 -i ${FOOTAGE}`), 'footage looped')
})

await check('a pinned duration cannot exceed the ceiling, whatever a file says', async () => {
  // A file written by a hand, or by a build that had a larger limit.
  const settings = makeSettings({ duration: 600 * 3600 })
  assert.equal(settings.duration, MAX_SEQUENCE_SECONDS)
  // And an ordinary one is left exactly alone.
  assert.equal(makeSettings({ duration: 90 }).duration, 90)
  assert.equal(makeSettings({}).duration, 0, 'zero still means "follow the clips"')
})

/**
 * The same sequence rendered twice, once with the still and once with a gap
 * where it was, differenced over the footage they share.
 *
 * This check exists because of how nearly it became a bug report. Rendered
 * through the real encoder, the footage *after* the still read about nine luma
 * units brighter than the same footage with a gap in front of it — which looks
 * exactly like the one thing a looped input is expected to get wrong: the
 * still's last frame repeating under the clip above it and showing through its
 * transparent padding. `overlay` really does repeat the last frame of a stream
 * that has run out, and this project has already been bitten by that in
 * `ffmpeg compare needs shortest=1`.
 *
 * It was the encoder. The two files have different content before the footage,
 * so the rate control arrives at it with a different history, and CQ 26 is not
 * bit-exact. Written losslessly the difference is **zero, on every pixel of
 * every shared frame** — which is the only form of this check worth having,
 * and the reason it is written down rather than remembered.
 */
await check('a still changes nothing about the footage after it', async () => {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.log('       skipped: no ffmpeg on PATH')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-stills-'))
  const render = (name, video) => {
    const out = path.join(dir, `${name}.mkv`)
    const { args, graph } = sequenceArgs({
      kind: 'sequence',
      id: name,
      name,
      output: path.join(dir, `${name}.mp4`),
      width: 1280,
      height: 720,
      frameRate: 30,
      duration: 9,
      video,
      audio: [],
      sourceBytes: 0,
    })
    const scriptAt = args.indexOf('-filter_complex_script')
    fs.writeFileSync(args[scriptAt + 1], graph)
    // The graph as built, with a bit-exact encode in place of the measured one.
    const run = spawnSync(
      'ffmpeg',
      [
        ...args.slice(0, scriptAt + 2),
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-c:v',
        'ffv1',
        '-pix_fmt',
        'yuv420p10le',
        '-c:a',
        'pcm_s16le',
        '-t',
        '9',
        '-y',
        out,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(run.status, 0, `${name} failed to render:\n${run.stderr.split('\n').slice(-8).join('\n')}`)
    return out
  }

  const footage = { id: 'c2', source: FOOTAGE, start: 4, duration: 5, offset: 0, speed: 1 }
  const withStill = render('with-still', [
    { id: 'c1', source: STILL, start: 0, duration: 4, offset: 0, speed: 1, still: true },
    footage,
  ])
  const withGap = render('with-gap', [footage])

  const diff = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'info',
      '-ss',
      '4',
      '-i',
      withStill,
      '-ss',
      '4',
      '-i',
      withGap,
      '-filter_complex',
      // `shortest=1`, because framesync otherwise repeats the last frame of
      // whichever input ends first and invents a difference at the tail.
      '[0:v][1:v]blend=all_mode=difference:shortest=1,signalstats,' +
        'metadata=print:key=lavfi.signalstats.YMAX',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  )
  const maxima = [...(diff.stderr + diff.stdout).matchAll(/YMAX=([\d.]+)/g)].map((m) => Number(m[1]))
  fs.rmSync(dir, { recursive: true, force: true })

  assert.ok(maxima.length > 100, `only ${maxima.length} frames compared — the renders are too short`)
  const worst = Math.max(...maxima)
  console.log(`       ${maxima.length} shared frames, largest pixel difference ${worst}`)
  assert.equal(worst, 0, `the still alters the footage after it by up to ${worst} luma`)
})

const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  await check('the browser lays out an element as wide as MAX_ELEMENT_PX claims', async () => {
    const result = await evaluate(
      cdp,
      `const probe = document.createElement('div');
       probe.style.position = 'absolute';
       probe.style.left = '0px';
       probe.style.top = '0px';
       probe.style.height = '1px';
       document.body.appendChild(probe);

       const widthAt = (px) => {
         probe.style.width = px + 'px';
         return probe.getBoundingClientRect().width;
       };

       const claimed = widthAt(${CLAIMED_ELEMENT_PX});
       const over = widthAt(${CLAIMED_ELEMENT_PX} * 4);
       probe.remove();
       return { claimed, over };`,
    )

    console.log(
      `       asked for ${CLAIMED_ELEMENT_PX.toLocaleString()}px, got ` +
        `${Math.round(result.claimed).toLocaleString()}px; asked for 4x, got ` +
        `${Math.round(result.over).toLocaleString()}px`,
    )
    assert.equal(
      Math.round(result.claimed),
      CLAIMED_ELEMENT_PX,
      'the engine will not lay out the width MAX_ELEMENT_PX claims it will',
    )
    assert.ok(
      result.over < CLAIMED_ELEMENT_PX * 4,
      'the engine laid out four times the claimed limit, so the limit is not where we think',
    )
  })

  await check('an image lands on the timeline as a still', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence, assets, importPipeline } = window.__fluxDev;
       const added = await importPipeline.importFiles(
         [{ path: ${JSON.stringify(STILL)}, kind: 'image' }], 'link');
       const asset = added[0] ?? assets.getAssets().find(a => a.path === ${JSON.stringify(STILL)});
       const probed = await assets.ensureProbed(asset.id);

       sequence.clearSequence();
       const lane = sequence.getSequence().tracks.slice().reverse().find(t => t.kind === 'video');
       const clip = sequence.addClip({
         assetId: asset.id, trackId: lane.id, start: 0,
         duration: probed.duration, still: true,
       });

       return {
         assetKind: asset.kind,
         assetDuration: probed.duration,
         still: clip?.still ?? null,
         duration: clip?.duration ?? null,
         width: probed.width, height: probed.height,
       };`,
    )

    console.log(
      `       ${result.width}x${result.height} image, ${result.assetDuration}s by default`,
    )
    assert.equal(result.assetKind, 'image')
    assert.equal(result.still, true, 'the clip does not know it is a still')
    assert.ok(result.duration > 0, 'the still landed with no length')
  })

  await check('dragging an image onto a lane drops it as a still', async () => {
    /*
     * The real drop path, driven by a real drop event.
     *
     * Every other check here calls `addClip` with `still: true`, which proves
     * the sequence can hold a still and proves nothing about how one gets
     * there. The route a hand actually takes is the Content Browser's drag and
     * the lane's `onDrop`, and that route has its own decisions in it: whether
     * the asset is asked about its soundtrack (a JPEG has none to read, and
     * asking got back "FLUX cannot read this file's audio yet"), whether the
     * clip is marked as a still at all, and what length a dropped picture
     * gets. A synthesised DataTransfer carrying the asset drag type is what
     * the Content Browser puts on the pointer, so this is that gesture with
     * the pointer left out.
     */
    const result = await evaluate(
      cdp,
      `const { sequence, assets, commands } = window.__fluxDev;
       const picture = assets.getAssets().find(a => a.path === ${JSON.stringify(STILL)});

       sequence.clearSequence();
       await commands.run('panel.focus.timeline');
       await new Promise(r => setTimeout(r, 200));

       const lanes = [...document.querySelectorAll('.tl-lane--video')];
       const lane = lanes[lanes.length - 1];
       if (!lane) return { noLane: true };
       const box = lane.getBoundingClientRect();

       const data = new DataTransfer();
       data.setData('application/x-flux-assets', JSON.stringify([picture.id]));

       const at = { clientX: Math.round(box.left + 8), clientY: Math.round(box.top + box.height / 2) };
       for (const type of ['dragover', 'drop']) {
         lane.dispatchEvent(new DragEvent(type, {
           bubbles: true, cancelable: true, dataTransfer: data, ...at,
         }));
       }
       // The drop probes the asset before it places anything.
       await new Promise(r => setTimeout(r, 1500));

       const clips = sequence.getSequence().clips;
       const notice = document.querySelector('.tl-notice, .timeline-notice');
       return {
         clips: clips.map(c => ({
           still: !!c.still,
           duration: Math.round(c.duration * 1000) / 1000,
           offset: c.offset,
           kind: c.kind,
         })),
         notice: notice ? notice.textContent : null,
       };`,
    )

    assert.ok(!result.noLane, 'there is no video lane to drop onto')
    console.log(
      `       dropped: ${JSON.stringify(result.clips)}` +
        (result.notice ? ` · notice "${result.notice}"` : ' · no notice'),
    )
    assert.equal(result.clips.length, 1, 'a dropped image did not become exactly one clip')
    assert.equal(result.clips[0].still, true, 'a dropped image is not marked as a still')
    assert.equal(result.clips[0].kind, 'video', 'a dropped image did not land on a video track')
    assert.ok(result.clips[0].duration > 0, 'a dropped image landed with no length')
    /*
     * And nothing is said about its sound. A picture has no soundtrack, and
     * the notice line is where a complaint about one would appear — "FLUX
     * cannot read this file's audio yet" is what a JPEG used to produce there.
     */
    assert.ok(
      !result.notice || !/audio|soundtrack/i.test(result.notice),
      `the drop complained about a picture's sound: "${result.notice}"`,
    )
  })

  await check('a still stretches far past the length its asset claims', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const clip = sequence.getSequence().clips[0];
       const before = clip.duration;
       const sourceSays = clip.sourceDuration;

       // Ten minutes, from a clip whose asset claims five seconds.
       const asked = 600;
       const allowed = sequence.allowedTrim([clip.id], 'end', asked);
       sequence.trimClips([clip.id], 'end', asked);
       const after = sequence.getSequence().clips.find(c => c.id === clip.id);

       return {
         before, sourceSays, asked, allowed,
         duration: after.duration,
         offset: after.offset,
       };`,
    )

    console.log(
      `       ${result.before.toFixed(2)}s of a source that claims ` +
        `${result.sourceSays.toFixed(2)}s, pulled out to ${result.duration.toFixed(2)}s`,
    )
    assert.ok(
      Math.abs(result.allowed - result.asked) < 0.05,
      `the tail stopped at ${result.allowed.toFixed(3)}s of the ${result.asked}s asked for — ` +
        `a still is being bounded by its file`,
    )
    assert.ok(
      result.duration > result.sourceSays * 10,
      `the still is ${result.duration.toFixed(2)}s, still inside its claimed ` +
        `${result.sourceSays.toFixed(2)}s`,
    )
    assert.equal(result.offset, 0, 'a still should have no in point')
  })

  await check('a still trims to exactly one frame, and no further', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const clip = sequence.getSequence().clips[0];
       const rate = sequence.getSequence().settings.frameRate;
       const frame = 1 / rate;

       // Far more than its length, from the tail: it must stop at one frame.
       sequence.trimClips([clip.id], 'end', -10000);
       const short = sequence.getSequence().clips.find(c => c.id === clip.id);

       // And then refuse to go further.
       const further = sequence.allowedTrim([clip.id], 'end', -frame);

       return {
         rate, frame,
         duration: short.duration,
         frames: Math.round(short.duration * rate),
         further,
       };`,
    )

    console.log(
      `       trimmed to ${result.frames} frame at ${result.rate}fps ` +
        `(${result.duration.toFixed(5)}s)`,
    )
    assert.equal(result.frames, 1, 'a still did not stop at one frame')
    assert.equal(result.further, 0, 'a one-frame still can still be trimmed shorter')
  })

  await check('a still cannot be stretched, because it has no rate', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const clip = sequence.getSequence().clips[0];
       const allowed = sequence.allowedStretch([clip.id], 'end', 30);
       const changed = sequence.stretchClips([clip.id], 'end', 30);
       const after = sequence.getSequence().clips.find(c => c.id === clip.id);
       return { allowed, changed, speed: after.speed };`,
    )
    assert.equal(result.allowed, 0, 'a still offered a stretch')
    assert.equal(result.changed, false, 'a still was stretched')
    assert.equal(result.speed, 1, 'a still ended up with a rate')
  })

  await check('the still is composited, over footage and on its own', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence, assets, importPipeline, playback, commands } = window.__fluxDev;

       const added = await importPipeline.importFiles(
         [{ path: ${JSON.stringify(FOOTAGE)}, kind: 'video' }], 'link');
       const footage = added[0]
         ?? assets.getAssets().find(a => a.path === ${JSON.stringify(FOOTAGE)});
       await assets.ensureProbed(footage.id);
       const picture = assets.getAssets().find(a => a.path === ${JSON.stringify(STILL)});

       sequence.clearSequence();
       const video = sequence.getSequence().tracks.filter(t => t.kind === 'video');
       const lower = video[video.length - 1];
       const upper = video.length > 1 ? video[0] : sequence.addTrack('video');

       // Footage along the bottom, a still over the first half of it.
       sequence.addClip({ assetId: footage.id, trackId: lower.id, start: 0, duration: 6 });
       sequence.addClip({
         assetId: picture.id, trackId: upper.id, start: 0, duration: 3, still: true,
       });

       const read = async (at) => {
         playback.seek(at);
         // Opening a source and drawing it are separate effects; this is the
         // same beat verify-playback waits for a cut.
         await new Promise(r => setTimeout(r, 1200));
         const canvas = document.querySelector('canvas.viewer-media');
         if (!canvas) return { layers: 0, shown: false };
         return {
           layers: Number(canvas.dataset.layers ?? 0),
           shown: getComputedStyle(canvas).display !== 'none',
           frameTime: canvas.dataset.frameTime ?? null,
         };
       };

       await commands.run('panel.focus.timeline');
       const both = await read(1.5);
       const footageOnly = await read(4.5);

       // And a still with nothing under it at all.
       sequence.clearSequence();
       sequence.addClip({
         assetId: picture.id, trackId: lower.id, start: 0, duration: 4, still: true,
       });
       const alone = await read(2);

       return { both, footageOnly, alone };`,
    )

    console.log(
      `       still over footage: ${result.both.layers} layers · footage alone: ` +
        `${result.footageOnly.layers} · still alone: ${result.alone.layers}`,
    )
    assert.ok(
      result.alone.shown,
      'a sequence of nothing but a still fell back to the element path — the pipeline refused it',
    )
    assert.equal(result.alone.layers, 1, 'a still on its own drew nothing')
    assert.equal(result.both.layers, 2, 'a still over footage did not composite both')
    assert.equal(result.footageOnly.layers, 1, 'the footage alone drew the wrong number of layers')
  })

  await check('what is on the canvas is the picture in the file', async () => {
    /*
     * The check above counts layers, which a blank layer would also satisfy.
     * This one compares the composite against the file: the image decoded
     * independently and drawn into a canvas of the same size with the same
     * contain-and-centre fit, then both sampled on a grid. A still drawn at
     * the wrong size, squashed to the frame, or not drawn at all moves these
     * means by tens; the agreement measured is under a tenth of one level.
     */
    const result = await evaluate(
      cdp,
      `const { sequence, assets, playback, commands } = window.__fluxDev;
       const picture = assets.getAssets().find(a => a.path === ${JSON.stringify(STILL)});

       sequence.clearSequence();
       const lane = sequence.getSequence().tracks.slice().reverse().find(t => t.kind === 'video');
       sequence.addClip({
         assetId: picture.id, trackId: lane.id, start: 0, duration: 6, still: true,
       });
       await commands.run('panel.focus.timeline');
       playback.seek(3);
       await new Promise(r => setTimeout(r, 1500));

       // A grid rather than a pixel: one sample cannot be told from noise.
       const meanOf = (ctx, w, h) => {
         const step = 16;
         let r = 0, g = 0, b = 0, n = 0;
         for (let y = Math.floor(h / step / 2); y < h; y += Math.floor(h / step)) {
           for (let x = Math.floor(w / step / 2); x < w; x += Math.floor(w / step)) {
             const px = ctx.getImageData(x, y, 1, 1).data;
             r += px[0]; g += px[1]; b += px[2]; n++;
           }
         }
         return { r: r / n, g: g / n, b: b / n, samples: n };
       };

       const canvas = document.querySelector('canvas.viewer-media');
       if (!canvas) return { missing: true };
       const onScreen = meanOf(canvas.getContext('2d'), canvas.width, canvas.height);

       const img = new Image();
       img.src = window.flux.fs.assetUrl(${JSON.stringify(STILL)});
       await img.decode();
       const ref = document.createElement('canvas');
       ref.width = canvas.width;
       ref.height = canvas.height;
       const rc = ref.getContext('2d');
       rc.fillStyle = '#000';
       rc.fillRect(0, 0, ref.width, ref.height);
       const fit = Math.min(ref.width / img.width, ref.height / img.height);
       const dw = img.width * fit, dh = img.height * fit;
       rc.drawImage(img, (ref.width - dw) / 2, (ref.height - dh) / 2, dw, dh);
       const expected = meanOf(rc, ref.width, ref.height);

       return {
         size: [canvas.width, canvas.height],
         samples: onScreen.samples,
         worst: Math.max(
           Math.abs(onScreen.r - expected.r),
           Math.abs(onScreen.g - expected.g),
           Math.abs(onScreen.b - expected.b),
         ),
         onScreen, expected,
       };`,
    )

    assert.ok(!result.missing, 'there is no composite canvas to read')
    console.log(
      `       ${result.size[0]}x${result.size[1]} composite, ${result.samples} samples, ` +
        `worst channel off by ${result.worst.toFixed(3)} of 255`,
    )
    assert.ok(
      result.worst < 2,
      `the composite differs from the file by ${result.worst.toFixed(2)} levels — ` +
        `drawn at ${JSON.stringify(result.onScreen)} against ${JSON.stringify(result.expected)}`,
    )
  })

  await check('nothing can be placed, moved or trimmed past the ceiling', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence, assets } = window.__fluxDev;
       const LIMIT = ${MAX_SEQUENCE_SECONDS};
       const picture = assets.getAssets().find(a => a.path === ${JSON.stringify(STILL)});

       sequence.clearSequence();
       const lane = sequence.getSequence().tracks.slice().reverse().find(t => t.kind === 'video');

       // Laying one down past the end.
       const past = sequence.addClip({
         assetId: picture.id, trackId: lane.id, start: LIMIT + 60, duration: 5, still: true,
       });

       // One that straddles it.
       const straddles = sequence.addClip({
         assetId: picture.id, trackId: lane.id, start: LIMIT - 2, duration: 5, still: true,
       });

       // A clip near the end, then every way of pushing it over.
       const clip = sequence.addClip({
         assetId: picture.id, trackId: lane.id, start: LIMIT - 60, duration: 30, still: true,
       });

       const trimAllowed = sequence.allowedTrim([clip.id], 'end', 3600);
       sequence.trimClips([clip.id], 'end', 3600);
       const trimmed = sequence.getSequence().clips.find(c => c.id === clip.id);

       sequence.moveClips([clip.id], 3600, 0);
       const moved = sequence.getSequence().clips.find(c => c.id === clip.id);

       // And a paste, which writes its clips without going through addClip.
       sequence.copyClips([clip.id]);
       const pasted = sequence.pasteClips(LIMIT - 1);

       const ends = sequence.getSequence().clips.map(c => c.start + c.duration);
       return {
         limit: LIMIT,
         placedPast: past !== null,
         placedStraddling: straddles !== null,
         trimAllowed,
         trimmedEnd: trimmed.start + trimmed.duration,
         movedEnd: moved.start + moved.duration,
         pasted: pasted.length,
         furthest: Math.max(...ends),
         clips: sequence.getSequence().clips.length,
       };`,
    )

    console.log(
      `       ceiling ${(result.limit / 3600).toFixed(0)}h · furthest clip ends at ` +
        `${(result.furthest / 3600).toFixed(4)}h · trim offered ` +
        `${result.trimAllowed.toFixed(1)}s of the 3600s asked`,
    )
    assert.equal(result.placedPast, false, 'a clip was laid down past the ceiling')
    assert.equal(result.placedStraddling, false, 'a clip was laid down straddling the ceiling')
    assert.ok(
      result.trimmedEnd <= result.limit + 1e-6,
      `a trim carried a clip to ${result.trimmedEnd}s, past the ${result.limit}s ceiling`,
    )
    assert.ok(
      result.movedEnd <= result.limit + 1e-6,
      `a move carried a clip to ${result.movedEnd}s, past the ceiling`,
    )
    assert.equal(result.pasted, 0, 'a paste landed clips past the ceiling')
    assert.ok(
      result.furthest <= result.limit + 1e-6,
      `something reaches ${result.furthest}s, past the ${result.limit}s ceiling`,
    )
  })

  await check('a sequence at the ceiling can still be laid out at every zoom', async () => {
    const result = await evaluate(
      cdp,
      `const { sequence, commands } = window.__fluxDev;
       // Pinned rather than built out of clips: the question is what the
       // panel does with a length, not how the length got there.
       sequence.updateSequenceSettings({ duration: ${MAX_SEQUENCE_SECONDS} });
       await new Promise(r => setTimeout(r, 300));

       // All the way in, further than the wheel could reasonably be pushed.
       for (let i = 0; i < 60; i++) await commands.run('timeline.zoomIn');
       await new Promise(r => setTimeout(r, 500));

       const content = document.querySelector('.tl-content');
       const asked = content ? parseFloat(content.style.width) : 0;
       const got = content ? content.getBoundingClientRect().width : 0;

       sequence.updateSequenceSettings({ duration: 0 });
       return { asked, got };`,
    )

    /*
     * The shortfall, in seconds of timeline rather than in pixels.
     *
     * At thirty-three million pixels the engine does not lay out exactly what
     * it is asked for — measured, 16px short of 33,218,900 — because its
     * layout arithmetic is fixed-point and this is near the top of its range.
     * Pixels are the wrong unit to judge that in. What a shortfall *means* is
     * how much of the end of the sequence falls outside the scrollable box,
     * and 16px at this zoom is 0.17 seconds of a hundred hours. So the
     * tolerance is one second: under that there is nothing anybody could act
     * on, and over it the end of the sequence is genuinely out of reach.
     */
    const zoom = result.asked / (MAX_SEQUENCE_SECONDS + 4)
    const shortBy = (result.asked - result.got) / zoom

    console.log(
      `       100h fully zoomed in: asked ${Math.round(result.asked).toLocaleString()}px, ` +
        `laid out ${Math.round(result.got).toLocaleString()}px ` +
        `(${zoom.toFixed(1)}px/s, ${shortBy >= 0 ? 'short by' : 'over by'} ` +
        `${Math.abs(shortBy).toFixed(2)}s)`,
    )
    assert.ok(result.asked > 0, 'the timeline content has no width at all')
    assert.ok(
      result.asked <= CLAIMED_ELEMENT_PX,
      `the timeline asked for ${Math.round(result.asked)}px, past the engine's limit — ` +
        `the zoom ceiling is not holding`,
    )
    /*
     * Not "the same width" — *not meaningfully narrower*. Everything inside
     * the content is positioned absolutely, so a box that grew for a child
     * reaching past the end is harmless; a box the engine truncated is not,
     * because then the last clip and the end marker sit outside it. Only the
     * narrow direction matters, and only past the point where it costs
     * somebody a second of their sequence.
     */
    assert.ok(
      shortBy < 1,
      `the content was laid out ${shortBy.toFixed(2)}s short of what the panel asked for — ` +
        `the end of the sequence is outside the scrollable box`,
    )
    assert.ok(
      result.got <= CLAIMED_ELEMENT_PX,
      `the content was laid out at ${Math.round(result.got)}px, past the engine's own limit`,
    )
    assert.ok(
      result.asked < CLAIMED_ELEMENT_PX,
      `the content asked for ${Math.round(result.asked)}px, which is the clamp itself — ` +
        `the reserve in tightestUseful is not doing its job`,
    )
  })
} finally {
  report()
  cdp.close()
}
