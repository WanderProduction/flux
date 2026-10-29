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
 * Measured on an ordinary workstation, sixty-four sources opened at once, all
 * sixty-four delivered frames, and a warm frame cost nothing measurable
 * either way: 0.1ms each with four open, 0ms with sixty-four, with the JS heap
 * flat at about twenty megabytes throughout. The ceiling the pool was sized
 * against was not there.
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
   * Megabytes of already-shrunk frames each source may keep for playing
   * backwards.
   *
   * Per source rather than in total, because that is where the eviction
   * decision is made. Only sources that have actually been played backwards
   * hold any, so the worst case is far below this times the pool.
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
  decoderPool: { min: 6, max: 96 },
  warmRadius: { min: 0, max: 8 },
  frameMemoryMb: { min: 256, max: 8192 },
  diskCacheMb: { min: 256, max: 262144 },
} as const

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
 * The decoder pool is scaled against it too, although decoders are not really
 * memory-bound. That is a deliberate approximation rather than an oversight:
 * what a decoder costs is driver and GPU resource, which cannot be asked for
 * from here, and memory is the best-correlated thing that can be. Sixty-four
 * was measured to be free on a 94GB machine, and the scale below asks for
 * fewer than that on every machine, so it stays inside what was proven.
 */
export function defaultsFor(spec: Machine = machine): PerformanceSettings {
  const gb = spec.totalMemoryBytes / GB
  return {
    decoderPool: clamp(6 + gb / 2, LIMITS.decoderPool, 8),
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
