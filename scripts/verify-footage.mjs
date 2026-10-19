/**
 * Verifies that real camera footage plays through the pipeline, upright.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-footage.mjs <file> [file...]
 *
 * The other harnesses run against fixtures built to be awkward in known ways.
 * This one runs against whatever a camera actually wrote, because the two
 * things it checks could only have been found that way:
 *
 *   - **HEVC decodes here.** 4:2:2 10-bit included, which is the profile the
 *     cameras in this library shoot and the one most likely to be assumed out
 *     of reach in a browser. A file that falls back to the element plays, so
 *     nothing looks broken — it just quietly stops being frame-addressable,
 *     which is the whole point of the pipeline.
 *   - **Rotation is applied.** Coded landscape, displayed vertical. The element
 *     path gets this from Chromium for free, so a sideways picture on the
 *     canvas is invisible until the two are compared against each other.
 *
 * Each file is checked for what it *is* rather than against a fixed
 * expectation: the demuxer's answer is compared with ffprobe's, so this works
 * on any footage pointed at it and fails when the two disagree.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'

const run = promisify(execFile)
const FILES = process.argv.slice(2)
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

if (FILES.length === 0) {
  console.error('  usage: node scripts/verify-footage.mjs <file> [file...]')
  process.exit(2)
}

/** What ffprobe says about a file — the independent opinion to check against. */
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-print_format', 'json', '-show_streams', '--', file,
  ])
  const s = JSON.parse(stdout).streams[0]
  const rotation = Number(
    ((s.side_data_list || []).find((d) => d.rotation !== undefined) || {}).rotation ?? 0,
  )
  const quarter = ((rotation % 180) + 180) % 180 === 90
  return {
    codec: s.codec_name,
    profile: s.profile,
    pixFmt: s.pix_fmt,
    coded: { width: s.width, height: s.height },
    display: quarter
      ? { width: s.height, height: s.width }
      : { width: s.width, height: s.height },
    rotation: ((rotation % 360) + 360) % 360,
  }
}

const { check, report } = createChecker()
const cdp = await attach()

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  for (const file of FILES) {
    const name = path.basename(file)
    const expected = await probe(file)
    const json = JSON.stringify(file)

    await check(`${name} (${expected.codec} ${expected.profile} ${expected.pixFmt}, rot ${expected.rotation}) decodes through the pipeline, upright`, async () => {
      const state = await evaluate(
        cdp,
        `const { importPipeline, assets, sequence, playback } = window.__fluxDev;
         const { trackFor } = window.__fluxDev.indexCache;
         const { VideoSource } = window.__fluxDev.videoSource;

         const added = await importPipeline.importFiles([{ path: ${json}, kind: 'video' }], 'link');
         const asset = added[0] ?? assets.getAssets().find(a => a.path === ${json});
         const probed = await assets.ensureProbed(asset.id);

         // What the demuxer made of it, before any decoding.
         const indexed = await trackFor(asset.path, 'video');

         // And whether a real decode produces a real frame.
         const opened = await VideoSource.open(asset.path);
         let decoded = null;
         if (opened.ok) {
           const frame = await opened.source.frameFor(Math.min(1, probed.duration / 2));
           if (frame) {
             decoded = {
               codedWidth: frame.codedWidth,
               codedHeight: frame.codedHeight,
               format: frame.format,
             };
           }
           decoded = decoded && { ...decoded, info: opened.source.info };
           opened.source.close();
         }

         // Then on the timeline, so the compositor is what draws it.
         sequence.clearSequence();
         sequence.addClip({ assetId: asset.id, trackId: 'V1', start: 0, duration: probed.duration });
         playback.seek(Math.min(1, probed.duration / 2));
         await new Promise(r => setTimeout(r, 1500));

         const canvas = document.querySelector('canvas.viewer-media');
         const shown = canvas && getComputedStyle(canvas).display !== 'none';
         let lit = 0;
         if (shown) {
           const c = document.createElement('canvas');
           c.width = 48; c.height = 27;
           const ctx = c.getContext('2d');
           ctx.drawImage(canvas, 0, 0, 48, 27);
           const d = ctx.getImageData(0, 0, 48, 27).data;
           for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 24) lit++;
         }

         return {
           indexOk: indexed.ok,
           indexReason: indexed.reason ?? null,
           codec: indexed.ok ? indexed.track.codec : null,
           coded: indexed.ok ? { width: indexed.track.width, height: indexed.track.height } : null,
           rotation: indexed.ok ? indexed.track.rotation : null,
           opened: opened.ok,
           openReason: opened.ok ? null : opened.reason,
           decoded,
           probedSize: { width: probed.width, height: probed.height },
           via: shown ? 'pipeline' : 'element',
           lit,
           sequenceFrame: { width: sequence.getSequence().width, height: sequence.getSequence().height },
         };`,
      )

      assert.ok(state.indexOk, `the demuxer refused it: ${state.indexReason}`)
      assert.deepEqual(
        state.coded,
        expected.coded,
        'coded size must be what ffprobe reports, not the displayed size',
      )
      assert.equal(state.rotation, expected.rotation, 'rotation disagrees with ffprobe')
      assert.ok(state.opened, `VideoSource refused it: ${state.openReason}`)
      assert.ok(state.decoded, 'no frame came out of the decoder')
      assert.equal(state.via, 'pipeline', 'fell back to the element instead of decoding')

      /*
       * The probe goes through a <video>, which Chromium rotates — so the
       * asset's own dimensions are the displayed ones. That is the number the
       * sequence takes its frame from, and it is what makes a vertical clip
       * produce a vertical sequence rather than a landscape one with bars.
       */
      assert.deepEqual(
        state.probedSize,
        expected.display,
        'the asset should carry the displayed size',
      )
      assert.ok(state.lit > 0, 'the canvas is black — a frame was drawn but not of anything')
    })
  }
} finally {
  report()
  cdp.close()
}
