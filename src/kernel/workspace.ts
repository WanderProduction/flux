/**
 * Workspaces, as the renderer sees them.
 *
 * A workspace holds projects. It is a folder with a manifest — see
 * electron/workspace.js for why that is the right shape — and this module is
 * the state around the one that is currently open, plus the list of the ones
 * this installation knows about.
 *
 * ## Not to be confused with a layout
 *
 * FLUX used to call its panel arrangements workspaces, which is Premiere's
 * word for them. They are `layouts` now (kernel/layouts.ts) and the word
 * belongs to this: the thing with projects and, later, people in it. The
 * rename happened the day this file was written, because two meanings of one
 * word in one app is a bug waiting for somebody to read the wrong comment.
 *
 * ## The known list is paths, not copies
 *
 * What is stored in this installation is a list of *where* workspaces are.
 * Everything about a workspace — its title, its picture, its projects — lives
 * in its own folder, so a workspace on a shared drive says the same thing to
 * everybody who opens it, and nothing has to be synchronised to make that
 * true.
 */

import { getProject, subscribeProject } from './project'
import { loadStore, saveStore } from './store'

export interface WorkspaceProject {
  root: string
  name: string
  file?: string
  addedAt: number
  openedAt?: number
  /** Set when the folder is not there — usually an unplugged drive. */
  missing?: boolean
}

export interface Workspace {
  root: string
  id: string
  title: string
  description: string
  avatar: string | null
  banner: string | null
  createdAt: number
  projects: WorkspaceProject[]
}

export type WorkspaceFailure =
  | 'no-title'
  | 'already-a-workspace'
  | 'denied'
  | 'write-failed'
  | 'not-a-workspace'
  | 'unavailable'

interface WorkspaceBridge {
  defaultParent: () => Promise<string>
  create: (
    parent: string | null,
    details: { title: string; description?: string; avatar?: string | null; banner?: string | null },
  ) => Promise<{ ok: boolean; workspace?: Workspace; reason?: string }>
  read: (root: string) => Promise<Workspace | null>
  is: (root: string) => Promise<boolean>
  update: (root: string, patch: Partial<Workspace>) => Promise<{ ok: boolean; workspace?: Workspace; reason?: string }>
  remember: (
    root: string,
    project: { root: string; name?: string; file?: string },
  ) => Promise<{ ok: boolean; workspace?: Workspace }>
  forget: (root: string, projectRoot: string) => Promise<{ ok: boolean; workspace?: Workspace }>
}

function bridge(): WorkspaceBridge | null {
  return (globalThis as { flux?: { workspace?: WorkspaceBridge } }).flux?.workspace ?? null
}

export const hasWorkspaces = (): boolean => bridge() !== null

/**
 * Where the known workspaces are listed.
 *
 * Not `workspaces` — that key held dockview layouts until the rename, and on
 * any installation older than this one it still does. Writing a different
 * shape into it would be read back by the layout restore as an arrangement
 * with no panels in it.
 */
const KNOWN_STORE = 'workspace-folders'
/** Which one to open on launch. */
const CURRENT_STORE = 'workspace-current'

let known: string[] = []
let current: Workspace | null = null
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getWorkspace(): Workspace | null {
  return current
}

export function knownWorkspaces(): string[] {
  return known
}

export function workspaceLoaded(): boolean {
  return loaded
}

export function defaultParent(): Promise<string> {
  return bridge()?.defaultParent() ?? Promise.resolve('')
}

/**
 * Finds the workspace to open, and opens it.
 *
 * A remembered path that no longer holds a workspace is dropped from the known
 * list rather than reported — unlike a *project*, where a missing folder is
 * usually an unplugged drive and silence would be wrong. A workspace lives in
 * the app's own data folder by default, so a missing one is almost always one
 * somebody deleted, and keeping a dead row in a picker nobody can act on is
 * worse than forgetting it.
 */
export async function loadWorkspaces(): Promise<void> {
  const api = bridge()
  if (!api) {
    loaded = true
    emit()
    return
  }

  const stored = await loadStore<string[]>(KNOWN_STORE, [])
  const alive: string[] = []
  for (const root of Array.isArray(stored) ? stored : []) {
    if (await api.is(root).catch(() => false)) alive.push(root)
  }
  known = alive
  if (alive.length !== (stored?.length ?? 0)) void saveStore(KNOWN_STORE, alive)

  const wanted = await loadStore<string | null>(CURRENT_STORE, null)
  const pick = wanted && alive.includes(wanted) ? wanted : (alive[0] ?? null)
  current = pick ? await api.read(pick) : null

  loaded = true
  emit()
}

