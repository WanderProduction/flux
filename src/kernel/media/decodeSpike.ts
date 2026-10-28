/**
 * Drives the decode spike. See media/decodeSpike.worker.ts for what it asks.
 *
 * Here rather than in the harness because a worker has to be created from a
 * module Vite can see at build time — `new Worker(new URL(...))` is a pattern
 * the bundler rewrites, not a string it can be handed. A harness reaching in
 * over CDP cannot do that, so the smallest possible shim lives in the app and
 * the harness calls this.
 *
 * Temporary by intent: once the port is done this goes, and whatever the real
 * decoder-worker interface turns out to be takes its place.
 */
import { assetUrl } from '../fsBridge'
import { trackFor } from './indexCache'

export interface SpikeResult {
  ok: boolean
  error?: string
  frames?: number
  asked?: number
  megabytes?: number
  readMs?: number
  decodeMs?: number
  sendMs?: number
  /** Measured on this side: how long the frames took to arrive and be let go. */
  receiveMs?: number
  received?: number
  failed?: string | null
}

let nextId = 1

/**
 * Reads and decodes one stretch of a file in a worker.
 *
 * `mode` is the question being asked. 'keep' closes the frames in the worker
 * and measures reading and decoding alone; 'send' transfers every frame to
 * this thread, which is what a real port would do and the part most likely to
 * be expensive.
 */
export async function spikeDecode(
  path: string,
  options: {
    seconds?: number
    gops?: number
    mode?: 'keep' | 'send'
    hardware?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  } = {},
): Promise<SpikeResult> {
  const got = await trackFor(path)
  if (!got.ok) return { ok: false, error: `no index: ${got.reason}` }
  const t = got.track
  if (!t.codec) return { ok: false, error: 'track has no codec' }

  /* A whole number of GOPs starting after `seconds`, so the first chunk is a
     keyframe and the decoder is never asked to start mid-GOP. */
  const after = options.seconds ?? 2
  let from = -1
  for (let i = 0; i < t.count; i++) {
    if (t.key[i] && t.pts[i] > after) {
      from = i
      break
    }
  }
  if (from < 0) return { ok: false, error: `no keyframe past ${after}s` }
  let to = from
  let seen = 0
  const want = options.gops ?? 3
  while (to + 1 < t.count && seen < want) {
    to += 1
    if (t.key[to]) seen += 1
  }

  const worker = new Worker(new URL('./decodeSpike.worker.ts', import.meta.url), {
    type: 'module',
  })
  const id = nextId++

  return new Promise<SpikeResult>((resolve) => {
    let received = 0
    let receiveMs = 0
    let firstAt = 0

    const finish = (result: SpikeResult) => {
      worker.terminate()
      resolve(result)
    }

    worker.onerror = (event) => {
      finish({ ok: false, error: `worker failed: ${event.message || 'no message'}` })
    }

    worker.onmessage = (event: MessageEvent) => {
      const body = event.data
      if (body?.id !== id) return

      /* A frame on its way home. Closed at once: this measures the trip, not
         what anyone would do with it, and a held 4K frame is a decoder slot. */
      if (body.frame) {
        const at = performance.now()
        if (!firstAt) firstAt = at
        try {
          ;(body.frame as VideoFrame).close()
        } catch {
          /* already gone */
        }
        received += 1
        receiveMs += performance.now() - at
        return
      }

      if (body.done || body.ok === false) {
        finish({ ...body, received, receiveMs })
      }
    }

    worker.postMessage({
      id,
      url: assetUrl(path),
      mode: options.mode ?? 'keep',
      hardware: options.hardware ?? 'no-preference',
      from,
      to,
      track: {
        codec: t.codec,
        description: t.description,
        width: t.width,
        height: t.height,
        count: t.count,
        offset: t.offset,
        bytes: t.bytes,
        pts: t.pts,
        key: t.key,
      },
    })
  })
}

/**
 * The same stretch decoded here, for the comparison that gives the worker
 * numbers meaning.
 *
 * Deliberately the same shape of work — one fetch, one decoder, frames closed
 * as they arrive — so the only difference between the two is which thread it
 * happens on.
 */
export async function spikeDecodeHere(
  path: string,
  options: { seconds?: number; gops?: number } = {},
): Promise<SpikeResult> {
  const got = await trackFor(path)
  if (!got.ok) return { ok: false, error: `no index: ${got.reason}` }
  const t = got.track
  if (!t.codec) return { ok: false, error: 'track has no codec' }

  const after = options.seconds ?? 2
  let from = -1
  for (let i = 0; i < t.count; i++) {
    if (t.key[i] && t.pts[i] > after) {
      from = i
      break
    }
  }
  if (from < 0) return { ok: false, error: `no keyframe past ${after}s` }
  let to = from
  let seen = 0
  const want = options.gops ?? 3
  while (to + 1 < t.count && seen < want) {
    to += 1
    if (t.key[to]) seen += 1
  }

  const start = t.offset[from]
  const end = t.offset[to] + t.bytes[to] - 1
  const readAt = performance.now()
  const res = await fetch(assetUrl(path), { headers: { Range: `bytes=${start}-${end}` } })
  if (!res.ok && res.status !== 206) return { ok: false, error: `read refused: ${res.status}` }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const readMs = performance.now() - readAt

  let out = 0
  let failed: string | null = null
  const decoder = new VideoDecoder({
    output: (frame) => {
      out += 1
      frame.close()
    },
    error: (err) => {
      failed = (err as Error)?.message ?? String(err)
    },
  })
  const decodeAt = performance.now()
  try {
    decoder.configure({
      codec: t.codec,
      description: t.description ?? undefined,
      codedWidth: t.width,
      codedHeight: t.height,
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: true,
    })
    for (let i = from; i <= to; i++) {
      const at = t.offset[i] - start
      if (at + t.bytes[i] > bytes.length) break
      decoder.decode(
        new EncodedVideoChunk({
          type: t.key[i] ? 'key' : 'delta',
          timestamp: Math.round(t.pts[i] * 1e6),
          data: bytes.subarray(at, at + t.bytes[i]),
        }),
      )
    }
    await decoder.flush()
  } catch (err) {
    return { ok: false, error: `decode threw: ${(err as Error)?.message ?? String(err)}` }
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      /* already gone */
    }
  }

  return {
    ok: true,
    frames: out,
    asked: to - from + 1,
    megabytes: bytes.length / 1048576,
    readMs,
    decodeMs: performance.now() - decodeAt,
    failed,
  }
}
