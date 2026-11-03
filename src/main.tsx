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
import * as indexAhead from './kernel/indexAhead'
import * as readiness from './kernel/readiness'
import * as layouts from './kernel/layoutPresets'
import * as layoutDefinitions from './kernel/layouts'
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
import * as performance from './kernel/performance'
import * as cache from './kernel/cache'
import * as account from './kernel/account'
import * as workspace from './kernel/workspace'
import * as pictures from './kernel/pictures'
import * as indexCache from './kernel/media/indexCache'
import * as ranges from './kernel/media/ranges'
import * as peaks from './kernel/media/peaks'
import * as mixer from './kernel/media/mixer'
import * as audioSource from './kernel/media/audioSource'
import * as selection from './kernel/selection'
import * as controlOps from './kernel/controlOps'
import * as controlBridge from './kernel/controlBridge'
import { listenForControl } from './kernel/controlBridge'
import * as importEdit from './kernel/importEdit'
import * as xmeml from '../shared/xmeml.js'
import * as editDocument from '../shared/editDocument.js'
import * as renderQueue from './kernel/renderQueue'
import * as renderSettings from './kernel/renderSettings'
import * as batchImport from './kernel/batchImport'
import * as batchExport from './kernel/batchExport'
import * as sequenceExport from './kernel/sequenceExport'
import * as keymap from './kernel/keymap'
import * as settings from './kernel/settings'
import * as keybindings from './kernel/keybindings'
import * as appearance from './kernel/appearance'
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

/*
 * The control surface answers from here rather than from a panel, for the
 * reason kernel/controlBridge.ts gives: it has to answer whether or not
 * anything is on screen. Registering the handler does not open the port —
 * that is still a deliberate act, by command.
 */
listenForControl()

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
      indexAhead,
      readiness,
      layouts,
      layoutDefinitions,
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
      ranges,
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
      controlOps,
      controlBridge,
      importEdit,
      xmeml,
      editDocument,
      renderQueue,
      renderSettings,
      batchImport,
      batchExport,
      sequenceExport,
      keymap,
      settings,
      keybindings,
      appearance,
      renderBridge,
      media: { audioSource },
      performance,
      cache,
      account,
      workspace,
      pictures,
    },
  })
}

/*
 * The look is read before anything is drawn, and the render waits for it.
 *
 * A theme applied *after* the first paint is a visible flash of the other
 * one, and on a near-black interface a flash of the default blue-grey is the
 * most noticeable thing the app could do on launch. One store read, so the
 * wait is a single IPC round trip.
 *
 * `finally` rather than `then`: a settings read that fails must still let the
 * app start. The worst case is booting on the shipped look, which is exactly
 * what a first launch does anyway.
 *
 * Not top-level `await`, which Vite's default build target does not support —
 * it would build here and fail the packaged bundle.
 *
 * No StrictMode: dockview owns imperative DOM and a double-invoked effect
 * rebuilds the layout twice on boot, which shows up as panels flickering.
 */
void appearance.loadAppearance().finally(() => {
  createRoot(container).render(<App />)
})

/*
 * Started here rather than left to the module's own wiring.
 *
 * `indexAhead` subscribes at import, so importing it would be enough — except
 * that the only other mention of it is inside the DEV block above, and a
 * bundler is entitled to decide a namespace import nothing references in a
 * production build can go. That would leave the indexing working perfectly in
 * development and absent from the app people actually run, which is the worst
 * shape a bug can have. Calling it is also the honest way to say when it
 * begins.
 */
indexAhead.indexAhead()

/*
 * How much machine to spend, read before anything starts spending it.
 *
 * Not awaited: everything that reads these settings subscribes to them, and
 * they begin at a modest laptop's worth — so the worst a slow answer costs is
 * a moment of behaving like a smaller computer, rather than a boot that waits
 * on an IPC round trip to draw anything.
 */
void performance.loadPerformance()
