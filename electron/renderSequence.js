/**
 * Running one sequence render: the composite, and what makes it count as done.
 *
 * electron/render.js is the same thing for one cut, and the two are deliberately
 * siblings rather than one function with a flag. They differ in what they hand
 * ffmpeg — one cut versus a filter graph — and agree on everything else: the
 * tools are found by `findTools`, the output is checked by `verify`, the write
 * goes to a `.flux-part` temporary and is renamed on success. Everything in
 * shared/renderFormat.js is used unchanged, flag for flag.
 *
 * No `electron` import, so scripts/verify-sequence-render.mjs can drive this
 * against real footage with no app running. Same rule as render.js, same reason.
 *
 * ## "The source" is now the sequence
 *
 * The verification rules do not change — see the long note in render.js about
 * the Adobe export that turned an 1850-frame 50fps source into 1108 frames at
 * 29.97 and looked perfectly healthy — but what they are measured against does.
 * There is no single source file to compare a composite with. What a sequence
 * render must come out as is what the *sequence* says: its frame size, its
 * frame rate, and its length including any gap at the end.
 *
 * So `verify` is called with the sequence standing in for a source file, which
 * is why that function takes a facts object rather than reading a file itself.
 * Every assertion it makes still applies, including the duration and the
 * counted — not read — frame count.
 *
 * ## Why the sources are probed first
 *
 * A filter graph names a stream per input: `[3:a]` is input 3's first audio
 * stream. If input 3 has no audio, ffmpeg refuses the entire graph — so one
 * file that lost its sound would take a forty-minute render down with it, at
 * the start if you are lucky and never otherwise.
 *
 * An audio clip only exists on the timeline because the importer found audio in
 * the file (see addLinkedClips), so this should never fire. "Should never fire"
 * is exactly the kind of assumption that is worth one cheap ffprobe per
 * *distinct* source: a clip whose sound has gone is dropped from the mix and
 * said out loud, and a clip whose picture has gone fails the job with a
 * sentence naming the file rather than with a filter-graph syntax error.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { sequenceArgs } from '../shared/sequenceGraph.js'
import { findTools, verify } from './render.js'

const run = promisify(execFile)

/**
 * How far the output's audio may be from the sequence's length, in seconds.
 *
 * Looser than the video's one second because an AAC frame is 1024 samples and
 * the encoder pads to a whole frame at each end, and because the container
 * records the two streams' durations separately. What this is here to catch is
 * a mixdown that stopped where the last clip did, which is out by the length of
 * the trailing gap — seconds, not milliseconds.
 */
const AUDIO_TOLERANCE_S = 2

/**
 * Which streams a file has, as the graph needs to know it.
 *
 * @param {string} ffprobe
 * @param {string} file
 * @returns {Promise<{ video: boolean, audio: boolean }>}
 */
async function streamsOf(ffprobe, file) {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-print_format', 'json', '--', file],
    { maxBuffer: 8 << 20 },
  )
  const streams = JSON.parse(stdout).streams ?? []
  return {
    video: streams.some((stream) => stream.codec_type === 'video'),
    audio: streams.some((stream) => stream.codec_type === 'audio'),
  }
}

/**
 * Drops what cannot be read and says so, or refuses the job.
 *
 * @param {string} ffprobe
 * @param {import('../shared/sequenceGraph.js').SequenceJob} job
 * @returns {Promise<{ ok: true, job: object, warnings: string[] } | { ok: false, error: string }>}
 */
async function checkSources(ffprobe, job) {
  const sources = new Set([...job.video, ...job.audio].map((cut) => cut.source))
  const facts = new Map()
  for (const source of sources) {
    try {
      facts.set(source, await streamsOf(ffprobe, source))
    } catch (err) {
      return { ok: false, error: `${path.basename(source)} could not be read: ${err.message}` }
    }
  }

  const warnings = []
  for (const cut of job.video) {
    if (!facts.get(cut.source)?.video) {
      return { ok: false, error: `${path.basename(cut.source)} has no video stream` }
    }
  }
  const audio = job.audio.filter((cut) => {
    if (facts.get(cut.source)?.audio) return true
    warnings.push(`${path.basename(cut.source)} has no audio stream — left out of the mix`)
    return false
  })

  return { ok: true, job: { ...job, audio }, warnings }
}

/**
 * Checks a sequence render against what the sequence says it should be.
 *
 * Exported so the harness can point it at a deliberately wrong file. A verifier
 * that is only ever handed correct output is indistinguishable from no verifier
 * at all, which is why scripts/verify-sequence-render.mjs calls this one
 * directly on a truncated encode and requires it to say no.
 *
 * @param {string} ffprobe
 * @param {import('../shared/sequenceGraph.js').SequenceJob} job
 * @param {string} [file] the file to check, when it is not the job's output yet
 */
