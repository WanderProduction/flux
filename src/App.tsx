import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview'

import { commands } from './kernel/commands'
import { panels } from './kernel/panels'
import { createKeymapController, defaultKeymap } from './kernel/keymap'
import { loadStore, saveStore, isDesktop } from './kernel/store'
import { workspaces, getWorkspace, type SavedLayouts } from './kernel/workspaces'
import { CommandPalette } from './shell/CommandPalette'
import { ProjectLauncher } from './launcher/ProjectLauncher'
import {
  closeProject,
  getProject,
  isDirty,
  isSaving,
  saveProject,
  subscribeProject,
  type Project,
} from './kernel/project'

const LAYOUTS_STORE = 'workspaces'
const LAST_WORKSPACE_STORE = 'last-workspace'

export function App() {
  const [project, setProject] = useState<Project | null>(getProject)

  useEffect(() => subscribeProject(() => setProject(getProject())), [])

  // The dock is unmounted entirely while no project is open, so panels can
  // assume a project exists rather than every one of them guarding for its
  // absence. It also guarantees their state is rebuilt when a different project
  // opens, instead of the previous project's timeline lingering on screen.
  if (!project) return <ProjectLauncher />
  return <Workspace key={project.root} project={project} />
}

function Workspace({ project }: { project: Project }) {
  const apiRef = useRef<DockviewApi | null>(null)
  const savedRef = useRef<SavedLayouts>({})
  const keymap = useMemo(() => createKeymapController(defaultKeymap), [])

  const [ready, setReady] = useState(false)
  const [activeId, setActiveId] = useState('edit')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [dirty, setDirty] = useState(isDirty)
  const [saving, setSaving] = useState(isSaving)

  useEffect(
    () =>
      subscribeProject(() => {
        setDirty(isDirty())
        setSaving(isSaving())
      }),
    [],
  )

  // Panels are read from the registry, not hardcoded — a plugin that registers
  // before mount is picked up here with no change to the shell.
  const components = useMemo(() => panels.components(), [])

  const say = useCallback((message: string) => {
    setFlash(message)
    window.setTimeout(() => setFlash((current) => (current === message ? null : current)), 1800)
  }, [])

  /** Rebuild the dock for a workspace: saved layout if there is one, else the shipped default. */
  const applyWorkspace = useCallback((id: string) => {
    const api = apiRef.current
    const workspace = getWorkspace(id)
    if (!api || !workspace) return

    api.clear()
    const saved = savedRef.current[id]
    if (saved) {
      try {
        api.fromJSON(saved as never)
        setActiveId(id)
        return
      } catch (err) {
        // A saved layout can reference a panel that no longer exists — an
        // uninstalled plugin, a renamed id. Falling back to the default beats
        // booting into an empty window with no way back.
        console.warn(`[flux] saved layout for "${id}" could not be restored — rebuilding`, err)
        api.clear()
      }
    }
    workspace.build(api)
    setActiveId(id)
  }, [])

  const saveWorkspace = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    savedRef.current = { ...savedRef.current, [activeId]: api.toJSON() }
    void saveStore(LAYOUTS_STORE, savedRef.current)
    say(`Saved "${getWorkspace(activeId)?.name}" layout`)
  }, [activeId, say])

  const resetWorkspace = useCallback(() => {
    const next = { ...savedRef.current }
    delete next[activeId]
    savedRef.current = next
    void saveStore(LAYOUTS_STORE, next)
    applyWorkspace(activeId)
    say(`Reset "${getWorkspace(activeId)?.name}" to default`)
  }, [activeId, applyWorkspace, say])

  /** Focus a panel, opening it in the current workspace if it isn't there. */
  const focusPanel = useCallback((panelId: string) => {
    const api = apiRef.current
    const definition = panels.get(panelId)
    if (!api || !definition) return

    const existing = api.getPanel(panelId)
    if (existing) {
      existing.api.setActive()
    } else {
      api.addPanel({ id: panelId, component: panelId, title: definition.title })
    }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    setReady(true)
  }, [])

  // Restore persisted layouts once the dock exists, then open the last workspace.
  useEffect(() => {
    if (!ready) return
    let cancelled = false

    void (async () => {
      const [layouts, last] = await Promise.all([
        loadStore<SavedLayouts>(LAYOUTS_STORE, {}),
        loadStore<string>(LAST_WORKSPACE_STORE, 'edit'),
      ])
      if (cancelled) return
      savedRef.current = layouts
      applyWorkspace(getWorkspace(last) ? last : 'edit')
    })()

    return () => {
      cancelled = true
    }
  }, [ready, applyWorkspace])

  // Remember the active workspace across launches.
  useEffect(() => {
    if (ready) void saveStore(LAST_WORKSPACE_STORE, activeId)
  }, [ready, activeId])

  // Everything the app can do is registered here as a command; the keymap and
  // the palette are both just consumers of this list.
  useEffect(() => {
    if (!ready) return

    const handle = commands.registerAll([
      {
        id: 'palette.open',
        title: 'Open Command Palette',
        category: 'View',
        run: () => setPaletteOpen(true),
      },
      ...workspaces.map((workspace) => ({
        id: `workspace.switch.${workspace.id}`,
        title: `Switch to ${workspace.name}`,
        category: 'Workspace',
        detail: 'Rearranges panels only — project, selection and playhead are untouched',
        run: () => applyWorkspace(workspace.id),
      })),
      {
        id: 'workspace.save',
        title: 'Save Current Layout',
        category: 'Workspace',
        detail: 'Stores the current panel arrangement for this workspace',
        run: saveWorkspace,
      },
      {
        id: 'workspace.reset',
        title: 'Reset Layout to Default',
        category: 'Workspace',
        run: resetWorkspace,
      },
      {
        id: 'project.save',
        title: 'Save Project',
        category: 'Project',
        detail: 'Writes the .flux document',
        run: async () => {
          const result = await saveProject()
          say(result.ok ? 'Project saved' : `Could not save: ${result.error}`)
        },
      },
      {
        id: 'project.close',
        title: 'Close Project',
        category: 'Project',
        detail: 'Returns to the launcher',
        run: closeProject,
      },
      ...panels.list().map((panel) => ({
        id: `panel.focus.${panel.id}`,
        title: `Focus ${panel.title}`,
        category: 'Panel',
        detail: panel.description,
        run: () => focusPanel(panel.id),
      })),
    ])

    return () => handle.dispose()
  }, [ready, applyWorkspace, saveWorkspace, resetWorkspace, focusPanel, say])

  useEffect(() => keymap.attach(), [keymap])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          FLUX<span className="brand-dot">.</span>
        </span>

        <button
          className="project-chip"
          onClick={closeProject}
          title={`${project.root}\nClick to close and return to the launcher`}
        >
          {project.name}
        </button>

        <nav className="workspace-tabs">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className={`ws-tab${workspace.id === activeId ? ' ws-tab--active' : ''}`}
              onClick={() => applyWorkspace(workspace.id)}
              title={`Switch to ${workspace.name}`}
            >
              {workspace.name}
              <kbd>{workspace.hint}</kbd>
            </button>
          ))}
        </nav>

        <button className="palette-hint" onClick={() => setPaletteOpen(true)}>
          Run a command <kbd>Ctrl K</kbd>
        </button>
      </header>

      <main className="dock-host">
        <DockviewReact
          className="flux-dock"
          components={components}
          onReady={onReady}
          disableFloatingGroups={false}
          floatingGroupBounds="boundedWithinViewport"
          watermarkComponent={Watermark}
        />
      </main>

      <footer className="statusbar">
        <span className="status-left">
          <span className="status-scope">{project.name} ▸ Sequence 1</span>
          <span className="status-dim">
            {saving ? 'saving…' : dirty ? 'unsaved changes' : 'saved'}
          </span>
        </span>
        <span className="status-right">
          {flash && <span className="status-flash">{flash}</span>}
          <span className="status-dim">{isDesktop ? 'desktop' : 'browser'}</span>
          <span className="status-dim">shell only — no engine</span>
        </span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        lookupChord={keymap.lookup}
      />
    </div>
  )
}

function Watermark() {
  return (
    <div className="watermark">
      <p>No panels open</p>
      <p className="watermark-hint">
        Press <kbd>Ctrl K</kbd> and search for a panel, or <kbd>Ctrl Shift R</kbd> to restore the
        default layout.
      </p>
    </div>
  )
}
