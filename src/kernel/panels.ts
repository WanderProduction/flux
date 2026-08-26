/**
 * The panel registry — the first dogfooded SDK seam.
 *
 * Decision from the planning session: the kernel is ours, but every *extension
 * point* is built by us through the exact interface a stranger will use. So the
 * six built-in panels are not special-cased anywhere — they are registered
 * through `panels.register()`, the same call a community panel makes. If this
 * interface is too weak to build the Timeline with, it is too weak to ship, and
 * we find that out on day one instead of after someone reverse-engineers it.
 */

import type { FunctionComponent } from 'react'
import type { IDockviewPanelProps } from 'dockview'

export interface PanelDefinition {
  /** Stable id used in layouts and by `panel.focus.<id>` commands. */
  id: string
  /** Tab label. */
  title: string
  /** One line describing what the panel is for — surfaced in the palette. */
  description?: string
  component: FunctionComponent<IDockviewPanelProps>
}

class PanelRegistry {
  private panels = new Map<string, PanelDefinition>()

  register(panel: PanelDefinition) {
    if (this.panels.has(panel.id)) {
      console.warn(`[flux] panel "${panel.id}" was already registered — overwriting`)
    }
    this.panels.set(panel.id, panel)
    return { dispose: () => this.panels.delete(panel.id) }
  }

  registerAll(panels: PanelDefinition[]) {
    panels.forEach((p) => this.register(p))
  }

  get(id: string): PanelDefinition | undefined {
    return this.panels.get(id)
  }

  list(): PanelDefinition[] {
    return [...this.panels.values()]
  }

  /** The `components` map dockview needs: panel id -> React component. */
  components(): Record<string, FunctionComponent<IDockviewPanelProps>> {
    return Object.fromEntries([...this.panels.values()].map((p) => [p.id, p.component]))
  }
}

export const panels = new PanelRegistry()
