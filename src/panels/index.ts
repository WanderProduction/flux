/**
 * Built-in panel registration.
 *
 * Note what this file is *not*: there is no switch statement in the shell that
 * knows about these six panels. They go through `panels.register()` exactly as a
 * community panel will. Deleting any entry here removes the panel cleanly, which
 * is the cheapest possible proof that the seam is real.
 */

import { panels } from '../kernel/panels'
import { ViewerPanel } from './ViewerPanel'
import { TimelinePanel } from './TimelinePanel'
import { NodeMapPanel } from './NodeMapPanel'
import { ContentBrowserPanel } from './ContentBrowserPanel'
import { InspectorPanel } from './InspectorPanel'
import { MixerPanel } from './MixerPanel'

export function registerBuiltinPanels() {
  panels.registerAll([
    {
      id: 'viewer',
      title: 'Viewer',
      description: 'Rendered output of the current scope at the playhead',
      component: ViewerPanel,
    },
    {
      id: 'timeline',
      title: 'Timeline',
      description: 'Time-occupying nodes of the current scope',
      component: TimelinePanel,
    },
    {
      id: 'nodemap',
      title: 'Node Map',
      description: 'Full signal graph of the current scope',
      component: NodeMapPanel,
    },
    {
      id: 'content',
      title: 'Content Browser',
      description: 'Browse the machine and import media into the project',
      component: ContentBrowserPanel,
    },
    {
      id: 'inspector',
      title: 'Inspector',
      description: 'Parameters of the current selection',
      component: InspectorPanel,
    },
    {
      id: 'mixer',
      title: 'Mixer',
      description: 'Audio buses and channel strips',
      component: MixerPanel,
    },
  ])
}
