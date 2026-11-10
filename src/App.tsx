import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview'

import { commands } from './kernel/commands'
import { importEditDocument } from './kernel/importEdit'
import { startControlServer, stopControlServer } from './kernel/controlBridge'
import { addMarker, markerAt, markerNear, removeMarkers } from './kernel/sequence'
import { getTime, isPlaying, seek, stalledClock, subscribePlayback } from './kernel/playback'
import { scrubAudio, setScrubAudio } from './kernel/media/mixer'
import { pickSequenceXml, readTextFile } from './kernel/fsBridge'
import { readXmeml } from '../shared/xmeml.js'
import { panels } from './kernel/panels'
import { createKeymapController, defaultKeymap } from './kernel/keymap'
import {
  getKeybindings,
  keybindingsLoaded,
  loadKeybindings,
  subscribeKeybindings,
} from './kernel/keybindings'
import { loadStore, saveStore, isDesktop } from './kernel/store'
import { layouts, getLayout, type SavedLayouts } from './kernel/layouts'
import {
  getLayoutPreset,
  layoutPresets,
  loadLayoutPresets,
  removeLayoutPreset,
  saveLayoutPreset,
  subscribeLayouts,
} from './kernel/layoutPresets'
import { getSequence, subscribeSequence } from './kernel/sequence'
import { getView, recordView } from './kernel/view'
import { getSelection } from './kernel/selection'
import { getRenderSettings } from './kernel/renderSettings'
import { add as addToQueue } from './kernel/renderQueue'
import { CommandPalette } from './shell/CommandPalette'
import { UpdateBadge } from './shell/UpdateBadge'
import { MediaWorkRing } from './shell/MediaWorkRing'
import { ImportChoiceHost } from './shell/ImportChoiceHost'
import { PerformanceDialog } from './panels/PerformanceDialog'
import { ProjectLauncher } from './launcher/ProjectLauncher'
import { AccountSetup } from './launcher/AccountSetup'
import { WorkspaceSetup } from './launcher/WorkspaceSetup'
import { WorkspaceDashboard } from './launcher/WorkspaceDashboard'
import {
  accountLoaded,
  getAccount,
  hasAccounts,
  loadAccount,
  subscribeAccount,
} from './kernel/account'
import {
  getWorkspace,
  loadWorkspaces,
  fileOpenedProjects,
  subscribeWorkspace,
  workspaceLoaded,
} from './kernel/workspace'
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
 * how *you* like panels arranged, the same in every project. Which layout is
 * currently open belongs to the project instead — it is where you left off in
 * this piece of work — so it rides in the .flux document. See kernel/view.ts.
 */
const LAYOUTS_STORE = 'layouts'
/** What that store was called before the word went to the project container. */
const LEGACY_LAYOUTS_STORE = 'workspaces'

/**
 * Four states, in order: no account, no workspace, no project, editing.
 *
 * Each one is the screen for the first question that has no answer yet, which
 * is why the order is fixed rather than a router: you cannot pick a workspace
 * before there is an account to own it, and a project card cannot be shown
 * before there is a workspace to list it in.
 *
 * The loading gate matters more than it looks. "There is no account" and "we
 * have not read the file yet" are indistinguishable from a null, and showing
 * the setup screen for the second one means every launch flashes a Create
 * Account form at somebody who has had an account for months.
 */
export function App() {
  const [project, setProject] = useState<Project | null>(getProject)
  const [, bump] = useState(0)

  useEffect(() => subscribeProject(() => setProject(getProject())), [])
  useEffect(() => subscribeAccount(() => bump((n) => n + 1)), [])
  useEffect(() => subscribeWorkspace(() => bump((n) => n + 1)), [])

  useEffect(() => {
    void loadAccount()
    void loadWorkspaces()
  }, [])

  /*
   * A project that is open is a project this workspace has — filed by
   * kernel/workspace.ts, off the project subscription rather than off this
   * component's render. See fileOpenedProjects for why that distinction is a
   * bug fix and not a preference.
   */
  useEffect(() => fileOpenedProjects(), [])

  // The dock is unmounted entirely while no project is open, so panels can
  // assume a project exists rather than every one of them guarding for its
  // absence. It also guarantees their state is rebuilt when a different project
  // opens, instead of the previous project's timeline lingering on screen.
  if (project) return <Editor key={project.root} project={project} />

  /*
   * In a plain browser there is no main process to hold a key or make a
   * folder, so the account layer cannot exist. `npm run dev:renderer` goes
   * straight to the dashboard-less launcher rather than showing a setup screen
   * whose Create button could never work.
   */
  if (!hasAccounts()) return <ProjectLauncher />
  if (!accountLoaded() || !workspaceLoaded()) return <div className="launcher launcher--waiting" />
  if (!getAccount()) return <AccountSetup />
  if (!getWorkspace()) return <WorkspaceSetup />
  return <WorkspaceDashboard />
}

