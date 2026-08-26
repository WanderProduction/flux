/**
 * The one way media enters a project, wherever the gesture started.
 *
 * This used to live inside the Content Browser, which was fine while the
 * Content Browser was the only thing that could import. It is not any more: a
 * file dragged straight onto the Timeline — from a folder, or out of Explorer —
 * has to be imported before it can become a clip. Two copies of the copy-or-
 * link decision would be two places for it to drift, so the decision lives here
 * and the panels just call in.
 *
 * The copy-or-link question is asked through a *request*, not a callback into
 * whichever panel happens to be mounted: the Timeline must be able to ask it,
 * and the Timeline has no dialog of its own. A single host mounted by the app
 * shell answers whatever is pending — see ImportChoiceHost in App.tsx.
 */

import { importAssets, type Asset } from './assets'
import { getImportMode, setImportMode, type ImportMode } from './importMode'
import { copyIntoImports, getProject } from './project'
import type { MediaKind } from './fsBridge'

export interface ImportEntry {
  path: string
  kind: MediaKind
  size?: number
  mtimeMs?: number
  inProject?: boolean
}

export interface ImportChoice {
  mode: 'copy' | 'link'
  remember: boolean
}

export interface ImportRequest {
  entries: ImportEntry[]
  projectName?: string
  answer: (choice: ImportChoice | null) => void
}

/** Copy progress, and the last failure, for whoever wants to show them. */
export interface ImportStatus {
  progress: string | null
  error: string | null
}

let request: ImportRequest | null = null
let status: ImportStatus = { progress: null, error: null }
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeImports(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getImportRequest(): ImportRequest | null {
  return request
}

export function getImportStatus(): ImportStatus {
  return status
}

export function clearImportError(): void {
  if (!status.error) return
  status = { ...status, error: null }
  emit()
}

function setStatus(patch: Partial<ImportStatus>) {
  status = { ...status, ...patch }
  emit()
}

function ask(entries: ImportEntry[]): Promise<ImportChoice | null> {
  // A second question while one is on screen would replace the first and leave
  // its caller waiting forever, so the newcomer is refused instead.
  if (request) return Promise.resolve(null)

  return new Promise((resolve) => {
    request = {
      entries,
      projectName: getProject()?.name,
      answer: (choice) => {
        request = null
        emit()
        resolve(choice)
      },
    }
    emit()
  })
}

/**
 * Copies each file into the project, then imports the copies.
 *
 * Sequential rather than parallel: copying several camera files at once
 * saturates the disk and makes every one of them slower, and a serial queue is
 * what lets the progress line say which file is being worked on.
 */
async function importByCopy(entries: ImportEntry[]): Promise<Asset[]> {
  const copied: ImportEntry[] = []
  const failures: string[] = []

  for (const [index, entry] of entries.entries()) {
    setStatus({ progress: `Copying ${index + 1} of ${entries.length}…` })
    const result = await copyIntoImports(entry.path)
    if (result.ok && result.path) {
      copied.push({
        path: result.path,
        kind: entry.kind,
        size: result.size,
        mtimeMs: result.mtimeMs,
        inProject: true,
      })
    } else {
      failures.push(`${entry.path.split(/[\\/]/).pop()} (${result.error ?? 'failed'})`)
    }
  }

  setStatus({
    progress: null,
    // Surfaced rather than swallowed: a copy that silently did not happen is a
    // file the user believes is backed up and is not.
    error: failures.length > 0 ? `Could not copy ${failures.length}: ${failures.join(', ')}` : null,
  })

  return copied.length > 0 ? importAssets(copied) : []
}

/**
 * Imports files into the project and returns the assets that were added.
 *
 * Returns [] for files already in the project — importing the same path twice
 * is a no-op, not a duplicate. Callers that need the asset either way (the
 * Timeline, placing a clip) should look the path up afterwards.
 *
 * `forced` comes from the split button's menu and skips both the stored
 * preference and the question.
 */
export async function importFiles(
  entries: ImportEntry[],
  forced?: 'copy' | 'link',
): Promise<Asset[]> {
  if (entries.length === 0) return []

  // Without a project there is nowhere to copy to, so linking is the only
  // option available.
  const canCopy = Boolean(getProject())
  let mode: ImportMode = forced ?? (canCopy ? getImportMode() : 'link')

  if (mode === 'ask') {
    const choice = await ask(entries)
    if (!choice) return []
    mode = choice.mode
    if (choice.remember) setImportMode(choice.mode)
  }

  if (mode === 'copy' && canCopy) return importByCopy(entries)
  return importAssets(entries)
}
