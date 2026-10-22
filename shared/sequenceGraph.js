/**
 * The whole sequence as one file: the ffmpeg filter graph that composites it.
 *
 * shared/renderFormat.js turns one clip into one file, and `cutArgs` is almost
 * all of it — a cut is an `-ss`, a `-t` and the encoder. A sequence is not,
 * because a sequence has layers, gaps, clips of different shapes and clips with
 * rotation, and all four have to be decided somewhere. This is that somewhere,
 * and it is shared for the same reason the encode is: the main process runs it,
 * the harness checks it, and two copies of a filter graph drift.
 *
 * The encode itself is unchanged — `encodeArgs` from renderFormat.js, flag for
 * flag. Only what reaches the encoder is different.
 *
 * ## Why a filter graph and not the Viewer's canvas
 *
 * The Viewer already composites: it decodes through WebCodecs, draws each
 * layer into the sequence's frame with `drawUpright`, and that is a working
 * compositor sitting right there. Piping its canvas to ffmpeg would reuse it.
 *
 * It would also mean decoding every frame in the renderer, reading it back out
 * of a canvas, and pushing it through IPC into an encoder — a decode, a
 * rasterise, a copy and an encode per frame, with a nine-hour render at the
 * mercy of a panel being closed, which is the exact thing electron/renderQueue
 * exists to avoid. ffmpeg can do the whole composite natively on the frames it
 * is already decoding. The cost of going native is that gaps, differing source
 * sizes, rotation and per-clip speed each have to be handled explicitly rather
 * than falling out of a canvas, so each gets a named decision below.
 *
 * ## The shape of the graph
 *
 * One opaque black base the length of the sequence, and one `overlay` per clip
 * on top of it, bottom track first:
 *
 *     color=black:s=WxH:r=R:d=D  ──────────────────────────────────[b]
 *     clip 0 ─ retime ─ fit ─ pad transparent ───────────────────── [v0]
 *     [b][v0] overlay ──────────────────────────────────────────────[x0]
 *     [x0][v1] overlay ─────────────────────────────────────────────[x1]  …
 *
 * Four things follow from that and each is the answer to one of the four
 * problems:
 *
 *   - **Gaps are black and silence, and the file is not shorter.** The base is
 *     `d=D` and the output is `-t D`, so the length is decided by the sequence
 *     rather than by where the clips happen to stop. Time with nothing under it
 *     shows the base, which is black; the audio mix has a full-length silent
 *     input under it for the same reason.
 *   - **Layers stack in track order.** Overlays are applied bottom track
 *     upward, so the last one written is in front — the same order the Viewer
 *     draws in, and for the same reason.
 *   - **Different source sizes compose.** Every clip is scaled to *fit* the
 *     sequence frame, keeping its aspect, and padded out to the full frame with
 *     **transparent** rather than black. Transparent is what makes it a
 *     composite: a portrait clip over a landscape one has to let the layer
 *     beneath it show down each side, and padding with black would paint over
 *     it. This is `fitted()` in ViewerPanel.tsx expressed as a filter.
 *   - **Rotation is applied, not baked.** Nothing here transposes. ffmpeg
 *     applies the container's display matrix on decode, so the frames arriving
 *     at `scale` are already upright and `scale` therefore sees the *displayed*
 *     size — which is the whole point, because two files in five in this
 *     library are coded 1920x1080 with `rotation: 90`. Scaling before the
 *     rotation would fit a vertical clip to a landscape box and then turn it.
 *     The same property `cutArgs` relies on, got for free by not interfering.
 *
 * ## Placement is absolute, and that is what keeps it in step
 *
 * Each clip's frames are stamped with where they belong in the sequence —
 * `setpts=…+start/TB` — and `overlay` pairs frames by timestamp, so a clip
 * lands at its own `start` and nowhere else.
 *
 * The obvious alternative was to build one full-length stream per track by
 * `concat`-ing clips and generated gaps. It was rejected: `concat` renumbers
 * timestamps from the start of the lane, so every segment's rounding adds to
 * the one before it, and a lane of fifty clips can drift a second away from the
 * base by its end — an upper layer appearing a frame or two early, deep into a
 * long sequence, which is precisely the kind of wrongness nobody finds by
 * watching. Absolute placement cannot accumulate: each clip's error is its own
 * and is at most half a frame.
 *
 * Clips need no padding to reach the sequence's length either. `eof_action=pass`
 * passes the base through once a clip's frames run out, and `overlay` already
 * passes the base through before a clip's first frame arrives. Verified on real
 * footage: a 2s clip placed at 110s of a 120s sequence produced exactly 3000
 * frames at 25fps, black at 50s and at 115s, content at 111s, and streamed at
 * 7.8x realtime without buffering the 110 seconds it was waiting through.
 *
 * ## Ten bits all the way through
 *
 * The base, every clip and every overlay are 10-bit — `yuv420p10le` and
 * `yuva420p10le`, with `format=yuv420p10` on the overlays. Compositing at eight
 * bits and encoding the result to `p010le` would throw away exactly the bits
 * that flag exists to keep: this material is 10-bit 4:2:2 in, and the archive
 * is ten bits out because it gets re-encoded again when it is reused.
 */