function Editor({ project }: { project: Project }) {
  const apiRef = useRef<DockviewApi | null>(null)
  const savedRef = useRef<SavedLayouts>({})
  /*
   * Started on the shipped map and then fed from the store.
   *
   * Two steps rather than one because the controller is built during the first
   * render and the stored bindings arrive from IPC a moment later. Starting on
   * the defaults means every key works during that moment; the effect below
   * hands it the user's map as soon as there is one, and on every later edit.
   */
  const keymap = useMemo(() => createKeymapController(defaultKeymap), [])

  useEffect(() => {
    if (!keybindingsLoaded()) void loadKeybindings()
    const push = () => keymap.setKeymap(getKeybindings())
    if (keybindingsLoaded()) push()
    return subscribeKeybindings(push)
  }, [keymap])

  /**
   * The layout this project was saved in, read once at mount.
   *
   * Once, and into the initial state - not in the restore effect. activeId is
   * reported back into the view as it changes, so a default of 'edit' would
   * record 'edit' over the saved value before the restore ever got to read it,
   * and every project would reopen in Edit no matter what was saved.
   */
  const openInRef = useRef(getLayout(getView().layout) ? getView().layout : 'edit')

  const [ready, setReady] = useState(false)
  const [activeId, setActiveId] = useState(openInRef.current)
  /**
   * The same id, readable synchronously.
   *
   * The debounced layout save fires half a second after a change, and `state`
   * is only new on the next render — so a save that read `activeId` from the
   * closure would attribute an arrangement to **whichever layout was open
   * before**. With one layout that is invisible; with two it means
   * switching writes each layout under the other's name, and the second time
   * you switch you get the wrong panels. See `markActive`.
   */
  const activeRef = useRef(openInRef.current)
  const markActive = useCallback((id: string) => {
    activeRef.current = id
    setActiveId(id)
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  /*
   * How much of this machine FLUX may spend.
   *
   * Owned here rather than by the Timeline, which used to own it. Nothing
   * about a decoder pool or a frame-memory budget is about the timeline, and
   * registering the command there meant it existed only while that panel was
   * mounted — so it was missing from any layout without a Timeline in it,
   * which the settings page then pointed at and could not reach.
   */
  const [performanceOpen, setPerformanceOpen] = useState(false)
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

  /*
   * Say it when the sound stops, because otherwise nothing does.
   *
   * A device that stops responding mid-playback now costs silence rather than
   * a frozen playhead — see `reported` in kernel/playback.ts — and silence
   * with no explanation is the kind of thing somebody files a bug about from
   * the wrong end. Said once per stall: the flag is sticky until the transport
   * moves, so this fires on the edge and not on every tick.
   */
  const saidStalled = useRef(false)
  const wasPlaying = useRef(false)
  useEffect(
    () =>
      subscribePlayback(() => {
        const playing = isPlaying()
        // A new play is a new chance for the device to work, and a new chance
        // to be told that it did not.
        if (playing && !wasPlaying.current) saidStalled.current = false
        wasPlaying.current = playing

        if (stalledClock() && !saidStalled.current) {
          saidStalled.current = true
          say('The audio device stopped responding — playing on without sound')
        }
      }),
    [say],
  )

  /** Rebuild the dock for a layout: the saved arrangement if there is one, else the shipped default. */
  /**
   * True while a layout is being torn down and rebuilt.
   *
   * Every one of those steps fires a layout-change event, and the first thing
   * `applyLayout` does is clear the dock — so without this the arrangement
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

  const applyLayout = useCallback((id: string) => {
    const api = apiRef.current
    const layout = getLayout(id)
    if (!api || !layout) return

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
    layout.build(api)
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

  const saveLayout = useCallback(() => {
    if (!apiRef.current) return
    rememberLayout(activeRef.current)
    say(`Saved "${getLayout(activeId)?.name}" layout`)
  }, [activeId, rememberLayout, say])

  const resetLayout = useCallback(() => {
    const next = { ...savedRef.current }
    delete next[activeId]
    savedRef.current = next
    void saveStore(LAYOUTS_STORE, next)
    applyLayout(activeId)
    say(`Reset "${getLayout(activeId)?.name}" to default`)
  }, [activeId, applyLayout, say])

  /** Focus a panel, opening it in the current layout if it isn't there. */
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

  /** Saves the arrangement under a name, through the same serialisation the layouts use. */
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
   * `rearranging` for the same reason applying a layout sets it: restoring
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
        if (preset.layoutId) {
          activeRef.current = preset.layoutId
          setActiveId(preset.layoutId)
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

  // Restore persisted arrangements once the dock exists, then open the last layout.
  useEffect(() => {
    if (!ready) return
    let cancelled = false

    void (async () => {
      /*
       * Under the new key, or the old one if this installation predates the
       * rename. Nothing is written back under the old name, so the first save
       * after this migrates it for good; reading both costs one round trip on
       * a machine that has already migrated and nothing afterwards.
       */
      let saved = await loadStore<SavedLayouts>(LAYOUTS_STORE, {})
      if (Object.keys(saved).length === 0) {
        saved = await loadStore<SavedLayouts>(LEGACY_LAYOUTS_STORE, {})
      }
      if (cancelled) return
      savedRef.current = saved
      applyLayout(openInRef.current)
    })()

    return () => {
      cancelled = true
    }
  }, [ready, applyLayout])

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
   * restoring: applying a layout clears the dock first, and that clearing
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

  // Reopening the project brings back the layout it was left in. Recorded,
  // not saved: switching layouts is not an edit and must not light the
  // unsaved dot — it travels with the next real save.
  useEffect(() => {
    if (ready) recordView({ layout: activeId })
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
      ...layouts.map((layout) => ({
        id: `layout.switch.${layout.id}`,
        title: `Switch to ${layout.name}`,
        category: 'Layout',
        detail: 'Rearranges panels only — project, selection and playhead are untouched',
        run: () => applyLayout(layout.id),
      })),
      {
        id: 'app.performance',
        title: 'Performance Settings',
        category: 'App',
        detail: 'How much of this machine FLUX may spend on playback',
        run: () => setPerformanceOpen(true),
      },
      {
        /*
         * App-level rather than the Timeline's, for the reason the Cache page
         * found the hard way: a command registered by a panel does not exist
         * while that panel is closed, and this one has to be reachable from
         * Settings.
         */
        id: 'app.toggleScrubAudio',
        title: 'Play Audio While Scrubbing',
        category: 'App',
        detail: 'Whether dragging the playhead plays a short grain of the sequence',
        run: () => {
          const next = !scrubAudio()
          setScrubAudio(next)
          say(next ? 'Scrubbing plays audio' : 'Scrubbing is silent')
        },
      },
      {
        id: 'layout.save',
        title: 'Save Current Layout',
        category: 'Workspace',
        detail: 'Stores the current panel arrangement for this layout',
        run: saveLayout,
      },
      {
        id: 'layout.reset',
        title: 'Reset Layout to Default',
        category: 'Workspace',
        run: resetLayout,
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
        id: 'marker.add',
        title: 'Add Marker',
        category: 'Timeline',
        detail: 'At the playhead, or over the marked span when there is one',
        run: () => {
          /*
           * Over the marked range when there is one, and a point otherwise.
           * Someone who has just marked in and out and reaches for a marker
           * means that span — making them mark it twice would be the kind of
           * small stupidity that stops people using a feature.
           */
          const { inPoint, outPoint } = getSequence().range ?? { inPoint: null, outPoint: null }
          const spanned = inPoint !== null && outPoint !== null && outPoint > inPoint
          const made = addMarker(
            spanned ? { start: inPoint, end: outPoint } : { start: getTime() },
          )
          say(made ? (spanned ? 'Marker over the marked span' : 'Marker added') : 'Could not add a marker')
        },
      },
      {
        id: 'marker.delete',
        title: 'Delete Marker at Playhead',
        category: 'Timeline',
        run: () => {
          const here = markerAt(getTime())
          if (!here) {
            say('No marker at the playhead')
            return
          }
          removeMarkers([here.id])
          say(here.name ? `Deleted “${here.name}”` : 'Marker deleted')
        },
      },
      {
        id: 'marker.next',
        title: 'Go to Next Marker',
        category: 'Timeline',
        run: () => {
          const next = markerNear(getTime(), 1)
          if (!next) {
            say('No marker after this')
            return
          }
          seek(next.start)
          if (next.name) say(next.name)
        },
      },
      {
        id: 'marker.previous',
        title: 'Go to Previous Marker',
        category: 'Timeline',
        run: () => {
          const previous = markerNear(getTime(), -1)
          if (!previous) {
            say('No marker before this')
            return
          }
          seek(previous.start)
          if (previous.name) say(previous.name)
        },
      },
      {
        id: 'control.start',
        title: 'Start Local Control Server',
        category: 'Project',
        detail: 'Lets an MCP server — and so a model — drive FLUX on this machine',
        run: async () => {
          const result = await startControlServer()
          if (!result.ok) {
            say(`Could not start: ${result.error}`)
            return
          }
          /*
           * The port is said; the token is not. It is written to a file
           * that only a program running as this user can read, and putting
           * it in a toast would be putting it on screen in every recording
           * and screenshot of this app.
           */
          say(
            result.already
              ? `Already listening on 127.0.0.1:${result.port}`
              : `Listening on 127.0.0.1:${result.port} — token in the app data folder`,
          )
        },
      },
      {
        id: 'control.stop',
        title: 'Stop Local Control Server',
        category: 'Project',
        run: async () => {
          const stopped = await stopControlServer()
          say(stopped ? 'Control server stopped' : 'It was not running')
        },
      },
      {
        id: 'edit.importXml',
        title: 'Import Sequence XML…',
        category: 'Project',
        detail: 'A Premiere or Resolve sequence, as clips on a new timeline',
        run: async () => {
          const file = await pickSequenceXml()
          if (!file) return
          const read = await readTextFile(file)
          if (!read.ok) {
            say(`Could not read that file: ${read.error}`)
            return
          }
          const parsed = readXmeml(read.text)
          if (!parsed.ok) {
            say(parsed.error)
            return
          }
          const result = await importEditDocument(parsed.document)
          /*
           * The warning count is said out loud rather than swallowed. An
           * import that quietly left a nest, a marker set and fourteen
           * offline sources behind looks exactly like one that worked.
           */
          say(
            result.placed > 0
              ? `${result.placed} clips on “${result.sequenceName}”` +
                (result.warnings.length ? ` — ${result.warnings.length} warning(s)` : '')
              : 'Nothing could be placed — none of its media was found',
          )
          for (const warning of result.warnings) console.warn('[flux] import:', warning)
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
        detail: 'Queues the selected clips and opens the Export layout',
        run: () => {
          const settings = getRenderSettings()
          const scope =
            settings.mode === 'sequence'
              ? 'one-file'
              : getSelection().size > 0
                ? 'selection'
                : 'sequence'
          const result = addToQueue(scope)
          applyLayout('export')
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
    applyLayout,
    saveLayout,
    resetLayout,
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
        layouts: layouts.map((layout) => ({ id: layout.id, name: layout.name })),
        activeLayout: activeId,
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

        <nav className="layout-tabs">
          {layouts.map((layout) => (
            <button
              key={layout.id}
              className={`ws-tab${layout.id === activeId ? ' ws-tab--active' : ''}`}
              onClick={() => applyLayout(layout.id)}
              title={`Switch to ${layout.name}`}
            >
              {layout.name}
              <kbd>{layout.hint}</kbd>
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

      {/* No lookupChord prop any more: the palette asks kernel/keybindings
          directly, which is also where the Hotkeys page reads and writes. A
          function threaded from here worked while the palette was the only
          thing that needed it; the second consumer is what made it a seam. */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ImportChoiceHost />
      {performanceOpen && <PerformanceDialog onClose={() => setPerformanceOpen(false)} />}
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
