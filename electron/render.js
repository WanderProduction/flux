/**
 * Running ffmpeg: one cut at a time, verified before it counts as done.
 *
 * Kept free of any `electron` import so `scripts/verify-render.mjs` can drive it
 * against real footage with no app running. The queue, the IPC and the progress
 * events live in main.js; what is here is the part that can be wrong in ways a
 * screenshot would not show.
 *
 * ## Why an encode is not finished when ffmpeg exits 0
 *
 * This is the whole reason this file is more than a `spawn` call. During the
 * tests that produced shared/renderFormat.js, an Adobe Media Encoder export
 * produced **1108 frames at 29.97fps from an 1850-frame 50fps source**. Exit
 * code fine. File plays. Thumbnail correct. Two thirds of the motion gone, and
 * nothing anywhere said so — it would have been discovered months later, by
 * someone trying to use the slow motion they thought they had archived.
 *
 * So `verify` re-opens the output and asserts it against the source: same
 * displayed size, same frame rate, the frame count the cut asked for, 10-bit
 * Main 10. A file that fails is reported as a failure and not counted, which is
 * the only way the "2TB became 195GB" number at the end means anything.
 *
 * ## The rotation trap, which is the one that nearly got through
 *
 * ffmpeg applies the display matrix on decode and writes upright pixels. A
 * source coded 1920x1080 with `rotation: 90` therefore produces a correct
 * output that is 1080x1920 with no rotation flag at all. A verifier comparing
 * `width` to `width` fails it — and in this library that is two files in five.
 * The comparison has to be against the source's *displayed* size, which is why
 * `sourceFacts` computes one and the assertion uses it.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  EXPECTED_PIX_FMT,
  EXPECTED_PROFILE,
  cutArgs,
  probeArgs,
} from '../shared/renderFormat.js'

const run = promisify(execFile)

/**
 * How far a duration may be out before it is a failure, in seconds.
 *
 * A cut's last frame is a whole frame, so an output is routinely a fraction of
 * a frame longer than asked for, and a container rounds its duration to its own
 * timescale. One second is far looser than either and still an order of
 * magnitude tighter than the failure this is here to catch, which lost a third
 * of the duration outright.
 */
const DURATION_TOLERANCE_S = 1

/**
 * How many frames out a cut may be.
 *
 * Two, not zero. `-ss` lands on a frame boundary and `-t` admits the frame that
 * straddles the end, so a cut can legitimately come out a frame either side of
 * `round(duration * fps)`. The error being guarded against is proportional — a
 * rate conform loses a third of them — so a tolerance of two frames costs
 * nothing and avoids failing correct files.
 */
const FRAME_TOLERANCE = 2

/** Where ffmpeg and ffprobe were found, once found. */
let tools = null

/**
 * Finds ffmpeg and ffprobe, or says why not.
 *
 * PATH first, because that is where a `winget`, `brew` or package-manager
 * install puts them and it is what the shell would use. Then the handful of
 * places a Windows install actually lands, so someone who installed ffmpeg
 * without putting it on PATH gets a working app instead of a support question.
 *
 * Checked by running them, not by stat'ing the file: a path that exists and
 * cannot execute is the same problem as one that is missing, and it is better
 * to find that out here than on the first encode of a nine-hour batch.
 *
 * @returns {Promise<{ ok: true, ffmpeg: string, ffprobe: string, version: string }
 *   | { ok: false, error: string }>}
 */
export async function findTools() {
  if (tools) return tools

  const candidates = ['ffmpeg']
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) {
      candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'))
    }
    candidates.push(
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    )
  } else {
    candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
  }

  for (const ffmpeg of candidates) {
    try {
      const { stdout } = await run(ffmpeg, ['-hide_banner', '-version'])
      const version = stdout.split('\n')[0].trim()
      // ffprobe ships beside ffmpeg in every distribution of it.
      const ffprobe =
        ffmpeg === 'ffmpeg'
          ? 'ffprobe'
          : path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'))
      await run(ffprobe, ['-hide_banner', '-version'])
      tools = { ok: true, ffmpeg, ffprobe, version }
      return tools
    } catch {
      // Try the next one. Only the last failure is worth reporting.
    }
  }

  return {
    ok: false,
    error:
      'ffmpeg and ffprobe were not found. Install ffmpeg and make sure it is on PATH ' +
      '(on Windows: winget install Gyan.FFmpeg), then try again.',
  }
}

