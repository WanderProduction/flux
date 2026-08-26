import fs from 'node:fs/promises'
import path from 'node:path'

import { mediaKindOf } from '../shared/mediaTypes.js'

/**
 * Project creation and on-disk layout.
 *
 *   <root>/
 *     project_files/     manifest, and the project's own state (assets, sequence)
 *     imports/           media copied into the project, when the user chooses to
 *     exports/           renders — nothing writes here yet
 *
 * The manifest lives in project_files rather than the root because that folder
 * is defined as "the app's stuff": anything FLUX owns and the user should not
 * hand-edit goes there, while imports/ and exports/ are theirs.
 *
 * Kept free of any `electron` import so scripts/verify-project.mjs can exercise
 * it against a real temp directory.
 */

export const PROJECT_DIRS = ['project_files', 'imports', 'exports']
export const PROJECT_FILES_DIR = 'project_files'
export const IMPORTS_DIR = 'imports'
export const MANIFEST_NAME = 'project.json'

/**
 * Bumped when the on-disk shape changes incompatibly. Opening a project from a
 * newer format has to fail loudly rather than silently misread it — a project
 * file is the one thing in a media app that must never be quietly corrupted.
 */
export const PROJECT_FORMAT = 1

export function manifestPath(root) {
  return path.join(root, PROJECT_FILES_DIR, MANIFEST_NAME)
}

export function projectStorePath(root, name) {
  return path.join(root, PROJECT_FILES_DIR, `${name}.json`)
}

export function importsPath(root) {
  return path.join(root, IMPORTS_DIR)
}

/** True when `root` already holds a FLUX project. */
export async function isProject(root) {
  try {
    await fs.access(manifestPath(root))
    return true
  } catch {
    return false
  }
}

/**
 * Creates the folder layout and the manifest.
 *
 * Refuses rather than merges when a project is already present: silently
 * adopting an existing project would make "create" and "open" the same button,
 * and the user would have no way to tell which one just happened.
 */
export async function createProject(root, name, appVersion) {
  const resolved = path.resolve(root)

  try {
    await fs.access(resolved)
  } catch {
    return { ok: false, error: 'no-such-directory' }
  }

  if (await isProject(resolved)) return { ok: false, error: 'already-a-project' }

  const manifest = {
    flux: { version: appVersion, format: PROJECT_FORMAT },
    name: name.trim() || 'Untitled',
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  }

  try {
    for (const dir of PROJECT_DIRS) {
      await fs.mkdir(path.join(resolved, dir), { recursive: true })
    }
    await fs.writeFile(manifestPath(resolved), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'write-failed' }
  }

  return { ok: true, project: { root: resolved, ...manifest } }
}

export async function openProject(root) {
  const resolved = path.resolve(root)

  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath(resolved), 'utf8'))
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'not-a-project' : 'unreadable' }
  }

  const format = manifest?.flux?.format
  if (typeof format !== 'number') return { ok: false, error: 'unreadable' }
  if (format > PROJECT_FORMAT) return { ok: false, error: 'newer-format' }

  // A project folder can lose a directory to a sync client or a careless
  // cleanup; recreate rather than fail, since the manifest is what defines it.
  try {
    for (const dir of PROJECT_DIRS) {
      await fs.mkdir(path.join(resolved, dir), { recursive: true })
    }
  } catch {
    // Non-fatal: opening read-only media still beats refusing to open at all.
  }

  return { ok: true, project: { root: resolved, ...manifest } }
}

/** Splits `clip.mp4` into `['clip', '.mp4']`, handling dotfiles and no-extension names. */
function splitName(fileName) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return [fileName, '']
  return [fileName.slice(0, dot), fileName.slice(dot)]
}

/**
 * Copies a file into the project's imports folder, never overwriting.
 *
 * A collision means two different files share a name — very common with camera
 * output, where every card starts again at C0001.MP4. Overwriting would destroy
 * whichever was imported first, so the newcomer is suffixed instead.
 */
export async function copyIntoImports(root, sourcePath) {
  if (!mediaKindOf(sourcePath)) return { ok: false, error: 'unsupported-type' }

  const destDir = importsPath(root)
  try {
    await fs.mkdir(destDir, { recursive: true })
  } catch {
    return { ok: false, error: 'denied' }
  }

  const [base, ext] = splitName(path.basename(sourcePath))

  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = path.join(destDir, attempt === 0 ? `${base}${ext}` : `${base} (${attempt})${ext}`)
    try {
      // COPYFILE_EXCL makes the "does it exist" check and the copy one atomic
      // step; testing first would leave a window for another copy to win.
      await fs.copyFile(sourcePath, candidate, fs.constants.COPYFILE_EXCL)
      const stat = await fs.stat(candidate)
      return { ok: true, path: candidate, size: stat.size, mtimeMs: stat.mtimeMs }
    } catch (err) {
      if (err.code === 'EEXIST') continue // name taken, try the next suffix
      if (err.code === 'ENOENT') return { ok: false, error: 'source-missing' }
      if (err.code === 'EACCES' || err.code === 'EPERM') return { ok: false, error: 'denied' }
      if (err.code === 'ENOSPC') return { ok: false, error: 'no-space' }
      return { ok: false, error: 'copy-failed' }
    }
  }
  return { ok: false, error: 'too-many-collisions' }
}

export async function readProjectStore(root, name) {
  try {
    return JSON.parse(await fs.readFile(projectStorePath(root, name), 'utf8'))
  } catch {
    return null // absent or corrupt — the renderer falls back to defaults
  }
}

export async function writeProjectStore(root, name, value) {
  const target = projectStorePath(root, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(value, null, 2), 'utf8')
  return true
}
