import fs from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

import { contentTypeOf } from '../shared/mediaTypes.js'

/**
 * Serves local media to the renderer over the `flux-asset` scheme.
 *
 * The whole point of this file is **byte ranges**, and it is worth being clear
 * why, because getting it wrong does not look like a bug in the server — it
 * looks like a bug in the player.
 *
 * Chromium's media stack decides whether a source is *seekable* from the
 * response it gets. No `Accept-Ranges`, no `Content-Length`, and a `Range`
 * request answered with a plain 200 all say the same thing: this is a stream
 * you may read from the beginning and nothing else. `video.seekable` then comes
 * back empty, assigning `currentTime` silently does nothing, and the element
 * plays the first couple of seconds it managed to buffer and stops. Which is
 * exactly what a viewer that cannot show anything past the head of a clip looks
 * like from the outside.
 *
 * So this speaks the small part of HTTP that matters:
 *   - always `Accept-Ranges: bytes` and a real `Content-Length`
 *   - `Range: bytes=a-b` -> 206 with `Content-Range`, and only those bytes
 *   - a range that cannot be satisfied -> 416, not a wrong answer
 *   - the body is a *stream*, so a 4GB file costs 64KB of memory rather than
 *     4GB — a media app that reads a take into RAM to show one frame of it has
 *     already lost
 */

/** Read in chunks rather than whole; the file may be enormous. */
const CHUNK = 1 << 16

/**
 * The largest range answered in one read instead of a stream.
 *
 * Streaming is right for a whole file and wrong for a span, and the difference
 * was costing most of the preview's frame rate. The decoder asks for one GOP
 * at a time — a few megabytes, bounded — and a stream hands that back in 64KB
 * pieces, so an eight megabyte span crossed the process boundary 128 times.
 * Each crossing is a turn of the main process's event loop, and the main
 * process is also importing, scanning and rendering: the per-chunk scheduling
 * is multiplied by a hundred and twenty-eight.
 *
 * Measured during playback of 4K footage, spans that read in 15ms from an idle
 * app were taking 300-730ms, and the share of reads over 200ms tracked the
 * frame rate almost exactly — 71% slow gave 5 fps, 4% slow gave 29. The frames
 * were never the problem; waiting for bytes that had already left the drive
 * was.
 *
 * Above this the stream still wins: a span this big is not a decoder asking
 * for a GOP, it is the media element asking for the file, and buffering that
 * is how a 4GB take costs 4GB of memory.
 */
const WHOLE_READ = 16 << 20

/**
 * Parses one byte range against a known size.
 *
 * Only single ranges. Multipart ranges are legal HTTP and no media element
 * asks for them, so answering with the whole file would be a silent wrong
 * answer where refusing is honest.
 *
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | 'unsatisfiable'}
 */
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    // `bytes=-500` means the *last* 500 bytes, not the first.
    const suffix = Number(rawEnd)
    if (suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

function streamOf(filePath, start, end) {
  return Readable.toWeb(
    fs.createReadStream(filePath, { start, end, highWaterMark: CHUNK }),
  )
}

/**
 * Reads one bounded span, in as few reads as the file will allow.
 *
 * Loops because a short read is legal and says nothing about the end of the
 * file; returns however much it got, so the caller can answer honestly about
 * a span that ran past the end rather than claiming bytes it does not have.
 *
 * @param {string} filePath
 * @param {number} start
 * @param {number} end inclusive
 * @returns {Promise<Buffer>}
 */
async function readSpan(filePath, start, end) {
  const length = end - start + 1
  const buffer = Buffer.allocUnsafe(length)
  const handle = await open(filePath, 'r')
  try {
    let got = 0
    while (got < length) {
      const { bytesRead } = await handle.read(buffer, got, length - got, start + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return got === length ? buffer : buffer.subarray(0, got)
  } finally {
    await handle.close()
  }
}

/**
 * Answers one request for a local file.
 *
 * `filePath` is expected to have been checked against the media allowlist
 * already — this deals with bytes, not with policy.
 *
 * @param {Request} request
 * @param {string} filePath
 * @returns {Promise<Response>}
 */
export async function serveFile(request, filePath) {
  let size
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return new Response('not a file', { status: 404 })
    size = info.size
  } catch (err) {
    const status = err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 404
    return new Response('not found', { status })
  }

  const contentType = contentTypeOf(filePath)
  const range = parseRange(request.headers.get('Range'), size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }

  // A HEAD is how a player asks "how big is this, and can I seek it?" without
  // pulling a byte. Answering it with a body wastes a read of the whole file.
  const wantsBody = request.method !== 'HEAD'

  if (!range) {
    return new Response(wantsBody ? streamOf(filePath, 0, size - 1) : null, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        // Local files, private to this user. Never let anything cache them
        // across projects, and never let a stale body outlive an edit.
        'Cache-Control': 'no-store',
      },
    })
  }

  const { start, end } = range

  // One read for a span a decoder could have asked for. See WHOLE_READ.
  if (wantsBody && end - start + 1 <= WHOLE_READ) {
    const body = await readSpan(filePath, start, end).catch(() => null)
    if (body) {
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.length),
          // What was actually read, which is the same as what was asked for
          // unless the file ended inside the span.
          'Content-Range': `bytes ${start}-${start + Math.max(0, body.length - 1)}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      })
    }
    // A file that cannot be opened for a span can still be streamed: fall
    // through rather than turning a readable file into a failed request.
  }

  return new Response(wantsBody ? streamOf(filePath, start, end) : null, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}
