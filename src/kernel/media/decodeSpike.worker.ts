/**
 * A spike, not the thing. Can a worker do the reading and the decoding?
 *
 * Decode on this machine runs at ten times realtime with the bytes in hand —
 * 294fps on the 4K footage — while playback delivers thirty. The missing
 * nine tenths goes on the renderer's main thread, which also does the range
 * reads, the shrink to preview size, the draw, React and the timeline. Moving
 * the pipeline from bytes to frames off that thread is the fix, and this
 * exists to find out what stands in the way before any of it is ported.
 *
 * Three things are genuinely unknown and each could sink it:
 *
 *   whether `flux-asset:` can be fetched from a worker at all. The scheme is
 *   registered privileged with supportFetchAPI, but privileges are granted to
 *   the renderer and a worker is a different global;
 *
 *   whether a decoded VideoFrame survives the trip to the main thread, and
 *   what it costs. VideoFrame is transferable in principle; a 4K frame that
 *   copied rather than moved would be worse than what we have;
 *
 *   whether decode in a worker runs at the same rate as decode on the main
 *   thread, or whether the hardware path is somehow poorer there.
 *
 * So this answers those three and nothing else. It holds no state, keeps no
 * decoder between jobs, and is deliberately not shaped like the VideoSource it
 * would eventually become — a spike that looks finished is one that gets
 * shipped without the port being thought through.
 */

/**
 * `self`, as it really is in here.
 *
 * The project compiles against the DOM lib, which types `self` as a Window —
 * so `postMessage` appears to want a target origin and refuses a transfer
 * list. Adding "WebWorker" to `lib` would fix the type and collide with DOM
 * everywhere else in the project, for one file's benefit. So the shape this
 * file actually uses is stated here and the lib is left alone.
 */
const worker = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}

/** Only what the decoder and the reads need; the rest of the track stays home. */
interface SpikeTrack {
  codec: string
  description: Uint8Array | null
  width: number
  height: number
  count: number
  offset: Float64Array
  bytes: Uint32Array
  pts: Float64Array
  key: Uint8Array
}

interface SpikeJob {
  id: number
  url: string
  track: SpikeTrack
  from: number
  to: number
  /** 'keep' closes frames here; 'send' transfers them to the main thread. */
  mode: 'keep' | 'send'
  hardware: 'prefer-hardware' | 'prefer-software' | 'no-preference'
}

worker.onmessage = async (event: MessageEvent<SpikeJob>) => {
  const job = event.data
  const t = job.track
  const reply = (body: Record<string, unknown>) => worker.postMessage({ id: job.id, ...body })

  if (typeof VideoDecoder === 'undefined') {
    reply({ ok: false, error: 'no VideoDecoder in this worker' })
    return
  }

  /* 1. The read. The first thing that could simply not be allowed here. */
  const start = t.offset[job.from]
  const end = t.offset[job.to] + t.bytes[job.to] - 1
  let bytes: Uint8Array
  const readAt = performance.now()
  try {
    const res = await fetch(job.url, { headers: { Range: `bytes=${start}-${end}` } })
    if (!res.ok && res.status !== 206) {
      reply({ ok: false, error: `read refused: HTTP ${res.status}` })
      return
    }
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    reply({ ok: false, error: `read threw: ${(err as Error)?.message ?? String(err)}` })
    return
  }
  const readMs = performance.now() - readAt

  /* 2. The decode, and 3. the trip home, timed apart so they can be judged
     apart — a cheap decode behind an expensive transfer is still a loss. */
  let out = 0
  let sendMs = 0
  let failed: string | null = null
  const decoder = new VideoDecoder({
    output: (frame) => {
      out += 1
      if (job.mode === 'send') {
        const at = performance.now()
        // Transferred, not copied: a 4K frame that copies would cost more than
        // the decode that made it, and whether this really moves is the thing
        // being measured.
        worker.postMessage({ id: job.id, frame }, [frame as unknown as Transferable])
        sendMs += performance.now() - at
      } else {
        frame.close()
      }
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
      hardwareAcceleration: job.hardware,
      optimizeForLatency: true,
    })
    for (let i = job.from; i <= job.to; i++) {
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
    reply({ ok: false, error: `decode threw: ${(err as Error)?.message ?? String(err)}` })
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      /* already gone */
    }
    return
  }
  const decodeMs = performance.now() - decodeAt
  try {
    if (decoder.state !== 'closed') decoder.close()
  } catch {
    /* already gone */
  }

  reply({
    ok: true,
    done: true,
    frames: out,
    asked: job.to - job.from + 1,
    megabytes: bytes.length / 1048576,
    readMs,
    decodeMs,
    sendMs,
    failed,
  })
}
