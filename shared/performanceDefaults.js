/**
 * What a machine should do by default, and the bounds it is held to.
 *
 * Lifted out of src/kernel/performance.ts when the Cache settings page made
 * the duplication visible. The renderer resolves these against the machine
 * and shows them; the main process prunes the media cache to the disk one at
 * startup, *before any renderer exists to ask*. So both sides need the same
 * answer from the same numbers, and until this file existed the main process
 * had no way to get it: it read the store, found nothing pinned on a machine
 * where nobody had opened the performance dialog, and fell back to a hardcoded
 * 256MB while the renderer was telling the user the budget was 5991MB.
 *
 * That is not a cosmetic disagreement. It means the index cache was being
 * trimmed to a twenty-third of its intended size on every machine that had
 * never touched the settings — which is most of them — and the only visible
 * symptom was clips taking the slow path to open again for no apparent reason.
 *
 * Plain JS with no imports, like the rest of shared/: the main process cannot
 * load a TypeScript module and should not need a build step to find out how
 * much disk it may use.
 *
 * The reasoning behind each number is kept with the number. It was written
 * against measurements and it is the part worth not losing.
 */

/**
 * What the machine has, as far as anything here knows.
 *
 * @typedef {{ totalMemoryBytes: number, cpuCount: number }} Machine
 */

const GB = 1024 * 1024 * 1024

/** Bounds, which exist to stop a hand-edited store making the app unusable. */
export const LIMITS = {
  /*
   * The floors are the values these were before they were settings, not the
   * smallest number that would work. A setting that can make the app slower
   * than it was is a trap, and a machine small enough to want less than this
   * is a machine that will not be playing 4K either way.
   */
  /*
   * The ceiling here is deliberately above what measured well. Twenty-four
   * concurrent HEVC decoders cost a tenth of the frame rate on the GPU this
   * was measured on, but that is one GPU and one codec, and a bound that
   * refused what some hardware can do would be a worse answer than a default
   * that does not reach for it. The default is twelve; see `defaultsFor`.
   */
  decoderPool: { min: 6, max: 96 },
  warmRadius: { min: 0, max: 8 },
  frameMemoryMb: { min: 256, max: 8192 },
  diskCacheMb: { min: 256, max: 262144 },
}

/**
 * Clips that keep a decoder open, on every machine.
 *
 * Twelve rather than thirteen because the cliff was measured between thirteen
 * and twenty-four open HEVC decoders and a default should sit below a cliff,
 * not on it. Twelve measured identical to six on both H.264 and HEVC — flat
 * across three passes, no gaps over 100ms — so the headroom above the seven
 * that a warm radius of three keeps open costs nothing and is there for
 * moving back and forth across a few cuts while editing.
 */
const DECODER_POOL = 12

/**
 * Holds a number inside its bounds, or falls back when it is not a number.
 *
 * @param {number} value
 * @param {{ min: number, max: number }} bounds
 * @param {number} fallback used when `value` is NaN or infinite
 * @returns {number}
 */
export function clamp(value, { min, max }, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * What this machine should do by default.
 *
 * Memory is the thing worth scaling against. It is the resource the app
 * actually consumes, it is knowable exactly, and it tracks how serious a
 * computer is closely enough for this purpose — nobody puts ninety-four
 * gigabytes in a machine they do not intend to work on.
 *
 * **The decoder pool is deliberately not scaled against it.** It was, and that
 * was the one real mistake in this file: system memory says nothing about how
 * many streams a GPU will decode at once, so scaling a decode-session count
 * by gigabytes gave this machine fifty-three and cost it a tenth of its frame
 * rate on HEVC. A number that cannot be derived from anything knowable here
 * is better left at the largest value measured to be safe on the heavier
 * codec, with the setting there for anyone whose hardware does more.
 *
 * **Frame memory still is**, and the difference is the point. The kept runs
 * are `ImageBitmap`s and they land in the renderer's own working set: in the
 * arm that held 14.8GB of them, the process grew by 11.7GB while the GPU grew
 * by 1.8GB. So gigabytes of system memory is the right thing to read for this
 * one and the wrong thing to read for the pool, whose decode sessions live on
 * the card. Two settings in the same struct, scaled from the same number, and
 * only one of them was entitled to it.
 *
 * @param {Machine} spec
 * @returns {{ decoderPool: number, warmRadius: number, frameMemoryMb: number, diskCacheMb: number }}
 */
export function defaultsFor(spec) {
  const gb = spec.totalMemoryBytes / GB
  return {
    decoderPool: DECODER_POOL,
    warmRadius: clamp(gb >= 32 ? 3 : gb >= 16 ? 2 : 1, LIMITS.warmRadius, 1),
    frameMemoryMb: clamp(gb * 16, LIMITS.frameMemoryMb, 256),
    diskCacheMb: clamp(gb * 64, LIMITS.diskCacheMb, 256),
  }
}
