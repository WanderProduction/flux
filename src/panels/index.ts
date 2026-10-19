/**
 * Built-in panel registration.
 *
 * Note what this file is *not*: there is no switch statement in the shell that
 * knows about these panels. They go through `panels.register()` exactly as a
 * community panel will. Deleting an entry here removes the panel cleanly, which
 * is the cheapest possible proof that the seam is real — and is exactly how the
 * Node Map, Inspector and Mixer left. They were empty scaffolding standing in
 * for systems that do not exist yet; three panels that all do real work say
 * more about where this is going than six where half are painted on.
 */

import { panels } from '../kernel/panels'
import { ViewerPanel } from './ViewerPanel'
import { TimelinePanel } from './TimelinePanel'
import { ContentBrowserPanel } from './ContentBrowserPanel'
import { ToolsPanel } from './ToolsPanel'
import { BatchPanel } from './BatchPanel'

export function registerBuiltinPanels() {
  panels.registerAll([
    {
      id: 'viewer',
      title: 'Viewer',
      description: 'Plays the sequence at the playhead',
      component: ViewerPanel,
    },
    {
      id: 'timeline',
      title: 'Timeline',
      description: 'Time-occupying nodes of the current scope',
      component: TimelinePanel,
    },
    {
      id: 'tools',
      title: 'Tools',
      description: 'What the pointer is holding',
      component: ToolsPanel,
    },
    {
      id: 'content',
      title: 'Content Browser',
      description: 'Browse the machine and import media into the project',
      component: ContentBrowserPanel,
    },
    {
      id: 'batch',
      title: 'Batch',
      description: 'Import a folder of footage, and export what survives review',
      component: BatchPanel,
    },
  ])
}
