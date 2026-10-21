/**
 * Verifies the sequence render — the whole timeline as one composited file.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-sequence-render.mjs <folder>
 *
 * The per-clip render is checked by verify-render.mjs and verify-render-queue.mjs
 * and most of what it does is visible: a file appears or it does not. A
 * *composite* is the opposite. Everything that can go wrong with one produces a
 * file that opens, plays and looks plausible:
 *
 *   - a gap that shortened the file instead of being black
 *   - a layer drawn behind the one it should be in front of
 *   - a rotated source composited on its side, or scaled before being turned
 *   - a mixdown that is half as loud because amix normalised it
 *   - a mute that was honoured on playback and ignored by the render
 *
 * So this harness does not ask ffmpeg whether it was happy. It reads the output
 * back: pixel luma at chosen moments, measured loudness, counted frames.
 *
 * And it includes a canary. A deliberately truncated encode and a
 * deliberately-wrong-sized one are both put through the real verifier and both
 * must be rejected — because a verifier that only ever sees correct output is
 * indistinguishable from no verifier at all.
 *
 * CLEARS the verification project's assets, sequences and render queue.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'
import { findTools } from '../electron/render.js'
import { verifySequence, sequenceAlreadyDone } from '../electron/renderSequence.js'

const run = promisify(execFile)

const FOLDER = process.argv[2]
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

if (!FOLDER) {
  console.error('  usage: node scripts/verify-sequence-render.mjs <folder>')
  process.exit(2)
}

const tools = await findTools()
if (!tools.ok) {
  console.error(`  FAIL ${tools.error}`)
  process.exit(1)
}
console.log(`  ${tools.version}`)

const { check, report } = createChecker()
const cdp = await attach()
const OUT = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-seq-'))

/**
 * 10-bit limited-range black.
 *
 * 16 is black in 8-bit video levels and the output is `yuv420p10le`, so every
 * value is shifted up two bits: 16 << 2. A gap measuring exactly this is black
 * because nothing was drawn there, not because the picture happened to be dark.
 */
const BLACK_Y = 64

/** How far from BLACK_Y still counts as black. Generous: this is a 1-in-4 test. */
const BLACK_SLACK = 3

// ── reading the output back ───────────────────────────────────────

/**
 * Average luma of a region of one frame, at one moment, on a 10-bit scale.
 *
 * `signalstats` is asked rather than a pixel being read, because an average
 * over a whole strip cannot be fooled by one stray macroblock and needs no
 * decoding on this side. The crop is `w:h:x:y`.
 *
 * `format=yuv420p10le` first, and it is not decoration. `signalstats` reports
 * in the pixel format's own range, so the same picture reads 110 out of an
 * 8-bit h264 source and 442 out of the 10-bit composite made from it — four
 * times the number, for the two extra bits. Comparing a source reading with an
 * output reading without this says the layers were drawn in the wrong order,
 * convincingly, when they were not. Everything here is therefore measured on
 * one scale, on which black is 64.
 */
async function luma(file, at, crop) {
  const filters = [
    ...(crop ? [`crop=${crop}`] : []),
    'format=yuv420p10le',
    'signalstats',
    'metadata=print:file=-',
  ]
  const { stderr, stdout } = await run(
    tools.ffmpeg,
    ['-hide_banner', '-v', 'error', '-ss', String(at), '-i', file,
     '-frames:v', '1', '-vf', filters.join(','), '-f', 'null', '-'],
    { maxBuffer: 8 << 20 },
  )
  const found = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stdout + stderr)
  if (!found) throw new Error(`no luma reading from ${path.basename(file)} at ${at}s`)
  return Number(found[1])
}

/**
 * Mean and peak loudness of a span, in dBFS.
 *
 * `volumedetect` rather than the peaks the waveform uses, for the same reason
 * the frame count is counted rather than read: this is what came out of the
 * encoder, measured from the file, not what something upstream believed.
 */
async function volume(file, at = null, length = null) {
  const args = ['-hide_banner', '-v', 'info', '-nostdin']
  if (at !== null) args.push('-ss', String(at))
  if (length !== null) args.push('-t', String(length))
  args.push('-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-')
  const { stderr } = await run(tools.ffmpeg, args, { maxBuffer: 8 << 20 })
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  return {
    mean: mean ? Number(mean[1]) : -Infinity,
    peak: peak ? Number(peak[1]) : -Infinity,
  }
}

