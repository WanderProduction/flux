/**
 * How much of the machine FLUX is allowed to spend.
 *
 * Every number here used to be a constant somewhere, chosen for a machine
 * nobody had measured. The one that mattered most said this, beside a decoder
 * pool of six:
 *
 *   "A machine has a small fixed number of hardware decoders — a handful to a
 *   dozen or so — and every open source holds one."
 *
 * **That was right, and the measurement that overruled it asked the wrong
 * question.** Sixty-four sources were opened at once and each asked for one
 * frame; all sixty-four answered, at no measurable cost. So the first version
 * of this file scaled the pool with memory and this machine got fifty-three.
 *
 * Holding sixty-four decoders open is not the same as sixty-four decoders
 * streaming, and streaming is the state playback is in. Measured again on
 * rotated HEVC 50p — forty clips, three passes over the same timeline, one
 * fresh app per arm:
 *
 *   | open | pass 1 | pass 2 | pass 3 | gaps over 100ms |
 *   |------|--------|--------|--------|-----------------|
 *   |    7 |  49.4  |  49.4  |  49.2  | 0 -> 1          |
 *   |   13 |  49.2  |  49.3  |  49.2  | 0 -> 1          |
 *   |   24 |  48.7  |  44.6  |  43.8  | 0 -> 10         |
 *
 * The cliff is between thirteen and twenty-four concurrent HEVC decoders, and
 * it shows up as *degradation with use*: the first pass is fine and the third
 * has lost a tenth of its frames. On H.264 the same sweep is flat from six to
 * twenty-four, which is why the original error survived — it was measured on
 * H.264. The pool therefore does not scale with anything; see `defaultsFor`.
 *
 * It belongs in the *installation* store rather than in a project, for the
 * same reason the viewer's preview resolutions do: it is about this computer
 * keeping up, not about the work. Copy a project to another machine and it
 * should arrive with that machine's appetite, not the one it was cut on.
 *
 * **Defaults are derived, not typed in.** A number chosen by hand is a number
 * that is wrong on most computers, and the complaint that started this was
 * exactly that — a machine with ninety-four gigabytes of memory and sixteen
 * cores running an app that had been told to behave like a laptop.
 */

import { loadStore, saveStore } from './store'

export interface PerformanceSettings {
  /**
   * How many clips keep a decoder open behind the playhead.
   *
   * What this really buys is arriving somewhere twice. Leaving a clip and
   * coming back should not mean paying for its index, its decoder and its
   * first keyframe again — and on a timeline of a hundred short clips, six is
   * about six seconds of work before everything is cold again.
   *
   * It is bounded from above by something this process cannot ask about: how
   * many streams the GPU will decode at once, which differs by codec and is
   * far smaller for HEVC than for H.264. Raising it past that does not fail,
   * it degrades — and only after a minute of playing, which is the hardest
   * kind of cost to attribute. The header has the numbers.
   */
  decoderPool: number
  /**
   * How many clips either side of the playhead are opened before they are
   * needed.
   *
   * One is enough to cover a cut. More is what covers an edit: trimming a
   * clip means watching the three around it, and each of those is a decoder
   * that could already be warm.
   */
  warmRadius: number
  /**
   * Megabytes of already-shrunk frames kept for playing backwards, across
   * every clip that holds any.
   *
   * In total rather than per source, since 0.0.40. It was per source, on the
   * grounds that only clips actually played backwards hold any and so the
   * worst case was far below this times the pool. A reverse pass crosses the
   * whole pool and plays every clip in it backwards, which makes the worst
   * case exactly this times the pool: measured at 14.8GB held against a
   * 1498MB budget. A number that bounds one clip while twelve are alive is
   * not a memory limit, whatever it is called.
   */
  frameMemoryMb: number
  /**
   * Megabytes of derived files kept on disk — indexes, waveform peaks,
   * thumbnails.
   *
   * The cheapest of the three to raise and the slowest to notice: what it
   * saves is re-reading and re-deriving things that never change.
   */
  diskCacheMb: number
}

