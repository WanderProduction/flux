import { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'

import { DIALOG_FILTERS, mediaKindOf } from '../shared/mediaTypes.js'
import {
  existsMany,
  isServableMediaPath,
  listDirectory,
  listDrives,
  listSubfolders,
  scanFootage,
} from './filesystem.js'
import { buildAppMenu, updateAppMenu } from './appMenu.js'
import { serveFile } from './assetServer.js'
import { checkEncoder, findTools } from './render.js'
import { RenderQueue } from './renderQueue.js'
import {
  forgetDerived,
  pruneCache,
  readDerived,
  sourceToken,
  writeDerived,
} from './mediaCache.js'
import {
  copyIntoImports,
  createProject,
  deleteSequence,
  importSequence,
  isProject,
  listSequences,
  openProject,
  saveProject,
  saveSequence,
  readQueue,
  writeQueue,
} from './project.js'
import { PROJECT_EXTENSION } from '../shared/projectFormat.js'
import { startUpdates } from './updater.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * A .flux path FLUX was started with, from double-clicking a document (Windows
 * and Linux pass it in argv; macOS sends open-file). Held until the renderer
 * asks, because the window is not ready when it arrives.
 */
let launchTarget = argvProjectFile(process.argv)

function argvProjectFile(argv) {
  return argv.slice(1).find((arg) => arg.toLowerCase().endsWith(PROJECT_EXTENSION)) ?? null
}

/**
 * One FLUX, one window.
 *
 * Without the lock, double-clicking a second project starts a second copy of
 * the app: two processes, two caches, and — once the same project is open in
 * both — two writers racing for one document. Windows hands the new argv to the
 * instance already running instead, which is also how a project gets opened
 * from Explorer while FLUX is up.
 */
/*
 * Occluded windows keep rendering too.
 *
 * backgroundThrottling covers a window that is minimised or backgrounded;
 * Chromium separately stops painting one that is merely *covered* by another
 * window, which is the common case while working — FLUX behind a browser. Same
 * reasoning: a media app must not stop playing because something is on top of
 * it.
 */
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) app.quit()

app.on('second-instance', (_event, argv) => {
  const target = argvProjectFile(argv)
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  if (target) win.webContents.send('project:open-target', target)
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  const [win] = BrowserWindow.getAllWindows()
  // Before the window exists this is the launch target; after, it is a request
  // to open a project in the app the user is already looking at.
  if (win) win.webContents.send('project:open-target', filePath)
  else launchTarget = filePath
})

/** Pushed from the renderer: true when closing now would lose an edit. */
let unsavedWork = false
/** Set once the user has answered the close prompt, so the retry goes through. */
let closing = false

/**
 * Where the dev renderer is served from.
 *
 * Overridable because the port is a single-tenant resource and FLUX is
 * developed in git worktrees. `vite.config.ts` pins 5273 with `strictPort`, so
 * two checkouts cannot both run `npm run dev` — and the failure is not a
 * refusal, it is a harness in worktree B attaching to :9222 and silently
 * driving the app vite is serving from worktree A. Every check then passes or
 * fails for reasons that have nothing to do with the code under test.
 *
 * `FLUX_DEV_PORT` is read by vite and by this, so one variable moves both
 * halves. `FLUX_DEBUG_PORT` in scripts/cdp.mjs is the third, and the set of
 * three is what lets a second worktree verify at the same time:
 *
 *   FLUX_DEV_PORT=5274 npx vite
 *   FLUX_DEV_PORT=5274 npx electron . --remote-debugging-port=9223
 *   FLUX_DEBUG_PORT=9223 node scripts/verify-timeline.mjs
 */
