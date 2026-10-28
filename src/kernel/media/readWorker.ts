/**
 * Range reads, off the main thread. See media/ranges.ts for who calls this.
 *
 * A read is already asynchronous, so it was never *blocking* the main thread —
 * but awaiting is not the same as being elsewhere. The bytes still arrive on
 * the main thread, the response is still assembled there, and the continuation
 * still has to wait its turn behind whatever that thread is doing. Measured at
 * 4x: reads account for 94-104% of every gap over 150ms during playback, and
 * the same 8MB span takes 19-32ms when the app is idle. The disk was never
 * slow. The thread was busy.
 *
 * So the read happens here and the bytes are transferred, which costs nothing
 * — the buffer moves rather than copies — and the main thread pays only for
 * the handoff.
 *
 * Reads are not serialised. Several can be in flight at once, which is what a
 * cut wants: the outgoing clip and the incoming one are both being read, and
 * making one wait for the other is most of what a cut costs.
 */

/**
 * `self`, as it really is in here.
 *
 * The project compiles against the DOM lib, which types `self` as a Window, so
 * `postMessage` appears to want a target origin and refuses a transfer list.
 * Adding "WebWorker" to `lib` would fix this file and collide with DOM across
 * the rest of the project, so the shape used here is stated locally instead.
 */
const worker = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}

interface ReadJob {
  kind: 'read'
  id: number
  /** Which source asked, so one source's reads can be dropped together. */
  reader: number
  url: string
  start: number
  end: number
}

interface AbortJob {
  kind: 'abort'
  reader: number
}

/**
 * In-flight reads, so a source that goes away takes its reads with it.
 *
 * A closed source whose reads carry on is not merely waste: the bytes arrive,
 * find nothing to feed, and in the meantime they were holding a place in a
 * queue that the clip now on screen is waiting in.
 */
const live = new Map<number, Set<AbortController>>()

function remember(reader: number, control: AbortController) {
  let held = live.get(reader)
  if (!held) {
    held = new Set()
    live.set(reader, held)
  }
  held.add(control)
}

function forget(reader: number, control: AbortController) {
  const held = live.get(reader)
  if (!held) return
  held.delete(control)
  if (held.size === 0) live.delete(reader)
}

worker.onmessage = async (event: MessageEvent<ReadJob | AbortJob>) => {
  const job = event.data

  if (job.kind === 'abort') {
    const held = live.get(job.reader)
    if (held) for (const control of held) control.abort()
    live.delete(job.reader)
    return
  }

  const control = new AbortController()
  remember(job.reader, control)
  try {
    const res = await fetch(job.url, {
      headers: { Range: `bytes=${job.start}-${job.end}` },
      signal: control.signal,
    })
    if (!res.ok && res.status !== 206) {
      worker.postMessage({ id: job.id, bytes: null })
      return
    }
    const buffer = await res.arrayBuffer()
    // Transferred: the buffer moves to the caller rather than being copied,
    // which is the whole point of reading here.
    worker.postMessage({ id: job.id, bytes: buffer }, [buffer])
  } catch {
    // Aborted, refused, or gone. The caller treats every one of them the same
    // way it always has — as a read that produced nothing — and decides for
    // itself whether that is fatal.
    worker.postMessage({ id: job.id, bytes: null })
  } finally {
    forget(job.reader, control)
  }
}
