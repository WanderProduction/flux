import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import {
  breadcrumbsOf,
  formatBytes,
  hasFilesystem,
  listDirectory,
  listPlaces,
  pickFiles,
  type DirectoryListing,
  type FolderEntry,
  type MediaKind,
  type Places,
} from '../kernel/fsBridge'
import {
  ensureProbed,
  getAssets,
  removeAssets,
  subscribeAssets,
  type Asset,
} from '../kernel/assets'
import {
  activateSequence,
  addLinkedClips,
  createSequence,
  getActiveSequenceId,
  getSequence,
  listSequences,
  removeSequence,
  subscribeSequence,
  type SequenceState,
} from '../kernel/sequence'
import { formatTimecode } from '../kernel/playback'
import { setAssetDragPayload, setFileDragPayload } from '../kernel/dragAssets'
import { setImportMode } from '../kernel/importMode'
import { importFiles, type ImportEntry } from '../kernel/importPipeline'
import {
  getPinned,
  isPinned,
  isPinnedLoaded,
  loadPinned,
  subscribePinned,
  togglePin,
} from '../kernel/pinned'
import { getProject, subscribeProject } from '../kernel/project'
import { loadStore, saveStore } from '../kernel/store'
import { getView, recordView, type BrowserLocation } from '../kernel/view'
import { mediaKindOf } from '../../shared/mediaTypes.js'
import { IMPORTS_DIR, projectChildPath } from '../../shared/projectNaming.js'
import { PanelFrame } from './PanelFrame'
import { AssetThumb } from './AssetThumb'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { SequenceSettingsDialog } from './SequenceSettingsDialog'
import { useSound } from './useSound'
import { TreeView, useDiskTree } from './FolderTree'

/**
 * Content Browser — browse the machine, import media into the project.
 *
 * The rail is ordered by how often it is reached for: the project first, then
 * the folders this person pinned, then the raw disks, with the OS's named
 * folders last as a fallback.
 *
 * PROJECT is the project's own folders as they really are on disk, and
 * `imports` is where the browser opens: it is the project's bin. There used to
 * be a separate synthetic "Assets" node beside the folders, which meant two
 * lists of the same footage that agreed only some of the time.
 *
 * One consequence has to be handled rather than ignored. A *linked* asset lives
 * wherever the user left it and is not inside `imports` at all, so it would
 * have nowhere to appear once the bin is gone. The imports view therefore shows
 * the folder's real contents *plus* any asset that lives elsewhere, marked as
 * linked. Everything imported is visible in one place, which is the property
 * the bin was there for.
 */

/** Shared with the project document, so the browser reopens where it was. */
type Location = BrowserLocation

const RAIL_STORE = 'ui-content-browser'
const RAIL_MIN = 140
const RAIL_MAX = 460
const RAIL_DEFAULT = 210

/** Directory portion of a path, for revealing an asset's folder. */
function folderOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut > 0 ? filePath.slice(0, cut) : filePath
}

