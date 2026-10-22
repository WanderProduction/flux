/**
 * Serves a release directory as an update feed.
 *
 *   npm run serve:updates                     serve release/ on 127.0.0.1:8788
 *   npm run serve:updates -- --dir <path>     serve somewhere else
 *   npm run serve:updates -- --port 9000
 *
 * This is the "local" half of local-now-server-later. `electron-updater`'s
 * generic provider wants nothing more than a static directory holding
 * `latest.yml` and the installers it names, so the thing standing in for a
 * release server is a static file server — and when there is a real one, the
 * only thing that changes is the URL. See electron/updater.js.
 *
 * ## Byte ranges are not optional
 *
 * An update is normally fetched *differentially*: electron-builder writes a
 * `.blockmap` beside each installer, and the updater reads the old and new
 * blockmaps, works out which blocks actually changed, and asks for just those
 * — as a `Range` request. A server that ignores `Range` and returns the whole
 * file with a 200 does not fail cleanly; it hands back megabytes where
 * kilobytes were asked for, and the updater either falls back to a full
 * download or assembles a corrupt file out of the pieces. So ranges are
 * answered properly here, which is also what makes this a fair rehearsal for
 * whatever serves the bytes later.
 *
 * Bound to 127.0.0.1 and not 0.0.0.0: this is a convenience for one machine,
 * and an unauthenticated file server that hands out executables has no
 * business being reachable from the network.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const DIR = path.resolve(flag('dir', path.join(ROOT, 'release')))
/**
 * 8911 rather than something tidier like 8080 or 8788.
 *
 * 8788 was the first choice and had to be abandoned: it is what
 * `wrangler pages dev` listens on, and on a machine that does any Cloudflare
 * work the bind fails with EADDRINUSE while netstat shows nothing at all
 * holding it — which is a deeply confusing half hour. A port nothing famous
 * claims is worth more than a memorable one.
 */
const PORT = Number(flag('port', '8911'))
const HOST = '127.0.0.1'

if (!fs.existsSync(DIR)) {
  console.error(`There is nothing to serve: ${DIR} does not exist.`)
  console.error('Build a release first:  npm run dist')
  process.exit(1)
}

const TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.AppImage': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
}

/**
 * The file a request names, or null if it points outside the served directory.
 *
 * Resolved and then checked against the root rather than merely having `..`
 * stripped: `%2e%2e` and friends survive a textual filter, and `path.resolve`
 * is the thing that actually decides where a path lands.
 */
function resolveTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const target = path.resolve(path.join(DIR, decoded))
  const within = target === DIR || target.startsWith(DIR + path.sep)
  return within ? target : null
}

const server = http.createServer((req, res) => {
  const started = Date.now()
  const done = (status, extra = '') => {
    console.log(`  ${status}  ${req.method} ${req.url}${extra}  ${Date.now() - started}ms`)
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return done(405)
  }

  const target = resolveTarget(req.url ?? '/')
  if (!target) {
    res.writeHead(403).end('outside the served directory')
    return done(403)
  }

  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    res.writeHead(404).end('not found')
    return done(404)
  }

  if (stat.isDirectory()) {
    // A listing, so that pointing a browser at the feed shows what is in it —
    // which is the quickest way to find out whether latest.yml is even there.
    const names = fs.readdirSync(target)
    const body = names.join('\n')
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return done(200, `  (${names.length} entries)`)
  }

  const headers = {
    'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'last-modified': stat.mtime.toUTCString(),
    // The feed must never be cached: the whole point of asking is to find out
    // whether it changed.
    'cache-control': 'no-store',
  }

  const range = req.headers.range
  if (range) {
    /*
     * `bytes=start-end`, where either end may be absent. Only a single range is
     * handled, because that is all the updater asks for and a multipart reply
     * is a different response format entirely — answering one badly would be
     * worse than refusing.
     */
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match || (match[1] === '' && match[2] === '')) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end()
      return done(416)
    }
    const suffix = match[1] === ''
    const start = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1])
    const end = suffix || match[2] === '' ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1)

    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end()
      return done(416)
    }

    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    })
    if (req.method === 'HEAD') {
      res.end()
      return done(206, `  bytes ${start}-${end}`)
    }
    fs.createReadStream(target, { start, end }).pipe(res)
    return done(206, `  bytes ${start}-${end}`)
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size })
  if (req.method === 'HEAD') {
    res.end()
    return done(200)
  }
  fs.createReadStream(target).pipe(res)
  return done(200, `  ${(stat.size / 1e6).toFixed(1)}MB`)
})

/**
 * A port that cannot be bound has to say so in one line.
 *
 * Node's default is an unhandled 'error' event, which exits with a stack trace
 * through net.js internals — and "EADDRINUSE" buried in that is not what
 * someone needs to read to learn that they should pass --port. Worth being
 * careful about because the address can be unbindable with *nothing visible
 * holding it*: Windows services and WSL take ports in ways that neither
 * netstat nor Get-NetTCPConnection report.
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  Port ${PORT} is already taken, so the feed cannot be served there.`)
    console.error(`  Pick another:  npm run serve:updates -- --port ${PORT + 1}`)
    console.error('')
    console.error('  Nothing may show up in netstat even so — Windows services and WSL')
    console.error('  can hold a port invisibly. Trying a different one is quicker than looking.')
  } else {
    console.error(`  The feed server could not start: ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`  update feed  http://${HOST}:${PORT}/`)
  console.log(`  serving      ${DIR}`)
  const manifest = path.join(DIR, 'latest.yml')
  if (fs.existsSync(manifest)) {
    const version = /version:\s*(\S+)/.exec(fs.readFileSync(manifest, 'utf8'))?.[1]
    console.log(`  offering     ${version ?? 'latest.yml, unparsed'}`)
  } else {
    console.log('  no latest.yml here, so nothing will be offered — run: npm run dist')
  }
  console.log('\n  Point an installed FLUX at it by writing, in its userData:')
  console.log(`    update-feed.json   {"url": "http://${HOST}:${PORT}/"}`)
})
