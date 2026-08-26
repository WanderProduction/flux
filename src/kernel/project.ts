/**
 * The open project.
 *
 * Everything the user makes belongs to a project, so this gates the app: until
 * one is open the launcher is shown instead of the dock. Project state (assets,
 * sequence) is written inside the project folder rather than into userData, so
 * opening a different project shows a different timeline and a project folder
 * copied to another machine brings its contents along.
 */

import { resetAssets } from './assets'
import { resetImportMode } from './importMode'
import { resetSequence } from './sequence'
import { loadStore, saveStore, setProjectRoot } from './store'

export interface Project {
  root: string
  name: string
  createdAt: number
  modifiedAt: number
  flux: { version: string; format: number }
}

export type ProjectError =
  | 'no-such-directory'
  | 'already-a-project'
  | 'not-a-project'
  | 'unreadable'
  | 'newer-format'
  | 'denied'
  | 'write-failed'

export type ProjectResult = { ok: true; project: Project } | { ok: false; error: ProjectError }

export interface CopyResult {
  ok: boolean
  path?: string
  size?: number
  mtimeMs?: number
  error?: string
}

interface ProjectBridge {
  create: (root: string, name: string) => Promise<ProjectResult>
  open: (root: string) => Promise<ProjectResult>
  is: (root: string) => Promise<boolean>
  copyIntoImports: (root: string, sourcePath: string) => Promise<CopyResult>
  storeGet: (root: string, name: string) => Promise<unknown>
  storeSet: (root: string, name: string, value: unknown) => Promise<boolean>
}

interface FluxBridge {
  project?: ProjectBridge
  fs?: { pickDirectory: () => Promise<string | null> }
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const hasProjects = Boolean(bridge?.project)

function requireProject(): ProjectBridge {
  if (!bridge?.project) throw new Error('project bridge unavailable outside Electron')
  return bridge.project
}

/** A project the user has opened before. `missing` is set when its folder is gone. */
export interface RecentProject {
  root: string
  name: string
  openedAt: number
  missing?: boolean
}

const RECENTS_STORE = 'recent-projects'
const MAX_RECENTS = 12

let current: Project | null = null
let recents: RecentProject[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeProject(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProject(): Project | null {
  return current
}

export function getRecents(): RecentProject[] {
  return recents
}

export async function loadRecents(): Promise<void> {
  const stored = await loadStore<RecentProject[]>(RECENTS_STORE, [])
  const list = Array.isArray(stored) ? stored : []

  // Folders get moved and deleted between sessions; a recents list that offers
  // dead entries with no warning is worse than one that admits it.
  if (bridge?.project) {
    const checked = await Promise.all(
      list.map(async (entry) => ({
        ...entry,
        missing: !(await requireProject().is(entry.root)),
      })),
    )
    recents = checked
  } else {
    recents = list
  }
  emit()
}

function rememberRecent(project: Project) {
  const entry: RecentProject = {
    root: project.root,
    name: project.name,
    openedAt: Date.now(),
  }
  recents = [entry, ...recents.filter((r) => r.root !== project.root)].slice(0, MAX_RECENTS)
  void saveStore(RECENTS_STORE, recents)
  emit()
}

export function forgetRecent(root: string) {
  recents = recents.filter((r) => r.root !== root)
  void saveStore(RECENTS_STORE, recents)
  emit()
}

/**
 * Makes a project current, pointing project-scoped stores at its folder.
 *
 * Order matters: the previous project's state is dropped *before* the new root
 * is set, so nothing from the old project can be written into the new one's
 * folder by a save that fires in between.
 */
function adopt(project: Project) {
  resetAssets()
  resetSequence()
  resetImportMode()
  current = project
  setProjectRoot(project.root)
  rememberRecent(project)
  emit()
}

export async function createProject(root: string, name: string): Promise<ProjectResult> {
  const result = await requireProject().create(root, name)
  if (result.ok) adopt(result.project)
  return result
}

export async function openProject(root: string): Promise<ProjectResult> {
  const result = await requireProject().open(root)
  if (result.ok) adopt(result.project)
  else if (result.error === 'not-a-project') {
    // Keep the list honest the moment we learn an entry is bad.
    recents = recents.map((r) => (r.root === root ? { ...r, missing: true } : r))
    emit()
  }
  return result
}

/** Returns to the launcher. Nothing is written on the way out — saves are continuous. */
export function closeProject() {
  resetAssets()
  resetSequence()
  resetImportMode()
  current = null
  setProjectRoot(null)
  emit()
}

export function pickDirectory(): Promise<string | null> {
  if (!bridge?.fs) throw new Error('filesystem bridge unavailable outside Electron')
  return bridge.fs.pickDirectory()
}

export function isProjectFolder(root: string): Promise<boolean> {
  return requireProject().is(root)
}

export function copyIntoImports(sourcePath: string): Promise<CopyResult> {
  if (!current) return Promise.resolve({ ok: false, error: 'no-project' })
  return requireProject().copyIntoImports(current.root, sourcePath)
}

/** Human text for the failures the launcher can hit. */
export function describeProjectError(error: ProjectError): string {
  switch (error) {
    case 'no-such-directory':
      return 'That folder no longer exists.'
    case 'already-a-project':
      return 'There is already a FLUX project in that folder. Open it instead.'
    case 'not-a-project':
      return 'No FLUX project in that folder.'
    case 'newer-format':
      return 'That project was made with a newer version of FLUX.'
    case 'denied':
      return 'FLUX is not allowed to write to that folder.'
    case 'write-failed':
      return 'The project could not be written.'
    default:
      return 'That project could not be read.'
  }
}
