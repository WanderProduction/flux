import fs from 'node:fs/promises'
import path from 'node:path'
import { mediaKindOf } from '../shared/mediaTypes.js'

/**
 * Filesystem reads for the Content Browser.
 *
 * Kept free of any `electron` import so it can be exercised by
 * `scripts/verify-filesystem.mjs` against a real temp directory. The moment
 * this needs `app.getPath`, that call belongs in main.js and the result gets
 * passed in.
 */

/**
 * A directory with more entries than this is truncated rather than sent whole.
 * A system folder can hold six figures of files, and serialising all of them
 * across IPC freezes the window for seconds — the exact stall FLUX exists to
 * avoid. The listing reports that it was cut so the UI can say so.
 */
const MAX_ENTRIES = 4000

/** Natural-ish ordering, so `clip2` sorts before `clip10`. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * @param {string} dirPath
 * @returns {Promise<{
 *   path: string,
 *   parent: string | null,
 *   folders: Array<{ name: string, path: string }>,
 *   files: Array<{ name: string, path: string, kind: 'image'|'video', size: number, mtimeMs: number }>,
 *   truncated: boolean,
 * }>}
 */
export async function listDirectory(dirPath) {
  const resolved = path.resolve(dirPath)
  const dirents = await fs.readdir(resolved, { withFileTypes: true })

  const folders = []
  /** @type {Array<{name: string, path: string, kind: 'image'|'video'}>} */
  const mediaNames = []
  let truncated = false

  for (const dirent of dirents) {
    if (folders.length + mediaNames.length >= MAX_ENTRIES) {
      truncated = true
      break
    }

    const name = dirent.name
    if (name.startsWith('.')) continue // dotfiles stay hidden

    const full = path.join(resolved, name)
    let isDirectory = dirent.isDirectory()

    // A symlink reports as neither file nor directory, so resolve it. If the
    // target is gone the stat throws and the entry is simply skipped.
    if (dirent.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(full)).isDirectory()
      } catch {
        continue
      }
    }

    if (isDirectory) {
      folders.push({ name, path: full })
      continue
    }

    const kind = mediaKindOf(name)
    if (kind) mediaNames.push({ name, path: full, kind })
  }

  // Only media files are stat'd — folders don't need size, and statting every
  // entry in a large mixed directory is what makes browsers feel slow.
  const files = []
  const stats = await Promise.all(
    mediaNames.map(async (entry) => {
      try {
        const stat = await fs.stat(entry.path)
        return { ...entry, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return null // vanished or unreadable between readdir and stat
      }
    }),
  )
  for (const stat of stats) if (stat) files.push(stat)

  folders.sort((a, b) => collator.compare(a.name, b.name))
  files.sort((a, b) => collator.compare(a.name, b.name))

  const parent = path.dirname(resolved)
  return {
    path: resolved,
    parent: parent === resolved ? null : parent, // a drive root is its own parent
    folders,
    files,
    truncated,
  }
}

/**
 * Mounted drive roots. On Windows there is no single filesystem root to walk,
 * so the 26 letters are probed directly — cheap in parallel, and it correctly
 * picks up mapped network and removable drives.
 * @returns {Promise<Array<{ name: string, path: string }>>}
 */
export async function listDrives() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const probed = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`
      try {
        await fs.access(root)
        return { name: `${letter}:`, path: root }
      } catch {
        return null
      }
    }),
  )
  return probed.filter((drive) => drive !== null)
}

/**
 * Which of these paths still exist. Imported assets are references to files on
 * disk, so a file can be moved or deleted behind the project's back — this is
 * how those cards get marked offline instead of rendering as broken images.
 * @param {string[]} paths
 * @returns {Promise<Record<string, boolean>>}
 */
export async function existsMany(paths) {
  const entries = await Promise.all(
    paths.map(async (target) => {
      try {
        await fs.access(target)
        return [target, true]
      } catch {
        return [target, false]
      }
    }),
  )
  return Object.fromEntries(entries)
}

/**
 * Guards the flux-asset protocol: only files FLUX itself recognises as media
 * may be served to the renderer. Without this the handler is an arbitrary-file
 * read primitive for anything that can reach the renderer.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isServableMediaPath(filePath) {
  return mediaKindOf(filePath) !== null
}
