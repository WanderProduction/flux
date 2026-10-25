/**
 * One place that knows what the app is preparing.
 *
 * Three queues make the things a timeline needs but a file does not contain:
 * a waveform (media/peaks.ts), a thumbnail (thumbnails.ts) and a frame index
 * (media/indexCache.ts). Each is sensibly built and sensibly throttled, and
 * until now each was invisible. Drop a shoot folder and the app is busy for a
 * while with no way to tell *what* it is busy with — which is indistinguishable
 * from being slow for no reason, and that is the version people report.
 *
 * So the queues report here, and this is the only thing the UI has to read.
 * It is deliberately a notice board rather than a scheduler: nothing here
 * starts, stops or orders any work, so a bug in it can make the ring wrong but
 * cannot make the app do less or more. The queues keep their own limits.
 *
 * ## Why the total resets
 *
 * A ring that filled once and then sat at 100% for the rest of the session
 * would be a decoration. The count is per *burst* — the work asked for since
 * the last moment nothing was pending — so dropping a second folder starts the
 * ring again from the beginning, which is what someone watching it expects.
 */

export type WorkKind = 'waveform' | 'thumbnail' | 'index'

export type WorkState = 'waiting' | 'running' | 'done' | 'failed' | 'dropped'

export interface WorkItem {
  /** Kind and path together: the same file can be in all three queues at once. */
  key: string
  kind: WorkKind
  path: string
  /** The file's own name, which is what the panel shows. */
  name: string
  state: WorkState
  queuedAt: number
  startedAt?: number
  endedAt?: number
  /** Why it failed, when it did. */
  note?: string
}

export interface WorkSummary {
  /** Asked for in this burst. */
  total: number
  /** Finished in this burst, however it finished. */
  finished: number
  running: number
  waiting: number
  /** 0..1 — finished over total, and 1 when there is nothing to do. */
  fraction: number
  /** True while anything is waiting or running. */
  busy: boolean
}

/**
 * How many finished items are kept for the panel.
 *
 * Enough to answer "what just happened" after a bulk drop, bounded because a
 * long session over a drive is tens of thousands of files and a list that grew
 * without limit would be its own memory problem.
 */
const HISTORY = 400

const items = new Map<string, WorkItem>()
const listeners = new Set<() => void>()

let total = 0
let finished = 0
let running = 0
let waiting = 0

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeMediaWork(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

const keyOf = (kind: WorkKind, path: string) => `${kind}:${path}`

/** Drops the oldest settled rows once the list is longer than it needs to be. */
function trim() {
  if (items.size <= HISTORY) return
  for (const [key, item] of items) {
    if (items.size <= HISTORY) break
    if (item.state === 'waiting' || item.state === 'running') continue
    items.delete(key)
  }
}

/**
 * A job has been asked for.
 *
 * Starts a new burst when nothing was pending, which is what keeps the ring
 * meaningful on the second folder someone drops.
 */
export function workQueued(kind: WorkKind, path: string): void {
  const key = keyOf(kind, path)
  const held = items.get(key)
  if (held && (held.state === 'waiting' || held.state === 'running')) return

  if (running === 0 && waiting === 0) {
    total = 0
    finished = 0
  }

  items.set(key, {
    key,
    kind,
    path,
    name: basename(path),
    state: 'waiting',
    queuedAt: Date.now(),
  })
  total += 1
  waiting += 1
  trim()
  emit()
}

/** A job has reached the front of its queue and started. */
export function workStarted(kind: WorkKind, path: string): void {
  const item = items.get(keyOf(kind, path))
  if (!item || item.state !== 'waiting') return
  item.state = 'running'
  item.startedAt = Date.now()
  waiting -= 1
  running += 1
  emit()
}

/** A job has finished, one way or another. */
export function workEnded(kind: WorkKind, path: string, state: 'done' | 'failed' | 'dropped', note?: string): void {
  const item = items.get(keyOf(kind, path))
  if (!item || (item.state !== 'waiting' && item.state !== 'running')) return
  if (item.state === 'waiting') waiting -= 1
  else running -= 1
  item.state = state
  item.endedAt = Date.now()
  if (note) item.note = note
  finished += 1
  trim()
  emit()
}

export function mediaWork(): WorkItem[] {
  return [...items.values()]
}

export function mediaWorkSummary(): WorkSummary {
  return {
    total,
    finished,
    running,
    waiting,
    fraction: total > 0 ? Math.min(1, finished / total) : 1,
    busy: running > 0 || waiting > 0,
  }
}

/** Forgets everything. For the harnesses, and for closing a project. */
export function clearMediaWork(): void {
  items.clear()
  total = 0
  finished = 0
  running = 0
  waiting = 0
  emit()
}
