/**
 * Builds the test fixtures the verification suites read.
 *
 *   node scripts/make-fixtures.mjs [dir]      # default ~/flux-media-test
 *
 * These used to be a paragraph of README prose and eight ffmpeg commands to
 * paste, which worked exactly as well as anyone's patience — and meant CI could
 * not run the one headless suite that reads real files. A fixture set that can
 * be rebuilt by a command is a fixture set a fresh clone and a runner both get.
 *
 * ## They are deliberately awkward, and the awkwardness is the point
 *
 * None of these is a nice file. Each was shaped around one thing that is hard
 * to get right and silent when it is wrong, so a suite reading them is reading
 * a trap rather than a sample:
 *
 *   - **`clipA.mp4` has no audio at all**, and `foreign_audio.mp4` has audio in
 *     a codec FLUX refuses. Those are two different answers to "where is the
 *     sound", and the app has to say which one it is looking at rather than
 *     showing silence for both.
 *   - **`open_gop.mp4`'s sync samples are not IDR frames**, which is what phone
 *     and drone footage does routinely and what a decoder will not start on.
 *   - **`long_take.mp4` is a minute long**, because everything a four-second
 *     file can tell you about playback it can also tell you while a completely
 *     broken server is underneath it.
 *   - **`voice_over.mp4` is loud and quiet on a schedule**, because a waveform
 *     drawn from audio that never changes cannot show whether it is following
 *     the audio or drawing a band of its own.
 *   - **`layer_red` is landscape and `layer_blue` is portrait**, so a correct
 *     composite is blue down the middle with red at the edges — the only way to
 *     see from the pixels that both layers were drawn.
 *   - **`corrupt.mp4` is an `ftyp` and nothing else.** It has to be refused,
 *     not partly believed.
 *
 * ## Exact numbers matter here
 *
 * `scripts/verify-demux.mjs` asserts that `clipA.mp4` is 96 samples and
 * `shot_B.mp4` is 72. Those are 4s and 3s at 24fps, and they are assertions
 * about the *index this demuxer built*, compared against a count known from
 * outside it. Changing a duration or a rate below means changing them there
 * too — and a fixture quietly regenerated at a different length would turn a
 * real check into one that only ever agrees with itself.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')

/** Found the same way electron/render.js finds it, minus the Windows search. */
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'

/**
 * The video fixtures, as ffmpeg argument lists.
 *
 * Written out rather than built from a template, because almost every one of
 * them differs from the others in the thing it exists to test, and a template
 * with six escape hatches is harder to read than six commands.
 */
