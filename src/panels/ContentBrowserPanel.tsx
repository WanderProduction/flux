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
  getAssets,
  importAssets,
  isLoaded,
  loadAssets,
  removeAssets,
  subscribeAssets,
  type Asset,
} from '../kernel/assets'
import { setAssetDragPayload } from '../kernel/dragAssets'
import {
  getImportMode,
  isImportModeLoaded,
  loadImportMode,
  setImportMode,
  type ImportMode,
} from '../kernel/importMode'
import {
  getPinned,
  isPinned,
  isPinnedLoaded,
  loadPinned,
  subscribePinned,
  togglePin,
} from '../kernel/pinned'
import { copyIntoImports, getProject, subscribeProject } from '../kernel/project'
import { loadStore, saveStore } from '../kernel/store'
import { mediaKindOf } from '../../shared/mediaTypes.js'
import { PanelFrame } from './PanelFrame'
import { AssetThumb } from './AssetThumb'
import { ImportChoiceDialog, type ImportChoice } from './ImportChoiceDialog'
import { TreeView, useDiskTree, type TreeRow } from './FolderTree'

/**
 * Content Browser — browse the machine, import media into the project.
 *
 * The rail is ordered by how often it is reached for: the project first, then
 * the folders this person pinned, then the raw disks, with the OS's named
 * folders last as a fallback.
 *
 * PROJECT shows two things. The project's own folder tree — imports, exports,
 * project_files as they really are on disk — and the Assets bin. They are not
 * the same list: a linked asset lives wherever the user left it and appears in
 * the bin without ever appearing under the project folder.
 */

/** The bin's synthetic root. Prefixed so it can never collide with a real path. */
const ASSETS_ROOT = '::assets'

type Location = { type: 'project' } | { type: 'folder'; path: string }

