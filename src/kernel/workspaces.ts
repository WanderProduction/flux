/**
 * Workspaces — named panel layouts, switched by hotkey.
 *
 * This is the fix for DaVinci's pages described in docs/INTERACTION-MODEL.md:
 * you get task-focused layouts, but they are *yours*, they are not rigid tabs,
 * and switching one changes only the arrangement of windows — never the project,
 * the selection or the playhead.
 *
 * A workspace has two possible sources of truth:
 *   - `build()`  — the shipped default, constructed programmatically.
 *   - a saved serialized dockview layout, which wins once the user saves.
 */

import type { DockviewApi } from 'dockview'

export interface WorkspaceDefinition {
  id: string
  name: string
  /** Shown in the top bar; the actual binding lives in the keymap. */
  hint: string
  build: (api: DockviewApi) => void
}

/**
 * EDIT — home base. Viewer + Files on top, Timeline full width beneath.
 * The layout a reels editor lives in; the Node Map is not even open.
 */
function buildEdit(api: DockviewApi) {
  api.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer' })
  api.addPanel({
    id: 'files',
    component: 'files',
    title: 'Files',
    position: { referencePanel: 'viewer', direction: 'right' },
  })
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: 'Inspector',
    position: { referencePanel: 'files', direction: 'within' },
  })
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: 'viewer', direction: 'below' },
  })
  api.getPanel('files')?.api.setActive()
}

/**
 * SOUND DESIGN — the Mixer takes the stage beside the Viewer.
 * Same project, same scope; only the furniture moved.
 */
function buildSound(api: DockviewApi) {
  api.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer' })
  api.addPanel({
    id: 'mixer',
    component: 'mixer',
    title: 'Mixer',
    position: { referencePanel: 'viewer', direction: 'right' },
  })
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: 'viewer', direction: 'below' },
  })
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: 'Inspector',
    position: { referencePanel: 'timeline', direction: 'right' },
  })
}

/**
 * NODES / MOTION — the Node Map takes the stage, Viewer and Inspector beneath.
 * The lens you flip to when you want to see how something is built.
 */
function buildNodes(api: DockviewApi) {
  api.addPanel({ id: 'nodemap', component: 'nodemap', title: 'Node Map' })
  api.addPanel({
    id: 'viewer',
    component: 'viewer',
    title: 'Viewer',
    position: { referencePanel: 'nodemap', direction: 'below' },
  })
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: 'Inspector',
    position: { referencePanel: 'viewer', direction: 'right' },
  })
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: 'viewer', direction: 'within' },
  })
  api.getPanel('viewer')?.api.setActive()
}

export const workspaces: WorkspaceDefinition[] = [
  { id: 'edit', name: 'Edit', hint: '1', build: buildEdit },
  { id: 'sound', name: 'Sound Design', hint: '2', build: buildSound },
  { id: 'nodes', name: 'Nodes / Motion', hint: '3', build: buildNodes },
]

export function getWorkspace(id: string): WorkspaceDefinition | undefined {
  return workspaces.find((w) => w.id === id)
}

/** Saved layouts, keyed by workspace id. Serialized dockview JSON. */
export type SavedLayouts = Record<string, unknown>
