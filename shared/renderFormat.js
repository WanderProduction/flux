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
 * What a verified output must be.
 *
 * Checked by the verifier after every encode, because the failure this catches
 * is silent: an Adobe export in the same test run produced 1108 frames at
 * 29.97fps from an 1850-frame 50fps source, and the file looked perfectly
 * healthy. Nothing about it announced that two thirds of the motion was gone.
 */
export const EXPECTED_PROFILE = 'Main 10'
export const EXPECTED_PIX_FMT = 'yuv420p10le'

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
 * @param {{ cq?: number, gop?: number }} [options]
 * @returns {string[]}
 */
export function encodeArgs(options = {}) {
  return [
    '-c:v', 'hevc_nvenc',
    // Quality-leaning preset. p7 measured no better on this material.
    '-preset', 'p6',
    '-rc', 'vbr',
    '-cq', String(options.cq ?? CQ),
    '-b:v', '0',
    '-g', String(options.gop ?? GOP_FRAMES),
    /*
     * 10-bit out, from 10-bit in. The source is 10-bit 4:2:2; the archive is
     * 4:2:0 to halve the chroma cost, but keeping ten bits of luma matters
     * because this footage gets re-encoded again when it is reused, and 10-bit
     * survives that second generation far better than 8-bit does.
     */
    '-pix_fmt', 'p010le',
    '-tag:v', 'hvc1',
    '-c:a', 'aac',
    '-b:a', AUDIO_BITRATE,
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
 * @param {number} [job.speed] how fast the source runs; 1 when untouched
 * @param {number} [job.frameRate] rate to force, or undefined to keep the source's
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
  if (stretched) {
    args.push('-filter:v', `setpts=PTS/${speed}`)
    args.push('-filter:a', atempoChain(speed))
  } else {
    args.push('-t', job.duration.toFixed(6))
  }
  if (job.frameRate) args.push('-r', String(job.frameRate))
  args.push(...encodeArgs(options))
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
