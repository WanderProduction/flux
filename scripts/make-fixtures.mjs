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
 *
 * ## Why almost everything here is `-bf 0`
 *
 * FLUX derives a clip's frame rate by **counting**: samples divided by the
 * track's duration, because a container's declared rate is a hint an encoder
 * may have got wrong. That makes the track duration load-bearing — and with
 * B-frames, ffmpeg writes an `mdhd` duration one frame longer than the samples
 * account for, to leave room for the last composition time.
 *
 * So a 4-second, 96-sample clip encoded with B-frames reports 96 / 4.0417 =
 * **23.753fps**. A sequence built on it snaps to a grid of 23.753, `4.0`
 * becomes `3.9994948`, and clips dropped end to end overlap by half a
 * millisecond. Six checks in verify-timeline fail, none of them about frame
 * rates, and the fixtures look perfectly ordinary.
 *
 * `-bf 0` makes the track duration exactly the samples' duration, and it is on
 * **`clipA.mp4` and `shot_B.mp4` only** — the two that get dropped onto a
 * timeline, where the sequence takes its rate from the first clip and every
 * placement is snapped to that grid.
 *
 * Everywhere else B-frames stay, because two checks depend on them:
 * `long_take.mp4` is what verify-demux uses to prove frames are *reordered* at
 * all (without it the whole presentation-order index is untested and every
 * lookup passes by accident), and `open_gop.mp4` exists to have sync samples
 * that are not IDR frames. Those files are never the first clip in a sequence,
 * so their rate costs nothing.
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
      '-c:v', 'libx264', '-bf', '0', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', '300k', '-g', '24', '-an',
    ],
  },
  {
    name: 'shot_B.mp4',
    // 480x270, 24fps, 3s — 72 samples, also asserted.
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=600:duration=3',
      '-c:v', 'libx264', '-bf', '0', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
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
  /*
   * Four uncompressed soundtracks, one per byte layout FLUX has to read.
   *
   * They exist because uncompressed audio is the one kind where being wrong is
   * *silent in the wrong direction*: a mistaken divisor is quiet audio, a
   * mistaken sign is loud audio, a mistaken byte order is noise, and none of
   * the three throws or looks odd on a waveform. Four files encoding the same
   * 440Hz tone four different ways turn that into a comparison — they must all
   * decode to the same tone at the same level, and any one path getting it
   * wrong shows up as that one disagreeing.
   *
   * ffmpeg writes `sowt`, `twos`, `in24` and `fl32`, the last two carrying a
   * `wave`/`enda` box that says little-endian despite the big-endian name.
   * **It does not write `lpcm` version 2**, which is what the cameras in this
   * archive use — that layout is checked against real footage instead, because
   * nothing here can produce one.
   */
  {
    name: 'pcm_sowt.mov',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le', '-shortest',
    ],
  },
  {
    name: 'pcm_twos.mov',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16be', '-shortest',
    ],
  },
  {
    name: 'pcm_in24.mov',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s24le', '-shortest',
    ],
  },
  {
    name: 'pcm_fl32.mov',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_f32le', '-shortest',
    ],
  },
  {
    name: 'photo.png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=1', '-frames:v', '1'],
  },
  {
    name: 'still.jpg',
    /*
     * 1024 wide, and that number is asserted by scripts/verify-timeline.mjs —
     * a still has no duration of its own, so what the probe reads off it is
     * its *size*, and the check that a still lands with the default duration
     * proves nothing unless the probe is known to have read the real file.
     */
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1024x576:rate=1:duration=1', '-frames:v', '1'],
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

/**
 * `rotated.mp4` — a clip whose orientation can actually be read off the screen.
 *
 * Every other fixture here is colour bars or a test pattern, and both are
 * nearly symmetric: drawn upside down they look like themselves. That is not a
 * hypothetical. The viewer turned every quarter-turn clip the wrong way for
 * months — `av_display_rotation_get` returns a counter-clockwise angle and
 * canvas `rotate()` takes a clockwise one — and nothing caught it, because the
 * checks compared sizes and asked whether the canvas was black. A 180-degree
 * error changes neither.
 *
 * So this one has **four differently coloured quadrants**, which pin the
 * orientation exactly: any wrong quarter turn, and any mirroring, moves at
 * least two of them.
 *
 * Built in two passes because the picture and the matrix are separate claims.
 * The upright picture is 180x320 with red, green, blue and white quadrants
 * clockwise from the top left; it is then turned a quarter clockwise and coded
 * landscape, exactly as a camera held on its side records it. The second pass
 * copies the stream untouched and writes `rotation: 90` into the track matrix,
 * which says "turn this a quarter counter-clockwise to display it" and takes
 * the picture back to where it started.
 *
 * `-display_rotation` is an *input* option and `-c copy` is what keeps this
 * honest: nothing re-encodes, so the coded pixels in the file are provably the
 * turned ones and the only thing the second pass adds is the matrix. The older
 * spelling, `-metadata:s:v rotate=90`, writes nothing at all on ffmpeg 8.
 */
async function makeRotated() {
  const name = 'rotated.mp4'
  const out = path.join(DIR, name)
  const coded = path.join(DIR, `.${name}.coded.tmp.mp4`)

  // Upright: red top-left, green top-right, blue bottom-left, white bottom-right.
  const quadrants = [
    'drawbox=x=0:y=0:w=90:h=160:c=red@1:t=fill',
    'drawbox=x=90:y=0:w=90:h=160:c=green@1:t=fill',
    'drawbox=x=0:y=160:w=90:h=160:c=blue@1:t=fill',
    'drawbox=x=90:y=160:w=90:h=160:c=white@1:t=fill',
  ].join(',')

  try {
    await run(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=180x320:d=2:r=24',
        // transpose=1 is a quarter clockwise: what the sensor would have read.
        '-vf', `${quadrants},transpose=1`,
        '-c:v', 'libx264', '-bf', '0', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-b:v', '300k', '-g', '24', '-an',
        coded,
      ],
      { maxBuffer: 8 << 20 },
    )
    await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', coded, '-c', 'copy', out],
      { maxBuffer: 8 << 20 },
    )
    const { size } = await fs.stat(out)
    console.log(`  ${name.padEnd(20)} ${size} bytes (coded 320x180, matrix 90)`)
  } catch (err) {
    console.error(`  FAILED ${name}: ${lastLine(err.stderr ?? err.message)}`)
    process.exitCode = 1
  } finally {
    await fs.rm(coded, { force: true })
  }
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

  await makeRotated()

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
