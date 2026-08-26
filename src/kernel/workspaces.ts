/**
 * Workspaces — named panel layouts, switched by hotkey.
 *
 * This is the fix for DaVinci's pages described in docs/INTERACTION-MODEL.md:
 * you get task-focused layouts, but they are *yours*, they are not rigid tabs,
 * and switching one changes only the arrangement of windows — never the project,
 * the selection or the playhead.
 *
 * There is one workspace right now, and that is deliberate. Sound Design and
 * Nodes / Motion were arrangements of a Mixer and a Node Map that did not exist
 * — three tabs that all showed the same three panels in slightly different
 * places. The mechanism is what matters and it is unchanged: add a definition
 * here and it gets a tab, a command and a slot in the keymap. The second
 * workspace arrives with the second thing worth arranging.
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
 * EDIT — Viewer and Content Browser on top, Timeline full width beneath.
 * The layout a reels editor lives in.
 */
function buildEdit(api: DockviewApi) {
  api.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer' })
  api.addPanel({
    id: 'content',
    component: 'content',
    title: 'Content Browser',
    position: { referencePanel: 'viewer', direction: 'right' },
  })
  api.addPanel({
    id: 'timeline',
    component: 'timeline',
    title: 'Timeline',
    position: { referencePanel: 'viewer', direction: 'below' },
  })
  api.getPanel('content')?.api.setActive()
}

export const workspaces: WorkspaceDefinition[] = [
  { id: 'edit', name: 'Edit', hint: '1', build: buildEdit },
]

export function getWorkspace(id: string): WorkspaceDefinition | undefined {
  return workspaces.find((w) => w.id === id)
}

/** Saved layouts, keyed by workspace id. Serialized dockview JSON. */
export type SavedLayouts = Record<string, unknown>
