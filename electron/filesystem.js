import fs from 'node:fs/promises'
import path from 'node:path'
import { mediaKindOf } from '../shared/mediaTypes.js'
import { skipReasonFor } from '../shared/footageFilter.js'

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

/**
 * Files one footage scan will return.
 *
 * Far larger than MAX_ENTRIES because it is a different promise: a listing is
 * drawn as cards in a pane and 4,000 of them is already more than anyone
 * reads, while a scan is a manifest handed to an importer. The whole library
 * this was built for is 10,898 video files, so the cap is set above it on
 * purpose — it exists to stop a scan of C: running for ever, not to ration a
 * real archive.
 */
const MAX_SCAN_FILES = 20000

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
    if (isHiddenEntry(name)) continue

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

/**
 * Entries a file browser should not show.
 *
 * Dotfiles everywhere, plus the Windows system folders that sit in every drive
 * root and only ever produce an EACCES when opened — `$Recycle.Bin`,
 * `System Volume Information` and friends. Explorer hides them for the same
 * reason. This is a name-based test rather than a real hidden-attribute check
 * because Node exposes no portable way to read that attribute, and a wrong
 * guess here only ever hides noise.
 * @param {string} name
 * @returns {boolean}
 */
export function isHiddenEntry(name) {
  if (name.startsWith('.')) return true
  if (process.platform !== 'win32') return false
  return name.startsWith('$') || name === 'System Volume Information'
}

/**
 * Subdirectories only — the tree's expand step.
 *
 * Deliberately not listDirectory: expanding a node needs no file metadata, and
 * statting every media file in a folder the user is only passing through is
 * work that shows up as a stutter on each chevron click.
 * @param {string} dirPath
 * @returns {Promise<{ folders: Array<{ name: string, path: string }>, truncated: boolean }>}
 */
export async function listSubfolders(dirPath) {
  const resolved = path.resolve(dirPath)
  const dirents = await fs.readdir(resolved, { withFileTypes: true })

  const folders = []
  let truncated = false

  for (const dirent of dirents) {
    if (folders.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const name = dirent.name
    if (isHiddenEntry(name)) continue

    const full = path.join(resolved, name)
    let isDirectory = dirent.isDirectory()
    if (dirent.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(full)).isDirectory()
      } catch {
        continue // dangling link
      }
    }
    if (isDirectory) folders.push({ name, path: full })
  }

  folders.sort((a, b) => collator.compare(a.name, b.name))
  return { folders, truncated }
}

/**
 * Every media file under a folder, for a batch import.
 *
 * Separate from listDirectory rather than a flag on it, because almost nothing
 * about it is the same job. listDirectory answers "what is in this folder" for
 * a browser pane and must return in a frame; this answers "what footage is in
 * this tree" for an import that is about to lay hundreds of clips on a
 * timeline, and is allowed to take seconds. The library this was built against
 * holds 10,898 video files across 343 folders, so walking it is real work.
 *
 * Three things it does that a listing must not:
 *
 *   - **It walks past proxy and cache folders.** See shared/footageFilter.js.
 *     A browser pane shows you what is there; a scan that offered the Proxies
 *     folder beside the originals would import every shot twice.
 *   - **It reports what it skipped**, by reason and with counts, so the filter
 *     is auditable rather than trusted.
 *   - **It is breadth-first.** A tree that has to be truncated is then
 *     truncated at depth rather than inside whichever branch happened to sort
 *     first — the difference between "the first 20,000 files of this archive"
 *     and "all of the A folder and none of the rest".
 *
 * Symlinks are not followed into. A footage drive with a link back to its own
 * parent is not hypothetical, and a scan that follows it does not finish.
 *
 * @param {string} rootPath
 * @param {{ maxFiles?: number }} [options]
 * @returns {Promise<{
 *   root: string,
 *   files: Array<{ name: string, path: string, kind: 'image'|'video', size: number, mtimeMs: number }>,
 *   folders: number,
 *   skipped: Array<{ path: string, reason: string }>,
 *   unreadable: Array<{ path: string, error: string }>,
 *   truncated: boolean,
 * }>}
 */
export async function scanFootage(rootPath, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES
  const root = path.resolve(rootPath)

  /** @type {Array<{ name: string, path: string, kind: 'image'|'video' }>} */
  const found = []
  /** @type {Array<{ path: string, reason: string }>} */
  const skipped = []
  /** @type {Array<{ path: string, error: string }>} */
  const unreadable = []
  let folders = 0
  let truncated = false

  let frontier = [root]
  while (frontier.length > 0 && !truncated) {
    /** @type {string[]} */
    const next = []
    for (const dir of frontier) {
      if (truncated) break
      folders += 1

      let dirents
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        // A folder that cannot be read is recorded, not fatal. One permission
        // error partway through a drive must not lose the scan that preceded it.
        unreadable.push({ path: dir, error: err instanceof Error ? err.message : String(err) })
        continue
      }

      for (const dirent of dirents) {
        const name = dirent.name
        const full = path.join(dir, name)

        if (dirent.isSymbolicLink()) continue

        if (dirent.isDirectory()) {
          const reason = skipReasonFor(name)
          if (reason) skipped.push({ path: full, reason })
          else next.push(full)
          continue
        }

        if (isHiddenEntry(name)) continue
        const kind = mediaKindOf(name)
        if (!kind) continue
        if (found.length >= maxFiles) {
          truncated = true
          break
        }
        found.push({ name, path: full, kind })
      }
    }
    frontier = next
  }

  /*
   * Stat'd at the end and in parallel, after the walk rather than during it.
   * The walk is one directory at a time because readdir order is what makes it
   * breadth-first; the stats have no ordering requirement and there are
   * thousands of them.
   */
  const files = []
  const stats = await Promise.all(
    found.map(async (entry) => {
      try {
        const stat = await fs.stat(entry.path)
        return { ...entry, size: stat.size, mtimeMs: stat.mtimeMs }
      } catch {
        return null // vanished or unreadable between readdir and stat
      }
    }),
  )
  for (const stat of stats) if (stat) files.push(stat)

  /*
   * Sorted by path, which for camera footage is also chronological: a card
   * writes DSCF1906 before DSCF1907, and a shoot folder is named for its date.
   * The order matters more here than in a listing — it is the order hundreds of
   * clips will be laid out in, and a review is a pass down the timeline.
   */
  files.sort((a, b) => collator.compare(a.path, b.path))

  return { root, files, folders, skipped, unreadable, truncated }
}