const CLIPS = [
  {
    name: 'clipA.mp4',
    // 640x360, 24fps, 4s — 96 samples, which verify-demux asserts. No audio,
    // on purpose: it is the "this file has no soundtrack" case.
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '300k', '-g', '24', '-an',
    ],
  },
  {
    name: 'shot_B.mp4',
    // 480x270, 24fps, 3s — 72 samples, also asserted.
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=600:duration=3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '300k', '-g', '24', '-c:a', 'aac', '-b:a', '96k', '-shortest',
    ],
  },
  {
    name: 'render.webm',
    /*
     * Not an mp4, and that is its whole job twice over: the demuxer must refuse
     * it with `no-moov` rather than misreading it, and asking it for an audio
     * track must fail rather than returning something.
     */
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2',
      '-c:v', 'libvpx-vp9', '-b:v', '200k', '-an',
    ],
  },
  {
    name: 'long_take.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=60',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '700k', '-g', '50', '-c:a', 'aac', '-b:a', '64k', '-shortest',
    ],
  },
  {
    name: 'open_gop.mp4',
    /*
     * Sync samples that are **not IDR frames**. `verify-demux` reads the first
     * NAL of every one of them to check this is still true — because a future
     * encoder quietly emitting IDRs would leave the decoder-recovery checks
     * passing while exercising nothing at all.
     */
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '200k',
      '-x264-params', 'open_gop=1:keyint=50:min-keyint=50:scenecut=0:bframes=3',
      '-an',
    ],
  },
  {
    name: 'voice_over.mp4',
    // Two seconds at 0.9 then two at 0.02, three times over.
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12',
      '-f', 'lavfi',
      '-i', 'aevalsrc=sin(2*PI*300*t)*if(eq(mod(floor(t/2)\\,2)\\,0)\\,0.9\\,0.02):d=12:s=48000',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '300k', '-g', '25', '-c:a', 'aac', '-b:a', '128k', '-shortest',
    ],
  },
  {
    name: 'foreign_audio.mp4',
    // AC-3: audio the demuxer refuses as an unsupported codec, which is a
    // different thing from clipA.mp4 having none.
    args: [
      '-f', 'lavfi', '-i', 'color=c=green:size=320x180:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '150k', '-g', '25', '-c:a', 'ac3', '-b:a', '96k', '-shortest',
    ],
  },
  {
    name: 'layer_red.mp4',
    args: [
      '-f', 'lavfi', '-i', 'color=c=red:size=1280x720:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '200k', '-g', '25', '-c:a', 'aac', '-b:a', '96k', '-shortest',
    ],
  },
  {
    name: 'layer_blue.mp4',
    // Portrait, against layer_red's landscape. Composited, the blue one is
    // letterboxed over the red and both are visible in the pixels.
    args: [
      '-f', 'lavfi', '-i', 'color=c=blue:size=480x640:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=900:duration=6',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '200k', '-g', '25', '-c:a', 'aac', '-b:a', '96k', '-shortest',
    ],
  },
  {
    name: 'photo.png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=1', '-frames:v', '1'],
  },
  {
    name: 'still.jpg',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1:duration=1', '-frames:v', '1'],
  },
]

/**
 * An `ftyp` box and nothing after it.
 *
 * A file that announces itself as an mp4 and then stops, which is what a
 * half-finished copy off a card looks like. The demuxer has to refuse it rather
 * than believe the part it can read — so this is written by hand rather than by
 * truncating a real file, because a truncation lands wherever it lands and this
 * lands exactly at the end of the one box that parses.
 */
function corruptMp4() {
  const box = Buffer.alloc(24)
  box.writeUInt32BE(24, 0)
  box.write('ftyp', 4, 'ascii')
  box.write('isom', 8, 'ascii')
  box.writeUInt32BE(0x200, 12)
  box.write('isom', 16, 'ascii')
  box.write('mp41', 20, 'ascii')
  return box
}

async function main() {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-version'])
    console.log(`  ${stdout.split('\n')[0].trim()}`)
  } catch {
    console.error(
      '  ffmpeg was not found. Install it and put it on PATH ' +
        '(Windows: winget install Gyan.FFmpeg), or set FFMPEG to its path.',
    )
    process.exit(1)
  }

  await fs.mkdir(DIR, { recursive: true })

  for (const clip of CLIPS) {
    const out = path.join(DIR, clip.name)
    try {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...clip.args, out], {
        maxBuffer: 8 << 20,
      })
      const { size } = await fs.stat(out)
      console.log(`  ${clip.name.padEnd(20)} ${size} bytes`)
    } catch (err) {
      console.error(`  FAILED ${clip.name}: ${lastLine(err.stderr ?? err.message)}`)
      process.exitCode = 1
    }
  }

  await fs.writeFile(path.join(DIR, 'corrupt.mp4'), corruptMp4())
  console.log(`  ${'corrupt.mp4'.padEnd(20)} 24 bytes (ftyp only)`)

  // A file that must never be listed as media, and a folder to descend into.
  await fs.writeFile(path.join(DIR, 'notes.txt'), 'not media\n', 'utf8')
  await fs.mkdir(path.join(DIR, 'Nested'), { recursive: true })
  await fs.copyFile(path.join(DIR, 'clipA.mp4'), path.join(DIR, 'Nested', 'clipA.mp4'))
  console.log(`  notes.txt, Nested/`)

  console.log(`\n  fixtures in ${DIR}`)
}

function lastLine(text) {
  const lines = String(text).trim().split('\n').filter(Boolean)
  return lines[lines.length - 1] ?? 'no output'
}

await main()