import { atempoChain, encodeArgs } from './renderFormat.js'

/**
 * @typedef {object} SequenceCut
 * @property {string} source absolute path to the file
 * @property {number} start seconds from the start of the sequence
 * @property {number} duration seconds of sequence it covers
 * @property {number} offset seconds into the source where it begins
 * @property {number} speed how fast the source runs; 1 when untouched
 * @property {number} [gain] linear multiplier, audio only — see trackLevel
 */

/**
 * @typedef {object} SequenceJob
 * @property {'sequence'} kind
 * @property {string} id
 * @property {string} name
 * @property {string} output absolute path to write
 * @property {number} width the frame everything is composited into
 * @property {number} height
 * @property {number} frameRate
 * @property {number} duration seconds of output
 * @property {number} [sampleRate] the sequence's rate; 48000 when it says nothing
 * @property {number} [channels] 1 or 2
 * @property {SequenceCut[]} video bottom track first; already in draw order
 * @property {SequenceCut[]} audio every audible clip on an audio track
 * @property {number} sourceBytes the share of its sources the sequence reads
 */

/** Seconds, at six decimal places, which is far below one sample. */
function s(value) {
  return Number(value).toFixed(6)
}

/**
 * The one chain that turns a decoded clip into a layer.
 *
 * Read in order: put the frames where they belong in the sequence, land them on
 * the sequence's frame grid, fit them to the frame, give the rest of the frame
 * no pixels at all, and say the pixels are square.
 *
 * `format=yuva420p10le` comes **before** `pad`, and that order is the whole
 * transparency of the padding: `pad` fills with the colour it is given in the
 * format it is handed, and a frame with no alpha channel yet cannot be padded
 * with something see-through — it comes out opaque black, which paints over
 * every layer underneath.
 *
 * @param {number} input which `-i` this clip is
 * @param {SequenceCut} cut
 * @param {SequenceJob} job
 */
