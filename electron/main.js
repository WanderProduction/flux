import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = 'http://127.0.0.1:5273'
const isDev = !app.isPackaged

/**
 * Workspaces and keymaps are user data, not app data — they live next to the
 * user's config so a reinstall never eats their layouts.
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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
