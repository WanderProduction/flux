/**
 * The archive encode, and the evidence for every flag in it.
 *
 * One definition, imported by the renderer (to show what an export will do),
 * the main process (to run it) and the harness (to check it). The same reason
 * mediaTypes.js is shared: three copies of an encoder command drift, and a
 * drifted encoder setting is a library that is half one format.
 *
 * ## Where these numbers come from
 *
 * Not from taste. Each was measured against this library's own footage with
 * VMAF, comparing NVENC, x265 and Adobe Media Encoder on identical clips. The
 * short version:
 *
 *   - **NVENC at CQ 26 matched x265 CRF 20** on size (9.4 vs 9.5 Mbps) and
 *     mean quality, 10-13x faster.
 *   - **It beat Adobe Media Encoder at 70% lower bitrate.** AME's "Highest"
 *     at 10.7 Mbps scored a 1% low of 83.96; NVENC at 9.4 Mbps scored 91.65.
 *     Driven at the *same* bitrate on the same silicon, ffmpeg scored 99.28
 *     against AME's 98.49 — the gap is how AME drives the encoder, and it
 *     exposes no constant-quality mode at all, which is the thing a library
 *     mixing locked-off interviews with handheld night footage needs most.
 *   - Compression measured 10.6x to 23.9x across varied content; 12x is the
 *     conservative planning figure.
 *
 * ## Two findings worth keeping, because both are counterintuitive
 *
 * **Adaptive quantisation lost.** `-spatial-aq`, `-temporal-aq` and
 * `-rc-lookahead` were tested on four clips including deliberately-chosen hard
 * strobing footage, on the theory that it would help exactly there. It used
 * 9-16% more bitrate *and* scored worse on mean, 1% low and minimum, on 4 of 4.
 * It is therefore absent on purpose rather than by omission. The honest caveat:
 * VMAF under-rewards AQ because AQ targets banding, which VMAF barely weights.
 * The decision stands on consistency and on it also costing more — but if
 * banding ever shows up in dark gradients, re-test AQ by eye rather than by
 * VMAF.
 *
 * **Strobing footage is easier to compress, not harder.** The hardest-looking
 * clip in the library scored 99.91 VMAF at 5.8 Mbps. A strobe-lit room is
 * mostly near-black between flashes and blown flat during them, and neither
 * holds detail. What costs bitrate is fine detail in motion — daylight
 * foliage, crowds, texture. Nobody should over-engineer for the strobes.
 */

/**
 * Keyframe interval, in frames, and the one setting here that buys something
 * other than quality.
 *
 * NVENC's default GOP is 250 frames — 8.34 seconds — which makes a lossless
 * stream-copy trim useless: every cut snaps back up to eight seconds. At 30 it
 * is one second. Measured cost of getting there, on one clip:
 *
 *   GOP 250 -> 5.10 Mbps   GOP 60 -> 5.22 (+2.4%)
 *   GOP 30  -> 5.35 (+4.9%)   GOP 15 -> 5.54 (+8.6%)
 *
 * VMAF was flat across all four. The precision is bought with storage alone,
 * and 4.9% is the right trade: it is what makes the *archive* re-cuttable later
 * with `-c copy`, at no quality cost, without going back to the originals.
 */
export const GOP_FRAMES = 30

/** Constant-quality target. Worst 1% low measured anywhere at this value: 95.64 VMAF. */
export const CQ = 26

export const AUDIO_BITRATE = '192k'