/** What a source file is, as the checks need to know it. */
async function facts(file) {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
     'stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration',
     '-print_format', 'json', '--', file],
    { maxBuffer: 8 << 20 },
  )
  const parsed = JSON.parse(stdout)
  const stream = parsed.streams[0]
  const spun = Number(
    (stream.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0,
  )
  const rotation = ((spun % 360) + 360) % 360
  const quarter = rotation === 90 || rotation === 270
  return {
    path: file,
    rotation,
    display: quarter
      ? { width: stream.height, height: stream.width }
      : { width: stream.width, height: stream.height },
    duration: Number(parsed.format.duration),
  }
}

// ── driving the app ──────────────────────────────────────────────

/**
 * Lays out a sequence from scratch, exactly as described.
 *
 * Built clip by clip rather than by importing a folder and editing it down,
 * because every check here is about a *shape* — a gap of a known length, a clip
 * on the track above another, a track at a known gain — and reaching those
 * shapes by razoring an imported batch would be several edits per check with
 * the shape as a side effect rather than as the request.
 *
 * `video` and `audio` are arrays of `{ asset, start, duration, offset, speed,
 * track }`, where `track` is 0 for the bottom-most and 1 for the one above it.
 */
function layout(spec) {
  return `
  const { assets, sequence, renderQueue } = window.__fluxDev;
  renderQueue.clear();
  const spec = ${JSON.stringify(spec)};
  const all = assets.getAssets();
  const held = sequence.getSequence();
  sequence.removeClips(held.clips.map(c => c.id));

  sequence.updateSequenceSettings({
    width: spec.width, height: spec.height,
    frameRate: spec.frameRate, duration: spec.duration ?? 0,
  });

  /* Enough tracks of each kind, made before anything is placed. addTrack puts a
     video track at the front of the list and an audio track at the back, which
     is the stacking order — so after this, video[0] is the TOP layer and the
     bottom-most is the last one. The spec counts from the bottom, like the
     compositor does, so the list is reversed to index it. */
  const wantVideo = Math.max(1, ...spec.video.map(c => (c.track ?? 0) + 1));
  const wantAudio = Math.max(1, ...spec.audio.map(c => (c.track ?? 0) + 1));
  const count = (kind) => sequence.getSequence().tracks.filter(t => t.kind === kind).length;
  while (count('video') < wantVideo) sequence.addTrack('video');
  while (count('audio') < wantAudio) sequence.addTrack('audio');

  const tracks = sequence.getSequence().tracks;
  const videoTracks = tracks.filter(t => t.kind === 'video').slice().reverse();
  const audioTracks = tracks.filter(t => t.kind === 'audio');

  const place = (lanes) => (c) => {
    const asset = all.find(a => a.path === c.asset);
    if (!asset) throw new Error('asset not imported: ' + c.asset);
    return sequence.addClip({
      assetId: asset.id,
      trackId: lanes[c.track ?? 0].id,
      start: c.start,
      duration: c.duration,
      offset: c.offset ?? 0,
      speed: c.speed ?? 1,
      sourceDuration: asset.duration ?? c.duration,
    });
  };
  const videoClips = spec.video.map(place(videoTracks));
  const audioClips = spec.audio.map(place(audioTracks));

  for (const [nth, change] of Object.entries(spec.audioTracks ?? {})) {
    const track = audioTracks[Number(nth)];
    if (change.gain !== undefined) sequence.setTrackGain(track.id, change.gain);
    if (change.muted !== undefined) sequence.setTrackMuted(track.id, change.muted);
    if (change.solo !== undefined) sequence.setTrackSolo(track.id, change.solo);
  }
  for (const [nth, change] of Object.entries(spec.videoTracks ?? {})) {
    const track = videoTracks[Number(nth)];
    if (change.hidden !== undefined) sequence.setTrackHidden(track.id, change.hidden);
  }
  if (spec.name) sequence.renameSequence(sequence.getSequence().id, spec.name);
  await new Promise(r => setTimeout(r, 150));
  `
}

