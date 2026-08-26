/**
 * The open project, and the document that is the project.
 *
 * This module owns persistence. assets.ts, sequence.ts and view.ts are pure
 * state: they announce changes and nothing else, and this listens, marks the
 * project unsaved, and folds everything into one `.flux` document. One file is
 * the project, so exactly one place decides when it gets written.
 *
 * Saving is explicit — Ctrl S, and nothing else. There is deliberately no
 * autosave yet. Because of that, closing with unsaved work has to *ask*: see
 * the close guard in electron/main.js, which is driven by the dirty flag this
 * module pushes across the bridge.
 */

import {
  getAssets,
  resetAssets,
  setAssets,
  subscribeAssets,
  verifyAssetPaths,
  type Asset,
} from './assets'
import {
  getImportMode,
  resetImportMode,
  setImportMode,
  subscribeImportMode,
  type ImportMode,
} from './importMode'
import {
  getSequence,
  resetSequence,
  setSequence,
  subscribeSequence,
  type SequenceState,
} from './sequence'
import { getView, resetView, setView, type ViewState } from './view'
import { loadStore, saveStore } from './store'
import { DOCUMENT_FORMAT } from '../../shared/projectFormat.js'

export interface ProjectDocument {
  flux: { format: number; version: string }
  name: string
  createdAt: number
  savedAt: number
  settings?: { importMode?: ImportMode }
  /** Workspace, timeline zoom, where the browser was. Never marks work unsaved. */
  view?: ViewState
  assets: Asset[]
  sequence: SequenceState | null
}