function videoChain(input, cut, job) {
  const speed = cut.speed > 0 ? cut.speed : 1
  const stretched = Math.abs(speed - 1) > 1e-9
  /*
   * `PTS-STARTPTS` zeroes the clip's own clock, the division is the speed
   * change, and `+start/TB` is where it goes. Division binds tighter than
   * addition in ffmpeg's expression language, so the speed applies to the
   * clip's time and not to its placement.
   */
  const pts = stretched
    ? `setpts=(PTS-STARTPTS)/${speed}+${s(cut.start)}/TB`
    : `setpts=PTS-STARTPTS+${s(cut.start)}/TB`

  return (
    `[${input}:v]${pts},` +
    `fps=${job.frameRate},` +
    `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease,` +
    `format=yuva420p10le,` +
    `pad=${job.width}:${job.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
    `setsar=1[v${input}]`
  )
}

/**
 * The chain for one clip's sound.
 *
 * `adelay` places it, which is the audio equivalent of the `setpts` offset
 * above and is applied *after* the speed change for the same reason: a
 * stretched clip is shorter or longer than its source, and where it starts is
 * not.
 *
 * The gain is linear and comes from the sequence, not from here: see
 * `trackLevel` in kernel/media/mixer.ts, which is the one place mute, solo and
 * the fader are turned into a number. The render agrees with what was heard
 * because it asks the same function.
 *
 * @param {number} input
 * @param {SequenceCut} cut
 * @param {SequenceJob} job
 * @param {{ sampleRate: number, layout: string }} audio
 */
function audioChain(input, cut, job, audio) {
  const speed = cut.speed > 0 ? cut.speed : 1
  const stretched = Math.abs(speed - 1) > 1e-9
  const steps = [`[${input}:a]asetpts=PTS-STARTPTS`]
  if (stretched) steps.push(atempoChain(speed))
  steps.push(`aresample=${audio.sampleRate}`)
  steps.push(`aformat=sample_fmts=fltp:channel_layouts=${audio.layout}`)
  // Unity is skipped rather than written as `volume=1`, so a graph read by hand
  // only mentions the tracks someone actually moved.
  if (Math.abs((cut.gain ?? 1) - 1) > 1e-6) steps.push(`volume=${cut.gain.toFixed(6)}`)
  if (cut.start > 0) steps.push(`adelay=${Math.round(cut.start * 1000)}:all=1`)
  return `${steps.join(',')}[a${input}]`
}

/**
 * Everything needed to render one sequence: the inputs, the graph, the encode.
 *
 * The graph comes back as a *string to be written to a file* rather than as an
 * argument, and that is not tidiness. Windows caps a command line at about
 * 32,000 characters; one clip is roughly 200 of them, so a sequence of a
 * hundred and fifty clips would simply refuse to start — and it would refuse
 * with an error about the command line rather than about the render. ffmpeg
 * reads a graph from a file with `-filter_complex_script`, so there is no limit
 * to hit.
 *
 * The audio format comes off the **job** rather than out of the options,
 * because it is part of the sequence and so part of the snapshot: a job queued
 * from a 48kHz stereo sequence must still render 48kHz stereo after someone has
 * changed that sequence's settings.
 *
 * @param {SequenceJob} job
 * @param {{ cq?: number, gop?: number }} [options]
 * @returns {{ args: string[], graph: string, inputs: number }}
 */
export function sequenceArgs(job, options = {}) {
  const audio = {
    sampleRate: job.sampleRate ?? 48000,
    /*
     * Mono or stereo. A sequence can say up to eight channels and this mixes
     * anything above two down to stereo rather than guessing at a surround
     * layout — the mixer plays through a stereo master too, so a stereo render
     * is the one that agrees with what was heard. Worth revisiting the day the
     * mixer grows a channel map; until then an honest downmix beats a 5.1 file
     * whose rear channels nobody has ever listened to.
     */
    layout: (job.channels ?? 2) === 1 ? 'mono' : 'stereo',
  }

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats']
  const chains = []

  /*
   * Sound only, when the Video switch is off. The picture half of the graph is
   * not built at all rather than built and then dropped with `-vn`: a composite
   * nobody is going to keep still costs every decode and every overlay, and on
   * a long sequence that is the whole render time for a file with no picture
   * in it.
   */
  const withVideo = job.withVideo !== false

  /*
   * The base: opaque black, the sequence's size and rate, the sequence's whole
   * length. It is what a gap is, and it is what fixes the output's duration —
   * so a sequence whose last clip ends early still comes out its stated length,
   * rather than silently stopping where the footage did.
   */
  if (withVideo) {
    chains.push(
      `color=c=black:s=${job.width}x${job.height}:r=${job.frameRate}:` +
        `d=${s(job.duration)},format=yuv420p10le,setsar=1[b]`,
    )
  }

  /** `-i` index of the next input, which is also the clip's label number. */
  let input = 0
  const addInput = (cut) => {
    const speed = cut.speed > 0 ? cut.speed : 1
    // Before `-i`, which is both the fast seek and — re-encoding, as here — a
    // frame-accurate one. The read limit is the span of source the clip covers,
    // which a stretch makes longer or shorter than the clip itself.
    if (cut.offset > 0) args.push('-ss', s(cut.offset))
    args.push('-t', s(cut.duration * speed))
    args.push('-i', cut.source)
    return input++
  }

  const videoLabels = []
  if (withVideo) {
    for (const cut of job.video) {
      const index = addInput(cut)
      chains.push(videoChain(index, cut, job))
      videoLabels.push(`v${index}`)
    }
  }

  const audioLabels = []
  for (const cut of job.audio) {
    const index = addInput(cut)
    chains.push(audioChain(index, cut, job, audio))
    audioLabels.push(`a${index}`)
  }

  /*
   * Bottom track first, so the last overlay written is the layer in front.
   * `eof_action=pass` is what lets a clip be shorter than the sequence: once
   * its frames run out the base passes through unchanged, instead of its last
   * frame being held to the end of the file.
   */
  let under = 'b'
  videoLabels.forEach((label, nth) => {
    const out = nth === videoLabels.length - 1 ? 'vout' : `x${nth}`
    chains.push(`[${under}][${label}]overlay=0:0:eof_action=pass:format=yuv420p10[${out}]`)
    under = out
  })
  // A sequence with no picture anywhere is black for its whole length, which is
  // a truthful render of an empty video track rather than a failure.
  if (withVideo && videoLabels.length === 0) chains.push(`[b]null[vout]`)

  /*
   * Silence under the mix, the length of the sequence.
   *
   * Two jobs at once: it is what a gap in the audio sounds like, and it is what
   * makes `duration=longest` mean the sequence's length rather than whichever
   * clip happens to end last.
   */
  chains.push(
    `anullsrc=channel_layout=${audio.layout}:sample_rate=${audio.sampleRate},` +
      `atrim=duration=${s(job.duration)}[asil]`,
  )
  if (audioLabels.length === 0) {
    chains.push(`[asil]anull[aout]`)
  } else {
    /*
     * `normalize=0` is mandatory. amix divides by the number of inputs by
     * default, so adding a second audio track would halve the first one — a
     * mixdown that gets quieter the more you put in it, which is not what any
     * mixer does and not what was heard on playback. `dropout_transition=0`
     * stops it ramping the remaining inputs up when one ends, which would move
     * a level nobody touched.
     */
    chains.push(
      `[asil]${audioLabels.map((label) => `[${label}]`).join('')}` +
        `amix=inputs=${audioLabels.length + 1}:duration=longest:` +
        `normalize=0:dropout_transition=0[aout]`,
    )
  }

  args.push('-filter_complex_script', `${job.output}.flux-graph`)
  if (withVideo) args.push('-map', '[vout]')
  args.push('-map', '[aout]')
  args.push(...encodeArgs(options))
  /*
   * The rate is forced, and here that is a statement rather than a conform: a
   * sequence has a frame rate of its own, every layer in it has just been
   * resampled to that rate, and the output is what the sequence is. It is the
   * same mechanism a speed change and the clip-mode conform policy use.
   */
  if (withVideo) args.push('-r', String(job.frameRate))
  // The length the sequence says it is, not the length the footage reaches.
  args.push('-t', s(job.duration))
  // The muxer stated, because the path handed to ffmpeg ends in `.flux-part`.
  args.push('-f', 'mp4')
  args.push('-y', job.output)

  // One chain per line, so a graph written to disk can be read when a render
  // goes wrong. ffmpeg accepts newlines between chains in a script.
  return { args, graph: `${chains.join(';\n')}\n`, inputs: input }
}
