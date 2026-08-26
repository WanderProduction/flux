/**
 * The FLUX project document — the one file that *is* the project.
 *
 *   <root>/
 *     project_files/<Project Name>.flux   the document
 *     imports/                            media copied into the project
 *     exports/                            renders
 *
 * The document holds everything the project knows: its name, its assets, its
 * sequence, its settings and where the user had the app arranged. Opening it is
 * the whole project coming back — that is what a .prproj does, and it is the
 * bar this has to clear.
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

/** The document lives with the app's bookkeeping, not loose in the root. */
export const DOCUMENT_DIR = 'project_files'

/**
 * Bumped when the document shape changes incompatibly.
 *
 *   1 — folder-only: a project.json manifest with assets.json / sequence.json
 *       beside it. Opened and migrated, never written.
 *   2 — a single .flux document, in the project root.
 *   3 — the document moved into project_files/ and gained `view`, so reopening
 *       restores the workspace and where you were, not just the edit.
 *
 * Older documents are read and upgraded. A *newer* one is refused outright —
 * see documentProblem.
 */
export const DOCUMENT_FORMAT = 3

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
 * Where the app arranged itself for this project: the active workspace, the
 * timeline's zoom, the folder the Content Browser was showing.
 *
 * This is saved but it is deliberately *not* unsaved work — zooming the
 * timeline must never light the dirty dot. It rides along with the next real
 * save. See kernel/view.ts.
 */
export function makeView(view) {
  return {
    workspace: typeof view?.workspace === 'string' ? view.workspace : 'edit',
    timeline: { zoom: Number(view?.timeline?.zoom) || 0 },
    browser: {
      location:
        view?.browser?.location?.type === 'folder' &&
        typeof view.browser.location.path === 'string'
          ? { type: 'folder', path: view.browser.location.path }
          : { type: 'project' },
    },
  }
}

/**
 * Builds a document from the parts the renderer holds.
 * @returns {object}
 */
export function makeDocument({
  name,
  createdAt,
  appVersion,
  assets,
  sequence,
  settings,
  view,
}) {
  return {
    flux: { format: DOCUMENT_FORMAT, version: appVersion },
    name,
    createdAt: createdAt ?? Date.now(),
    savedAt: Date.now(),
    settings: settings ?? {},
    view: makeView(view),
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
