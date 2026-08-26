import fs from 'node:fs/promises'
import path from 'node:path'

import { mediaKindOf } from '../shared/mediaTypes.js'
import { projectFolderPath, safeFolderName } from '../shared/projectNaming.js'
import {
  AUTOSAVE_NAME,
  DOCUMENT_FORMAT,
  documentFileName,
  documentProblem,
  isProjectFile,
  makeDocument,
} from '../shared/projectFormat.js'

/**
 * Project creation, and reading and writing the project document.
 *
 *   <root>/
 *     <Project Name>.flux    the document — this IS the project
 *     project_files/         the app's bookkeeping: autosave
 *     imports/               media copied into the project
 *     exports/               renders — nothing writes here yet
 *
 * Kept free of any `electron` import so scripts/verify-project-fs.mjs can
 * exercise it against a real temp directory.
 */

export const PROJECT_DIRS = ['project_files', 'imports', 'exports']
export const PROJECT_FILES_DIR = 'project_files'
export const IMPORTS_DIR = 'imports'

/** The v1 manifest. Read for migration, never written. */
const LEGACY_MANIFEST = 'project.json'

export function projectFilesPath(root) {
  return path.join(root, PROJECT_FILES_DIR)
}

export function autosavePath(root) {
  return path.join(root, PROJECT_FILES_DIR, AUTOSAVE_NAME)
}

export function importsPath(root) {
  return path.join(root, IMPORTS_DIR)
}

/** The document in a project folder, or null. */
export async function findProjectFile(root) {
  try {
    const entries = await fs.readdir(root)
    const found = entries.filter(isProjectFile).sort()
    return found.length > 0 ? path.join(root, found[0]) : null
  } catch {
    return null
  }
}

/** True when `root` holds a project — a .flux document, or a v1 manifest. */
export async function isProject(root) {
  if (await findProjectFile(root)) return true
  try {
    await fs.access(path.join(root, PROJECT_FILES_DIR, LEGACY_MANIFEST))
    return true
  } catch {
    return false
  }
}

/**
 * Writes JSON without ever leaving a half-written file in place.
 *
 * A project document is the one file a media app must never corrupt, and a
 * plain writeFile that is interrupted — a crash, a power cut, a sync client
 * grabbing the handle — truncates the real thing. Writing a temp file and
 * renaming it makes the swap atomic: the old document survives intact until the
 * new one is complete on disk.
 */
async function writeJsonAtomic(target, value) {
  const temp = `${target}.tmp-${process.pid}`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  try {
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true })
    throw err
  }
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'))
}

/**
 * Creates a project folder named after the project inside `parent`, its
 * subfolders, and the document.
 *
 * The named folder matters: without it, choosing Downloads once would scatter
 * project_files / imports / exports directly into Downloads, and a second
 * project could never live beside the first.
 */
export async function createProject(parent, name, appVersion) {
  const resolvedParent = path.resolve(parent)

  try {
    await fs.access(resolvedParent)
  } catch {
    return { ok: false, error: 'no-such-directory' }
  }

  const folder = safeFolderName(name)
  const root = path.join(resolvedParent, folder)
  if (await isProject(root)) return { ok: false, error: 'already-a-project' }

  const document = makeDocument({
    name: name.trim() || 'Untitled',
    appVersion,
    assets: [],
    sequence: null,
  })
  const file = path.join(root, documentFileName(folder))

  try {
    for (const dir of PROJECT_DIRS) {
      await fs.mkdir(path.join(root, dir), { recursive: true })
    }
    await writeJsonAtomic(file, document)
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'write-failed',
    }
  }

  return { ok: true, project: { root, file, ...document } }
}

/** Where `createProject` would put a project — used by the launcher's preview. */
export function plannedProjectPath(parent, name) {
  return projectFolderPath(path.resolve(parent), name)
}

/**
 * Reads a v1 project (project.json + assets.json + sequence.json) into a v2
 * document, so folders made before the format existed still open.
 */
async function readLegacyProject(root) {
  const manifest = await readJson(path.join(root, PROJECT_FILES_DIR, LEGACY_MANIFEST))
  const read = async (name) => {
    try {
      return await readJson(path.join(root, PROJECT_FILES_DIR, `${name}.json`))
    } catch {
      return null
    }
  }

  return makeDocument({
    name: manifest?.name ?? path.basename(root),
    createdAt: manifest?.createdAt,
    appVersion: manifest?.flux?.version ?? '0.0.0',
    assets: (await read('assets')) ?? [],
    sequence: await read('sequence'),
    settings: { importMode: (await read('import-mode')) ?? 'ask' },
  })
}

/**
 * Opens a project folder, or a .flux file directly.
 *
 * When an autosave is newer than the saved document, the autosave wins and the
 * project comes back marked unsaved. Preferring the older file would silently
 * discard whatever happened after the last save — which is exactly the work an
 * autosave exists to protect.
 */
export async function openProject(target) {
  const resolved = path.resolve(target)

  let root = resolved
  let file = null

  if (isProjectFile(resolved)) {
    file = resolved
    root = path.dirname(resolved)
  } else {
    file = await findProjectFile(resolved)
  }

  let document = null
  let migrated = false

  if (file) {
    try {
      document = await readJson(file)
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'not-a-project' : 'unreadable' }
    }
  } else {
    // No document: this may be a project from before the format existed.
    try {
      document = await readLegacyProject(root)
      migrated = true
      file = path.join(root, documentFileName(safeFolderName(document.name)))
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'not-a-project' : 'unreadable' }
    }
  }

  const problem = documentProblem(document)
  if (problem) return { ok: false, error: problem }

  // A folder can lose a directory to a sync client or a careless cleanup;
  // recreate rather than fail, since the document is what defines the project.
  try {
    for (const dir of PROJECT_DIRS) {
      await fs.mkdir(path.join(root, dir), { recursive: true })
    }
  } catch {
    // Non-fatal: opening read-only media still beats refusing to open at all.
  }

  let recovered = false
  try {
    const [autosaveStat, fileStat] = await Promise.all([
      fs.stat(autosavePath(root)),
      fs.stat(file).catch(() => null),
    ])
    if (!fileStat || autosaveStat.mtimeMs > fileStat.mtimeMs) {
      const autosaved = await readJson(autosavePath(root))
      if (!documentProblem(autosaved)) {
        document = autosaved
        recovered = true
      }
    }
  } catch {
    // No autosave, or it is unreadable. The saved document stands.
  }

  return {
    ok: true,
    project: { root, file, ...document },
    // `dirty` on open: migrated and recovered projects both hold something the
    // document on disk does not, so the user is told there is work to save.
    dirty: migrated || recovered,
    recovered,
    migrated,
  }
}

/** Writes the document. `file` is the target so Save As can pass a new path. */
export async function saveProject(file, document) {
  try {
    await writeJsonAtomic(file, document)
    // The autosave has served its purpose; leaving it behind would make the
    // next open think there is unsaved work.
    await fs.rm(autosavePath(path.dirname(file)), { force: true })
    return { ok: true, savedAt: document.savedAt }
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'write-failed',
    }
  }
}

export async function writeAutosave(root, document) {
  try {
    await writeJsonAtomic(autosavePath(root), document)
    return { ok: true }
  } catch {
    return { ok: false }
  }
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
    const candidate = path.join(
      destDir,
      attempt === 0 ? `${base}${ext}` : `${base} (${attempt})${ext}`,
    )
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

export { DOCUMENT_FORMAT }
