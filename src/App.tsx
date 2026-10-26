import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview'

import { commands } from './kernel/commands'
import { panels } from './kernel/panels'
import { createKeymapController, defaultKeymap } from './kernel/keymap'
import { loadStore, saveStore, isDesktop } from './kernel/store'
import { workspaces, getWorkspace, type SavedLayouts } from './kernel/workspaces'
import {
  getLayoutPreset,
  layoutPresets,
  loadLayoutPresets,
  removeLayoutPreset,
  saveLayoutPreset,
  subscribeLayouts,
} from './kernel/layouts'
import { getSequence, subscribeSequence } from './kernel/sequence'
import { getView, recordView } from './kernel/view'
import { getSelection } from './kernel/selection'
import { getRenderSettings } from './kernel/renderSettings'
import { add as addToQueue } from './kernel/renderQueue'
import { CommandPalette } from './shell/CommandPalette'
import { UpdateBadge } from './shell/UpdateBadge'
import { MediaWorkRing } from './shell/MediaWorkRing'
import { ImportChoiceHost } from './shell/ImportChoiceHost'
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

/**
 * Layouts are an app-level preference, the way a Premiere or AE workspace is:
 * how *you* like panels arranged, the same in every project. Which workspace is
 * currently open belongs to the project instead — it is where you left off in
 * this piece of work — so it rides in the .flux document. See kernel/view.ts.
 */