const DEV_PORT = Number(process.env.FLUX_DEV_PORT) || 5273
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`
const isDev = !app.isPackaged

/**
 * Local media is served to the renderer over a custom scheme rather than
 * file://, which the renderer's CSP blocks outright.
 *
 * `stream: true` and `supportFetchAPI: true` are what let the handler answer
 * with a streamed, ranged response — see electron/assetServer.js for why byte
 * ranges are the whole ballgame for a video element.
 *
 * Must be registered before the app is ready.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'flux-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/**
 * Workspaces, keymaps and the project's asset list are user data, not app data
 * — they live next to the user's config so a reinstall never eats their work.
 */
const storePath = (name) => path.join(app.getPath('userData'), `${name}.json`)

async function readStore(name) {
  try {
    return JSON.parse(await fs.readFile(storePath(name), 'utf8'))
  } catch {
    return null // absent or corrupt — the renderer falls back to defaults
  }
}

async function writeStore(name, value) {
  await fs.mkdir(path.dirname(storePath(name)), { recursive: true })
  await fs.writeFile(storePath(name), JSON.stringify(value, null, 2), 'utf8')
  return true
}

// ── where the window was left ───────────────────────

/**
 * Size, position and state, in this installation's settings.
 *
 * Not in the project document: which corner of which monitor the window was in
 * is a fact about this machine, and carrying it inside a project folder would
 * mean opening someone else's project moved your window.
 */
const WINDOW_STORE = 'ui-window'

/** The default, and what a window with nowhere sensible to go falls back to. */
const DEFAULT_SIZE = { width: 1600, height: 950 }

/**
 * Read synchronously, because the window is built before anything can await.
 *
 * A few hundred bytes off a local disk once at startup. Making this async would
 * mean either showing a window at the wrong size and moving it — which is
 * visible, and looks like a bug — or delaying the window on a promise.
 */
function savedWindowState() {
  try {
    const raw = readFileSync(storePath(WINDOW_STORE), 'utf8')
    const state = JSON.parse(raw)
    return state && typeof state === 'object' ? state : null
  } catch {
    return null // absent, or corrupt: the defaults are perfectly good
  }
}

/** How much of `bounds` lies inside `area`, in pixels. */
function overlap(area, bounds) {
  const width = Math.min(area.x + area.width, bounds.x + bounds.width) - Math.max(area.x, bounds.x)
  const height =
    Math.min(area.y + area.height, bounds.y + bounds.height) - Math.max(area.y, bounds.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * Where to open, given what was saved and what is plugged in now.
 *
 * The display it was on can be gone — a laptop undocked, a monitor unplugged,
 * a projector put away — and restoring those coordinates would put the window
 * somewhere the user cannot see or reach it. That is not a small bug: a window
 * you cannot find looks exactly like an app that will not start.
 *
 * So a saved position is used only when a real part of the window would land on
 * a display that exists. "A real part" rather than "any part": a window with two
 * pixels on screen is as lost as one with none. Otherwise it opens centred on
 * the primary display, which is where a window with no history goes.
 *
 * The size is clamped to the work area either way, because a window saved on a
 * 4K monitor must not open larger than the 1080p one it is now opening on.
 */
function placeWindow(state) {
  const primary = screen.getPrimaryDisplay()
  const centred = (area) => ({
    width: Math.min(DEFAULT_SIZE.width, area.width),
    height: Math.min(DEFAULT_SIZE.height, area.height),
    x: Math.round(area.x + (area.width - Math.min(DEFAULT_SIZE.width, area.width)) / 2),
    y: Math.round(area.y + (area.height - Math.min(DEFAULT_SIZE.height, area.height)) / 2),
  })

  const bounds = state?.bounds
  const sane =
    bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
  if (!sane) return centred(primary.workArea)

  // A quarter of the window, or a reasonable patch of it, has to be on a
  // display that is actually connected.
  const enough = Math.min(bounds.width * bounds.height * 0.25, 200 * 200)
  const home = screen
    .getAllDisplays()
    .find((display) => overlap(display.workArea, bounds) >= enough)
  if (!home) return centred(primary.workArea)

  const area = home.workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    // Nudged back inside if the display it is on has since become smaller.
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)),
  }
}

/**
 * Records the window as it is now.
 *
 * `getNormalBounds` rather than `getBounds`: while a window is maximized or
 * full screen its bounds are the screen's, and saving those would mean
 * un-maximizing it next time produced a window the size of the display rather
 * than the size it was before it was maximized.
 */
function rememberWindow(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return
  void writeStore(WINDOW_STORE, {
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  }).catch(() => {})
}

/** Named starting points for the Content Browser's left rail. */
async function listPlaces() {
  const named = [
    ['Home', 'home'],
    ['Desktop', 'desktop'],
    ['Documents', 'documents'],
    ['Downloads', 'downloads'],
    ['Pictures', 'pictures'],
    ['Videos', 'videos'],
  ]

  const places = []
  for (const [label, key] of named) {
    try {
      const target = app.getPath(key)
      await fs.access(target)
      places.push({ name: label, path: target })
    } catch {
      // Not every platform defines every known folder, and a redirected one can
      // point somewhere that no longer exists. Skip rather than show a dead row.
    }
  }
  return { places, drives: await listDrives() }
}

function createWindow() {
  const saved = savedWindowState()
  const win = new BrowserWindow({
    ...placeWindow(saved),
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    show: false,
    /*
     * Shown rather than hidden now that the Window menu is worth reaching: it
     * is where the panels are listed and where layouts are saved, and a menu
     * you have to know to press Alt for is a menu most people never find.
     */
    autoHideMenuBar: false,
    title: 'FLUX',
    icon: path.join(
      __dirname,
      '..',
      'build',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * Keep rendering when the window is not in front.
       *
       * Chromium stops producing frames for a backgrounded or occluded window,
       * which for an ordinary app is a battery win and for this one is wrong:
       * the playhead is driven by requestAnimationFrame, so alt-tabbing away
       * would silently freeze playback mid-take. It also stops `scroll` events
       * from firing at all, which is a strange thing to discover only when a
       * panel that follows a scroll position quietly stops following it.
       */
      backgroundThrottling: false,
    },
  })

  /*
   * Maximized and full screen are applied before the window is shown.
   *
   * Doing it afterwards is visible: the window appears at its restored size and
   * then jumps, which reads as a glitch on every single launch.
   */
  if (saved?.fullScreen) win.setFullScreen(true)
  else if (saved?.maximized) win.maximize()

  // A menu before the renderer has described itself, so the bar is never
  // empty — it fills in with panels and layouts a moment later.
  buildAppMenu(win)

  win.once('ready-to-show', () => {
    win.show()
    /*
     * Recorded as soon as it is on screen, not only when it changes.
     *
     * A window that opened and was never touched has still told us something:
     * that this is where it opens. Without this, a fresh install has no window
     * state at all until the first drag, and "nothing was written" is
     * indistinguishable from "nothing writes".
     */
    rememberWindow(win)
  })

  /*
   * Saved as it changes, not only on the way out.
   *
   * A crash, a kill, or a power cut all skip 'close', and losing the window
   * position to any of them would be a small irritation every time. Debounced
   * because dragging a window fires these continuously.
   */
  let remembering = null
  const rememberSoon = () => {
    clearTimeout(remembering)
    remembering = setTimeout(() => rememberWindow(win), 400)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, rememberSoon)
  }
  // And once more on the way out, synchronously enough to beat the process
  // ending: the debounce may not have fired for the last nudge.
  win.on('close', () => {
    clearTimeout(remembering)
    rememberWindow(win)
  })

  /**
   * Nothing may close over unsaved work without asking.
   *
   * There is no autosave, so this dialog is the only thing standing between a
   * stray Alt+F4 and a lost edit. `unsavedWork` is pushed from the renderer as
   * it changes, because a 'close' handler cannot wait for an answer: preventing
   * the close has to be decided synchronously.
   */
  win.on('close', (event) => {
    if (closing || !unsavedWork) return
    event.preventDefault()

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'FLUX',
      message: 'Save changes before closing?',
      detail: 'Your changes since the last save will be lost otherwise.',
    })

    if (choice === 2) return // Cancel: stay open
    if (choice === 1) {
      closing = true
      win.close()
      return
    }
    // Save: the renderer owns the document, so it does the writing and tells
    // us when the file is actually on disk.
    win.webContents.send('project:save-and-close')
  })

  if (isDev) {
    // Double-clicking a .flux launches this directly, which in dev means the
    // renderer comes from Vite. Saying so beats a blank window that looks like
    // the project failed to open.
    win.webContents.once('did-fail-load', () => {
      dialog.showMessageBoxSync(win, {
        type: 'error',
        title: 'FLUX',
        message: 'The FLUX dev server is not running.',
        detail: `This is a development build, so the interface is served from ${DEV_URL}.