/**
 * What the archive keeps, given what the source has.
 *
 * The chroma follows the source. A 4:2:2 source is archived 4:2:2; everything
 * else is archived 4:2:0, which is what every output before this was.
 *
 * This used to be two constants, and the comment on the pixel format said the
 * archive was 4:2:0 "to halve the chroma cost". Measured on 2026-11-01 across
 * four Fujifilm 4:2:2 clips, same arguments but the pixel format: keeping 4:2:2
 * costs **3–4% more weight** and no extra encode time. It does not halve
 * anything. The quality it buys back is small too — chroma SSIM +0.0003 to
 * +0.0007, luma identical — so both sides of that trade were small, and the
 * reason to take this side is the one the file already gives for keeping ten
 * bits: this footage is re-encoded when it is reused, and what survives the
 * second generation is what was kept in the first.
 *
 * It is also newly possible. `p210le` needs 4:2:2 NVENC encoding, which arrived
 * with the Blackwell generation — the ffmpeg `findTools` resolves advertises
 * `p210le` and `p216le` on `hevc_nvenc`, and the card here is an RTX 5060.
 *
 * **`profile` and `pixFmt` move together or not at all.** A 4:2:2 encode
 * reports profile `Rext`, not `Main 10` — the same profile the Fujifilm sources
 * themselves carry — so a verifier holding `Main 10` as a constant would reject
 * every 4:2:2 output it had just correctly written. That is why this returns
 * pairs and why the encode and the check read them from one function.
 *
 * `accept` is wider than `write` for a 4:2:2 source, and deliberately so. Every
 * output already in the archive came from the 4:2:0 era, and the verifier is
 * what `alreadyDone` asks on resume — demanding the new format would quietly
 * condemn the whole existing archive to a re-encode the moment anything touched
 * it. A 4:2:0 output of a 4:2:2 source is older than this change, not broken.
 * Re-encoding the archive to 4:2:2 is a thing to decide and run on purpose, not
 * a side effect of opening a project.
 *
 * The rest of the verification is unchanged, and it is there because the failure
 * it catches is silent: an Adobe export in the same test run produced 1108
 * frames at 29.97fps from an 1850-frame 50fps source, and the file looked
 * perfectly healthy. Nothing about it announced that two thirds of the motion
 * was gone.
 *
 * @param {string} [sourcePixFmt] the source's pixel format, from `sourceFacts`.
 *   Absent for the sequence render, which composites many sources into one
 *   frame and has no single answer — it stays 4:2:0, as it always was.
 */
export function archiveFormat(sourcePixFmt = '') {
  /** What ffprobe reports for each, which is not what ffmpeg is asked for. */
  const main10 = { profile: 'Main 10', pixFmt: 'yuv420p10le' }
  const rext422 = { profile: 'Rext', pixFmt: 'yuv422p10le' }
  // Nothing else in this library contains "422", and 4:4:4 is not archived
  // differently because nothing here is 4:4:4.
  return /422/.test(sourcePixFmt)
    ? { encode: 'p210le', write: rext422, accept: [rext422, main10] }
    : { encode: 'p010le', write: main10, accept: [main10] }
}

/**
 * The encoder arguments, in order.
 *
 * `-b:v 0` is **mandatory**, not redundant with `-rc vbr`: without it NVENC
 * silently caps the bitrate at a default and constant quality stops being
 * constant. `-tag:v hvc1` is also mandatory — without it HEVC-in-MP4 will not
 * play in QuickTime, Finder preview, or Premiere on macOS, which makes the
 * archive unusable on half the machines that need to read it.
 *
 * Deliberately absent:
 *
 *   - **No `-vf scale`.** 4K stays 4K. Punch-in and reframe is the main value
 *     of 4K b-roll, and an archive that threw it away would have to be shot
 *     again. It is also the flag that interacts badly with rotation: any
 *     explicit scale must use post-rotation dimensions or two in five files
 *     come out squashed.
 *   - **No frame-rate conform.** 25, 29.97 and 50fps all stay as shot. The
 *     50fps material is kept for slow motion, and conforming it is the exact
 *     failure described above.
 *
 * ## The audio half is settings, the video half is a finding
 *
 * Everything above `-c:a` was measured and is not offered as a choice. The
 * sound is the other way round: AAC at 192k is a sensible default rather than
 * a result, because the thing being optimised for was the *picture* — nobody
 * scored a VMAF on a soundtrack. So codec, bitrate, rate and channels are
 * parameters here, and the panel offers them.
 *
 * `sampleRate` and `channels` are absent unless asked for, and that absence is
 * load-bearing: emitting `-ar 48000` on a 44.1kHz source resamples it, so a
 * field nobody touched has to produce *no flag*, not a flag carrying the
 * number the source already had. See `resolveOutput` in kernel/renderSettings.
 *
 * @param {{ cq?: number, gop?: number, sourcePixFmt?: string,
 *   audio?: { codec?: string, bitrate?: number, sampleRate?: number,
 *   channels?: number } }} [options]
 * @returns {string[]}
 */
