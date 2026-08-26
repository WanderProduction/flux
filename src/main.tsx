import { createRoot } from 'react-dom/client'

import 'dockview/dist/styles/dockview.css'
import './styles/theme.css'
import './styles/app.css'

import { App } from './App'
import { registerBuiltinPanels } from './panels'

// Panels register before the first render so the dock's component map is
// complete on mount. Plugins will hook in here later, ahead of this call.
registerBuiltinPanels()

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

// No StrictMode: dockview owns imperative DOM and a double-invoked effect
// rebuilds the layout twice on boot, which shows up as panels flickering.
createRoot(container).render(<App />)