export async function createWorkspace(
  parent: string | null,
  details: { title: string; description?: string; avatar?: string | null; banner?: string | null },
): Promise<{ ok: true; workspace: Workspace } | { ok: false; reason: WorkspaceFailure }> {
  const api = bridge()
  if (!api) return { ok: false, reason: 'unavailable' }

  const result = await api.create(parent, details)
  if (!result.ok || !result.workspace) {
    return { ok: false, reason: (result.reason as WorkspaceFailure) ?? 'write-failed' }
  }

  known = known.includes(result.workspace.root) ? known : [...known, result.workspace.root]
  current = result.workspace
  void saveStore(KNOWN_STORE, known)
  void saveStore(CURRENT_STORE, current.root)
  emit()
  return { ok: true, workspace: result.workspace }
}

/** Opens a workspace that is already known, or adopts one from a folder. */
export async function openWorkspace(root: string): Promise<boolean> {
  const api = bridge()
  if (!api) return false
  const workspace = await api.read(root)
  if (!workspace) return false

  current = workspace
  if (!known.includes(root)) {
    known = [...known, root]
    void saveStore(KNOWN_STORE, known)
  }
  void saveStore(CURRENT_STORE, root)
  emit()
  return true
}

/** Re-reads the open workspace from disk. Cheap, and the only way to be right. */
export async function refreshWorkspace(): Promise<void> {
  const api = bridge()
  if (!api || !current) return
  const next = await api.read(current.root)
  if (next) {
    current = next
    emit()
  }
}

export async function editWorkspace(
  patch: Partial<Pick<Workspace, 'title' | 'description' | 'avatar' | 'banner'>>,
): Promise<{ ok: true } | { ok: false; reason: WorkspaceFailure }> {
  const api = bridge()
  if (!api || !current) return { ok: false, reason: 'unavailable' }
  const result = await api.update(current.root, patch)
  if (result.ok && result.workspace) {
    current = result.workspace
    emit()
    return { ok: true }
  }
  return { ok: false, reason: (result.reason as WorkspaceFailure) ?? 'write-failed' }
}

/**
 * Files a project under the open workspace.
 *
 * Called when a project is created or opened, so the dashboard fills itself
 * rather than asking anybody to curate it. A workspace you have to add things
 * to by hand is a workspace that is always out of date.
 */
export async function rememberProject(project: {
  root: string
  name?: string
  file?: string
}): Promise<void> {
  const api = bridge()
  if (!api || !current) return
  const result = await api.remember(current.root, project)
  if (result.ok && result.workspace) {
    current = result.workspace
    emit()
  }
}

/**
 * Files every project that opens, for as long as the app runs.
 *
 * Driven off the project subscription rather than a React effect, and that is
 * not a style preference — it was a bug. An effect keyed on the open project
 * only sees states React renders, so a project created and closed inside one
 * batch goes from null to null and is never filed at all. The subscription
 * fires on the change itself, synchronously, which is the only version of this
 * that cannot be outrun.
 *
 * The dependency points this way on purpose: workspaces know about projects,
 * projects know nothing about workspaces. A project has to open on a machine
 * with no workspace at all — in a browser, or before the first one is made —
 * and kernel/project.ts carrying a reference to this module would make that
 * impossible to reason about.
 */
export function fileOpenedProjects(): () => void {
  return subscribeProject(() => {
    const open = getProject()
    if (open) void rememberProject({ root: open.root, name: open.name })
  })
}

/** Takes a project off the dashboard. The folder is not touched. */
export async function forgetProject(projectRoot: string): Promise<void> {
  const api = bridge()
  if (!api || !current) return
  const result = await api.forget(current.root, projectRoot)
  if (result.ok && result.workspace) {
    current = result.workspace
    emit()
  }
}

/** Leaves the workspace open-less, which puts the setup screen back. */
export function closeWorkspace(): void {
  current = null
  void saveStore(CURRENT_STORE, null)
  emit()
}

export function describeWorkspaceError(reason: WorkspaceFailure): string {
  switch (reason) {
    case 'no-title':
      return 'A workspace needs a name.'
    case 'already-a-workspace':
      return 'There is already a workspace in that folder.'
    case 'denied':
      return 'That folder cannot be written to.'
    case 'not-a-workspace':
      return 'That folder is not a workspace.'
    case 'unavailable':
      return 'Workspaces need the desktop app.'
    default:
      return 'The workspace could not be written.'
  }
}
