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
  getRenderSettings,
  onRenderSettingsChanged,
  setRenderSettings,
  type RenderSettings,
} from './renderSettings'
import {
  onQueueChanged,
  setQueue,
  type QueuedJob,
} from './renderQueue'
import {
  addSequence,
  getActiveSequenceId,
  listSequences,
  noteSequenceFile,
  resetSequence,
  sequenceDocument,
  setSequences,
  subscribeSequence,
  type SequenceState,
} from './sequence'
import { importAssets, type ImportCandidate } from './assets'
import { getView, resetView, setView, type ViewState } from './view'
import { loadStore, saveStore } from './store'
import { DOCUMENT_FORMAT } from '../../shared/projectFormat.js'

export interface ProjectDocument {
  flux: { format: number; version: string }
  name: string
  createdAt: number
  savedAt: number
  settings?: { importMode?: ImportMode; render?: Partial<RenderSettings> }
  /** Workspace, timeline zoom, where the browser was. Never marks work unsaved. */
  view?: ViewState
  assets: Asset[]
  /**
   * The sequence, for projects written before sequences were files.
   *
   * Read on open and never written again: an embedded copy that stayed would be
   * a second answer to what the timeline holds, and the two would drift the
   * first time one was saved without the other.
   */
  sequence?: SequenceState | null
  /** Which sequence was open. The set of them is the sequences folder. */
  activeSequence?: string
}

/** A media reference carried inside a sequence file. See shared/sequenceFormat.js. */
export interface SequenceMedia {
  id: string
  path: string
  name: string
  kind: 'video' | 'image'
  size?: number
  mtimeMs?: number
  width?: number
  height?: number
  duration?: number
}

export interface Project extends ProjectDocument {
  root: string
  /** Absolute path of the .flux document, inside project_files. */
  file: string
  /** Read from the sequences folder on open, not from the document. */
  sequences?: Array<SequenceState & { file: string; media?: SequenceMedia[] }>
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
  listSequences: (root: string) => Promise<Array<SequenceState & { file: string; media?: SequenceMedia[] }>>
  saveSequence: (
    root: string,
    document: Record<string, unknown>,
    previousFile?: string,
  ) => Promise<{ ok: boolean; file?: string; error?: string }>
  deleteSequence: (root: string, file: string) => Promise<{ ok: boolean; error?: string }>
  readQueue: (root: string) => Promise<{ jobs: QueuedJob[] }>
  writeQueue: (root: string, jobs: QueuedJob[]) => Promise<{ ok: boolean; error?: string }>
  importSequence: (
    root: string,
    sourcePath: string,
  ) => Promise<{ ok: boolean; file?: string; sequence?: SequenceState & { media?: SequenceMedia[] }; error?: string }>
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
    settings: { importMode: getImportMode(), render: getRenderSettings() },
    view: getView(),
    assets: getAssets(),
    // The sequences themselves are files; the document only remembers which
    // one was open. See shared/sequenceFormat.js.
    activeSequence: getActiveSequenceId(),
  }
}

/**
 * Resolves a sequence's media against this project's assets.
 *
 * A sequence carries the files its clips refer to, so one made elsewhere can
 * open here — and its clips reference asset ids that mean nothing in this
 * project. Files are matched by **path**: one already in the bin is used, and
 * anything new is linked where it lies, exactly as importing by link does.
 *
 * Then the clips are remapped onto whatever id this project uses for that file.
 * Not the other way round — adopting the sequence's ids would mean two projects
 * eventually claiming one id for two different files, and a clip pointing at
 * the wrong footage is a worse failure than an extra pass over the clip list.
 */