interface Machine {
  totalMemoryBytes: number
  cpuCount: number
}

interface MachineBridge {
  machine?: () => Promise<Machine>
}

/**
 * What the machine has, as far as anything here knows.
 *
 * Eight gigabytes and four cores until the main process says otherwise, which
 * is the shape of a modest laptop — the right thing to assume before the
 * answer arrives, and the right thing to keep assuming in a plain browser
 * where there is nobody to ask.
 */
let machine: Machine = { totalMemoryBytes: 8 * 1024 * 1024 * 1024, cpuCount: 4 }

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
} as const

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

function clamp(value: number, { min, max }: { min: number; max: number }, fallback: number): number {
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
 */
export function defaultsFor(spec: Machine = machine): PerformanceSettings {
  const gb = spec.totalMemoryBytes / GB
  return {
    decoderPool: DECODER_POOL,
    warmRadius: clamp(gb >= 32 ? 3 : gb >= 16 ? 2 : 1, LIMITS.warmRadius, 1),
    frameMemoryMb: clamp(gb * 16, LIMITS.frameMemoryMb, 256),
    diskCacheMb: clamp(gb * 64, LIMITS.diskCacheMb, 256),
  }
}

let settings: PerformanceSettings = defaultsFor()
/** Null until the user has changed something: the defaults follow the machine. */
let chosen: Partial<PerformanceSettings> = {}
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function settle() {
  const base = defaultsFor()
  settings = {
    decoderPool: clamp(chosen.decoderPool ?? base.decoderPool, LIMITS.decoderPool, base.decoderPool),
    warmRadius: clamp(chosen.warmRadius ?? base.warmRadius, LIMITS.warmRadius, base.warmRadius),
    frameMemoryMb: clamp(
      chosen.frameMemoryMb ?? base.frameMemoryMb,
      LIMITS.frameMemoryMb,
      base.frameMemoryMb,
    ),
    diskCacheMb: clamp(chosen.diskCacheMb ?? base.diskCacheMb, LIMITS.diskCacheMb, base.diskCacheMb),
  }
  emit()
}

export function subscribePerformance(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPerformance(): PerformanceSettings {
  return settings
}

export function getMachine(): Machine {
  return machine
}

/** Which of these the user has pinned, as against left to follow the machine. */
export function getChosen(): Partial<PerformanceSettings> {
  return { ...chosen }
}

/**
 * Changes one or more settings and remembers them.
 *
 * A value of `null` puts that one back to following the machine, which is a
 * different state from happening to equal the default today: a laptop that
 * gains memory, or a project opened on a bigger machine, should move with it.
 */
export function setPerformance(patch: Partial<Record<keyof PerformanceSettings, number | null>>): void {
  for (const [key, value] of Object.entries(patch) as [keyof PerformanceSettings, number | null][]) {
    if (value === null) delete chosen[key]
    else chosen[key] = value
  }
  settle()
  void saveStore('performance', chosen)
}

/** Back to the machine's own answer for everything. */
export function resetPerformance(): void {
  chosen = {}
  settle()
  void saveStore('performance', chosen)
}

/**
 * Asks the machine what it has and reads back anything the user pinned.
 *
 * Both are awaited together because the defaults depend on the first and the
 * settled values depend on both — settling once at the end rather than twice
 * keeps anything watching from seeing a value that was never real.
 */
export async function loadPerformance(): Promise<void> {
  const bridge = (globalThis as { flux?: MachineBridge }).flux
  const [spec, stored] = await Promise.all([
    bridge?.machine?.().catch(() => null) ?? Promise.resolve(null),
    loadStore<Partial<PerformanceSettings>>('performance', {}),
  ])
  if (spec && Number.isFinite(spec.totalMemoryBytes) && spec.totalMemoryBytes > 0) machine = spec
  chosen = stored && typeof stored === 'object' ? { ...stored } : {}
  settle()
}