export function encodeArgs(options = {}) {
  const audio = options.audio ?? {}
  return [
    '-c:v', 'hevc_nvenc',
    // Quality-leaning preset. p7 measured no better on this material.
    '-preset', 'p6',
    '-rc', 'vbr',
    '-cq', String(options.cq ?? CQ),
    '-b:v', '0',
    '-g', String(options.gop ?? GOP_FRAMES),
    /*
     * Ten bits out whatever came in, and the chroma the source had.
     *
     * Ten bits because this footage gets re-encoded again when it is reused,
     * and 10-bit survives that second generation far better than 8-bit does —
     * which is true of the chroma for the same reason, and is why 4:2:2 is no
     * longer flattened on the way in. See `archiveFormat` for what that costs
     * (3–4%) and for why the profile has to be read from the same place.
     *
     * `sourcePixFmt` is a fact about the source rather than a setting, so it is
     * not something the panel offers. The sequence render does not pass it and
     * gets 4:2:0, as it always did.
     */
    '-pix_fmt', archiveFormat(options.sourcePixFmt).encode,
    '-tag:v', 'hvc1',
    '-c:a', audio.codec ?? 'aac',
    '-b:a', audio.bitrate ? `${audio.bitrate}k` : AUDIO_BITRATE,
    ...(audio.sampleRate ? ['-ar', String(audio.sampleRate)] : []),
    ...(audio.channels ? ['-ac', String(audio.channels)] : []),
    /*
     * Data streams dropped. Fujifilm files carry a timecode track that survives
     * into the mp4 as a stream of codec `unknown`, which some players stumble
     * over and which carries nothing the archive needs.
     */
    '-dn',
    // The index at the front, so a file opens without reading to its end.
    '-movflags', '+faststart',
  ]
}

/**
 * The audio filter chain for a speed change.
 *
 * `atempo` only accepts 0.5 to 2.0 in one instance, so anything outside that
 * is reached by chaining: 4x is `atempo=2,atempo=2`. The timeline allows ten
 * times either way, so the chain can be three deep.
 *
 * Pitch moves with the speed, which is what a stretch means before anyone asks
 * for pitch to be held — and it is what the mixer already does on playback, so
 * the render matches what was heard while reviewing.
 *
 * @param {number} speed
 * @returns {string}
 */
export function atempoChain(speed) {
  const steps = []
  let left = speed
  while (left > 2) {
    steps.push('atempo=2')
    left /= 2
  }
  while (left < 0.5) {
    steps.push('atempo=0.5')
    left *= 2
  }
  // Floating point can leave this a hair off 1 for a clip nobody stretched.
  if (Math.abs(left - 1) > 1e-6) steps.push(`atempo=${left.toFixed(6)}`)
  return steps.join(',')
}

/**
 * The whole command for one cut, as an argument list.
 *
 * `-ss` goes **before** `-i`, which is both the fast seek and — when
 * re-encoding, as here — a frame-accurate one. Verified on real footage: a
 * 4.000s cut from a 50fps source produced exactly 200 frames at 50fps.
 *
 * That accuracy is a property of cutting from the *original*. Trimming an
 * already-encoded archive with `-c copy` is instant and lossless but snaps to
 * the nearest keyframe, which is what GOP_FRAMES exists to make tolerable.
 * Here there is no snapping at all, because the frames are being made now.
 *
 * Rotation is left alone and that is deliberate: ffmpeg applies the display
 * matrix on decode and writes upright pixels with no rotation flag, so a clip
 * coded 1920x1080 at 90 degrees comes out 1080x1920 the right way up. The
 * consequence belongs to the verifier, which must compare against the
 * *displayed* dimensions — comparing coded ones fails on every rotated file.
 *
 * ## Speed, and why the rate is forced when there is one
 *
 * A stretched clip covers `duration * speed` seconds of its source in
 * `duration` seconds of output, so the read limit goes on the *input* — `-t`
 * before `-i` — and `setpts=PTS/speed` compresses it back down.
 *
 * `-r` then matters. `setpts` retimes frames without removing any, so a clip
 * played at 2x keeps every frame in half the time: a 50fps source comes out a
 * perfectly valid 100fps file, which is not what anyone meant by "twice as
 * fast". Forcing the rate makes ffmpeg drop or duplicate to hit it, which is
 * what every NLE does with a speed change.
 *
 * `-r` is also how the sequence-rate policy is expressed, so the two share one
 * mechanism rather than each having their own.
 *
 * @param {object} job
 * @param {string} job.source absolute path to the original
 * @param {string} job.output absolute path to write
 * @param {number} job.offset seconds into the source where the cut starts
 * @param {number} job.duration seconds of output
 * ## Silence is a thing the timeline says, not an export option
 *
 * `job.silent` writes the cut with no audio stream at all, and it is set by the
 * planner from the mute and solo state of the track the clip's sound sits on —
 * see ExportJob in kernel/batchExport.ts. A clip you were watching with its
 * track muted archives as a clip with no sound, because that is the file you
 * reviewed.
 *
 * `-an` goes *after* `encodeArgs`, which has already said `-c:a aac`. That
 * order is deliberate and it is how ffmpeg resolves it: the later option wins,
 * so the codec choice is simply unused rather than contradicted. Putting `-an`
 * first and the codec after it would produce a file with sound.
 *
 * @param {number} [job.speed] how fast the source runs; 1 when untouched
 * @param {number} [job.frameRate] rate to force, or undefined to keep the source's
 * @param {boolean} [job.silent] write no audio stream
 * @param {{width:number,height:number}} [job.scale] fit and pad the picture to this
 * @param {boolean} [job.video] false to write no video stream
 * @param {{ cq?: number, gop?: number }} [options]
 * @returns {string[]}
 */
