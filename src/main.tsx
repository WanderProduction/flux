import { createRoot } from 'react-dom/client'

import 'dockview/dist/styles/dockview.css'
import './styles/theme.css'
import './styles/app.css'

import { App } from './App'
import { registerBuiltinPanels } from './panels'

import * as assets from './kernel/assets'
import * as sequence from './kernel/sequence'
import * as thumbnails from './kernel/thumbnails'
import { commands } from './kernel/commands'
import { panels } from './kernel/panels'
import * as store from './kernel/store'
import * as project from './kernel/project'
import * as importMode from './kernel/importMode'

// Panels register before the first render so the dock's component map is
// complete on mount. Plugins will hook in here later, ahead of this call.
registerBuiltinPanels()

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

/**
 * A dev-only handle on the live kernel modules.
 *
 * Stripped from production builds by the DEV guard. It exists because reaching
 * these modules from outside — a DevTools console, or the verification
 * harnesses in scripts/ — by dynamic import does NOT get you the instances the
 * app is using: Vite appends a cache-busting query after an HMR update, and a
 * different specifier is a different module with its own separate state. That
 * failure is silent and convincing; state simply reads as empty. Anything
 * inspecting the running app must go through here.
 */
if (import.meta.env.DEV) {
  Object.assign(window, {
    __fluxDev: { assets, sequence, thumbnails, commands, panels, store, project, importMode },
  })
}

// No StrictMode: dockview owns imperative DOM and a double-invoked effect
// rebuilds the layout twice on boot, which shows up as panels flickering.
createRoot(container).render(<App />)
