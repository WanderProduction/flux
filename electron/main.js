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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (isDev) {
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
