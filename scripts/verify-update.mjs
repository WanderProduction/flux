/**
 * Checks that an installed FLUX can find, fetch and stage a newer one.
 *
 *   npm run dist            build the installer and the latest.yml it fetches
 *   npm run verify:update   check the three answers a feed can give
 *
 * Updating is the one feature whose failure mode is that *nothing happens*.
 * A wrong URL, a missing latest.yml, a stale checksum, an updater that quietly
 * refuses because the build is unpackaged — every one of those looks exactly
 * like "there is no update yet", which is also the correct and expected answer
 * almost all of the time. There is no way to tell them apart by using the app.
 * So they have to be told apart here.
 *
 * Three answers a feed can give, and all three have to be right:
 *
 *   current   it offers the version already running -> say so, do nothing
 *   ready     it offers a newer one -> fetch it, check it, stage it
 *   error     it cannot be reached  -> report it, and keep working
 *
 * The third is not a formality. An editor that would not start because a
 * release server is down would be a far worse bug than never updating at all,
 * and FLUX is meant to run on a machine with no internet in front of it.
 *
 * ## How the newer version is made
 *
 * By writing a latest.yml that offers `0.0.2` and points at the 0.0.1
 * installer, carrying that file's real sha512 and real size.
 *
 * That is not a shortcut around the test — it is the test. What is under
 * examination is the *mechanism*: that the feed is read from the place it was
 * told to read, that a higher semver is recognised as newer, that 93MB comes
 * down over HTTP, and that the checksum in the manifest is verified against
 * the bytes that actually arrived. Those are the parts that break. What is
 * inside the installer is electron-builder's business, and building a second
 * real version here would add minutes to prove something no code in this
 * repository decides.
 *
 * Nothing is ever installed: `quitAndInstall` is left alone, so this harness
 * cannot replace the FLUX on the machine running it.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, createChecker, findPageTarget } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(ROOT, 'release')
const EXE = path.join(RELEASE, 'win-unpacked', 'FLUX.exe')
const FEED_DIR = path.join(RELEASE, 'update-test-feed')

/** Its own ports, so a dev app or a real feed server is never what gets tested. */
const DEBUG_PORT = 9413
const FEED_PORT = 8789
/** Nothing listens here. That is the point of the last phase. */
const DEAD_PORT = 8799

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
/**
 * One patch above whatever is built, so this keeps working across releases.
 *
 * Pinning a literal here would quietly become wrong: the first time FLUX
 * actually shipped as that version, the harness would be offering an update to
 * the version already running and would be testing the 'current' path twice.
 */
const NEWER = (() => {
  const [major, minor, patch] = APP_VERSION.split('.').map(Number)
  if (![major, minor, patch].every(Number.isFinite)) {
    console.error(`  FAIL cannot read a semver out of "${APP_VERSION}"`)
    process.exit(1)
  }
  return `${major}.${minor}.${patch + 1}`
})()

for (const [what, where] of [
  ['a packaged FLUX', EXE],
  ['an installer to offer', path.join(RELEASE, `FLUX Setup ${APP_VERSION}.exe`)],
  ['a manifest', path.join(RELEASE, 'latest.yml')],
]) {
  if (!fs.existsSync(where)) {
    console.error(`  FAIL no ${what} at ${where}`)
    console.error('       build one first:  npm run dist')
    process.exit(1)
  }
}

const { check, report } = createChecker()

// ── the feed that offers a newer FLUX ─────────────────────────────

/**
 * Writes a feed directory offering `NEWER`, pointing at the installer that
 * exists, with its real checksum.
 *
 * The sha512 is measured from the file rather than copied out of the real
 * latest.yml. They are the same bytes today, but a manifest whose checksum was
 * assumed rather than measured is precisely the failure this is here to catch:
 * electron-updater rejects a download whose hash does not match, so a harness
 * feeding it a hash it had not computed itself could not tell a working
 * verification from an absent one.
 */
function buildFeed() {
  const installer = `FLUX Setup ${APP_VERSION}.exe`
  const offered = `FLUX Setup ${NEWER}.exe`

  fs.rmSync(FEED_DIR, { recursive: true, force: true })
  fs.mkdirSync(FEED_DIR, { recursive: true })
  fs.copyFileSync(path.join(RELEASE, installer), path.join(FEED_DIR, offered))

  const blockmap = path.join(RELEASE, `${installer}.blockmap`)
  if (fs.existsSync(blockmap)) {
    // Copied so the updater finds a blockmap where it expects one. It will
    // still fall back to the full file, because the *old* build's blockmap is
    // not on the feed — which is the honest situation for a first update.
    fs.copyFileSync(blockmap, path.join(FEED_DIR, `${offered}.blockmap`))
  }

  const bytes = fs.readFileSync(path.join(FEED_DIR, offered))
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64')

  fs.writeFileSync(
    path.join(FEED_DIR, 'latest.yml'),
    [
      `version: ${NEWER}`,
      'files:',
      `  - url: ${offered}`,
      `    sha512: ${sha512}`,
      `    size: ${bytes.length}`,
      `path: ${offered}`,
      `sha512: ${sha512}`,
      `releaseDate: "${new Date().toISOString()}"`,
      '',
    ].join('\n'),
    'utf8',
  )
  return { offered, size: bytes.length }
}

/**
 * Where electron-updater keeps what it has already downloaded.
 *
 * `updaterCacheDirName: flux-updater` in app-update.yml puts it here, outside
 * the app's own userData, because a staged installer has to survive the
 * install that replaces the app.
 */
const CACHE = path.join(os.homedir(), 'AppData', 'Local', 'flux-updater')

