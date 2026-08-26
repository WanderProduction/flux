import fs from 'node:fs'
import { stat } from 'node:fs/promises'
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