/** Forgets the cached discovery, so a harness can re-run it. */
export function resetTools() {
  tools = null
}

/**
 * Whether this machine can encode with NVENC at all.
 *
 * Asked once and reported plainly rather than discovered as a failed encode:
 * `hevc_nvenc` present in the build does not mean a usable GPU is behind it,
 * and the difference between "no NVIDIA card" and "your first 400 encodes
 * failed" is worth a single probe up front.
 *
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function checkEncoder() {
  const found = await findTools()
  if (!found.ok) return { ok: false, error: found.error }
  try {
    const { stdout } = await run(found.ffmpeg, ['-hide_banner', '-encoders'])
    if (!stdout.includes('hevc_nvenc')) {
      return { ok: false, error: 'This ffmpeg build has no hevc_nvenc encoder.' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * What a file is, as ffprobe sees it.
 *
 * `display` is the shape on screen, with rotation applied — the number a
 * verification has to compare against. See the rotation trap above.
 *
 * @param {string} ffprobe
 * @param {string} file
 */
export async function sourceFacts(ffprobe, file) {
  /*
   * Every stream, not `v:0`, so one probe answers both questions — what the
   * picture is, and whether there is any sound to carry. The second is what
   * lets a verification tell "this output has no audio because the clip was
   * muted" apart from "because the source never had any", which is the
   * difference between a correct file and a silently wrong one.
   *
   * Unlike `probeArgs`, dropping the stream selector costs nothing here: there
   * is no `-count_frames` in this call, so ffprobe is reading headers rather
   * than decoding.
   */
  const { stdout } = await run(
    ffprobe,
    [
      '-v', 'error',
      '-show_entries',
      'stream=codec_type,width,height,r_frame_rate,nb_frames,profile,pix_fmt:stream_side_data=rotation:format=duration,size',
      '-print_format', 'json',
      '--', file,
    ],
    { maxBuffer: 8 << 20 },
  )
  const parsed = JSON.parse(stdout)
  const streams = parsed.streams ?? []
  const stream = streams.find((one) => one.codec_type === 'video')
  if (!stream) throw new Error(`${path.basename(file)} has no video stream`)
  const hasAudio = streams.some((one) => one.codec_type === 'audio')

  const rotationRaw = Number(
    (stream.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0,
  )
  const rotation = ((rotationRaw % 360) + 360) % 360
  const quarter = rotation === 90 || rotation === 270

  return {
    coded: { width: stream.width, height: stream.height },
    display: quarter
      ? { width: stream.height, height: stream.width }
      : { width: stream.width, height: stream.height },
    rotation,
    frameRate: rateOf(stream.r_frame_rate),
    profile: stream.profile,
    pixFmt: stream.pix_fmt,
    hasAudio,
    duration: Number(parsed.format?.duration ?? 0),
    bytes: Number(parsed.format?.size ?? 0),
  }
}

/**
 * Whether a file carries any sound.
 *
 * Its own tiny probe because the output is checked with `probeArgs`, which
 * carries `-count_frames` and a `v:0` selector — counting every audio frame of
 * a two-minute clip to find out whether the stream exists would be minutes of
 * decoding for a yes or no.
 *
 * @param {string} ffprobe
 * @param {string} file
 */
async function hasAudioStream(ffprobe, file) {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type',
     '-print_format', 'json', '--', file],
    { maxBuffer: 8 << 20 },
  )
  return (JSON.parse(stdout).streams ?? []).length > 0
}

/** `30000/1001` -> 29.97. A rate is a ratio in the container, not a decimal. */
function rateOf(text) {
  if (!text) return 0
  const [num, den] = String(text).split('/').map(Number)
  if (!den) return num || 0
  return num / den
}