export function ContentBrowserPanel() {
  const [project, setProjectState] = useState(getProject)
  // The document may say `{ type: 'project' }`, which is a *symbolic* default
  // meaning "this project's imports folder". Storing it that way rather than an
  // absolute path is what lets a project folder move to another machine and
  // still open where it should.
  const [location, setLocation] = useState<Location>(() => getView().browser.location)
  const [places, setPlaces] = useState<Places | null>(null)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'denied' | 'unreadable'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assets, setAssets] = useState<Asset[]>(getAssets)
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null)
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT)
  const [pinnedFolders, setPinnedFolders] = useState(getPinned)
  /**
   * The project's sequences, mirrored from the kernel.
   *
   * They are shown in the bin beside the media because that is what they are:
   * things this project contains. The alternative — a separate list somewhere
   * else — is the same mistake the synthetic "Assets" node was, two places
   * showing the project's contents and agreeing only some of the time.
   */
  const [sequences, setSequences] = useState<SequenceState[]>(() => listSequences())
  const [activeSequence, setActiveSequence] = useState(() => getActiveSequenceId())
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** Where copied media lands, and where the browser opens. */
  const importsFolder = useMemo(
    () => (project ? projectChildPath(project.root, IMPORTS_DIR) : null),
    [project],
  )

  useEffect(() => subscribeProject(() => setProjectState(getProject())), [])

  useEffect(
    () =>
      subscribeSequence(() => {
        setSequences(listSequences())
        setActiveSequence(getActiveSequenceId())
      }),
    [],
  )

  // Where you were browsing goes into the project document. Recorded rather
  // than saved: walking a folder tree is not an edit. See kernel/view.ts.
  useEffect(() => {
    const symbolic = importsFolder && location.type === 'folder' && location.path === importsFolder
    recordView({ browser: { location: symbolic ? { type: 'project' } : location } })
  }, [location, importsFolder])

  // Resolve the symbolic default once the project is known, so the panel's own
  // `location` is always a real folder from here on.
  useEffect(() => {
    if (location.type === 'project' && importsFolder) {
      setLocation({ type: 'folder', path: importsFolder })
    }
  }, [location, importsFolder])

  useEffect(() => {
    // The project applies the document; the panel only mirrors it.
    setAssets([...getAssets()])
    return subscribeAssets(() => setAssets([...getAssets()]))
  }, [])

  useEffect(() => {
    const unsubscribe = subscribePinned(() => setPinnedFolders([...getPinned()]))
    if (!isPinnedLoaded()) void loadPinned()
    else setPinnedFolders([...getPinned()])
    return unsubscribe
  }, [])

  // ── rail width, remembered across sessions ────────────────────
  useEffect(() => {
    let cancelled = false
    void loadStore<number>(RAIL_STORE, RAIL_DEFAULT).then((width) => {
      if (!cancelled && typeof width === 'number') {
        setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, width)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const beginResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      dragStateRef.current = { startX: event.clientX, startWidth: railWidth }

      const onMove = (move: PointerEvent) => {
        const state = dragStateRef.current
        if (!state) return
        setRailWidth(
          Math.min(RAIL_MAX, Math.max(RAIL_MIN, state.startWidth + (move.clientX - state.startX))),
        )
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        dragStateRef.current = null
        // Persist on release rather than on every move: a drag fires hundreds
        // of events and each one would be a disk write.
        setRailWidth((width) => {
          void saveStore(RAIL_STORE, width)
          return width
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [railWidth],
  )

  // ── the three disk trees ──────────────────────────────────────
  useEffect(() => {
    if (!hasFilesystem) return
    let cancelled = false
    void listPlaces().then((result) => {
      if (!cancelled) setPlaces(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const drives = useMemo(() => places?.drives ?? [], [places])
  const disk = useDiskTree(drives)

  const projectRoots = useMemo<FolderEntry[]>(
    () => (project ? [{ name: project.name, path: project.root }] : []),
    [project],
  )
  const projectTree = useDiskTree(projectRoots)

  const pinnedRoots = useMemo<FolderEntry[]>(
    () => pinnedFolders.map((p) => ({ name: p.name, path: p.path })),
    [pinnedFolders],
  )
  const pinnedTree = useDiskTree(pinnedRoots)

  // Open the project's folder immediately, so imports/exports/project_files are
  // visible without the user having to discover the chevron.
  const expandedProjectRef = useRef<string | null>(null)
  const expandProject = projectTree.expand
  useEffect(() => {
    if (!project || expandedProjectRef.current === project.root) return
    expandedProjectRef.current = project.root
    expandProject(project.root)
  }, [project, expandProject])

  // ── navigation ────────────────────────────────────────────────
  const openFolder = useCallback(
    (path: string, revealInTree = true) => {
      setLocation({ type: 'folder', path })
      setSelected(new Set())
      setFocusedAssetId(null)
      // Keep the disk tree in step with the grid, so descending through folder
      // cards does not leave the tree pointing somewhere else entirely.
      if (revealInTree) void disk.reveal(path)
    },
    [disk],
  )

  /** The project's bin: the imports folder. */
  const openImports = useCallback(() => {
    if (!importsFolder) return
    setLocation({ type: 'folder', path: importsFolder })
    setSelected(new Set())
    setFocusedAssetId(null)
    void projectTree.reveal(importsFolder)
  }, [importsFolder, projectTree])

  const [reloadToken, setReloadToken] = useState(0)
  const refresh = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    if (location.type !== 'folder' || !hasFilesystem) return

    let cancelled = false
    setStatus('loading')
    void listDirectory(location.path).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setListing(result.listing)
        setStatus('idle')
      } else {
        setListing(null)
        setStatus(result.error)
      }
    })

    return () => {
      cancelled = true
    }
  }, [location, reloadToken])

  const goUp = useCallback(() => {
    if (location.type === 'folder' && listing?.parent) openFolder(listing.parent)
  }, [location, listing, openFolder])

  // ── import ────────────────────────────────────────────────────

  /**
   * Everything the panel imports goes through the kernel pipeline, which owns
   * the copy-or-link decision and asks the question through a request the app
   * shell answers. The Timeline imports the same way — see kernel/importPipeline.
   */
  const importPaths = useCallback(async (entries: ImportEntry[], forced?: 'copy' | 'link') => {
    if (entries.length === 0) return 0
    setSelected(new Set())
    const added = await importFiles(entries, forced)
    return added.length
  }, [])

  const pickAndImport = useCallback(
    async (forced?: 'copy' | 'link') => {
      if (!hasFilesystem) return
      const paths = await pickFiles()
      if (paths.length === 0) return
      // The dialog returns bare paths, so kind is re-derived here — through the
      // same shared definition main validated against, never a second regex.
      const entries = paths
        .map((path) => ({ path, kind: mediaKindOf(path) }))
        .filter((entry): entry is ImportEntry => entry.kind !== null)
      await importPaths(entries, forced)
    },
    [importPaths],
  )

  const selectedEntries = useCallback(
    () => (listing ? listing.files.filter((file) => selected.has(file.path)) : []),
    [listing, selected],
  )

  /** The split button's target: the current selection, or the file picker. */
  const runImport = useCallback(
    async (forced?: 'copy' | 'link') => {
      const chosen = selectedEntries()
      if (chosen.length > 0) await importPaths(chosen, forced)
      else await pickAndImport(forced)
    },
    [selectedEntries, importPaths, pickAndImport],
  )

  // ── pinning ───────────────────────────────────────────────────
  const currentFolder = location.type === 'folder' ? location.path : null
  const currentIsPinned = currentFolder ? isPinned(currentFolder) : false

  const togglePinCurrent = useCallback(() => {
    if (currentFolder) togglePin(currentFolder)
  }, [currentFolder])

  // ── commands ──────────────────────────────────────────────────
  useEffect(() => {
    if (!hasFilesystem) return
    const handle = commands.registerAll([
      {
        id: 'content.import',
        title: 'Import Media…',
        category: 'Content',
        detail: 'Asks whether to copy into the project or link the originals',
        run: () => void runImport(),
      },
      {
        id: 'content.importCopy',
        title: 'Import Media (Copy Into Project)',
        category: 'Content',
        run: () => void runImport('copy'),
      },
      {
        id: 'content.importOrigin',
        title: 'Import Media (Keep Originals)',
        category: 'Content',
        run: () => void runImport('link'),
      },
      {
        id: 'content.project',
        title: 'Go to Project Imports',
        category: 'Content',
        detail: "The project's bin — everything imported, wherever the file lives",
        run: openImports,
      },
      { id: 'content.up', title: 'Go Up One Folder', category: 'Content', run: goUp },
      { id: 'content.refresh', title: 'Refresh Folder', category: 'Content', run: refresh },
      {
        id: 'content.collapseTree',
        title: 'Collapse All Folders',
        category: 'Content',
        run: () => disk.collapseAll(),
      },
      {
        id: 'content.togglePin',
        title: currentIsPinned ? 'Unpin This Folder' : 'Pin This Folder',
        category: 'Content',
        enabled: () => Boolean(currentFolder),
        run: togglePinCurrent,
      },
      {
        id: 'content.resetImportMode',
        title: 'Ask Again How To Import',
        category: 'Content',
        detail: "Clears this project's remembered copy-or-link choice",
        run: () => setImportMode('ask'),
      },
    ])
    return () => handle.dispose()
  }, [runImport, openImports, goUp, refresh, disk, currentIsPinned, currentFolder, togglePinCurrent])

  // ── the bin ───────────────────────────────────────────────────

  const inImports = location.type === 'folder' && location.path === importsFolder

  /** Assets by path, so any card can tell whether it is already in the project. */
  const assetByPath = useMemo(() => {
    const map = new Map<string, Asset>()
    assets.forEach((asset) => map.set(asset.path, asset))
    return map
  }, [assets])

  /**
   * Assets that live outside the imports folder — the linked ones.
   *
   * Shown alongside the folder's real contents, and only there. Without this a
   * linked import would be in the project, on the timeline, and visible nowhere
   * in the browser at all.
   */
  const linkedAssets = useMemo(() => {
    if (!inImports || !importsFolder) return []
    return assets
      .filter((asset) => !asset.path.startsWith(importsFolder))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [assets, inImports, importsFolder])

  // ── path bar ──────────────────────────────────────────────────
  const crumbs = useMemo(
    () => (location.type === 'folder' ? breadcrumbsOf(location.path) : []),
    [location],
  )

  // Keep the deepest crumb in view. The strip scrolls instead of squeezing, so
  // without this a deep path would show its root and hide where you are.
  const crumbsRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const strip = crumbsRef.current
    if (strip) strip.scrollLeft = strip.scrollWidth
  }, [crumbs])

  /**
   * A new sequence holding the chosen media, laid end to end.
   *
   * Anything not in the project yet is imported on the way, for the same reason
   * dragging an unimported file onto the timeline imports it: the gesture says
   * what the person wants, and refusing it to make a point about bookkeeping
   * helps nobody.
   *
   * End to end in the order they are listed rather than the order they were
   * clicked — the order on screen is the only one that is visible, and a
   * sequence assembled in click order would look shuffled.
   */
  const newSequenceFrom = useCallback(
    async (paths: string[]) => {
      const wanted = paths
        .map((path) => ({ path, kind: mediaKindOf(path) }))
        .filter((entry): entry is ImportEntry => entry.kind !== null)
      if (wanted.length === 0) return null

      const known = new Map(getAssets().map((asset) => [asset.path, asset]))
      const missing = wanted.filter((entry) => !known.has(entry.path))
      if (missing.length > 0) await importFiles(missing)

      const byPath = new Map(getAssets().map((asset) => [asset.path, asset]))
      const chosen = wanted
        .map((entry) => byPath.get(entry.path))
        .filter((asset): asset is Asset => Boolean(asset))
      if (chosen.length === 0) return null

      const made = createSequence({ name: undefined })
      for (const asset of chosen) {
        const probed = (await ensureProbed(asset.id)) ?? asset
        // A still has no duration of its own, so it gets the length every NLE
        // gives one. Five seconds is long enough to see and short enough to
        // trim rather than fight.
        const length = probed.duration && probed.duration > 0 ? probed.duration : 5
        /*
         * Each one asks for the start and lands after the last.
         *
         * addClip slides a clip forward past whatever is already on the track,
         * so the queue lays itself out; a running total here would be a second
         * answer to the same question, and the wrong one the moment a clip
         * landed anywhere but where the total predicted. There was one, and a
         * canary proved it changed nothing — which is exactly what dead
         * arithmetic looks like from the outside, and what makes the next
         * person reading this think it is what orders the clips.
         *
         * The sound follows its picture's start rather than finding its own,
         * so a pair cannot come apart here. See addLinkedClips.
         */
        addLinkedClips({ assetId: asset.id, trackId: 'V1', start: 0, duration: length }, true)
      }
      setSelected(new Set())
      return made
    },
    [],
  )

  /**
   * Opens a sequence in the Timeline.
   *
   * Every sequence in the project already has a tab — they are all loaded when
   * the project opens — so this switches to it rather than making a second one.
   * A sequence open twice would be two views of one thing that can disagree.
   */
  const openSequence = useCallback((id: string) => {
    activateSequence(id)
    void commands.run('panel.focus.timeline')
  }, [])

  /**
   * Settings, for a sequence that may not be the one on screen.
   *
   * It is activated first. Every editing function in kernel/sequence.ts works
   * on the active sequence deliberately — there is no way to mutate one nobody
   * is looking at — and settings are not the place to punch the first hole in
   * that. Switching to it is also what somebody about to change its frame size
   * almost certainly wants.
   */
  const openSettings = useCallback((id: string) => {
    activateSequence(id)
    setSettingsOpen(true)
  }, [])

  const backgroundMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const chosen = [...selected]
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            id: 'new',
            label: 'New Sequence',
            hint: 'Ctrl N',
            run: () => void commands.run('sequence.new'),
          },
          {
            id: 'from',
            label:
              chosen.length === 1
                ? 'New Sequence From Clip'
                : `New Sequence From ${chosen.length} Clips`,
            disabled: chosen.length === 0,
            run: () => void newSequenceFrom(chosen),
          },
          {
            id: 'import',
            label: 'Import Media\u2026',
            separated: true,
            run: () => void pickAndImport(),
          },
        ],
      })
    },
    [selected, newSequenceFrom, pickAndImport],
  )

  const sequenceMenu = useCallback(
    (event: React.MouseEvent, one: SequenceState) => {
      event.preventDefault()
      event.stopPropagation()
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          { id: 'open', label: 'Open in Timeline', run: () => openSequence(one.id) },
          {
            id: 'settings',
            label: 'Sequence Settings\u2026',
            run: () => openSettings(one.id),
          },
          {
            id: 'delete',
            label: 'Delete Sequence',
            separated: true,
            danger: true,
            // The last one cannot go: a project with no sequence has nowhere to
            // put a clip, and the timeline would have nothing to draw.
            disabled: listSequences().length <= 1,
            run: () => {
              removeSequence(one.id)
            },
          },
        ],
      })
    },
    [openSequence, openSettings],
  )

  const toggleSelect = (path: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  useEffect(() => {
    const handle = commands.registerAll([
      {
        id: 'sequence.new',
        title: 'New Sequence',
        category: 'Sequence',
        detail: 'An empty sequence, and switches to it',
        run: () => {
          createSequence()
          void commands.run('panel.focus.timeline')
        },
      },
      {
        id: 'sequence.newFromSelection',
        title: 'New Sequence From Selected Clips',
        category: 'Sequence',
        detail: 'Lays the selected media end to end in a new sequence',
        enabled: () => selected.size > 0,
        run: () => void newSequenceFrom([...selected]),
      },
      {
        id: 'sequence.settings',
        title: 'Sequence Settings\u2026',
        category: 'Sequence',
        detail: 'Frame size, rate, duration, colour and audio',
        run: () => setSettingsOpen(true),
      },
    ])
    return () => handle.dispose()
  }, [selected, newSequenceFrom])

  if (!hasFilesystem) {
    return (
      <PanelFrame>
        <div className="cb-empty">
          <p>The Content Browser needs the desktop app.</p>
          <p className="cb-empty-hint">
            Run <code>npm run dev</code> to browse and import local media.
          </p>
        </div>
      </PanelFrame>
    )
  }

  return (
    <PanelFrame scroll={false}>
      <div className="cb" style={{ gridTemplateColumns: `${railWidth}px 4px 1fr` }}>
        <aside className="cb-rail">
          <section className="cb-tree-section">
            <h3 className="cb-rail-title">Project</h3>
            {/* The project's real folders. `imports` is the bin, and is where
                the browser opens. */}
            <div className="cb-subtree cb-subtree--folders">
              <TreeView
                rows={projectTree.rows}
                selectedId={location.type === 'folder' ? location.path : null}
                onSelect={(row) => openFolder(row.id, false)}
                onToggle={(row) => projectTree.toggle(row.id)}
                emptyNote="No project open"
              />
            </div>
          </section>

          <section className="cb-tree-section">
            <h3 className="cb-rail-title">Pinned</h3>
            <TreeView
              rows={pinnedTree.rows}
              selectedId={location.type === 'folder' ? location.path : null}
              onSelect={(row) => openFolder(row.id, false)}
              onToggle={(row) => pinnedTree.toggle(row.id)}
              emptyNote="Open a folder and pin it"
            />
          </section>

          <section className="cb-tree-section">
            <h3 className="cb-rail-title">This PC</h3>
            <TreeView
              rows={disk.rows}
              selectedId={location.type === 'folder' ? location.path : null}
              onSelect={(row) => openFolder(row.id, false)}
              onToggle={(row) => disk.toggle(row.id)}
              emptyNote="No drives found"
            />
          </section>

          {places && places.places.length > 0 && (
            <section className="cb-tree-section">
              <h3 className="cb-rail-title">Quick</h3>
              <div className="cb-quick">
                {places.places.map((place) => (
                  <button
                    key={place.path}
                    className={`cb-quick-item${
                      location.type === 'folder' && location.path === place.path
                        ? ' cb-quick-item--active'
                        : ''
                    }`}
                    onClick={() => openFolder(place.path)}
                    title={place.path}
                  >
                    {place.name}
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>

        <div
          className="cb-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          title="Drag to resize"
        />

        <div className="cb-main">
          {/* Sits inside the main column so the path lines up with the files it
              describes, rather than starting over at the rail. */}
          <div className="cb-pathbar">
            <button
              className="cb-icon-button"
              onClick={goUp}
              disabled={!listing?.parent || location.type !== 'folder'}
              title="Go up one folder"
              aria-label="Go up one folder"
            >
              ↑
            </button>

            <nav className="cb-crumbs" ref={crumbsRef}>
              {crumbs.map((crumb, i) => (
                <button
                  key={crumb.path}
                  className={`cb-crumb${i === crumbs.length - 1 ? ' cb-crumb--current' : ''}`}
                  onClick={() => openFolder(crumb.path)}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              ))}
            </nav>

            <span className="cb-pathbar-end">
              {location.type === 'folder' && (
                <button
                  className={`cb-btn${currentIsPinned ? ' cb-btn--primary' : ''}`}
                  onClick={togglePinCurrent}
                  title={currentIsPinned ? 'Remove from Pinned' : 'Keep this folder in Pinned'}
                >
                  {currentIsPinned ? 'Pinned' : 'Pin'}
                </button>
              )}
              <ImportSplitButton count={selected.size} onImport={runImport} />
            </span>
          </div>

          <div className="cb-scroll">
            <FolderGrid
              status={status}
              listing={listing}
              selected={selected}
              assetByPath={assetByPath}
              linkedAssets={linkedAssets}
              focusedAssetId={focusedAssetId}
              isBin={inImports}
              sequences={inImports ? sequences : []}
              activeSequence={activeSequence}
              onOpenFolder={openFolder}
              onToggle={toggleSelect}
              onImportOne={(file) => void importPaths([file])}
              onReveal={(path) => openFolder(path)}
              onOpenSequence={openSequence}
              onSequenceMenu={sequenceMenu}
              onBackgroundMenu={backgroundMenu}
            />
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {settingsOpen && (
        <SequenceSettingsDialog sequence={getSequence()} onClose={() => setSettingsOpen(false)} />
      )}
    </PanelFrame>
  )
}

/**
 * Import, with the two explicit modes one click away.
 *
 * The plain button follows the preference (asking when there isn't one); the
 * menu names both modes outright, so someone who knows what they want never has
 * to answer a dialog to get it.
 */
function ImportSplitButton({
  count,
  onImport,
}: {
  count: number
  onImport: (forced?: 'copy' | 'link') => void | Promise<number | void>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = count > 0 ? `Import ${count}` : 'Import…'
  const run = (forced?: 'copy' | 'link') => {
    setOpen(false)
    void onImport(forced)
  }

  return (
    <div className="split-button" ref={ref}>
      <button className="cb-btn split-button-main" onClick={() => run()}>
        {label}
      </button>
      <button
        className="cb-btn split-button-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Import options"
        onClick={() => setOpen((value) => !value)}
      >
        ▾
      </button>

      {open && (
        <div className="split-menu" role="menu">
          <button className="split-menu-item" role="menuitem" onClick={() => run('copy')}>
            <span>Import Copy</span>
            <span className="split-menu-detail">Copies into the project's imports folder</span>
          </button>
          <button className="split-menu-item" role="menuitem" onClick={() => run('link')}>
            <span>Import Origin</span>
            <span className="split-menu-detail">Points at the files where they are</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The file grid — a folder's real contents, and in the project's bin the
 * linked assets that live elsewhere.
 *
 * One grid rather than two. A card is a card: it shows a file, it says whether
 * that file is in the project, and it can be dragged onto the Timeline. What
 * differs between a folder on some drive and the project's own imports folder
 * is only which cards are there, which is a filter, not a second component.
 */
function FolderGrid({
  status,
  listing,
  selected,
  assetByPath,
  linkedAssets,
  focusedAssetId,
  isBin,
  sequences,
  activeSequence,
  onOpenFolder,
  onToggle,
  onImportOne,
  onReveal,
  onOpenSequence,
  onSequenceMenu,
  onBackgroundMenu,
}: {
  status: 'idle' | 'loading' | 'denied' | 'unreadable'
  listing: DirectoryListing | null
  selected: Set<string>
  assetByPath: Map<string, Asset>
  linkedAssets: Asset[]
  focusedAssetId: string | null
  isBin: boolean
  sequences: SequenceState[]
  activeSequence: string
  onOpenFolder: (path: string) => void
  onToggle: (path: string) => void
  onImportOne: (file: ImportEntry) => void
  onReveal: (path: string) => void
  onOpenSequence: (id: string) => void
  onSequenceMenu: (event: React.MouseEvent, one: SequenceState) => void
  onBackgroundMenu: (event: React.MouseEvent) => void
}) {
  // Bring a card selected from elsewhere into view.
  useEffect(() => {
    if (!focusedAssetId) return
    document
      .querySelector(`[data-asset-id="${focusedAssetId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedAssetId])

  if (status === 'denied') {
    return (
      <div className="cb-empty">
        <p>Permission denied.</p>
        <p className="cb-empty-hint">Windows will not let FLUX read this folder.</p>
      </div>
    )
  }
  if (status === 'unreadable') {
    return (
      <div className="cb-empty">
        <p>This folder could not be read.</p>
      </div>
    )
  }
  if (status === 'loading' && !listing) {
    return <div className="cb-empty cb-empty--quiet">Reading folder…</div>
  }
  if (!listing) return null

  const empty =
    listing.folders.length === 0 &&
    listing.files.length === 0 &&
    linkedAssets.length === 0 &&
    sequences.length === 0

  return (
    <>
      {listing.truncated && (
        <div className="cb-banner">
          This folder is very large — showing the first part of it only.
        </div>
      )}

      {empty ? (
        isBin ? (
          // Right-clickable even when there is nothing here: an empty project is
          // exactly where somebody reaches for "New Sequence".
          <div className="cb-empty" onContextMenu={onBackgroundMenu}>
            <p>Nothing imported yet.</p>
            <p className="cb-empty-hint">
              Browse a folder in the tree and import, or press <kbd>Ctrl K</kbd> and run{' '}
              <em>Import Media…</em>
            </p>
            <p className="cb-empty-hint">
              Right-click here, or press <kbd>Ctrl N</kbd>, for a new sequence.
            </p>
          </div>
        ) : (
          <div className="cb-empty cb-empty--quiet">Nothing here that FLUX can open.</div>
        )
      ) : (
        <div className="cb-grid" onContextMenu={onBackgroundMenu}>
          {/* Sequences first. They are what the project *is* — the media is
              what it is made of — and a sequence buried under forty clips is a
              sequence nobody finds. */}
          {sequences.map((one) => (
            <SequenceCard
              key={one.id}
              sequence={one}
              active={one.id === activeSequence}
              onOpen={() => onOpenSequence(one.id)}
              onMenu={(event) => onSequenceMenu(event, one)}
            />
          ))}

          {listing.folders.map((folder: FolderEntry) => (
            <div
              key={folder.path}
              className="card card--folder"
              title={folder.path}
              onDoubleClick={() => onOpenFolder(folder.path)}
            >
              <div className="thumb thumb--folder" />
              <div className="card-meta">
                <span className="card-name">{folder.name}</span>
                <span className="card-sub">folder</span>
              </div>
            </div>
          ))}

          {listing.files.map((file) => (
            <FileCard
              key={file.path}
              path={file.path}
              name={file.name}
              kind={file.kind}
              size={file.size}
              asset={assetByPath.get(file.path)}
              selected={selected.has(file.path)}
              focused={assetByPath.get(file.path)?.id === focusedAssetId}
              onClick={() => onToggle(file.path)}
              onDoubleClick={() => void onImportOne(file)}
            />
          ))}

          {linkedAssets.map((asset) => (
            <FileCard
              key={asset.id}
              path={asset.path}
              name={asset.name}
              kind={asset.kind}
              size={asset.size}
              asset={asset}
              // Selectable like any other card. A linked asset lives outside
              // the imports folder, which is why it is listed separately — but
              // it is in the project exactly as much as a copied one, and a
              // card that cannot be chosen is a card that cannot be built into
              // a sequence.
              selected={selected.has(asset.path)}
              focused={asset.id === focusedAssetId}
              onClick={() => onToggle(asset.path)}
              onDoubleClick={() => onReveal(folderOf(asset.path))}
            />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * A sequence, as a card.
 *
 * The thumbnail is black when there is nothing in it yet, and otherwise says
 * how long it runs. A picture would be better and is not available: drawing one
 * means compositing a frame of the sequence, which needs a decoder per clip and
 * a canvas per card. The length is the one fact about a sequence that is worth
 * a glance, and it is honest — a black rectangle that claimed to be a frame
 * would not be.
 */
function SequenceCard({
  sequence,
  active,
  onOpen,
  onMenu,
}: {
  sequence: SequenceState
  active: boolean
  onOpen: () => void
  onMenu: (event: React.MouseEvent) => void
}) {
  const clips = sequence.clips.length
  const runs = sequence.clips.reduce(
    (end, clip) => Math.max(end, clip.start + clip.duration),
    0,
  )
  const pinned = sequence.settings.duration > 0
  const length = pinned ? sequence.settings.duration : runs

  return (
    <div
      className={`card card--sequence${active ? ' card--sequence-open' : ''}`}
      data-sequence-id={sequence.id}
      title={`${sequence.name} — ${sequence.settings.width}×${sequence.settings.height} at ${sequence.settings.frameRate} fps`}
      onDoubleClick={onOpen}
      onContextMenu={onMenu}
    >
      <div className="thumb thumb--sequence">
        {clips > 0 && (
          <span className="seq-thumb-time">
            {formatTimecode(length, sequence.settings.frameRate, 0)}
          </span>
        )}
        {pinned && <span className="seq-thumb-pinned" title="This sequence has a set length" />}
      </div>
      <div className="card-meta">
        <span className="card-name">{sequence.name}</span>
        <span className="card-sub">
          {clips === 0 ? 'empty' : `${clips} clip${clips === 1 ? '' : 's'}`}
        </span>
      </div>
      <span className="card-kind card-kind--sequence">sequence</span>
      {active && (
        <span className="card-badge" title="Open in the Timeline">
          open
        </span>
      )}
    </div>
  )
}

/**
 * One card.
 *
 * Draggable whether or not it is in the project: an unimported file dropped on
 * the Timeline imports itself on the way, which is the whole point of being
 * able to drag from anywhere. What is never draggable is a file that is gone —
 * that could only ever produce a clip with nothing to play.
 */
function FileCard({
  path,
  name,
  kind,
  size,
  asset,
  selected,
  focused,
  onClick,
  onDoubleClick,
}: {
  path: string
  name: string
  kind: MediaKind
  size: number
  asset?: Asset
  selected: boolean
  focused: boolean
  onClick?: () => void
  onDoubleClick?: () => void
}) {
  const missing = asset?.missing ?? false

  // Said here rather than only at the drop: whether a file has sound is a fact
  // about the file, and knowing it before you drag it is what stops a silent
  // clip reading as a broken timeline.
  const sound = useSound(path, kind, !missing)

  return (
    <div
      data-asset-id={asset?.id}
      className={`card${selected ? ' card--selected' : ''}${focused ? ' card--selected' : ''}${
        missing ? ' card--missing' : ''
      }`}
      title={path}
      draggable={!missing}
      onDragStart={(event) => {
        // An asset drags by id, so the drop is a pure placement. Anything else
        // drags by path, and the drop imports it first.
        if (asset) setAssetDragPayload(event, [asset.id])
        else setFileDragPayload(event, [{ path, kind, size }])
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <AssetThumb path={path} kind={kind} missing={missing} />
      <div className="card-meta">
        <span className="card-name">{name}</span>
        <span className="card-sub">
          {/* A zero size means nobody has stat'd it yet, not an empty file.
              Saying "0 B" about someone's footage is worse than saying nothing. */}
          {missing ? 'file not found' : size > 0 ? formatBytes(size) : kind}
        </span>
      </div>
      <span className={`card-kind card-kind--${kind}`}>{kind}</span>

      {asset?.inProject && (
        <span className="card-badge" title="Copied into the project">
          in project
        </span>
      )}
      {asset && !asset.inProject && (
        <span className="card-badge card-badge--linked" title={`Linked from ${path}`}>
          linked
        </span>
      )}

      {sound?.kind === 'silent' && (
        <span
          className="card-badge card-badge--silent"
          title="This file has no soundtrack, so it drops as picture alone"
        >
          no audio
        </span>
      )}
      {sound?.kind === 'unreadable' && (
        <span
          className="card-badge card-badge--silent"
          title={`FLUX cannot read this file's audio yet (${sound.detail})`}
        >
          audio ?
        </span>
      )}

      {asset && (
        <button
          className="card-remove"
          title="Remove from project (the file on disk is untouched)"
          onClick={(event) => {
            event.stopPropagation()
            removeAssets([asset.id])
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}