/**
 * Clears it.
 *
 * A previous run's 0.0.2 sitting on disk is reported as staged without the
 * feed being asked for anything, so a phase that passed from cache would be
 * checking nothing at all.
 */
function clearUpdaterCache() {
  fs.rmSync(CACHE, { recursive: true, force: true })
}

// ── driving the app ───────────────────────────────────────────────

function serveFeed(dir, port) {
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'serve-updates.mjs'), '--dir', dir, '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  server.stdout.on('data', (chunk) => log.push(String(chunk)))
  server.stderr.on('data', (chunk) => log.push(String(chunk)))
  return { server, log }
}

/**
 * Starts the packaged app against `feed` and waits until `until` is happy.
 *
 * The harness must not decide how long a 93MB download takes, only that it
 * ends — so this polls the state the app reports rather than sleeping for a
 * guessed interval.
 */
async function runAgainst(feed, { until, timeoutMs = 120_000 }) {
  const child = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, FLUX_UPDATE_FEED: feed },
  })

  let cdp = null
  try {
    const target = await findPageTarget(DEBUG_PORT)
    cdp = connect(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')

    /** Not `evaluate` from cdp.mjs: that asserts `__fluxDev`, which a build has not got. */
    const read = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        )
      }
      return result.result.value
    }

    const deadline = Date.now() + timeoutMs
    let status = null
    while (Date.now() < deadline) {
      status = await read('return await window.flux.updates.state()')
      if (status && until(status)) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // Read from the same page, so a state the interface cannot render is still
    // a failure — see updateLabel in src/kernel/updates.ts.
    const badge = await read(
      "return document.querySelector('.status-update')?.textContent ?? null",
    )
    return { status, badge }
  } finally {
    cdp?.close()
    child.kill()
    // The next phase cannot start while this one holds the single-instance
    // lock, and killing is not instant.
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

// ── the phases ────────────────────────────────────────────────────

console.log(`  ${EXE}`)
console.log(`  running ${APP_VERSION}, offering ${NEWER}`)

clearUpdaterCache()

let serving = null
try {
  serving = serveFeed(RELEASE, FEED_PORT)

  await check('a feed offering the version already running says so', async () => {
    const { status, badge } = await runAgainst(`http://127.0.0.1:${FEED_PORT}/`, {
      until: (s) => s.state === 'current' || s.state === 'error' || s.state === 'ready',
      timeoutMs: 30_000,
    })
    assert.equal(
      status.state,
      'current',
      `offered ${APP_VERSION} to a ${APP_VERSION} app and it said "${status.state}"` +
        (status.error ? ` — ${status.error}` : ''),
    )
    // Which feed answered, not merely that one did: a check that silently fell
    // back to app-update.yml would also reach 'current', and would be wrong.
    assert.equal(status.feed?.from, 'FLUX_UPDATE_FEED', `feed came from ${status.feed?.from}`)
    // And the status bar says nothing, because there is nothing to say.
    assert.equal(badge, null, `the status bar said "${badge}" with no update to report`)
  })

  serving.server.kill()
  serving = null

  const offer = buildFeed()

  await check('a newer FLUX is found, fetched, checked and staged', async () => {
    console.log(`       offering ${offer.offered} (${(offer.size / 1e6).toFixed(1)}MB)`)
    clearUpdaterCache()

    serving = serveFeed(FEED_DIR, FEED_PORT)
    const { status } = await runAgainst(`http://127.0.0.1:${FEED_PORT}/`, {
      until: (s) => s.state === 'ready' || s.state === 'error',
    })

    assert.notEqual(
      status.state,
      'error',
      `the update failed: ${status.error}\n       feed server said:\n${serving.log.join('').trim()}`,
    )
    assert.equal(status.state, 'ready', `ended in "${status.state}", not staged`)
    assert.equal(status.version, NEWER, `staged ${status.version}, expected ${NEWER}`)

    /*
     * The bytes have to be on disk, and there have to be the right number of
     * them. electron-updater reports 'ready' only after verifying the sha512,
     * so a file of exactly the expected size here means the checksum in the
     * manifest was matched against what came over HTTP — the one part of this
     * that stands between a user and a corrupt FLUX.
     */
    const staged = path.join(CACHE, 'pending', offer.offered)
    assert.ok(fs.existsSync(staged), `nothing staged at ${staged}`)
    assert.equal(fs.statSync(staged).size, offer.size, 'the staged installer is the wrong size')
  })

  await check('a window opening onto a staged update offers it', async () => {
    // The cache is deliberately *not* cleared: the download already happened
    // in the previous phase, and a window that opens afterwards has to learn
    // that an update is waiting rather than start again from nothing. This is
    // the case the renderer gets wrong if it only listens for events.
    const { status, badge } = await runAgainst(`http://127.0.0.1:${FEED_PORT}/`, {
      until: (s) => s.state === 'ready',
    })
    assert.equal(status.state, 'ready', `ended in "${status.state}"`)
    assert.ok(badge, 'an update was staged and the status bar said nothing')
    assert.ok(
      badge.includes(NEWER) && /restart/i.test(badge),
      `the badge said "${badge}" — it has to name the version and say what to do`,
    )
  })

  serving.server.kill()
  serving = null

  await check('an unreachable feed is reported, and FLUX still runs', async () => {
    clearUpdaterCache()
    const { status } = await runAgainst(`http://127.0.0.1:${DEAD_PORT}/`, {
      until: (s) => s.state === 'error',
      timeoutMs: 45_000,
    })
    assert.equal(status.state, 'error', `ended in "${status.state}" with no server to talk to`)
    assert.ok(status.error, 'an error state with no error in it')
  })
} finally {
  serving?.server.kill()
  report()
}
