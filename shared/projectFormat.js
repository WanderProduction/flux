/**
 * The FLUX project document — the one file that *is* the project.
 *
 * `<root>/<Project Name>.flux` holds everything the project knows: its name,
 * its assets and its sequence. It sits in the project root rather than inside
 * project_files because it is the user's document, not the app's bookkeeping —
 * it is the thing they back up, copy and double-click.
 *
 * The format is plain JSON on purpose. VISION.md promises open, inspectable
 * project files; a media app that can lose someone's edit to an opaque binary
 * blob has failed at the only job that really matters. It also means a project
 * diffs in git.
 *
 * Imported by BOTH the Electron main process (which reads and writes it) and
 * the renderer (which builds and applies it).
 */

export const PROJECT_EXTENSION = '.flux'

/**
 * Bumped when the document shape changes incompatibly.
 *
 *   1 — folder-only: a project.json manifest with assets.json / sequence.json
 *       beside it. Opened and migrated, never written.
 *   2 — a single .flux document.
 */
export const DOCUMENT_FORMAT = 2

/** Autosave lives in project_files: it is the app's safety net, not a document. */
export const AUTOSAVE_NAME = 'autosave.flux'

/**
 * @param {string} fileName
 * @returns {boolean}
 */
export function isProjectFile(fileName) {
  return fileName.toLowerCase().endsWith(PROJECT_EXTENSION)
}

/**
 * @param {string} safeName a name already run through safeFolderName
 * @returns {string}
 */
export function documentFileName(safeName) {
  return `${safeName}${PROJECT_EXTENSION}`
}

/**
 * Builds a document from the parts the renderer holds.
 * @returns {object}
 */
export function makeDocument({ name, createdAt, appVersion, assets, sequence, settings }) {
  return {
    flux: { format: DOCUMENT_FORMAT, version: appVersion },
    name,
    createdAt: createdAt ?? Date.now(),
    savedAt: Date.now(),
    settings: settings ?? {},
    assets: assets ?? [],
    sequence: sequence ?? null,
  }
}

/**
 * Why a document cannot be opened, or null when it can.
 *
 * Refusing a newer format matters more here than anywhere else: silently
 * misreading a project would present a damaged edit as the real one, and the
 * next save would make that permanent.
 * @param {any} doc
 * @returns {'unreadable' | 'newer-format' | null}
 */
export function documentProblem(doc) {
  const format = doc?.flux?.format
  if (typeof format !== 'number') return 'unreadable'
  if (format > DOCUMENT_FORMAT) return 'newer-format'
  return null
}
