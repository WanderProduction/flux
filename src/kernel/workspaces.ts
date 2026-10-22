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
 * EDIT — Tools down the left, Viewer and Content Browser on top, Timeline full
 * width beneath. The layout a reels editor lives in.
 */
function buildEdit(api: DockviewApi) {
  api.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer' })
  // Left of everything and narrow: a tool strip is read at a glance and picked
  // from without looking, which is why every editor puts it at an edge.
  api.addPanel({
    id: 'tools',
    component: 'tools',
    title: 'Tools',
    position: { referencePanel: 'viewer', direction: 'left' },
  })
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
  api.getPanel('tools')?.api.setSize({ width: 150 })
  api.getPanel('content')?.api.setActive()
}

/**
 * EXPORT — what is about to be rendered, what it will be rendered as, and the
 * picture to check it against.
 *
 * The second workspace, and the thing that made a second one worth having: the
 * export question is not an arrangement of the editing panels, it is a
 * different set of them. Premiere, Resolve and Media Encoder all reach the
 * same answer — a whole page rather than a dialog — because "am I about to
 * write the right files" is not a question anyone can answer from a corner of
 * the screen.
 *
 * Left is the list with the pictures, middle is the settings, right is the
 * Viewer. No Timeline and no Tools: this is not where you edit, and an export
 * page that invited a trim would invite trimming something already queued,
 * which the snapshot rule says will not take effect.
 */
function buildExport(api: DockviewApi) {
  api.addPanel({ id: 'exportList', component: 'exportList', title: 'To render' })
  api.addPanel({
    id: 'render',
    component: 'render',
    title: 'Render',
    position: { referencePanel: 'exportList', direction: 'right' },
  })
  api.addPanel({
    id: 'viewer',
    component: 'viewer',
    title: 'Viewer',
    position: { referencePanel: 'render', direction: 'right' },
  })
  api.getPanel('exportList')?.api.setSize({ width: 380 })
  api.getPanel('exportList')?.api.setActive()
}

export const workspaces: WorkspaceDefinition[] = [
  { id: 'edit', name: 'Edit', hint: '1', build: buildEdit },
  { id: 'export', name: 'Export', hint: '2', build: buildExport },
]

export function getWorkspace(id: string): WorkspaceDefinition | undefined {
  return workspaces.find((w) => w.id === id)
}

/** Saved layouts, keyed by workspace id. Serialized dockview JSON. */
export type SavedLayouts = Record<string, unknown>
