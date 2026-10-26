import { Menu } from 'electron'

/**
 * The application menu, built from what the renderer says it has.
 *
 * The menu lives in the main process and the panels live in the renderer, so
 * one of them has to tell the other. The renderer does the telling: it owns the
 * panel registry and the saved layouts, and both can change while the app runs
 * — a panel is registered by an extension, a preset is saved — so a menu built
 * once at startup from a list hardcoded here would start lying immediately.
 *
 * Every item does the same thing: send a command id back. Nothing in this file
 * knows what "panel.focus.timeline" means, which is what keeps the menu from
 * becoming a second, divergent copy of the command table.
 */

/** The last description the renderer sent, so the menu can be rebuilt on focus. */
let current = { panels: [], presets: [], workspaces: [], activeWorkspace: null }

const send = (window, id) => {
  if (!window || window.isDestroyed()) return
  window.webContents.send('menu:run', id)
}

/**
 * Items for panels that are open are checked.
 *
 * A menu that only ever opened things would be half a control: Premiere's
 * Window menu tells you what is on screen as much as it lets you put something
 * there, and that is most of its value when a layout has got away from you.
 */
function panelItems(window, panels) {
  if (panels.length === 0) {
    return [{ label: 'No panels registered', enabled: false }]
  }
  return panels.map((panel) => ({
    label: panel.title,
    type: 'checkbox',
    checked: Boolean(panel.open),
    click: () => send(window, `panel.toggle.${panel.id}`),
  }))
}

function presetItems(window, presets) {
  if (presets.length === 0) {
    return [{ label: 'No saved layouts yet', enabled: false }]
  }
  return presets.map((preset) => ({
    label: preset.name,
    click: () => send(window, `layout.apply.${preset.id}`),
  }))
}

export function buildAppMenu(window) {
  const { panels, presets, workspaces, activeWorkspace } = current

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => send(window, 'project.save') },
        { type: 'separator' },
        { label: 'Close Project', click: () => send(window, 'project.close') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Run a Command…',
          accelerator: 'CmdOrCtrl+K',
          click: () => send(window, 'palette.open'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        /*
         * Saving sits at the top, above the presets it makes, because that is
         * the order the hand goes in: arrange, keep, come back to it later.
         */
        { label: 'Save Layout as Preset…', click: () => send(window, 'layout.saveAs') },
        {
          label: 'Saved Layouts',
          submenu: presetItems(window, presets),
        },
        { label: 'Manage Saved Layouts…', click: () => send(window, 'layout.manage') },
        { type: 'separator' },
        // The built-in arrangements, which are a different thing from presets.
        ...workspaces.map((workspace) => ({
          label: `${workspace.name} Workspace`,
          type: 'radio',
          checked: workspace.id === activeWorkspace,
          click: () => send(window, `workspace.switch.${workspace.id}`),
        })),
        { label: 'Reset Layout to Default', click: () => send(window, 'workspace.reset') },
        { type: 'separator' },
        ...panelItems(window, panels),
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Called when the renderer's panels, presets or workspace change. */
export function updateAppMenu(window, description) {
  current = {
    panels: Array.isArray(description?.panels) ? description.panels : [],
    presets: Array.isArray(description?.presets) ? description.presets : [],
    workspaces: Array.isArray(description?.workspaces) ? description.workspaces : [],
    activeWorkspace: description?.activeWorkspace ?? null,
  }
  buildAppMenu(window)
}
