/**
 * Reading spans of a media file, from somewhere other than the main thread.
 *
 * One worker for the whole app rather than one per source. A read is waiting
 * on a file, not computing, so several in flight cost one thread between them;
 * a worker per source would mean a worker per clip on the timeline, each with
 * its own module instance and its own startup, for no parallelism that this
 * one does not already have.
 *
 * Everything here degrades to the behaviour it replaced. If a worker cannot be
 * created — a browser without module workers, a packaged build whose CSP
 * refuses it, a test environment with no Worker at all — `readRange` fetches
 * on the calling thread exactly as `VideoSource` used to, and the only loss is
 * the contention this was meant to remove. Playback never fails because of
 * where a read happened.
 */

/** Counters, for the harness that asks which path the reads took. */
const stats = {
  /** Reads served by the worker. */
  offThread: 0,
  /** Reads that fell back to the calling thread, and why. */
  onThread: 0,
  failed: 0,
  /** Set once, if the worker could not be created at all. */
  unavailable: null as string | null,
}

export type RangeStats = typeof stats

export function rangeStats(): RangeStats {
  return { ...stats }
}

export function clearRangeStats(): void {
  stats.offThread = 0
  stats.onThread = 0
  stats.failed = 0
}

let useWorker = true

/**
 * For the harness that measures it. Not a setting: nobody wants this off.
 *
 * The fallback is not a second implementation written for the test — it is
 * the path every read takes where no worker can be had, and it is exactly
 * what `VideoSource` did before this existed. So turning the worker off is a
 * faithful control, and both arms run in one app rather than against a second
 * build, which would be a second variable.
 */
export function setReadWorkerEnabled(on: boolean): void {
  useWorker = on
}

interface Waiting {
  resolve: (bytes: Uint8Array | null) => void
}

let worker: Worker | null = null
let started = false
const waiting = new Map<number, Waiting>()
let nextId = 1
let nextReader = 1

/**
 * The worker, made on first use and never again.
 *
 * Made lazily because a project with no video never needs one, and the cost of
 * starting it is paid by whoever first plays something rather than by every
 * launch. A failure to start is remembered, not retried: a worker that cannot
 * be created once will not be creatable a hundred reads later, and trying
 * would put the failure on the path of every read.
 */
function reader(): Worker | null {
  if (started) return worker
  started = true
  try {
    worker = new Worker(new URL('./readWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const { id, bytes } = event.data ?? {}
      const held = waiting.get(id)
      if (!held) return
      waiting.delete(id)
      held.resolve(bytes ? new Uint8Array(bytes as ArrayBuffer) : null)
    }
    worker.onerror = () => {
      /*
       * The worker died with reads outstanding. Everyone waiting is answered
       * with nothing — which is a case every caller already handles, because
       * a refused or aborted read has always looked like this — and the next
       * read starts a fresh worker.
       */
      stats.unavailable = 'the read worker stopped'
      for (const held of waiting.values()) held.resolve(null)
      waiting.clear()
      worker = null
      started = false
    }
  } catch (err) {
    stats.unavailable = (err as Error)?.message ?? 'no worker'
    worker = null
  }
  return worker
}

/**
 * A handle for one source's reads, so they can be dropped together.
 *
 * `VideoSource` held an AbortController for exactly this: when a source closes
 * its reads must stop, or the bytes arrive to feed a decoder that is gone
 * while the clip now on screen waits behind them. The same promise, across a
 * thread boundary.
 */
export class RangeReader {
  private readonly id = nextReader++
  private closed = false
  /** Reads started on this thread because there was no worker. */
  private readonly here = new AbortController()

  async read(url: string, start: number, end: number): Promise<Uint8Array | null> {
    if (this.closed) return null
    const sent = useWorker ? reader() : null
    if (!sent) return this.readHere(url, start, end)

    const id = nextId++
    const answer = new Promise<Uint8Array | null>((resolve) => {
      waiting.set(id, { resolve })
    })
    try {
      sent.postMessage({ kind: 'read', id, reader: this.id, url, start, end })
    } catch {
      waiting.delete(id)
      return this.readHere(url, start, end)
    }
    const bytes = await answer
    if (bytes) stats.offThread += 1
    else stats.failed += 1
    return bytes
  }

  /** What `VideoSource.readRange` used to be, kept as the fallback. */
  private async readHere(url: string, start: number, end: number): Promise<Uint8Array | null> {
    stats.onThread += 1
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: this.here.signal,
      })
      if (!res.ok && res.status !== 206) return null
      return new Uint8Array(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /** Stops this source's reads, wherever they are happening. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.here.abort()
    try {
      worker?.postMessage({ kind: 'abort', reader: this.id })
    } catch {
      /* no worker, or already gone: the reads it held went with it */
    }
  }
}