Run "npm run dev" and try again.`,
      })
      win.close()
    })
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  return win
}

ipcMain.handle('store:get', (_e, name) => readStore(name))
ipcMain.handle('store:set', (_e, name, value) => writeStore(name, value))

ipcMain.handle('fs:places', () => listPlaces())
ipcMain.handle('fs:list', async (_e, dirPath) => {
  try {
    return { ok: true, listing: await listDirectory(dirPath) }
  } catch (err) {
    // Permission denied and "not a directory" are ordinary while browsing a
    // real disk, so they travel back as data for the UI to render calmly
    // rather than as an exception that trips an error boundary.
    return { ok: false, error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'unreadable' }
  }
})
ipcMain.handle('fs:subfolders', async (_e, dirPath) => {
  try {
    return { ok: true, ...(await listSubfolders(dirPath)) }
  } catch (err) {
    // Expanding a tree node onto an unreadable folder is routine on a real
    // disk, so this is data for the row to render, not an exception.
    return {
      ok: false,
      error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'unreadable',
    }
  }
})
ipcMain.handle('fs:exists', (_e, paths) => existsMany(paths))

/**
 * Every media file under a folder, for a batch import.
 *
 * Takes as long as the tree does — 11,213 files across 1,080 folders measured
 * at 407ms — which is why it is one call rather than the renderer walking the
 * tree a listing at a time over IPC. The same walk done as 1,080 round trips
 * is a window that stops repainting.
 */
ipcMain.handle('fs:scan', async (_e, dirPath) => {
  try {
    return { ok: true, scan: await scanFootage(dirPath) }
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'unreadable',
    }
  }
})

/**
 * Project state lives inside the project folder, not in userData: opening a
 * different project must show a different timeline, and copying a project
 * folder to another machine has to bring its contents with it.
 */
ipcMain.handle('project:save', (_e, file, document) => saveProject(file, document))
/**
 * Handed over once, then forgotten.
 *
 * The launcher asks for this every time it mounts, and closing a project brings
 * the launcher back - so a value that persisted would reopen the same project
 * the moment you closed it, and closing would be impossible.
 */
ipcMain.handle('project:launchTarget', () => {
  const target = launchTarget
  launchTarget = null
  return target
})

ipcMain.on('project:unsaved', (_e, value) => {
  unsavedWork = Boolean(value)
})
ipcMain.on('project:close-confirmed', (event) => {
  closing = true
  BrowserWindow.fromWebContents(event.sender)?.close()
})

ipcMain.handle('project:listSequences', (_e, root) => listSequences(root))
ipcMain.handle('project:saveSequence', (_e, root, document, previousFile) =>
  saveSequence(root, document, previousFile),
)
ipcMain.handle('project:deleteSequence', (_e, root, file) => deleteSequence(root, file))
/*
 * The render queue lives beside the document rather than inside it, so a job
 * finishing does not light the unsaved dot. See electron/project.js.
 */
ipcMain.handle('project:readQueue', (_e, root) => readQueue(root))
ipcMain.on('menu:describe', (event, description) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window) updateAppMenu(window, description)
})

ipcMain.handle('project:writeQueue', (_e, root, jobs) => writeQueue(root, jobs))
ipcMain.handle('project:importSequence', (_e, root, sourcePath) => importSequence(root, sourcePath))

ipcMain.handle('project:create', (_e, root, name) => createProject(root, name, app.getVersion()))
ipcMain.handle('project:open', (_e, root) => openProject(root))
ipcMain.handle('project:is', (_e, root) => isProject(root))
ipcMain.handle('project:copyIntoImports', (_e, root, sourcePath) =>
  copyIntoImports(root, sourcePath),
)

/**
 * The media cache lives with the app's data, not with the project.
 *
 * It holds demuxed sample tables — derived from the media, rebuildable from it,
 * and shared by every project that cuts the same footage. See
 * electron/mediaCache.js for why that is the right side of the line.
 */
const mediaCachePath = () => path.join(app.getPath('userData'), 'media-cache')

/**
 * A stat, and deliberately not a read.
 *
 * The renderer asks this before every open, including the ones its own
 * in-memory index answers — so it has to be the cheapest question in the
 * system. Bundling the entry into the reply would mean reading a megabyte off
 * disk to tell a caller that already has the answer that it still holds.
 */
ipcMain.handle('media:sourceToken', (_e, filePath) => sourceToken(filePath))
/**
 * What is cached under `name` for a file, but only if it still matches `token`.
 *
 * Uint8Array survives the structured clone, so the bytes arrive as bytes with
 * no base64 round trip through a string.
 */
ipcMain.handle('media:read', (_e, filePath, name, token) =>
  readDerived(mediaCachePath(), filePath, name, token),
)
ipcMain.handle('media:write', (_e, filePath, name, token, payload) =>
  writeDerived(mediaCachePath(), filePath, name, token, payload),
)
ipcMain.handle('media:forget', (_e, filePath, name) =>
  forgetDerived(mediaCachePath(), filePath, name),
)

ipcMain.handle('dialog:pickProjectFile', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    title: 'Open a FLUX project',
    properties: ['openFile'],
    filters: [{ name: 'FLUX project', extensions: [PROJECT_EXTENSION.slice(1)] }],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

ipcMain.handle('dialog:pickDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the project',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

ipcMain.handle('dialog:pickOutputDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    title: 'Where should the exports go?',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

/**
 * The export queue.
 *
 * One at a time, app-wide, and held here rather than in the renderer: an export
 * runs for minutes or hours and must not be at the mercy of a panel closing or
 * a workspace being switched. See electron/renderQueue.js.
 *
 * Progress is pushed rather than polled. A queue of four hundred jobs emits on
 * every ffmpeg stats line, so the renderer gets told and coalesces it into a
 * render; asking every frame for the state of something that changes twice a
 * second is work for nothing.
 */
let queue = null

ipcMain.handle('render:tools', async () => {
  const found = await findTools()
  if (!found.ok) return { ok: false, error: found.error }
  const encoder = await checkEncoder()
  if (!encoder.ok) return { ok: false, error: encoder.error, version: found.version }
  return { ok: true, version: found.version }
})

ipcMain.handle('render:start', async (event, jobs, config) => {
  if (queue && !queue.finished) return { ok: false, error: 'an export is already running' }

  const sender = event.sender
  queue = new RenderQueue({
    jobs,
    outDir: config.outDir,
    concurrency: config.concurrency,
    options: config.options,
    resume: config.resume !== false,
    onEvent: (payload) => {
      // The window can be gone while an export is still running.
      if (!sender.isDestroyed()) sender.send('render:event', payload)
    },
  })

  const summary = await queue.run()
  return { ok: true, summary }
})

ipcMain.handle('render:cancel', () => {
  if (!queue || queue.finished) return false
  queue.cancel()
  return true
})

ipcMain.handle('render:state', () => (queue ? queue.state() : null))

/**
 * Opens the output folder in the OS file manager.
 *
 * An export's whole point is a folder of files somewhere else, so "show me"
 * is the obvious next thing to want, and making someone navigate to a path they
 * just watched scroll past is a small cruelty.
 */
ipcMain.handle('render:reveal', (_e, dirPath) => shell.openPath(dirPath))

ipcMain.handle('dialog:pickFiles', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: DIALOG_FILTERS,
  })
  if (result.canceled) return []

  // The dialog's filters are a hint the user can defeat with "All files", so
  // the extension check is repeated here rather than trusted from the picker.
  return result.filePaths.filter((filePath) => mediaKindOf(filePath) !== null)
})

app.whenReady().then(() => {
  protocol.handle('flux-asset', async (request) => {
    const raw = new URL(request.url).searchParams.get('p')
    if (!raw) return new Response('missing path', { status: 400 })

    const filePath = path.resolve(raw)
    // Policy here, bytes in assetServer: the renderer may ask for any path it
    // likes, and only media the app can actually decode is ever handed back.
    if (!isServableMediaPath(filePath)) {
      return new Response('unsupported media type', { status: 403 })
    }

    try {
      return await serveFile(request, filePath)
    } catch {
      return new Response('could not be read', { status: 500 })
    }
  })

  createWindow()

  // After the window, and not awaited: the cache working is not a condition of
  // the app starting, and a directory full of indexes to stat is exactly the
  // kind of thing that has no business happening before the first paint.
  pruneCache(mediaCachePath()).catch(() => {})

  // Same reasoning, one step further: whether a newer FLUX exists is never a
  // reason to make this one slower to appear.
  startUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
