/**
 * How a FLUX that is already installed becomes a newer one.
 *
 * The shape of this is set by one requirement: the place updates come from has
 * to be changeable *without building a new app*. FLUX is served off a folder on
 * this machine today and off a server later, and if the URL were only baked in
 * at build time then moving the feed would mean shipping a release whose whole
 * purpose was to say where the next release lives — and anyone still on the old
 * one could never be told. So the baked-in URL is the last resort, not the
 * first:
 *
 *   FLUX_UPDATE_FEED           an environment variable  (what the harness uses)
 *   userData/update-feed.json  {"url": "..."}           (what a user sets)
 *   app-update.yml             written by electron-builder from `publish`
 *
 * ## Two traps, both silent
 *
 * `electron-updater` is CommonJS, and `autoUpdater` is a *lazy getter* on its
 * exports that constructs an NsisUpdater the first time it is read. Two things
 * follow. One: `import { autoUpdater }` gives `undefined` — the named export
 * cannot be seen through the CJS/ESM bridge, because at the moment the bridge
 * looks there is no such property yet. It has to come off the default import.
 * Two: reading it outside Electron throws, because the constructor asks `app`
 * for its version. Hence the default import here and the access inside
 * `startUpdates`, rather than at the top of the file.
 *
 * ## Why nothing happens in a dev build
 *
 * An unpackaged app has no version to compare and no installer to run, so
 * `electron-updater` refuses to work there, and that refusal is the honest
 * answer rather than something to force past: an update that "worked" against
 * a dev tree would be testing a code path no user ever runs.
 */

import { app, ipcMain, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import electronUpdater from 'electron-updater'

/** A user's override, in their config directory rather than inside the app. */
const FEED_FILE = 'update-feed.json'

/**
 * Where to look for new builds, most specific first.
 *
 * `from` is carried along because "checking for updates" that silently checks
 * the wrong place looks exactly like "no updates" — the only way to tell them
 * apart from the outside is to show which feed was actually used.
 */
export function feedUrl() {
  const fromEnv = process.env.FLUX_UPDATE_FEED
  if (fromEnv) return { url: fromEnv, from: 'FLUX_UPDATE_FEED' }

  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), FEED_FILE), 'utf8')
    const url = JSON.parse(raw)?.url
    if (typeof url === 'string' && url.length > 0) return { url, from: FEED_FILE }
  } catch {
    // Absent or corrupt. Having no override is the ordinary case, so this is
    // not worth reporting — the build's own URL is used instead.
  }
  return { url: null, from: 'app-update.yml' }
}

/**
 * The last thing the updater said, as the renderer needs to render it.
 *
 * Held here rather than asked for, because the interesting states arrive as
 * events while nobody is looking: a window that opens after the check has
 * finished would otherwise have no way to learn that an update is waiting.
 */
let current = { state: 'idle', version: null, percent: 0, error: null, feed: null }

function publish(next) {
  current = { ...current, ...next }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', current)
  }
}

/**
 * Wires the updater up and asks once, at startup.
 *
 * Deliberately not awaited by anything: whether there is a newer FLUX is never
 * a reason to delay showing this one.
 */
export function startUpdates() {
  const feed = feedUrl()
  current = { ...current, feed }

  ipcMain.handle('update:state', () => current)

  if (!app.isPackaged) {
    current = {
      ...current,
      state: 'disabled',
      error: 'this is a development build — updates apply to an installed FLUX',
    }
    ipcMain.handle('update:check', () => current)
    ipcMain.handle('update:install', () => false)
    return
  }

  // Lazy getter: see the header. Reading this is what builds the updater.
  const { autoUpdater } = electronUpdater

  /*
   * A download is started without asking, and installing is not.
   *
   * Those are opposite answers to the same question, and on purpose. Fetching
   * is invisible and recoverable — the worst case is bytes nobody wanted.
   * Installing restarts the app, and restarting an editor out from under
   * someone who is mid-edit is a way to lose work. So FLUX downloads quietly
   * and then waits to be told.
   */
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  if (feed.url) {
    /*
     * `generic` is a plain static host: a directory with latest.yml and the
     * installers beside it. That is the same contract for a folder served off
     * this machine and for a bucket on the internet, which is what makes
     * "local now, server later" a change of one string rather than a port.
     */
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
  }

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', error: null }))
  autoUpdater.on('update-available', (info) =>
    publish({ state: 'downloading', version: info.version, percent: 0 }),
  )
  autoUpdater.on('update-not-available', () => publish({ state: 'current', version: null }))
  autoUpdater.on('download-progress', (progress) =>
    publish({ state: 'downloading', percent: Math.round(progress.percent) }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    publish({ state: 'ready', version: info.version, percent: 100 }),
  )
  autoUpdater.on('error', (err) =>
    /*
     * An unreachable feed is not a broken app.
     *
     * This is the common case — offline, or the update server simply not
     * running — and it must not read as something being wrong with FLUX
     * itself. It is recorded here and deliberately not shown; see updateLabel
     * in src/kernel/updates.ts for why a standing failure in the status bar
     * would be worse than silence.
     */
    publish({ state: 'error', error: String(err?.message ?? err) }),
  )

  ipcMain.handle('update:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      publish({ state: 'error', error: String(err?.message ?? err) })
    }
    return current
  })

  /**
   * Quits and runs the installer that was downloaded.
   *
   * Returns rather than throwing if there is nothing staged: the button that
   * calls this is only shown in the 'ready' state, but a stale renderer asking
   * must not take the app down.
   */
  ipcMain.handle('update:install', () => {
    if (current.state !== 'ready') return false
    // `isSilent: false` so the user sees the installer do its work; the second
    // argument runs the new FLUX afterwards rather than leaving them at a
    // closed app wondering whether it worked.
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })

  autoUpdater.checkForUpdates().catch((err) => {
    publish({ state: 'error', error: String(err?.message ?? err) })
  })
}
