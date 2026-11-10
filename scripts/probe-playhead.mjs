/**
 * How evenly the drawn playhead moves.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/probe-playhead.mjs            (control, or after a change)
 *
 * Not a pass/fail suite — a measurement, to be run either side of a change and
 * compared. It exists because "playback lags" has been the wrong question
 * twice: once it was the timeline re-rendering 75 times a second while decode
 * delivered a perfect 50fps, and the number that found it was the *spread* of
 * the gaps, never the mean.
 *
 * ## What is sampled, and why it is the DOM and not the clock
 *
 * Per animation frame: the sequence time the transport reports, and the actual
 * `left` the Timeline wrote on the playhead. The second one is what a person
 * sees. A clock that is perfectly accurate on average still looks like a
 * stutter if the pixel it is drawn at jumps 0, 2, 0, 2 — and that distinction
 * is invisible to any measurement of the clock alone.
 *
 * ## What the numbers mean
 *
 * `dt` is the wall time between animation frames: the display's own beat, and
 * the control for everything else. `dx` is how far the playhead moved in those
 * same intervals. A playhead moving evenly has `dx` as steady as `dt`, so the
 * figure to read is **cv** — the standard deviation over the mean. Low is
 * smooth. `still` counts frames where the playhead did not move at all and
 * `jump` those where it moved more than twice the median, which are the two
 * halves of a visible stutter.
 */

import os from 'node:os'
import path from 'node:path'

import { attach, ensureProject, evaluate, requireFixtures } from './cdp.mjs'

const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')
const SECONDS = Number(process.env.PROBE_SECONDS ?? 6)
/** A clip with sound, so the mixer is the clock rather than the wall. */
const FIXTURE = process.env.PROBE_CLIP ?? 'voice_over.mp4'

const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)
await ensureProject(cdp, VERIFY_PROJECT)
const FIXTURES = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')
await requireFixtures(cdp, FIXTURES)

/** A clip on the timeline, the Edit layout, following on: the state being measured. */
await evaluate(
  cdp,
  `const { importPipeline, assets, sequence, playback, view, commands } = window.__fluxDev;
   await commands.run('layout.switch.edit');
   await new Promise((r) => setTimeout(r, 500));

   const added = await importPipeline.importFiles(
     [{ path: ${JSON.stringify(path.join(FIXTURES, FIXTURE))}, kind: 'video' }], 'link');
   const asset = added[0] ?? assets.getAssets().find((a) => a.name === ${JSON.stringify(FIXTURE)});
   const probed = await assets.ensureProbed(asset.id);

   sequence.setSequence(null);
   sequence.setSequenceSize(1920, 1080);
   // Several copies, so the sequence is long enough to play through and wide
   // enough that the timeline actually has to scroll to follow.
   for (let i = 0; i < 6; i++) {
     const start = i * probed.duration;
     sequence.addClip({ assetId: asset.id, trackId: 'V1', start, duration: probed.duration });
     // And on A1, because the mixer is only the clock when it has a voice to
     // play — a picture-only timeline is clocked by the wall, which is not the
     // state this is measuring.
     sequence.addClip({ assetId: asset.id, trackId: 'A1', start, duration: probed.duration });
   }
   view.recordView({ timeline: { follow: true } });
   playback.pause();
   playback.seek(0);
   await new Promise((r) => setTimeout(r, 1500));
   return true;`,
)

const out = await evaluate(
  cdp,
  `const { playback } = window.__fluxDev;
   const head = document.querySelector('.tl-playhead');
   if (!head) throw new Error('no playhead element on screen');

   const t = [];       // sequence time the transport reports
   const x = [];       // the px the timeline drew it at
   const w = [];       // wall clock, the control

   playback.seek(0);
   playback.play();
   // One beat before sampling, so the first interval is not the one that
   // includes starting the transport.
   await new Promise((r) => requestAnimationFrame(r));

   const until = performance.now() + ${SECONDS} * 1000;
   await new Promise((done) => {
     const step = (now) => {
       w.push(now);
       t.push(playback.getTime());
       x.push(parseFloat(head.style.left) || 0);
       if (now < until && playback.isPlaying()) requestAnimationFrame(step);
       else done();
     };
     requestAnimationFrame(step);
   });
   playback.pause();

   const deltas = (a) => a.slice(1).map((v, i) => v - a[i]);
   return {
     dt: deltas(w), dx: deltas(x), dtime: deltas(t), frames: w.length,
     // No export names the active clock, so this reports the thing that
     // decides it: a mixer with voices is the clock, otherwise the wall is.
     voices: window.__fluxDev.mixer.mixerStats().voices,
   };`,
)

/** Mean, spread and the two shapes of a stutter. */
function describe(values) {
  const n = values.length
  if (n === 0) return null
  const mean = values.reduce((a, b) => a + b, 0) / n
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(n - 1, Math.floor(q * n))]
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
  const median = at(0.5)
  return {
    mean,
    median,
    p95: at(0.95),
    max: sorted[n - 1],
    cv: mean === 0 ? 0 : sd / mean,
    still: values.filter((v) => Math.abs(v) < 1e-6).length,
    jump: values.filter((v) => Math.abs(v) > Math.abs(median) * 2 && Math.abs(median) > 1e-9).length,
  }
}

const row = (name, d, unit) =>
  d === null
    ? `  ${name}: nothing sampled`
    : `  ${name.padEnd(16)} mean ${d.mean.toFixed(2)}${unit}  median ${d.median.toFixed(2)}  ` +
      `p95 ${d.p95.toFixed(2)}  max ${d.max.toFixed(2)}  cv ${d.cv.toFixed(3)}  ` +
      `still ${d.still}  jump ${d.jump}`

const dt = describe(out.dt)
const dx = describe(out.dx)
const dtime = describe(out.dtime.map((v) => v * 1000))

console.log(`\n${out.frames} animation frames over ~${SECONDS}s\n`)
console.log(row('wall dt (ms)', dt, 'ms'))
console.log(row('clock dt (ms)', dtime, 'ms'))
console.log(row('playhead dx (px)', dx, 'px'))
console.log(
  `\n  read cv on "playhead dx": the wall clock's own cv (${dt ? dt.cv.toFixed(3) : '?'}) is the floor.\n`,
)

cdp.close()