export function cutArgs(job, options = {}) {
  const speed = job.speed && job.speed > 0 ? job.speed : 1
  const stretched = Math.abs(speed - 1) > 1e-9

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats']
  if (job.offset > 0) args.push('-ss', job.offset.toFixed(6))
  // The read limit is an input option so the filter below sees exactly the
  // span the clip covers, rather than the whole rest of the file.
  if (stretched) args.push('-t', (job.duration * speed).toFixed(6))
  args.push('-i', job.source)
  /*
   * The video filter chain, which has two possible reasons to exist.
   *
   * `scale` is absent unless someone typed a size — the archive encode has
   * none on purpose, because 4K staying 4K is most of what 4K b-roll is for.
   * When it is present it fits *inside* the box and pads out to it rather than
   * stretching, for the same reason the compositor does: a clip is not
   * deformed to match a number someone typed.
   *
   * It also goes **after** the decode, which is where rotation has already
   * been applied — so `scale` sees the displayed shape. This is the flag the
   * note at the top of this file warns about: an explicit scale that used
   * coded dimensions would squash two files in five in this library.
   */
  const chain = []
  if (stretched) chain.push(`setpts=PTS/${speed}`)
  if (job.scale) {
    const { width, height } = job.scale
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`)
    chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`)
    chain.push('setsar=1')
  }
  if (chain.length > 0) args.push('-filter:v', chain.join(','))

  if (stretched) {
    // No point retiming a stream that is about to be dropped, and an audio
    // filter on a job with `-an` is a warning on every encode for nothing.
    if (!job.silent) args.push('-filter:a', atempoChain(speed))
  } else {
    args.push('-t', job.duration.toFixed(6))
  }
  if (job.frameRate) args.push('-r', String(job.frameRate))
  args.push(...encodeArgs(options))
  if (job.silent) args.push('-an')
  /*
   * Sound only, when the Video switch is off. Same trick as `-an`: after the
   * encoder flags, so the later option wins and the codec choice is simply
   * unused rather than contradicted.
   *
   * The file keeps its `.mp4` extension rather than becoming `.m4a`. AAC in
   * mp4 is a perfectly ordinary sound file, and an export whose *names* change
   * when a switch is flicked would break every resume — `alreadyDone` looks
   * for the output path, and a path that moved is a path that is not there.
   */
  if (job.video === false) args.push('-vn')
  /*
   * The container stated rather than inferred from the extension.
   *
   * An encode writes to a temporary name and renames on success, so the path
   * ffmpeg is actually given ends in `.flux-part` — and ffmpeg picks its muxer
   * from the extension, so without this it refuses the whole command with
   * "Error opening output files: Invalid argument". Which reads like a bad
   * argument somewhere in the encoder settings rather than what it is.
   */
  args.push('-f', 'mp4')
  args.push('-y', job.output)
  return args
}

/**
 * What ffprobe must be asked to make a verification possible.
 *
 * `-count_frames` is the expensive part and the necessary one: `nb_frames` is a
 * container field an encoder can get wrong, and the whole reason this check
 * exists is that a wrong one looked healthy.
 *
 * @param {string} file
 * @returns {string[]}
 */
export function probeArgs(file) {
  return [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,nb_read_frames,profile,pix_fmt,duration:format=duration,size',
    '-print_format', 'json',
    '--', file,
  ]
}
