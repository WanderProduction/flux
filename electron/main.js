import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

import { DIALOG_FILTERS, mediaKindOf } from '../shared/mediaTypes.js'
import {
  existsMany,
  isServableMediaPath,
  listDirectory,
  listDrives,
  listSubfolders,
} from './filesystem.js'
import { copyIntoImports, createProject, isProject, openProject, saveProject } from './project.js'
import { PROJECT_EXTENSION } from '../shared/projectFormat.js'

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

const DEV_URL = 'http://127.0.0.1:5273'
const isDev = !app.isPackaged

/**
 * Local media is served to the renderer over a custom scheme rather than
 * file://, which the renderer's CSP blocks outright. Going through net.fetch
 * also gets range requests for free, so a <video> can seek without the whole
 * file being pulled into memory first.
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
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    show: false,
    autoHideMenuBar: true,
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
    },
  })

  win.once('ready-to-show', () => win.show())

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

ipcMain.handle('project:create', (_e, root, name) => createProject(root, name, app.getVersion()))
ipcMain.handle('project:open', (_e, root) => openProject(root))
ipcMain.handle('project:is', (_e, root) => isProject(root))
ipcMain.handle('project:copyIntoImports', (_e, root, sourcePath) =>
  copyIntoImports(root, sourcePath),
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
    if (!isServableMediaPath(filePath)) {
      return new Response('unsupported media type', { status: 403 })
    }

    try {
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
