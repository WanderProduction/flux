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
/*
 * The numbers live in shared/ rather than here, and the reason is the startup
 * prune: the main process trims the media cache to the disk budget before any
 * renderer exists to be asked what it is. A formula that lived only in this
 * file left that side guessing, and it guessed 256MB against this side's
 * 5991MB. One formula, two readers — see the note at the top of that file.
 */
import {
  clamp,
  defaultsFor as defaultsForMachine,
  LIMITS,
} from '../../shared/performanceDefaults.js'

/** Re-exported, because a caller asking what the bounds are should not have to know. */
export { LIMITS } from '../../shared/performanceDefaults.js'

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

/**
 * What this machine should do by default.
 *
 * The formula is shared; what is local is *which machine* — `machine` here is
 * filled in by the main process's reply and falls back to a modest laptop, and
 * a caller that passes nothing means "this one".
 */
export function defaultsFor(spec: Machine = machine): PerformanceSettings {
  return defaultsForMachine(spec)
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