/**
 * Checks an output against the source and the format it was supposed to be.
 *
 * @param {string} ffprobe
 * @param {object} job
 * @param {ReturnType<typeof sourceFacts> extends Promise<infer T> ? T : never} source
 * @returns {Promise<{ ok: true, facts: object } | { ok: false, error: string, facts?: object }>}
 */
export async function verify(ffprobe, job, source) {
  /*
   * A sound-only render has no picture to measure, so none of the assertions
   * below apply — size, rate and frame count are all about a stream that was
   * deliberately not written. What is left is the two things that still mean
   * something: there must be sound, and there must be no picture.
   *
   * The second half matters as much as the first. Without it, flicking Video
   * off and rendering again would be skipped by resume: the old file with its
   * picture passes every check that remains.
   */
  if (job.video === false) {
    let length = 0
    try {
      const { stdout } = await run(
        ffprobe,
        ['-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration,size',
         '-print_format', 'json', '--', job.output],
        { maxBuffer: 8 << 20 },
      )
      const parsed = JSON.parse(stdout)
      const streams = parsed.streams ?? []
      const sound = streams.find((one) => one.codec_type === 'audio')
      const picture = streams.find((one) => one.codec_type === 'video')
      if (picture) return { ok: false, error: 'the output has a video stream, and this is a sound-only render' }
      if (!sound) return { ok: false, error: 'the output has no audio stream' }
      length = Number(sound.duration ?? parsed.format?.duration ?? 0)
      const facts = {
        width: 0,
        height: 0,
        frameRate: 0,
        frames: 0,
        duration: length,
        bytes: Number(parsed.format?.size ?? 0),
        hasAudio: true,
        soundOnly: true,
      }
      if (length > 0 && Math.abs(length - job.duration) > DURATION_TOLERANCE_S) {
        return {
          ok: false,
          error: `the audio is ${length.toFixed(2)}s, expected ${job.duration.toFixed(2)}s`,
          facts,
        }
      }
      return { ok: true, facts }
    } catch (err) {
      return { ok: false, error: `could not probe the output: ${err.message}` }
    }
  }

  let facts
  try {
    const { stdout } = await run(ffprobe, probeArgs(job.output), { maxBuffer: 8 << 20 })
    const parsed = JSON.parse(stdout)
    const stream = parsed.streams?.[0]
    if (!stream) return { ok: false, error: 'the output has no video stream' }
    facts = {
      width: stream.width,
      height: stream.height,
      frameRate: rateOf(stream.r_frame_rate),
      frames: Number(stream.nb_read_frames ?? 0),
      profile: stream.profile,
      pixFmt: stream.pix_fmt,
      duration: Number(parsed.format?.duration ?? stream.duration ?? 0),
      bytes: Number(parsed.format?.size ?? 0),
      hasAudio: await hasAudioStream(ffprobe, job.output),
    }
  } catch (err) {
    return { ok: false, error: `could not probe the output: ${err.message}` }
  }

  const problems = []

  /*
   * Against the *displayed* size. ffmpeg bakes rotation into the pixels, so a
   * rotated source legitimately changes shape here and comparing coded sizes
   * would fail two files in five.
   *
   * Unless a scale was asked for, in which case that is the size to check —
   * a job told to produce 1920x1080 is wrong if it produced the source's
   * shape, however faithfully.
   */
  const wantedSize = job.scale ?? source.display
  if (facts.width !== wantedSize.width || facts.height !== wantedSize.height) {
    problems.push(
      `size is ${facts.width}x${facts.height}, expected ${wantedSize.width}x${wantedSize.height}`,
    )
  }

  /*
   * The rate asked for, which is the source's unless the job forced one.
   *
   * It has to be the request rather than the source, now that a job can
   * legitimately change the rate — a speed change forces one so the output is
   * not a 100fps file, and the sequence-rate policy forces one on purpose.
   * What this still catches is the failure it was built for: a rate that
   * nobody asked for, which is how an 1850-frame 50fps source became 1108
   * frames at 29.97 and looked perfectly healthy.
   */
  const wantedRate = job.frameRate || source.frameRate
  if (Math.abs(facts.frameRate - wantedRate) > 0.01) {
    problems.push(
      `frame rate is ${facts.frameRate.toFixed(3)}, expected ${wantedRate.toFixed(3)}`,
    )
  }

  const wantedFrames = Math.round(job.duration * wantedRate)
  if (Math.abs(facts.frames - wantedFrames) > FRAME_TOLERANCE) {
    problems.push(`${facts.frames} frames, expected about ${wantedFrames}`)
  }

  if (Math.abs(facts.duration - job.duration) > DURATION_TOLERANCE_S) {
    problems.push(`duration is ${facts.duration.toFixed(2)}s, expected ${job.duration.toFixed(2)}s`)
  }

  if (facts.profile !== EXPECTED_PROFILE) {
    problems.push(`profile is ${facts.profile}, expected ${EXPECTED_PROFILE}`)
  }
  if (facts.pixFmt !== EXPECTED_PIX_FMT) {
    problems.push(`pixel format is ${facts.pixFmt}, expected ${EXPECTED_PIX_FMT}`)
  }

  /*
   * Sound, against what the timeline said it should be — and this is here for
   * **resume** as much as for correctness.
   *
   * Without it, muting a track and rendering again would skip every clip:
   * `alreadyDone` asks the verifier, and a file with sound passes every check
   * above whether or not anyone wanted the sound. The archive would keep
   * whatever the first run happened to produce, permanently, and nothing would
   * say so.
   *
   * Asymmetric on purpose. "Silent, so there must be no audio" is always a
   * fair demand. "Not silent, so there must be audio" is only fair when the
   * source had some — which is why `sourceFacts` reports it, and why a caller
   * that does not know (the sequence render, which does its own audio check)
   * simply does not trigger this branch.
   */
  if (job.silent && facts.hasAudio) {
    problems.push('the output has sound, and this clip was muted on the timeline')
  } else if (!job.silent && source.hasAudio === true && !facts.hasAudio) {
    problems.push('the output has no sound, and its source has some')
  }

  return problems.length === 0
    ? { ok: true, facts }
    : { ok: false, error: problems.join('; '), facts }
}