export async function verifySequence(ffprobe, job, file = job.output) {
  /*
   * The sequence, in the shape `verify` expects a source file in. Its frame is
   * the displayed size because there is no rotation to apply to a composite:
   * the layers were turned upright on the way in, and the frame they were drawn
   * into is the one the sequence settings name.
   */
  /*
   * No `hasAudio` and no `silent`, deliberately. Those two drive `verify`'s
   * sound check, which exists for the clip path — where a muted track means a
   * file with no audio stream at all. A composite always has an audio stream,
   * silent base and all, and whether it should be *quiet* is a question about
   * levels that the mixdown already answered. The real check for it is below,
   * against the sequence's length.
   */
  const asSource = {
    display: { width: job.width, height: job.height },
    frameRate: job.frameRate,
  }
  /*
   * `video: false` is what tells `verify` to measure a sound-only file — no
   * picture to compare, and a picture present means the switch was ignored.
   */
  const checked = await verify(
    ffprobe,
    { ...job, output: file, video: job.withVideo !== false },
    asSource,
  )
  if (!checked.ok) return checked
  if (job.withVideo === false) return checked

  /*
   * And then the half `verify` does not look at. A composite with no sound at
   * all, or with sound that stops where the last clip did rather than where the
   * sequence does, is a deliverable that is wrong in a way the picture checks
   * cannot see.
   */
  let sound
  try {
    const { stdout } = await run(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,channels,duration',
        '-print_format', 'json',
        '--', file,
      ],
      { maxBuffer: 8 << 20 },
    )
    sound = JSON.parse(stdout).streams?.[0]
  } catch (err) {
    return { ok: false, error: `could not probe the output's audio: ${err.message}`, facts: checked.facts }
  }

  if (!sound) {
    return { ok: false, error: 'the output has no audio stream', facts: checked.facts }
  }
  const length = Number(sound.duration ?? 0)
  if (length > 0 && Math.abs(length - job.duration) > AUDIO_TOLERANCE_S) {
    return {
      ok: false,
      error: `the audio is ${length.toFixed(2)}s, expected ${job.duration.toFixed(2)}s`,
      facts: checked.facts,
    }
  }

  return { ok: true, facts: { ...checked.facts, audioChannels: sound.channels, audioDuration: length } }
}

/**
 * Composites and encodes one sequence, verifies it, and reports what happened.
 *
 * The same temporary-then-rename as a cut, for the same reason: a crash partway
 * through must not leave a half-written file where a finished one should be,
 * because a resumable run asks "is the output there" and a truncated file that
 * answers yes is a hole nothing would ever find.
 *
 * The filter graph is written beside the temporary and removed on success. It
 * is kept when the render fails, next to the `.flux-part` file that failed,
 * because a composite that came out wrong is diagnosed by reading the graph
 * that produced it and there is no other copy of it anywhere.
 *
 * @param {object} args
 * @param {import('../shared/sequenceGraph.js').SequenceJob} args.job
 * @param {(progress: { seconds: number, speed: number | null }) => void} [args.onProgress]
 * @param {(message: string) => void} [args.onWarning]
 * @param {AbortSignal} [args.signal]
 * @param {{ cq?: number, gop?: number }} [args.options]
 */
export async function encodeSequence({ job, onProgress, onWarning, signal, options = {} }) {
  const found = await findTools()
  if (!found.ok) return { ok: false, stage: 'tools', error: found.error }

  if (!(job.duration > 0)) {
    return { ok: false, stage: 'plan', error: 'the sequence has no length' }
  }

  const checked = await checkSources(found.ffprobe, job)
  if (!checked.ok) return { ok: false, stage: 'probe', error: checked.error }
  for (const warning of checked.warnings) onWarning?.(warning)
  const ready = checked.job

  await fs.mkdir(path.dirname(job.output), { recursive: true })

  // Beside the target rather than in the system temp directory, so the rename
  // is within one filesystem and therefore atomic.
  const partial = `${job.output}.flux-part`
  const { args, graph } = sequenceArgs({ ...ready, output: partial }, options)
  const graphFile = `${partial}.flux-graph`
  await fs.writeFile(graphFile, graph, 'utf8')

  const encoded = await new Promise((resolve) => {
    const child = spawn(found.ffmpeg, args, { windowsHide: true })
    let stderr = ''

    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })

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
    if (encoded.cancelled) {
      // A cancel is not a diagnosis, so the graph goes too.
      await fs.rm(graphFile, { force: true })
      return { ok: false, stage: 'cancelled', cancelled: true }
    }
    return { ok: false, stage: 'encode', error: encoded.error, kept: graphFile }
  }

  const result = await verifySequence(found.ffprobe, { ...ready, output: partial }, partial)
  if (!result.ok) {
    /*
     * The failed output and its graph are both kept, under temporary names. A
     * composite that failed verification is the only evidence there is of how,
     * and `.flux-part` means no resume will mistake it for finished work.
     */
    return {
      ok: false,
      stage: 'verify',
      error: result.error,
      facts: result.facts,
      kept: partial,
      graph: graphFile,
    }
  }

  await fs.rm(graphFile, { force: true })
  await fs.rename(partial, job.output)

  /*
   * No never-write-a-bigger-file rule here, and its absence is deliberate.
   * That rule answers "the encode cost more than the footage it came from, so
   * keep the original" — and a composite has no original. There is no file on
   * disk that is this sequence; that is the entire point of rendering it. The
   * ratio is still reported, because it is still the honest measure of what the
   * render cost against what it read.
   */
  return {
    ok: true,
    keptOriginal: false,
    output: job.output,
    bytes: result.facts.bytes,
    sourceBytes: job.sourceBytes,
    ratio: job.sourceBytes > 0 ? job.sourceBytes / result.facts.bytes : 0,
    facts: result.facts,
    source: { frameRate: job.frameRate, display: { width: job.width, height: job.height } },
    warnings: checked.warnings,
  }
}

function lastLine(text) {
  const lines = String(text).trim().split('\n').filter(Boolean)
  return lines[lines.length - 1] ?? 'no output'
}

/**
 * Whether a sequence render is already there and sound, for a resumable queue.
 *
 * Verified, not merely present — the same `AND` that `alreadyDone` in render.js
 * insists on. Skipping on existence alone would permanently adopt whatever a
 * killed process left behind.
 *
 * @param {import('../shared/sequenceGraph.js').SequenceJob} job
 */
export async function sequenceAlreadyDone(job) {
  const found = await findTools()
  if (!found.ok) return false
  try {
    await fs.access(job.output)
  } catch {
    return false
  }
  try {
    const checked = await verifySequence(found.ffprobe, job)
    return checked.ok
  } catch {
    return false
  }
}