export interface Project extends ProjectDocument {
  root: string
  /** Absolute path of the .flux document, inside project_files. */
  file: string
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

interface OpenResult {
  ok: boolean
  project?: Project
  error?: ProjectError
  dirty?: boolean
  migrated?: boolean
  relocated?: boolean
}

interface ProjectBridge {
  create: (parent: string, name: string) => Promise<ProjectResult>
  open: (target: string) => Promise<OpenResult>
  is: (root: string) => Promise<boolean>
  save: (file: string, document: ProjectDocument) => Promise<{ ok: boolean; error?: string }>
  copyIntoImports: (root: string, sourcePath: string) => Promise<CopyResult>
  /** A .flux path passed on the command line, when FLUX was launched with one. */
  launchTarget: () => Promise<string | null>
  /** Tells the main process whether closing would lose work. */
  setUnsaved: (unsaved: boolean) => void
  /** Main asks for a save before it lets the window close. */
  onSaveAndClose: (handler: () => Promise<void>) => void
  /** A .flux opened while FLUX was already running. */
  onOpenTarget: (handler: (file: string) => void) => void
}

interface FluxBridge {
  project?: ProjectBridge
  fs?: { pickDirectory: () => Promise<string | null>; pickProjectFile: () => Promise<string | null> }
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const hasProjects = Boolean(bridge?.project)

function requireProject(): ProjectBridge {
  if (!bridge?.project) throw new Error('project bridge unavailable outside Electron')
  return bridge.project
}

/** A project the user has opened before. `missing` is set when its file is gone. */
export interface RecentProject {
  root: string
  file?: string
  name: string
  openedAt: number
  missing?: boolean
}

const RECENTS_STORE = 'recent-projects'
const MAX_RECENTS = 12

let current: Project | null = null
let recents: RecentProject[] = []
let dirty = false
let saving = false
/**
 * Set while a document is being applied to the state modules.
 *
 * Those modules notify on every change and this listens to mark the project
 * unsaved — so without the guard, *opening* a project marks it unsaved. The
 * offline-path re-check is the one that bites: it runs just after open and
 * touches every asset, so a freshly opened project would claim work to save
 * before the user had done anything.
 */
let applying = false
const listeners = new Set<() => void>()

/** Last value pushed to main, so the bridge is not hit on every notification. */
let pushedUnsaved = false

function pushUnsaved() {
  const unsaved = Boolean(current) && dirty
  if (unsaved === pushedUnsaved) return
  pushedUnsaved = unsaved
  bridge?.project?.setUnsaved(unsaved)
}

function emit() {
  pushUnsaved()
  listeners.forEach((listener) => listener())
}

export function subscribeProject(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProject(): Project | null {
  return current
}

export function isDirty(): boolean {
  return dirty
}

export function isSaving(): boolean {
  return saving
}

export function getRecents(): RecentProject[] {
  return recents
}

// ── the document ──────────────────────────────────────────────

/** Everything the project currently is, ready to write. */
export function buildDocument(): ProjectDocument | null {
  if (!current) return null
  return {
    // Stamped, not carried over: a project opened from an older format is
    // being written in the current one, and a document that keeps claiming the
    // format it arrived as is simply lying about its own shape.
    flux: { format: DOCUMENT_FORMAT, version: current.flux.version },
    name: current.name,
    createdAt: current.createdAt,
    savedAt: Date.now(),
    settings: { importMode: getImportMode() },
    view: getView(),
    assets: getAssets(),
    sequence: getSequence(),
  }
}

/** Anything that changes project state lands here. */
function markDirty() {
  if (!current || applying) return
  if (dirty) return
  dirty = true
  emit()
}

// Persistence is wired once, at module load, rather than from a component:
// state can change with no panel mounted, and those changes still have to be
// saved. view.ts is absent on purpose — see the note at the top of that file.
subscribeAssets(markDirty)
subscribeSequence(markDirty)
subscribeImportMode(markDirty)

// ── recents ───────────────────────────────────────────────────

export async function loadRecents(): Promise<void> {
  const stored = await loadStore<RecentProject[]>(RECENTS_STORE, [])
  const list = Array.isArray(stored) ? stored : []

  // Folders get moved and deleted between sessions; a recents list that offers
  // dead entries with no warning is worse than one that admits it.
  if (bridge?.project) {
    recents = await Promise.all(
      list.map(async (entry) => ({
        ...entry,
        missing: !(await requireProject().is(entry.root)),
      })),
    )
  } else {
    recents = list
  }
  emit()
}

function rememberRecent(project: Project) {
  const entry: RecentProject = {
    root: project.root,
    file: project.file,
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

// ── open, create, close ───────────────────────────────────────

/** Drops all project state without writing anything. */
function clearState() {
  resetAssets()
  resetSequence()
  resetImportMode()
  resetView()
}

/**
 * Makes a project current and applies its document.
 *
 * Order matters: the previous project's state is dropped before the new root is
 * set, so nothing from the old project can be written into the new one's folder
 * by a save that fires in between.
 */
function adopt(project: Project, startDirty: boolean) {
  applying = true
  clearState()
  current = project

  setAssets(project.assets ?? [])
  setSequence(project.sequence ?? null)
  setImportMode(project.settings?.importMode ?? 'ask', { persist: false })
  setView(project.view)

  // setAssets/setSequence/setView notify without marking dirty, so this is the
  // whole truth about whether there is unsaved work.
  dirty = startDirty
  rememberRecent(project)
  emit()

  // Files move while FLUX is closed; the check is async so the project opens
  // immediately and offline badges appear a moment later. It stays inside the
  // applying guard: discovering a file is missing is not the user's edit.
  void verifyAssetPaths().finally(() => {
    applying = false
  })
}

export async function createProject(parent: string, name: string): Promise<ProjectResult> {
  const result = await requireProject().create(parent, name)
  if (result.ok) adopt(result.project, false)
  return result
}

export async function openProject(target: string): Promise<ProjectResult> {
  const result = await requireProject().open(target)
  if (result.ok && result.project) {
    adopt(result.project, Boolean(result.dirty))
    return { ok: true, project: result.project }
  }
  if (result.error === 'not-a-project') {
    // Keep the list honest the moment we learn an entry is bad.
    recents = recents.map((r) => (r.root === target ? { ...r, missing: true } : r))
    emit()
  }
  return { ok: false, error: result.error ?? 'unreadable' }
}

export function closeProject() {
  clearState()
  current = null
  dirty = false
  emit()
}

// ── saving ────────────────────────────────────────────────────

export async function saveProject(): Promise<{ ok: boolean; error?: string }> {
  const document = buildDocument()
  if (!current || !document) return { ok: false, error: 'no-project' }

  saving = true
  emit()
  const result = await requireProject().save(current.file, document)
  saving = false

  if (result.ok) {
    current = { ...current, ...document }
    dirty = false
  }
  emit()
  return result
}

// ── main-process conversations ────────────────────────────────

if (bridge?.project) {
  // The window will not close on unsaved work without asking; when the user
  // picks Save there, main hands the save back here, because the renderer is
  // the only side that knows what the document currently is.
  bridge.project.onSaveAndClose(async () => {
    await saveProject()
  })

  // Double-clicking a .flux while FLUX is already running opens it here rather
  // than starting a second copy of the app.
  bridge.project.onOpenTarget((file) => {
    void openProject(file)
  })
}

// ── misc bridge passthroughs ──────────────────────────────────

export function pickDirectory(): Promise<string | null> {
  if (!bridge?.fs) throw new Error('filesystem bridge unavailable outside Electron')
  return bridge.fs.pickDirectory()
}

export function pickProjectFile(): Promise<string | null> {
  if (!bridge?.fs) throw new Error('filesystem bridge unavailable outside Electron')
  return bridge.fs.pickProjectFile()
}

export function isProjectFolder(root: string): Promise<boolean> {
  return requireProject().is(root)
}

/** A .flux path FLUX was launched with, so double-clicking a document works. */
export function launchTarget(): Promise<string | null> {
  return requireProject().launchTarget()
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
      return 'There is already a FLUX project there. Open it instead.'
    case 'not-a-project':
      return 'No FLUX project in that folder.'
    case 'newer-format':
      return 'That project was made with a newer version of FLUX.'
    case 'denied':
      return 'FLUX is not allowed to write there.'
    case 'write-failed':
      return 'The project could not be written.'
    default:
      return 'That project could not be read.'
  }
}