/** What the import pipeline accepts, whether it came from the grid or a dialog. */
interface ImportEntry {
  path: string
  kind: MediaKind
  size?: number
  mtimeMs?: number
  inProject?: boolean
}

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
  const [location, setLocation] = useState<Location>({ type: 'project' })
  const [places, setPlaces] = useState<Places | null>(null)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'denied' | 'unreadable'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assets, setAssets] = useState<Asset[]>(getAssets)
  const [assetsOpen, setAssetsOpen] = useState(true)
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null)
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT)
  const [pinnedFolders, setPinnedFolders] = useState(getPinned)
  const [pendingImport, setPendingImport] = useState<{
    entries: ImportEntry[]
    resolve: (choice: ImportChoice | null) => void
  } | null>(null)
  const [copyProgress, setCopyProgress] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  useEffect(() => subscribeProject(() => setProjectState(getProject())), [])

  useEffect(() => {
    const unsubscribe = subscribeAssets(() => setAssets([...getAssets()]))
    if (!isLoaded()) void loadAssets()
    else setAssets([...getAssets()])
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = subscribePinned(() => setPinnedFolders([...getPinned()]))
    if (!isPinnedLoaded()) void loadPinned()
    else setPinnedFolders([...getPinned()])
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!isImportModeLoaded()) void loadImportMode()
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

  const openAssets = useCallback(() => {
    setLocation({ type: 'project' })
    setSelected(new Set())
  }, [])

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
  const askImportMode = useCallback(
    (entries: ImportEntry[]) =>
      new Promise<ImportChoice | null>((resolve) => setPendingImport({ entries, resolve })),
    [],
  )

  /**
   * Copies each file into the project, then imports the copies.
   *
   * Sequential rather than parallel: copying several camera files at once
   * saturates the disk and makes every one of them slower, and a serial queue is
   * what lets the progress line say which file is being worked on.
   */
  const importByCopy = useCallback(async (entries: ImportEntry[]) => {
    const copied: ImportEntry[] = []
    const failures: string[] = []

    for (const [index, entry] of entries.entries()) {
      setCopyProgress(`Copying ${index + 1} of ${entries.length}…`)
      const result = await copyIntoImports(entry.path)
      if (result.ok && result.path) {
        copied.push({
          path: result.path,
          kind: entry.kind,
          size: result.size,
          mtimeMs: result.mtimeMs,
          inProject: true,
        })
      } else {
        failures.push(`${entry.path.split(/[\\/]/).pop()} (${result.error ?? 'failed'})`)
      }
    }

    setCopyProgress(null)
    if (copied.length > 0) importAssets(copied)
    if (failures.length > 0) {
      // Surfaced rather than swallowed: a copy that silently did not happen is a
      // file the user believes is backed up and is not.
      setCopyError(`Could not copy ${failures.length}: ${failures.join(', ')}`)
    }
    return copied.length
  }, [])

  /**
   * The single way media enters the project. `forced` comes from the split
   * button's menu and skips both the preference and the question.
   */
  const importPaths = useCallback(
    async (entries: ImportEntry[], forced?: 'copy' | 'link') => {
      if (entries.length === 0) return 0
      setSelected(new Set())

      // Without a project there is nowhere to copy to, so linking is the only
      // option available.
      const canCopy = Boolean(getProject())
      let mode: ImportMode = forced ?? (canCopy ? getImportMode() : 'link')

      if (mode === 'ask') {
        const choice = await askImportMode(entries)
        if (!choice) return 0
        mode = choice.mode
        if (choice.remember) setImportMode(choice.mode)
      }

      if (mode === 'copy' && canCopy) return importByCopy(entries)
      return importAssets(entries).length
    },
    [askImportMode, importByCopy],
  )

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
      { id: 'content.project', title: 'Go to Project Assets', category: 'Content', run: openAssets },
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
  }, [runImport, openAssets, goUp, refresh, disk, currentIsPinned, currentFolder, togglePinCurrent])

  // ── project + asset tree rows ─────────────────────────────────
  const assetRows = useMemo<TreeRow[]>(() => {
    const root: TreeRow = {
      id: ASSETS_ROOT,
      label: 'Assets',
      depth: 0,
      icon: 'project',
      expandable: true,
      expanded: assetsOpen,
      note: assets.length > 0 ? String(assets.length) : undefined,
      title: 'Media imported into this project',
    }
    if (!assetsOpen) return [root]

    if (assets.length === 0) {
      return [
        root,
        {
          id: '::assets-empty',
          label: 'nothing imported',
          depth: 1,
          icon: 'folder',
          expandable: false,
          expanded: false,
          placeholder: true,
          title: 'Import media to fill the project',
        },
      ]
    }

    const leaves = [...assets]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map<TreeRow>((asset) => ({
        id: asset.id,
        label: asset.name,
        depth: 1,
        // The asset's own kind, so a clip never wears a folder icon.
        icon: asset.kind,
        expandable: false,
        expanded: false,
        note: asset.missing ? 'offline' : undefined,
        title: asset.path,
      }))
    return [root, ...leaves]
  }, [assets, assetsOpen])

  const onAssetSelect = useCallback((row: TreeRow) => {
    setLocation({ type: 'project' })
    setFocusedAssetId(row.id === ASSETS_ROOT ? null : row.id)
  }, [])

  // ── path bar ──────────────────────────────────────────────────
  const crumbs = useMemo(
    () => (location.type === 'folder' ? breadcrumbsOf(location.path) : []),
    [location],
  )

  const toggleSelect = (path: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

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
            {/* The project's real folders, and the bin. Wrapped separately so
                each can be styled and addressed on its own. */}
            <div className="cb-subtree cb-subtree--folders">
              <TreeView
                rows={projectTree.rows}
                selectedId={location.type === 'folder' ? location.path : null}
                onSelect={(row) => openFolder(row.id, false)}
                onToggle={(row) => projectTree.toggle(row.id)}
                emptyNote="No project open"
              />
            </div>
            <div className="cb-subtree cb-subtree--assets">
            <TreeView
              rows={assetRows}
              selectedId={location.type === 'project' ? (focusedAssetId ?? ASSETS_ROOT) : null}
              onSelect={onAssetSelect}
              onToggle={(row) => {
                if (row.id === ASSETS_ROOT) setAssetsOpen((open) => !open)
              }}
              onDragStartRow={(row, event) => {
                // Leaves are assets, so the tree is a drag source for the
                // timeline exactly like the cards are.
                if (row.id.startsWith('::')) return
                const asset = assets.find((a) => a.id === row.id)
                if (asset && !asset.missing) setAssetDragPayload(event, [asset.id])
              }}
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

            <nav className="cb-crumbs">
              {location.type === 'project' ? (
                <>
                  <button
                    className="cb-crumb"
                    onClick={() => project && openFolder(project.root, false)}
                    title={project?.root}
                  >
                    {project?.name ?? 'Project'}
                  </button>
                  <button className="cb-crumb cb-crumb--current" onClick={openAssets}>
                    Assets
                  </button>
                </>
              ) : (
                crumbs.map((crumb, i) => (
                  <button
                    key={crumb.path}
                    className={`cb-crumb${i === crumbs.length - 1 ? ' cb-crumb--current' : ''}`}
                    onClick={() => openFolder(crumb.path)}
                    title={crumb.path}
                  >
                    {crumb.label}
                  </button>
                ))
              )}
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

          {copyProgress && <div className="cb-progress">{copyProgress}</div>}
          {copyError && (
            <div className="cb-banner cb-banner--error" onClick={() => setCopyError(null)}>
              {copyError}
            </div>
          )}

          <div className="cb-scroll">
            {location.type === 'project' ? (
              <ProjectGrid
                assets={assets}
                focusedId={focusedAssetId}
                onReveal={(path) => openFolder(path)}
              />
            ) : (
              <FolderGrid
                status={status}
                listing={listing}
                selected={selected}
                onOpenFolder={openFolder}
                onToggle={toggleSelect}
                onImportOne={(file) => void importPaths([file])}
              />
            )}
          </div>
        </div>
      </div>

      {pendingImport && (
        <ImportChoiceDialog
          count={pendingImport.entries.length}
          projectName={project?.name}
          onChoose={(choice) => {
            pendingImport.resolve(choice)
            setPendingImport(null)
          }}
          onCancel={() => {
            pendingImport.resolve(null)
            setPendingImport(null)
          }}
        />
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

function ProjectGrid({
  assets,
  focusedId,
  onReveal,
}: {
  assets: Asset[]
  focusedId: string | null
  onReveal: (path: string) => void
}) {
  // Bring a card selected from the tree into view.
  useEffect(() => {
    if (!focusedId) return
    document.querySelector(`[data-asset-id="${focusedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusedId])

  if (assets.length === 0) {
    return (
      <div className="cb-empty">
        <p>No assets yet.</p>
        <p className="cb-empty-hint">
          Browse a folder in the tree and import, or press <kbd>Ctrl K</kbd> and run{' '}
          <em>Import Media…</em>
        </p>
      </div>
    )
  }

  return (
    <div className="cb-grid">
      {assets.map((asset) => (
        <div
          key={asset.id}
          data-asset-id={asset.id}
          className={`card${asset.missing ? ' card--missing' : ''}${
            asset.id === focusedId ? ' card--selected' : ''
          }`}
          title={asset.path}
          // Only a resolvable asset is draggable — dropping a card whose file is
          // gone could only ever produce a clip that cannot play.
          draggable={!asset.missing}
          onDragStart={(e) => setAssetDragPayload(e, [asset.id])}
          onDoubleClick={() => onReveal(folderOf(asset.path))}
        >
          <AssetThumb path={asset.path} kind={asset.kind} missing={asset.missing} />
          <div className="card-meta">
            <span className="card-name">{asset.name}</span>
            <span className="card-sub">
              {asset.missing ? 'file not found' : formatBytes(asset.size)}
            </span>
          </div>
          <span className={`card-kind card-kind--${asset.kind}`}>{asset.kind}</span>
          {asset.inProject && (
            <span className="card-badge" title="Copied into the project">
              in project
            </span>
          )}
          <button
            className="card-remove"
            title="Remove from project (the file on disk is untouched)"
            onClick={(e) => {
              e.stopPropagation()
              removeAssets([asset.id])
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

function FolderGrid({
  status,
  listing,
  selected,
  onOpenFolder,
  onToggle,
  onImportOne,
}: {
  status: 'idle' | 'loading' | 'denied' | 'unreadable'
  listing: DirectoryListing | null
  selected: Set<string>
  onOpenFolder: (path: string) => void
  onToggle: (path: string) => void
  onImportOne: (file: ImportEntry) => void
}) {
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

  const empty = listing.folders.length === 0 && listing.files.length === 0

  return (
    <>
      {listing.truncated && (
        <div className="cb-banner">
          This folder is very large — showing the first part of it only.
        </div>
      )}

      {empty ? (
        <div className="cb-empty cb-empty--quiet">Nothing here that FLUX can open.</div>
      ) : (
        <div className="cb-grid">
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
            <div
              key={file.path}
              className={`card${selected.has(file.path) ? ' card--selected' : ''}`}
              title={file.path}
              onClick={() => onToggle(file.path)}
              onDoubleClick={() => void onImportOne(file)}
            >
              <AssetThumb path={file.path} kind={file.kind} />
              <div className="card-meta">
                <span className="card-name">{file.name}</span>
                <span className="card-sub">{formatBytes(file.size)}</span>
              </div>
              <span className={`card-kind card-kind--${file.kind}`}>{file.kind}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