/**
 * Encodes one cut, verifies it, and reports what happened.
 *
 * Writes to a temporary name and renames on success, for the reason the project
 * document is written the same way: a crash or a cancel partway through must
 * not leave a half-written file sitting where a finished one should be. A
 * resumable batch asks "does the output exist" to decide what to skip, and a
 * truncated file that answers yes is a hole in the archive that nothing would
 * ever find.
 *
 * @param {object} args
 * @param {object} args.job   { source, output, offset, duration, sourceBytes, wholeFile }
 *   `sourceBytes` is the share of the source this cut uses, not the whole
 *   file — see ExportJob in kernel/batchExport.ts for why.
 * @param {(progress: { seconds: number, speed: number | null }) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {{ cq?: number, gop?: number }} [args.options]
 */
export async function encodeCut({ job, onProgress, signal, options = {} }) {
  const found = await findTools()
  if (!found.ok) return { ok: false, stage: 'tools', error: found.error }

  let source
  try {
    source = await sourceFacts(found.ffprobe, job.source)
  } catch (err) {
    return { ok: false, stage: 'probe', error: err.message }
  }

  await fs.mkdir(path.dirname(job.output), { recursive: true })

  /*
   * A temporary beside the target rather than in the system temp directory, so
   * the rename is within one filesystem and therefore atomic. Across volumes a
   * "rename" is a copy, which is minutes for a large file and not atomic at all.
   */
  const partial = `${job.output}.flux-part`
  const args = cutArgs({ ...job, output: partial }, options)

  const encoded = await new Promise((resolve) => {
    const child = spawn(found.ffmpeg, args, { windowsHide: true })
    let stderr = ''

    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })

    /*
     * Progress comes off stderr, which is where ffmpeg puts `-stats`. Parsed
     * for the time reached rather than a percentage: this is the only honest
     * number ffmpeg gives, and the caller knows the duration and can do the
     * division itself.
     */
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr = (stderr + text).slice(-4000)
      if (!onProgress) return
      const at = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (at) {
        const seconds = Number(at[1]) * 3600 + Number(at[2]) * 60 + Number(at[3])
        const speed = /speed=\s*([\d.]+)x/.exec(text)
        onProgress({ seconds, speed: speed ? Number(speed[1]) : null })
      }
    })

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, error: err.message, stderr })
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return resolve({ ok: false, cancelled: true, stderr })
      resolve(
        code === 0
          ? { ok: true, stderr }
          : { ok: false, error: `ffmpeg exited ${code}: ${lastLine(stderr)}`, stderr },
      )
    })
  })

  if (!encoded.ok) {
    await fs.rm(partial, { force: true })
    return encoded.cancelled
      ? { ok: false, stage: 'cancelled', cancelled: true }
      : { ok: false, stage: 'encode', error: encoded.error }
  }

  const checked = await verify(found.ffprobe, { ...job, output: partial }, source)
  if (!checked.ok) {
    /*
     * The failed output is kept, with its temporary name, rather than deleted.
     * A file that failed verification is evidence — it is how the one clip that
     * went wrong gets diagnosed — and `.flux-part` means no resume will ever
     * mistake it for a finished encode.
     */
    return { ok: false, stage: 'verify', error: checked.error, facts: checked.facts, kept: partial }
  }

  /*
   * Never write a bigger file.
   *
   * Some of this material is already a delivery export at 35 Mbps, and some of
   * it is short enough that a container's overhead outweighs the saving. Where
   * the encode lost, the original wins — but only for a cut that *is* the whole
   * file, because for a trim there is no original of that range to keep. A
   * losing trim is reported and kept; it is still smaller than the whole source
   * it came from.
   */
  /*
   * Never on a sound-only render. The rule falls back to *keeping the
   * original*, and the original has a picture in it — answering "your audio
   * export was bigger than the source" with the whole video file is not a
   * smaller file, it is the wrong file.
   */
  const grew = job.sourceBytes > 0 && checked.facts.bytes >= job.sourceBytes
  if (grew && job.wholeFile && job.video !== false) {
    await fs.rm(partial, { force: true })
    const copy = path.join(
      path.dirname(job.output),
      path.basename(job.output, path.extname(job.output)) + path.extname(job.source),
    )
    await fs.copyFile(job.source, copy)
    return {
      ok: true,
      keptOriginal: true,
      output: copy,
      bytes: job.sourceBytes,
      sourceBytes: job.sourceBytes,
      ratio: 1,
      facts: checked.facts,
      source,
    }
  }

  await fs.rename(partial, job.output)
  return {
    ok: true,
    keptOriginal: false,
    output: job.output,
    bytes: checked.facts.bytes,
    sourceBytes: job.sourceBytes,
    ratio: job.sourceBytes > 0 ? job.sourceBytes / checked.facts.bytes : 0,
    grew,
    facts: checked.facts,
    source,
  }
}

function lastLine(text) {
  const lines = String(text).trim().split('\n').filter(Boolean)
  return lines[lines.length - 1] ?? 'no output'
}

/**
 * Whether an output is already there and sound, for a resumable batch.
 *
 * Verified, not merely present. Trap 6 in the brief is "skip files already
 * encoded AND verified, so a crash at hour 9 does not re-do hours 1-8" — and
 * the `AND` is the whole point: skipping on existence alone would permanently
 * adopt whatever a killed process left behind.
 *
 * @param {object} job
 */
export async function alreadyDone(job) {
  const found = await findTools()
  if (!found.ok) return false
  try {
    await fs.access(job.output)
  } catch {
    return false
  }
  try {
    const source = await sourceFacts(found.ffprobe, job.source)
    const checked = await verify(found.ffprobe, job, source)
    return checked.ok
  } catch {
    return false
  }
}