function resolveSequenceMedia(one: SequenceState & { media?: SequenceMedia[] }): SequenceState {
  const media = one.media ?? []
  if (media.length === 0) return one

  const byPath = () => new Map(getAssets().map((asset) => [asset.path.toLowerCase(), asset]))
  let known = byPath()

  const missing: ImportCandidate[] = media
    .filter((item) => !known.has(item.path.toLowerCase()))
    .map((item) => ({
      path: item.path,
      kind: item.kind,
      name: item.name,
      size: item.size,
      mtimeMs: item.mtimeMs,
      width: item.width,
      height: item.height,
      duration: item.duration,
    }))
  if (missing.length > 0) {
    importAssets(missing)
    known = byPath()
  }

  const remap = new Map<string, string>()
  for (const item of media) {
    const asset = known.get(item.path.toLowerCase())
    if (asset && asset.id !== item.id) remap.set(item.id, asset.id)
  }
  if (remap.size === 0) return one

  return {
    ...one,
    clips: one.clips.map((clip) =>
      remap.has(clip.assetId) ? { ...clip, assetId: remap.get(clip.assetId) as string } : clip,
    ),
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
/*
 * Through a handler rather than a subscription, so renderSettings does not have
 * to import this module back. A render setting is a decision about the work, so
 * changing one is unsaved work — unlike the queue, which is bookkeeping and
 * lives in its own file for exactly that reason.
 */
onRenderSettingsChanged(markDirty)

/*
 * The queue writes itself, rather than going out with the document.
 *
 * Deliberately not routed through markDirty: a row changing from waiting to
 * done is not unsaved work, it is a render reporting progress, and four hundred
 * of them would keep the dot lit for an hour over something nobody did.
 */
onQueueChanged((jobs) => {
  const root = current?.root
  if (!root || applying) return
  void bridgeOrNull()?.writeQueue(root, jobs)
})

async function loadQueue(root: string): Promise<void> {
  const stored = await bridgeOrNull()?.readQueue(root)
  setQueue(stored?.jobs)
}

/** The project bridge, or null outside Electron, where there is no filesystem. */
function bridgeOrNull(): ProjectBridge | null {
  return (globalThis as { flux?: { project?: ProjectBridge } }).flux?.project ?? null
}

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
  // Media before sequences: the clips are remapped onto this project's asset
  // ids on the way in, so nothing downstream ever sees an id from elsewhere.
  setSequences((project.sequences ?? []).map(resolveSequenceMedia), project.activeSequence)
  setImportMode(project.settings?.importMode ?? 'ask', { persist: false })
  setRenderSettings(project.settings?.render)
  /*
   * The queue is read after the project is otherwise open, and not awaited.
   * It is a sidecar: a project with no queue file, or an unreadable one, opens
   * exactly the same and simply starts with an empty list. Blocking the open
   * on it would make a nice-to-have able to delay the thing people are waiting
   * for.
   */
  void loadQueue(project.root)
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

/**
 * Reads the project's sequences off disk, or migrates the one it used to carry.
 *
 * The sequences folder is the list. A project written before sequences were
 * files has one inside the document instead: it is brought across here and
 * written out on the next save, which is why such a project opens with unsaved
 * work — the same as any other migration.
 */
async function withSequences(project: Project): Promise<Project & { migratedSequence?: boolean }> {
  const sequences = await requireProject()
    .listSequences(project.root)
    .catch(() => [])

  if (sequences.length > 0) return { ...project, sequences }
  if (!project.sequence) return { ...project, sequences: [] }
  return {
    ...project,
    sequences: [project.sequence as SequenceState & { file: string }],
    migratedSequence: true,
  }
}

export async function createProject(parent: string, name: string): Promise<ProjectResult> {
  const result = await requireProject().create(parent, name)
  if (result.ok) adopt({ ...result.project, sequences: [] }, false)
  return result
}

export async function openProject(target: string): Promise<ProjectResult> {
  const result = await requireProject().open(target)
  if (result.ok && result.project) {
    const project = await withSequences(result.project)
    adopt(project, Boolean(result.dirty) || project.migratedSequence === true)
    return { ok: true, project }
  }
  if (result.error === 'not-a-project') {
    // Keep the list honest the moment we learn an entry is bad.
    recents = recents.map((r) => (r.root === target ? { ...r, missing: true } : r))
    emit()
  }
  return { ok: false, error: result.error ?? 'unreadable' }
}

/**
 * Copies a `.fluxseq` into this project and opens it.
 *
 * The media it names is resolved the same way a sequence read at open time is,
 * so one made in another project arrives with its clips pointing at this
 * project's assets — see resolveSequenceMedia.
 */
export async function importSequenceFile(
  sourcePath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!current) return { ok: false, error: 'no-project' }
  const result = await requireProject().importSequence(current.root, sourcePath)
  if (!result.ok || !result.sequence) return { ok: false, error: result.error ?? 'unreadable' }

  const resolved = resolveSequenceMedia(result.sequence)
  addSequence({ ...resolved, file: result.file })
  return { ok: true }
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

  /*
   * The sequences first, then the document.
   *
   * A document that named a sequence whose file had not been written would
   * point at nothing, and the project would open with an empty timeline. The
   * other order fails safely: a sequence on disk that the document does not
   * name yet is still found, because the folder is the list.
   */
  const sequenceError = await writeSequences(current.root)
  const result = sequenceError
    ? { ok: false, error: sequenceError }
    : await requireProject().save(current.file, document)
  saving = false

  if (result.ok) {
    current = { ...current, ...document }
    dirty = false
  }
  emit()
  return result
}

/**
 * Writes every sequence to its own file, and removes the files of any that have
 * been deleted since the last save.
 *
 * All of them, not just the ones that changed. A sequence is a few kilobytes of
 * JSON, and tracking which are dirty would be a second bookkeeping system whose
 * only job is to be wrong occasionally.
 */
async function writeSequences(root: string): Promise<string | null> {
  const bridge = requireProject()
  const assets = getAssets()
  const live = new Set<string>()

  for (const one of listSequences()) {
    const written = await bridge.saveSequence(
      root,
      sequenceDocument(one, assets, current?.flux.version),
      one.file,
    )
    if (!written.ok) return written.error ?? 'write-failed'
    if (written.file) {
      noteSequenceFile(one.id, written.file)
      live.add(written.file.toLowerCase())
    }
  }

  // Anything left in the folder that is no longer in the project was deleted
  // in this session. The folder is the list, so it has to be told.
  const onDisk = await bridge.listSequences(root).catch(() => [])
  for (const stale of onDisk) {
    if (!live.has(stale.file.toLowerCase())) await bridge.deleteSequence(root, stale.file)
  }
  return null
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