/** Queues the active sequence as one file, renders it, and reports the row. */
const RENDER = `
  const row0 = window.__fluxDev.renderQueue;
  row0.clear();
  const added = row0.add('one-file');
  const result = await row0.start();
  const row = row0.getQueue()[0];
  return {
    added, result,
    status: row ? row.status : null,
    error: row ? row.error : null,
    output: row ? row.output : null,
    job: row ? { duration: row.duration, width: row.width, height: row.height,
                 frameRate: row.frameRate, video: row.video.length,
                 audio: row.audio.length, sourceBytes: row.sourceBytes } : null,
  };
`

/** Renders the laid-out sequence and fails loudly with ffmpeg's own words. */
async function render(spec) {
  const state = await evaluate(cdp, layout(spec) + RENDER)
  assert.ok(state.result.ok, `start refused: ${state.result.error}`)
  assert.equal(state.status, 'done', `the render ended as ${state.status}: ${state.error}`)
  return state
}

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  // ── three real files, imported once ────────────────────────────

  const sources = await evaluate(
    cdp,
    `const { batchImport, assets, renderSettings } = window.__fluxDev;
     const planned = await batchImport.planBatch(${JSON.stringify(FOLDER)});
     if (!planned.ok) throw new Error('planBatch: ' + planned.error);
     /* Three files, not the folder. The shapes these checks need are built by
        hand below; importing 130 clips to then delete them would cost minutes
        of probing for nothing. */
     await batchImport.runBatch({ ...planned.plan, files: planned.plan.files.slice(0, 3) });
     renderSettings.updateRenderSettings({
       mode: 'sequence',
       outDir: ${JSON.stringify(OUT)},
       /* Off for the whole run. Several checks render the same sequence again
          with one thing changed, and a resume would hand the second one the
          first one's file. The resume path has a check of its own at the end. */
       resume: false,
     });
     return assets.getAssets()
       .filter(a => a.kind === 'video')
       .map(a => ({ path: a.path, duration: a.duration, name: a.name }));`,
  )
  if (sources.length < 2) {
    console.error(`  FAIL ${FOLDER} yielded ${sources.length} readable clips; two are needed`)
    process.exit(1)
  }
  const probed = await Promise.all(sources.map((one) => facts(one.path)))
  const [A, B] = probed
  console.log(
    `  ${probed.length} sources: ` +
      probed
        .map((f) => `${path.basename(f.path)} ${f.display.width}x${f.display.height}` +
          (f.rotation ? ` rot${f.rotation}` : ''))
        .join(', '),
  )

  /** The sequence frame used wherever a clip is meant to fill it exactly. */
  const FILLS = { width: A.display.width, height: A.display.height, frameRate: 25 }

  // ── the plan ───────────────────────────────────────────────────

  await check('the plan is the sequence, not a list of clips', async () => {
    const state = await evaluate(
      cdp,
      layout({
        ...FILLS,
        duration: 8,
        name: 'Plan check',
        video: [
          { asset: A.path, start: 0, duration: 2 },
          { asset: B.path, start: 4, duration: 2 },
        ],
        audio: [
          { asset: A.path, start: 0, duration: 2 },
          { asset: B.path, start: 4, duration: 2 },
        ],
      }) +
        `const { sequenceExport, renderSettings } = window.__fluxDev;
         const plan = sequenceExport.planSequence(renderSettings.getRenderSettings().outDir);
         return {
           job: plan.job && {
             kind: plan.job.kind, id: plan.job.id, duration: plan.job.duration,
             width: plan.job.width, height: plan.job.height, frameRate: plan.job.frameRate,
             video: plan.job.video.length, audio: plan.job.audio.length,
             output: plan.job.output, sourceBytes: plan.job.sourceBytes,
           },
           skipped: plan.skipped.length,
         };`,
    )
    assert.ok(state.job, 'nothing was planned')
    assert.equal(state.job.kind, 'sequence')
    assert.equal(state.job.video, 2, 'the plan did not cover both video clips')
    assert.equal(state.job.audio, 2, 'the plan did not cover both audio clips')
    assert.equal(state.job.width, FILLS.width)
    assert.equal(state.job.height, FILLS.height)
    assert.equal(state.job.frameRate, FILLS.frameRate)
    /*
     * The pinned length, including the two seconds of nothing after the last
     * clip. This is the number that makes a gap a gap rather than a shorter
     * file, and the planner is where it is decided.
     */
    assert.equal(state.job.duration, 8, 'the plan ignored the sequence length')
    assert.ok(state.job.output.endsWith('.mp4'), 'the output is not an mp4')
    assert.ok(state.job.sourceBytes > 0, 'nothing was counted as read')
    assert.equal(state.skipped, 0, 'something was refused that should not have been')
  })

  await check('a hidden video track is not composited, and a silent one is not decoded', async () => {
    const state = await evaluate(
      cdp,
      layout({
        ...FILLS,
        duration: 4,
        video: [
          { asset: A.path, start: 0, duration: 2, track: 0 },
          { asset: B.path, start: 0, duration: 2, track: 1 },
        ],
        audio: [
          { asset: A.path, start: 0, duration: 2, track: 0 },
          { asset: B.path, start: 0, duration: 2, track: 1 },
        ],
      }) +
        // `layout` already destructured `sequence` and `assets` off the handle.
        `const { sequenceExport } = window.__fluxDev;
         const plan = () => sequenceExport.planSequence('/out').job;
         const open = plan();

         const lanes = sequence.getSequence().tracks;
         const topVideo = lanes.filter(t => t.kind === 'video')[0];
         const firstAudio = lanes.filter(t => t.kind === 'audio')[0];

         sequence.setTrackHidden(topVideo.id, true);
         const hidden = plan();
         sequence.setTrackHidden(topVideo.id, false);

         sequence.setTrackMuted(firstAudio.id, true);
         const muted = plan();
         sequence.setTrackMuted(firstAudio.id, false);

         /* Solo on the second audio track: the first should drop out even
            though nothing about it changed, which is the rule playback
            follows. */
         const secondAudio = lanes.filter(t => t.kind === 'audio')[1];
         sequence.setTrackSolo(secondAudio.id, true);
         const soloed = plan();
         sequence.setTrackSolo(secondAudio.id, false);

         return {
           open: { video: open.video.length, audio: open.audio.length },
           hidden: hidden.video.length,
           muted: muted.audio.length,
           soloed: soloed.audio.length,
         };`,
    )
    assert.deepEqual(state.open, { video: 2, audio: 2 }, 'setup: four clips expected')
    assert.equal(state.hidden, 1, 'a hidden video track was still composited')
    assert.equal(state.muted, 1, 'a muted audio track was still mixed in')
    assert.equal(state.soloed, 1, 'solo on one track did not drop the other')
  })

  // ── the render ─────────────────────────────────────────────────

  await check('a gap is black and silent, and does not shorten the file', async () => {
    /*
     * The failure this is here for: a renderer that laid the clips end to end
     * would produce a 4-second file of two clips butted together — correct
     * frame count for what it contains, nothing complaining, and a deliverable
     * two seconds short with the pause cut out of the middle of it.
     */
    const state = await render({
      ...FILLS,
      duration: 8,
      name: 'Gap check',
      video: [
        { asset: A.path, start: 0, duration: 2 },
        { asset: B.path, start: 4, duration: 2 },
      ],
      audio: [
        { asset: A.path, start: 0, duration: 2 },
        { asset: B.path, start: 4, duration: 2 },
      ],
    })

    const out = state.output
    const { stdout } = await run(
      tools.ffprobe,
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
       'stream=width,height,r_frame_rate,nb_read_frames,profile,pix_fmt:format=duration',
       '-print_format', 'json', '--', out],
      { maxBuffer: 8 << 20 },
    )
    const stream = JSON.parse(stdout).streams[0]
    const length = Number(JSON.parse(stdout).format.duration)

    assert.equal(stream.width, FILLS.width, 'the output is not the sequence frame')
    assert.equal(stream.height, FILLS.height, 'the output is not the sequence frame')
    assert.equal(stream.r_frame_rate, `${FILLS.frameRate}/1`)
    assert.equal(stream.profile, 'Main 10', 'the archive encode was not used')
    assert.equal(stream.pix_fmt, 'yuv420p10le', 'the composite lost its ten bits')
    assert.ok(Math.abs(length - 8) < 0.1, `the file is ${length}s, expected 8s`)
    assert.ok(
      Math.abs(stream.nb_read_frames - 8 * FILLS.frameRate) <= 2,
      `${stream.nb_read_frames} frames, expected ${8 * FILLS.frameRate}`,
    )

    // The middle gap, the trailing gap, and a moment that has a clip under it.
    const middle = await luma(out, 3)
    const trailing = await luma(out, 7)
    const content = await luma(out, 1)
    assert.ok(
      Math.abs(middle - BLACK_Y) <= BLACK_SLACK,
      `the gap at 3s reads ${middle}, expected black (${BLACK_Y})`,
    )
    assert.ok(
      Math.abs(trailing - BLACK_Y) <= BLACK_SLACK,
      `the tail at 7s reads ${trailing}, expected black (${BLACK_Y})`,
    )
    assert.ok(content > BLACK_Y + 10, `the clip at 1s reads ${content}, which is black`)

    const whole = await volume(out)
    const quiet = await volume(out, 2.3, 1.4)
    if (whole.peak < -30) {
      console.log('       (the sources are near-silent — the gap check cannot mean anything)')
    } else {
      assert.ok(
        quiet.peak < -45,
        `the silent gap peaks at ${quiet.peak}dB, expected silence`,
      )
    }
    console.log(
      `       8.00s, ${stream.nb_read_frames} frames, gap black at 3s and 7s, ` +
        `mix ${whole.mean}dB mean / gap ${quiet.peak}dB peak`,
    )
  })

  await check('a rotated source is composited upright, not on its side', async () => {
    /*
     * The trap the per-clip renderer already has a note about, in the one place
     * it bites hardest. A source coded 1920x1080 with `rotation: 90` is
     * displayed 1080x1920, and composited into a *landscape* frame it must
     * therefore sit in the middle with black down each side.
     *
     * If rotation were ignored, or applied after the scale, the 1920x1080 coded
     * frame would fill the landscape frame edge to edge and the side strips
     * would not be black. Two files in five in this library are like this.
     */
    const spun = probed.find((one) => one.rotation === 90 || one.rotation === 270)
    if (!spun) {
      console.log('       (no rotated source among the three — skipping)')
      return
    }
    assert.ok(
      spun.display.height > spun.display.width,
      'setup: the rotated source should be portrait once turned',
    )

    const state = await render({
      // Deliberately landscape, whatever the footage is.
      width: 1920,
      height: 1080,
      frameRate: 25,
      duration: 2,
      name: 'Rotation check',
      video: [{ asset: spun.path, start: 0, duration: 2 }],
      audio: [],
    })

    const out = state.output
    const left = await luma(out, 1, '40:1080:0:0')
    const right = await luma(out, 1, '40:1080:1880:0')
    const centre = await luma(out, 1, '300:300:810:390')
    assert.ok(
      Math.abs(left - BLACK_Y) <= BLACK_SLACK && Math.abs(right - BLACK_Y) <= BLACK_SLACK,
      `the sides read ${left} and ${right}, expected black — a rotated source ` +
        'filling a landscape frame means the rotation was not applied',
    )
    assert.ok(centre > BLACK_Y + 5, `the middle reads ${centre}, so nothing was drawn`)
    console.log(`       sides ${left}/${right} (black), middle ${centre}`)
  })

  await check('the upper track is in front, and the one below shows where it is not', async () => {
    /*
     * Decided by luma rather than by eye. Both clips fill the frame, so at a
     * moment covered by both the composite must read as the TOP clip's own
     * frame and not the bottom one's — and at a moment covered only by the
     * bottom one, as the bottom's.
     *
     * The two clips have to actually look different for that to mean anything,
     * which is checked rather than assumed.
     */
    if (probed.length < 2) {
      console.log('       (one source only — skipping)')
      return
    }
    const under = A
    const over = B

    const state = await render({
      ...FILLS,
      duration: 4,
      name: 'Layer check',
      // track 0 is the bottom. The top clip covers 1s to 2s of the four.
      video: [
        { asset: under.path, start: 0, duration: 4, track: 0 },
        { asset: over.path, start: 1, duration: 1, track: 1 },
      ],
      audio: [],
    })

    const out = state.output
    // The sources' own frames at the moments the composite draws them.
    const underAt15 = await luma(under.path, 1.5)
    const overAt05 = await luma(over.path, 0.5)
    const underAt05 = await luma(under.path, 0.5)
    // 24 on the 10-bit scale — six 8-bit levels, which is about the smallest
    // difference a CQ 26 re-encode cannot plausibly account for on its own.
    if (Math.abs(underAt15 - overAt05) < 24) {
      console.log(
        `       (the two clips read ${underAt15} and ${overAt05} — too alike to tell apart)`,
      )
      return
    }

    const covered = await luma(out, 1.5)
    const uncovered = await luma(out, 0.5)
    assert.ok(
      Math.abs(covered - overAt05) < Math.abs(covered - underAt15),
      `at 1.5s the composite reads ${covered}; the top clip is ${overAt05} and the ` +
        `bottom is ${underAt15}, so the back layer was drawn in front`,
    )
    assert.ok(
      Math.abs(uncovered - underAt05) < 48,
      `at 0.5s the composite reads ${uncovered}, expected the bottom layer (${underAt05})`,
    )
    console.log(
      `       covered ${covered} ≈ top ${overAt05} (bottom is ${underAt15}); ` +
        `uncovered ${uncovered} ≈ bottom ${underAt05}`,
    )
  })

  await check('the mixdown is a sum, and a fader moves it by what it says', async () => {
    /*
     * Two failures at once. `amix` divides by the number of its inputs unless
     * told not to, so a second audio track would halve the first — a mixdown
     * that gets quieter the more you put in it. And a track gain is in decibels
     * on the fader, so -6dB has to come out 6dB down and not 6 somethings else.
     *
     * Measured from the file both times, with nothing changed between the two
     * renders except the fader.
     */
    const unity = await render({
      ...FILLS,
      duration: 3,
      name: 'Mix check',
      video: [{ asset: A.path, start: 0, duration: 3 }],
      audio: [{ asset: A.path, start: 0, duration: 3 }],
    })
    const loud = await volume(unity.output)
    if (loud.peak < -30) {
      console.log('       (the source is near-silent — skipping)')
      return
    }

    const quieter = await render({
      ...FILLS,
      duration: 3,
      name: 'Mix check down',
      video: [{ asset: A.path, start: 0, duration: 3 }],
      audio: [{ asset: A.path, start: 0, duration: 3 }],
      audioTracks: { 0: { gain: -6 } },
    })
    const soft = await volume(quieter.output)

    const dropped = loud.mean - soft.mean
    assert.ok(
      Math.abs(dropped - 6) < 0.8,
      `-6dB on the fader moved the mix by ${dropped.toFixed(2)}dB`,
    )
    console.log(`       ${loud.mean}dB at unity, ${soft.mean}dB at -6 (${dropped.toFixed(2)} down)`)
  })

  await check('a muted track is silent in the render, and the picture is untouched', async () => {
    const state = await render({
      ...FILLS,
      duration: 3,
      name: 'Mute check',
      video: [{ asset: A.path, start: 0, duration: 3 }],
      audio: [{ asset: A.path, start: 0, duration: 3 }],
      audioTracks: { 0: { muted: true } },
    })
    assert.equal(state.job.audio, 0, 'a muted track was still queued into the mix')

    const heard = await volume(state.output)
    assert.ok(heard.peak < -45, `a muted render peaks at ${heard.peak}dB, expected silence`)
    /*
     * And the output is still a full, correct video. A mute must not shorten
     * the file or cost it its audio stream — silence is a stream of silence,
     * which is what the mix's silent base is for.
     */
    const checked = await verifySequence(tools.ffprobe, {
      ...state.job,
      output: state.output,
      duration: 3,
    })
    assert.ok(checked.ok, `the muted render did not verify: ${checked.error}`)
    console.log(`       silent (${heard.peak}dB peak), picture verified`)
  })

  await check('a stretched clip composites at its own speed', async () => {
    /*
     * Speed and placement are one `setpts` expression — `(PTS-STARTPTS)/speed +
     * start/TB` — and getting the precedence wrong would divide the *placement*
     * by the speed, putting the clip at half the time it belongs at. What that
     * shows up as is a sequence whose length is right and whose contents have
     * slid, so the length alone would not catch it: the clip is placed after a
     * second of black, and that second has to still be black.
     */
    const length = Math.min(2, A.duration / 2)
    const state = await render({
      ...FILLS,
      duration: 1 + length + 1,
      name: 'Speed check',
      video: [{ asset: A.path, start: 1, duration: length, speed: 2 }],
      audio: [{ asset: A.path, start: 1, duration: length, speed: 2 }],
    })

    const checked = await verifySequence(tools.ffprobe, {
      ...state.job,
      output: state.output,
      duration: 2 + length,
    })
    assert.ok(checked.ok, `the stretched render did not verify: ${checked.error}`)

    const before = await luma(state.output, 0.5)
    const during = await luma(state.output, 1 + length / 2)
    const after = await luma(state.output, 1.5 + length)
    assert.ok(
      Math.abs(before - BLACK_Y) <= BLACK_SLACK,
      `the second before the clip reads ${before}, so a 2x clip slid to 0.5s`,
    )
    assert.ok(during > BLACK_Y + 10, `nothing was drawn at ${1 + length / 2}s`)
    assert.ok(
      Math.abs(after - BLACK_Y) <= BLACK_SLACK,
      `the tail reads ${after}, so the clip ran past its length`,
    )
    console.log(`       2x over ${length}s, placed at 1s, ${checked.facts.frames} frames`)
  })

  // ── the canary ─────────────────────────────────────────────────

  await check('a deliberately wrong output is rejected', async () => {
    /*
     * The check that makes every other check above mean something. All of them
     * end in `verifySequence` saying yes; if it said yes to anything, none of
     * them would have tested anything at all.
     *
     * Two wrongnesses, chosen because they are the two that have actually
     * happened to this project's renders: a file that is short — the Adobe
     * export that turned 1850 frames into 1108 and looked healthy — and a file
     * that is the wrong shape, which is what scaling before rotating produces.
     */
    const good = await render({
      ...FILLS,
      duration: 4,
      name: 'Canary',
      video: [{ asset: A.path, start: 0, duration: 4 }],
      audio: [{ asset: A.path, start: 0, duration: 4 }],
    })
    const job = { ...good.job, output: good.output, duration: 4 }

    const sound = await verifySequence(tools.ffprobe, job)
    assert.ok(sound.ok, `the good render was rejected: ${sound.error}`)

    const encode = (file, extra) =>
      run(
        tools.ffmpeg,
        ['-hide_banner', '-v', 'error', '-i', good.output, ...extra,
         '-c:v', 'hevc_nvenc', '-rc', 'vbr', '-cq', '26', '-b:v', '0',
         '-pix_fmt', 'p010le', '-tag:v', 'hvc1', '-c:a', 'aac',
         '-f', 'mp4', '-y', file],
        { maxBuffer: 8 << 20 },
      )

    // A third of the duration, which is the shape of the failure that started
    // all of this. Everything else about the file is right.
    const short = path.join(OUT, 'canary-short.mp4')
    await encode(short, ['-t', '1.3'])
    const truncated = await verifySequence(tools.ffprobe, { ...job, output: short })
    assert.equal(truncated.ok, false, 'a file a third of the length was accepted')
    assert.match(
      truncated.error,
      /frames|duration/,
      `the truncated file was rejected for the wrong reason: ${truncated.error}`,
    )

    // Correct length, wrong frame. What a composite that ignored the sequence's
    // size, or scaled a rotated clip before turning it, comes out as.
    const squashed = path.join(OUT, 'canary-squashed.mp4')
    await encode(squashed, ['-vf', `scale=${Math.round(FILLS.width / 2)}:${Math.round(FILLS.height / 2)}`])
    const wrongSize = await verifySequence(tools.ffprobe, { ...job, output: squashed })
    assert.equal(wrongSize.ok, false, 'a file half the size was accepted')
    assert.match(
      wrongSize.error,
      /size/,
      `the wrong-sized file was rejected for the wrong reason: ${wrongSize.error}`,
    )

    // And no audio at all, which the picture checks cannot see.
    const mute = path.join(OUT, 'canary-mute.mp4')
    await run(
      tools.ffmpeg,
      ['-hide_banner', '-v', 'error', '-i', good.output, '-an', '-c:v', 'copy',
       '-f', 'mp4', '-y', mute],
      { maxBuffer: 8 << 20 },
    )
    const silent = await verifySequence(tools.ffprobe, { ...job, output: mute })
    assert.equal(silent.ok, false, 'a file with no audio stream was accepted')

    console.log(
      `       rejected: short ("${truncated.error}"), ` +
        `wrong size ("${wrongSize.error}"), no audio ("${silent.error}")`,
    )
  })

  await check('resume says yes only to a render that verifies', async () => {
    const good = await render({
      ...FILLS,
      duration: 2,
      name: 'Resume check',
      video: [{ asset: A.path, start: 0, duration: 2 }],
      audio: [{ asset: A.path, start: 0, duration: 2 }],
    })
    const job = { ...good.job, output: good.output, duration: 2 }
    assert.equal(await sequenceAlreadyDone(job), true, 'a finished render was not recognised')

    // The same file, described as a longer sequence. Nothing on disk changed;
    // what it is being asked to be did.
    assert.equal(
      await sequenceAlreadyDone({ ...job, duration: 20 }),
      false,
      'resume accepted a file that is a tenth of the sequence',
    )
    assert.equal(
      await sequenceAlreadyDone({ ...job, output: path.join(OUT, 'never-written.mp4') }),
      false,
      'resume accepted a file that is not there',
    )
  })

  // ── the snapshot ───────────────────────────────────────────────

  await check('a queued sequence render is a snapshot of what was reviewed', async () => {
    /*
     * The same property verify-render-queue.mjs checks for a clip job, and it
     * matters more here: a sequence render is a snapshot of an entire edit, so
     * an afternoon of further cutting afterwards is exactly what a queue you
     * add to invites. A job that resolved at render time would composite
     * whatever the sequence had become.
     */
    const state = await evaluate(
      cdp,
      layout({
        ...FILLS,
        duration: 6,
        name: 'Snapshot check',
        video: [
          { asset: A.path, start: 0, duration: 2 },
          { asset: B.path, start: 2, duration: 2 },
        ],
        audio: [{ asset: A.path, start: 0, duration: 2 }],
      }) +
        // `sequence` and `renderQueue` are already in scope from `layout`.
        `renderQueue.add('one-file');
         const before = JSON.parse(JSON.stringify(renderQueue.getQueue()[0]));

         // Everything a queue is meant to survive: a clip deleted, a clip
         // razored, the frame changed and the sequence made longer.
         const clips = sequence.getSequence().clips.filter(c => c.kind === 'video');
         sequence.removeClips([clips[0].id]);
         sequence.splitClips(clips[1].start + 1, [clips[1].id]);
         sequence.updateSequenceSettings({ width: 640, height: 360, duration: 60 });
         await new Promise(r => setTimeout(r, 200));

         const after = JSON.parse(JSON.stringify(renderQueue.getQueue()[0]));
         return {
           before: { duration: before.duration, width: before.width, height: before.height,
                     video: before.video, audio: before.audio },
           after: { duration: after.duration, width: after.width, height: after.height,
                    video: after.video, audio: after.audio },
           rows: renderQueue.getQueue().length,
           clipsNow: sequence.getSequence().clips.length,
         };`,
    )
    assert.equal(state.rows, 1, 'the queued render vanished when the sequence was edited')
    assert.deepEqual(
      state.after,
      state.before,
      'editing the sequence retroactively changed what was queued',
    )
    assert.ok(state.clipsNow > 0, 'setup: the sequence should still have clips')
  })

  await check('re-adding the sequence replaces its row rather than queueing it twice', async () => {
    const state = await evaluate(
      cdp,
      `const { renderQueue } = window.__fluxDev;
       const first = renderQueue.add('one-file');
       const before = renderQueue.getQueue().length;
       const again = renderQueue.add('one-file');
       return { first, again, before, after: renderQueue.getQueue().length };`,
    )
    assert.equal(state.after, state.before, 'the queue grew on a second Add')
    assert.equal(state.again.added, 0)
    assert.equal(state.again.replaced, 1, 'the second Add did not replace the first row')
  })
} finally {
  report()
  await fs.rm(OUT, { recursive: true, force: true })
  cdp.close()
}