const LAYOUTS_STORE = 'workspaces'

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

  /**
   * The workspace this project was saved in, read once at mount.
   *
   * Once, and into the initial state - not in the restore effect. activeId is
   * reported back into the view as it changes, so a default of 'edit' would
   * record 'edit' over the saved value before the restore ever got to read it,
   * and every project would reopen in Edit no matter what was saved.
   */
  const openInRef = useRef(getWorkspace(getView().workspace) ? getView().workspace : 'edit')

  const [ready, setReady] = useState(false)
  const [activeId, setActiveId] = useState(openInRef.current)
  /**
   * The same id, readable synchronously.
   *
   * The debounced layout save fires half a second after a change, and `state`
   * is only new on the next render — so a save that read `activeId` from the
   * closure would attribute a layout to **whichever workspace was open
   * before**. With one workspace that is invisible; with two it means
   * switching writes each layout under the other's name, and the second time
   * you switch you get the wrong panels. See `markActive`.
   */
  const activeRef = useRef(openInRef.current)
  const markActive = useCallback((id: string) => {
    activeRef.current = id
    setActiveId(id)
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [openSequence, setOpenSequence] = useState(() => getSequence().name)
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

  useEffect(() => subscribeSequence(() => setOpenSequence(getSequence().name)), [])

  // Panels are read from the registry, not hardcoded — a plugin that registers
  // before mount is picked up here with no change to the shell.
  const components = useMemo(() => panels.components(), [])

  const say = useCallback((message: string) => {
    setFlash(message)
    window.setTimeout(() => setFlash((current) => (current === message ? null : current)), 1800)
  }, [])

  /** Rebuild the dock for a workspace: saved layout if there is one, else the shipped default. */
  /**
   * True while a layout is being torn down and rebuilt.
   *
   * Every one of those steps fires a layout-change event, and the first thing
   * `applyWorkspace` does is clear the dock — so without this the arrangement
   * saved a moment later would be the empty one, and the layout would be lost
   * by the act of restoring it.
   */
  const [presets, setPresets] = useState(layoutPresets)
  const [layoutDialog, setLayoutDialog] = useState<{
    mode: 'save' | 'manage'
    name: string
  } | null>(null)

  // Read once, then kept in step: the menu is built from this list too.
  useEffect(() => {
    void loadLayoutPresets().then(() => setPresets([...layoutPresets()]))
    return subscribeLayouts(() => setPresets([...layoutPresets()]))
  }, [])

  const rearranging = useRef(false)

  const applyWorkspace = useCallback((id: string) => {
    const api = apiRef.current
    const workspace = getWorkspace(id)
    if (!api || !workspace) return

    rearranging.current = true
    api.clear()
    const saved = savedRef.current[id]
    if (saved) {
      try {
        api.fromJSON(saved as never)
        markActive(id)
        rearranging.current = false
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
    markActive(id)
    rearranging.current = false
  }, [markActive])

  /** Writes the arrangement down, without saying anything about it. */
  const rememberLayout = useCallback((id: string) => {
    const api = apiRef.current
    if (!api) return
    savedRef.current = { ...savedRef.current, [id]: api.toJSON() }
    void saveStore(LAYOUTS_STORE, savedRef.current)
  }, [])

  const saveWorkspace = useCallback(() => {
    if (!apiRef.current) return
    rememberLayout(activeRef.current)
    say(`Saved "${getWorkspace(activeId)?.name}" layout`)
  }, [activeId, rememberLayout, say])

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

  /**
   * A panel the Window menu can turn off as well as on.
   *
   * `focusPanel` only ever opens; a menu with a tick beside each panel has to
   * be able to clear the tick too, which is the half people reach for when a
   * layout has got away from them.
   */
  const togglePanel = useCallback(
    (panelId: string) => {
      const api = apiRef.current
      if (!api) return
      const open = api.getPanel(panelId)
      if (open) api.removePanel(open)
      else focusPanel(panelId)
    },
    [focusPanel],
  )

  /** Saves the arrangement under a name, through the same serialisation the workspaces use. */
  const savePreset = useCallback(
    (name: string) => {
      const api = apiRef.current
      if (!api) return
      const preset = saveLayoutPreset(name, api.toJSON(), activeRef.current)
      say(`Saved layout "${preset.name}"`)
    },
    [say],
  )

  /**
   * Puts a saved arrangement back.
   *
   * `rearranging` for the same reason applying a workspace sets it: restoring
   * clears the dock first, and that clearing is a layout change which would
   * otherwise be written down as the user's current arrangement — losing the
   * thing being restored at the moment of restoring it.
   */
  const applyPreset = useCallback(
    (id: string) => {
      const api = apiRef.current
      const preset = getLayoutPreset(id)
      if (!api || !preset) return
      rearranging.current = true
      try {
        api.fromJSON(preset.layout as Parameters<typeof api.fromJSON>[0])
        if (preset.workspace) {
          activeRef.current = preset.workspace
          setActiveId(preset.workspace)
        }
        say(`Layout "${preset.name}"`)
      } catch {
        say(`Could not apply "${preset.name}" — it was saved by a different version`)
      } finally {
        rearranging.current = false
      }
    },
    [say],
  )

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    setReady(true)
  }, [])

  // Restore persisted layouts once the dock exists, then open the last workspace.
  useEffect(() => {
    if (!ready) return
    let cancelled = false

    void (async () => {
      const layouts = await loadStore<SavedLayouts>(LAYOUTS_STORE, {})
      if (cancelled) return
      savedRef.current = layouts
      applyWorkspace(openInRef.current)
    })()

    return () => {
      cancelled = true
    }
  }, [ready, applyWorkspace])

  /**
   * The arrangement is written down as it changes.
   *
   * It used to wait for Ctrl Alt S, which meant the ordinary way to lose a
   * layout was to spend ten minutes building one and then close the app — and
   * nothing on screen said that would happen. Every other thing about where
   * you were is remembered without being asked; the panels should be too.
   *
   * Debounced, because dragging a splitter fires this continuously and each
   * write is a round trip to disk. Half a second is longer than any gesture's
   * gaps and shorter than the time between deciding you are done and closing
   * the window.
   *
   * `rearranging` is what keeps a restore from overwriting what it is
   * restoring: applying a workspace clears the dock first, and that clearing
   * is itself a layout change.
   */
  useEffect(() => {
    const api = apiRef.current
    if (!ready || !api) return

    let pending: number | undefined
    const disposable = api.onDidLayoutChange(() => {
      if (rearranging.current) return
      window.clearTimeout(pending)
      pending = window.setTimeout(() => rememberLayout(activeRef.current), 500)
    })

    return () => {
      window.clearTimeout(pending)
      disposable.dispose()
      // On the way out, keep whatever the last change was rather than dropping
      // it because the debounce had not fired yet.
      if (!rearranging.current) rememberLayout(activeRef.current)
    }
  }, [ready, activeId, rememberLayout])

  // Reopening the project brings back the workspace it was left in. Recorded,
  // not saved: switching workspaces is not an edit and must not light the
  // unsaved dot — it travels with the next real save.
  useEffect(() => {
    if (ready) recordView({ workspace: activeId })
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
      {
        /*
         * Send to render: queue what is selected, then go and look at it.
         *
         * One keystroke doing two things, and that pairing is the whole point
         * of it — "send this to render" is a single thought, and splitting it
         * into *add* and then *go and check* is how a queue ends up with
         * something in it nobody looked at. With nothing selected it takes the
         * whole sequence, because that is what someone pressing it on an empty
         * selection means; in sequence mode there is only ever one thing to
         * send, so the selection does not come into it.
         */
        id: 'render.send',
        title: 'Send to Render',
        category: 'Render',
        detail: 'Queues the selected clips and opens the Export workspace',
        run: () => {
          const settings = getRenderSettings()
          const scope =
            settings.mode === 'sequence'
              ? 'one-file'
              : getSelection().size > 0
                ? 'selection'
                : 'sequence'
          const result = addToQueue(scope)
          applyWorkspace('export')
          const parts: string[] = []
          if (result.added) parts.push(`${result.added} queued`)
          if (result.replaced) parts.push(`${result.replaced} updated`)
          if (result.skipped.length) parts.push(`${result.skipped.length} refused`)
          say(parts.length ? parts.join(' · ') : 'Nothing to render')
        },
      },
      {
        id: 'layout.saveAs',
        title: 'Save Layout as Preset…',
        category: 'Workspace',
        detail: 'Keeps this arrangement under a name you can come back to',
        run: () => setLayoutDialog({ mode: 'save', name: '' }),
      },
      {
        id: 'layout.manage',
        title: 'Manage Saved Layouts…',
        category: 'Workspace',
        run: () => setLayoutDialog({ mode: 'manage', name: '' }),
      },
      ...layoutPresets().map((preset) => ({
        id: `layout.apply.${preset.id}`,
        title: `Layout: ${preset.name}`,
        category: 'Workspace',
        run: () => applyPreset(preset.id),
      })),
      ...panels.list().map((panel) => ({
        id: `panel.toggle.${panel.id}`,
        title: `Toggle ${panel.title}`,
        category: 'Panel',
        detail: panel.description,
        run: () => togglePanel(panel.id),
      })),
      ...panels.list().map((panel) => ({
        id: `panel.focus.${panel.id}`,
        title: `Focus ${panel.title}`,
        category: 'Panel',
        detail: panel.description,
        run: () => focusPanel(panel.id),
      })),
    ])

    return () => handle.dispose()
  }, [
    ready,
    applyWorkspace,
    saveWorkspace,
    resetWorkspace,
    focusPanel,
    togglePanel,
    applyPreset,
    presets,
    say,
  ])

  /**
   * The application menu is told what this window has.
   *
   * It is built in the main process and the panels live here, so somebody has
   * to carry the list across. Re-sent on every layout change as well as when
   * the presets change, because the ticks beside the panel names are the half
   * of the menu that says what is *already* on screen.
   */
  useEffect(() => {
    if (!ready) return
    const bridge = (window as unknown as { flux?: { menu?: { describe: (d: unknown) => void } } })
      .flux?.menu
    if (!bridge) return

    const describe = () => {
      const api = apiRef.current
      const open = new Set(api ? api.panels.map((panel) => panel.id) : [])
      bridge.describe({
        panels: panels.list().map((panel) => ({
          id: panel.id,
          title: panel.title,
          open: open.has(panel.id),
        })),
        presets: presets.map((preset) => ({ id: preset.id, name: preset.name })),
        workspaces: workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
        activeWorkspace: activeId,
      })
    }

    describe()
    const api = apiRef.current
    const disposable = api?.onDidLayoutChange(describe)
    return () => disposable?.dispose()
  }, [ready, activeId, presets])

  /** And the answers come back as command ids, run through the same table as everything else. */
  useEffect(() => {
    const bridge = (
      window as unknown as { flux?: { menu?: { onRun: (h: (id: string) => void) => () => void } } }
    ).flux?.menu
    if (!bridge) return
    return bridge.onRun((id) => {
      void commands.run(id)
    })
  }, [])

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

        {/* Last in the bar, so it sits in the corner. What it reports belongs
            to the whole app rather than to any panel — the queues it watches
            go on running with every panel closed — which is why it lives here
            and not in the Timeline. */}
        <MediaWorkRing />
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
          {/* The sequence that is actually open. This said "Sequence 1"
              literally, from back when a project had exactly one and its name
              could not change — so it kept saying it through every rename and
              every switch between tabs. */}
          <span className="status-scope">
            {project.name} ▸ {openSequence}
          </span>
          <span className="status-dim">
            {saving ? 'saving…' : dirty ? 'unsaved changes' : 'saved'}
          </span>
        </span>
        <span className="status-right">
          {flash && <span className="status-flash">{flash}</span>}
          {/* Says nothing at all unless there is an update to mention — see
              updateLabel in kernel/updates. */}
          <UpdateBadge />
          <span className="status-dim">{isDesktop ? 'desktop' : 'browser'}</span>
          {/*
            Said plainly rather than left as "shell only — no engine", which
            stopped being true once mp4 was demuxed and decoded here. "pre-alpha"
            is the honest word: a working slice of the engine, a long way from a
            finished editor, and nothing in the UI painted on.
          */}
          <span className="status-dim">pre-alpha</span>
        </span>
      </footer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        lookupChord={keymap.lookup}
      />
      <ImportChoiceHost />
      {layoutDialog && (
        <div
          className="layout-sheet-backdrop"
          onClick={() => setLayoutDialog(null)}
          role="presentation"
        >
          <div
            className="layout-sheet"
            role="dialog"
            aria-label={layoutDialog.mode === 'save' ? 'Save layout as preset' : 'Saved layouts'}
            onClick={(event) => event.stopPropagation()}
          >
            {layoutDialog.mode === 'save' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!layoutDialog.name.trim()) return
                  savePreset(layoutDialog.name)
                  setLayoutDialog(null)
                }}
              >
                <h2 className="layout-sheet-title">Save layout as preset</h2>
                <p className="layout-sheet-note">
                  The arrangement of every panel, under a name. Saving over a name you already used
                  replaces it.
                </p>
                <input
                  className="layout-sheet-input"
                  autoFocus
                  placeholder="Assembling, Grading, Two monitors…"
                  value={layoutDialog.name}
                  onChange={(event) =>
                    setLayoutDialog({ mode: 'save', name: event.target.value })
                  }
                />
                <div className="layout-sheet-actions">
                  <button type="button" className="batch-button" onClick={() => setLayoutDialog(null)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="batch-button batch-button--go"
                    disabled={!layoutDialog.name.trim()}
                  >
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h2 className="layout-sheet-title">Saved layouts</h2>
                {presets.length === 0 ? (
                  <p className="layout-sheet-note">
                    None yet. Arrange the panels how you like them, then Window ▸ Save Layout as
                    Preset.
                  </p>
                ) : (
                  <div className="layout-sheet-list" role="list">
                    {presets.map((preset) => (
                      <div className="layout-row" role="listitem" key={preset.id}>
                        <button
                          className="layout-row-name"
                          onClick={() => {
                            applyPreset(preset.id)
                            setLayoutDialog(null)
                          }}
                        >
                          {preset.name}
                        </button>
                        <button
                          className="layout-row-drop"
                          title={`Forget "${preset.name}"`}
                          onClick={() => {
                            removeLayoutPreset(preset.id)
                            say(`Forgot layout "${preset.name}"`)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="layout-sheet-actions">
                  <button className="batch-button" onClick={() => setLayoutDialog(null)}>
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
