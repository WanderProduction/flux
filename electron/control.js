/**
 * A local control surface, so something other than a hand can drive FLUX.
 *
 * The reason this exists is an MCP server: a language model deciding which
 * takes survive needs to put a sequence together and start a render, and the
 * only other way to do that is to puppet the GUI through the DevTools
 * protocol — which needs a window, breaks on hot reload, and is a debugging
 * tool rather than an interface.
 *
 * ## Why it talks to a running FLUX rather than replacing it
 *
 * The first design for this was headless: a Node process that read the project
 * files and ran ffmpeg itself, with FLUX not involved. It is the better
 * long-term shape and it is not the one here, for a boring reason — the two
 * planners that turn a timeline into render jobs are ~470 lines of TypeScript
 * in `src/kernel/`, and a plain Node process cannot import them without a
 * build step. Rewriting them as JavaScript to get them out is a large change
 * to the most heavily checked code in the app, bought for an audience of one
 * process.
 *
 * Talking to the running app costs nothing and reuses every tested path: the
 * planners, the queue, the settings, the verifier. The price is that FLUX has
 * to be open, which it is anyway.
 *
 * ## It is off until it is asked for
 *
 * This is the one surface in FLUX that lets another program write files and
 * start work. It therefore does not open on launch. It is started
 * deliberately, by command, and when it starts it says so.
 *
 * ## Loopback, and a token
 *
 * `serve-updates` binds to 127.0.0.1 and has no auth, which is right for it —
 * it hands out files that are already on the machine. This is different: it
 * can write into a project and spend hours of GPU time, so loopback alone is
 * not enough. Any process on this machine can reach a loopback port, including
 * a page in a browser the user has open.
 *
 * So every request carries a token, minted per launch and written to a file in
 * the app's own data directory. A caller that can read that file is already a
 * program running as this user; one that cannot is refused. The token never
 * goes in a URL — only in a header — because URLs end up in logs.
 *
 * Nothing here imports `electron`, so the whole surface can be exercised by a
 * harness with no app running: the operations it serves arrive as a map of
 * functions from main.js.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

/**
 * The port.
 *
 * 8912, next to the update server's 8911 and for the same reason it chose an
 * odd number: the tidy ports are the ones something else on a developer's
 * machine has already taken, and a control surface that silently failed to
 * bind would look like a control surface that is ignoring you.
 */
export const DEFAULT_PORT = 8912

const HOST = '127.0.0.1'

/** Requests larger than this are refused. A cut list is small; a file is not. */
const MAX_BODY = 4 << 20

export function mintToken() {
  return crypto.randomBytes(24).toString('hex')
}

/**
 * Writes the token where a local program can find it.
 *
 * In the app's data directory rather than in the project, because it belongs
 * to this installation rather than to any one edit — and because a token
 * inside a project folder would be copied along with the project, to a
 * machine where it still worked.
 *
 * @param {string} dir the app's userData path
 * @param {string} token
 * @returns {Promise<string>} where it was written
 */
export async function writeToken(dir, token) {
  const file = path.join(dir, 'control-token')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
  return file
}

/**
 * Starts the surface.
 *
 * @param {object} config
 * @param {Record<string, (params: object) => Promise<unknown>>} config.operations
 * @param {string} config.token
 * @param {number} [config.port]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startControl({ operations, token, port = DEFAULT_PORT }) {
  const server = http.createServer((req, res) => {
    void handle(req, res, operations, token)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

async function handle(req, res, operations, token) {
  const send = (status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      // This is not a browser API and must never be treated as one by a page
      // that happens to find the port.
      'access-control-allow-origin': 'null',
    })
    res.end(text)
  }

  /*
   * The token is compared in constant time. The comparison is almost certainly
   * not the weakest thing here, but a timing-safe compare is one line and
   * explaining why a loopback service was exempt from it is longer.
   */
  const offered = req.headers['x-flux-token']
  const expected = Buffer.from(token)
  const given = Buffer.from(typeof offered === 'string' ? offered : '')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    send(401, { ok: false, error: 'bad or missing X-Flux-Token' })
    return
  }

  if (req.method === 'GET' && req.url === '/operations') {
    // So a client can discover what this build understands rather than
    // guessing from a version number.
    send(200, { ok: true, operations: Object.keys(operations).sort() })
    return
  }

  if (req.method !== 'POST') {
    send(405, { ok: false, error: 'POST an operation to /call' })
    return
  }
  if (req.url !== '/call') {
    send(404, { ok: false, error: `no route ${req.url}` })
    return
  }

  let raw = ''
  let tooBig = false
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY) {
      tooBig = true
      break
    }
  }
  if (tooBig) {
    send(413, { ok: false, error: 'request too large' })
    return
  }

  let body
  try {
    body = JSON.parse(raw || '{}')
  } catch (err) {
    send(400, { ok: false, error: `body is not JSON: ${err.message}` })
    return
  }

  const operation = operations[body.op]
  if (!operation) {
    send(404, {
      ok: false,
      error: `no operation "${body.op}"`,
      // Named rather than left to a guess: the caller is often a model, and a
      // list is the difference between it correcting itself and it retrying.
      operations: Object.keys(operations).sort(),
    })
    return
  }

  try {
    const value = await operation(body.params ?? {})
    send(200, { ok: true, value })
  } catch (err) {
    /*
     * The message, not the stack. A caller needs to know what went wrong well
     * enough to try something else; a stack trace from inside the renderer is
     * noise to it and detail about this machine to anything else.
     */
    send(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
