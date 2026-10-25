import { createRoot } from 'react-dom/client'

import 'dockview/dist/styles/dockview.css'
import './styles/theme.css'
import './styles/app.css'

import { App } from './App'
import { registerBuiltinPanels } from './panels'
import * as tools from './kernel/tools'
import { registerToolCommands } from './kernel/tools'

import * as assets from './kernel/assets'
import * as sequence from './kernel/sequence'
import * as thumbnails from './kernel/thumbnails'
import * as mediaWork from './kernel/mediaWork'
import { commands } from './kernel/commands'
import { panels } from './kernel/panels'
import * as store from './kernel/store'
import * as project from './kernel/project'
import * as importMode from './kernel/importMode'
import * as pinned from './kernel/pinned'
import * as view from './kernel/view'
import * as playback from './kernel/playback'
import * as importPipeline from './kernel/importPipeline'
import * as videoSource from './kernel/media/videoSource'
import * as indexCache from './kernel/media/indexCache'
import * as peaks from './kernel/media/peaks'
import * as mixer from './kernel/media/mixer'
import * as audioSource from './kernel/media/audioSource'
import * as selection from './kernel/selection'
import * as renderQueue from './kernel/renderQueue'
import * as renderSettings from './kernel/renderSettings'
import * as batchImport from './kernel/batchImport'
import * as batchExport from './kernel/batchExport'
import * as sequenceExport from './kernel/sequenceExport'
import * as keymap from './kernel/keymap'
import * as renderBridge from './kernel/renderBridge'

// Panels register before the first render so the dock's component map is
// complete on mount. Plugins will hook in here later, ahead of this call.
registerBuiltinPanels()

/**
 * Tools are commands, so the palette and the keymap both reach them — and they
 * are registered here rather than by the Tools panel, because a tool you could
 * lose by closing a window is not a tool.
 */
registerToolCommands()

/**
 * The mixer listens to the transport for the whole life of the app.
 *
 * Not inside a panel: sound is not something the Viewer happens to do while it
 * is open, and closing a panel must not stop the sequence playing.
 */
mixer.connectMixer()

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
    __fluxDev: {
      assets,
      sequence,
      thumbnails,
      mediaWork,
      commands,
      panels,
      store,
      project,
      importMode,
      pinned,
      view,
      tools,
      playback,
      importPipeline,
      videoSource,
      indexCache,
      peaks,
      mixer,
      /*
       * The batch modules go on the handle for the reason attach() gives: a
       * harness that reaches them by dynamic import gets a *different module
       * instance*, and these two mutate the sequence and asset stores. A
       * separate instance would lay its clips into a store nothing is showing,
       * and the checks would read an empty timeline and fail for a reason that
       * has nothing to do with the code under test.
       */
      selection,
      renderQueue,
      renderSettings,
      batchImport,
      batchExport,
      sequenceExport,
      keymap,
      renderBridge,
      media: { audioSource },
    },
  })
}

// No StrictMode: dockview owns imperative DOM and a double-invoked effect
// rebuilds the layout twice on boot, which shows up as panels flickering.
createRoot(container).render(<App />)
