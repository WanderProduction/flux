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
import { loadStore, saveStore } from '../kernel/store'
import { mediaKindOf } from '../../shared/mediaTypes.js'
import { PanelFrame } from './PanelFrame'
import { AssetThumb } from './AssetThumb'
import { TreeView, useDiskTree, type TreeRow } from './FolderTree'

/** Directory portion of a path, for revealing an asset's folder. */
function folderOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut > 0 ? filePath.slice(0, cut) : filePath
}

/**
 * Content Browser — browse the machine, import media into the project.
 *
 * The rail holds two trees: the project's imported assets, and the local disks
 * with every mounted drive as its own root. They are separate on purpose. A
 * project asset is a *reference* to a file, not the file's location, so folding
 * them into one tree would suggest the project mirrors the disk — and it does
 * not. Project folders, when they arrive, will be the project's own structure
 * with no relationship to where the files actually live.
 *
 * Both trees drive the same grid.
 */

type Location = { type: 'project' } | { type: 'folder'; path: string }

const RAIL_STORE = 'ui-content-browser'
const RAIL_MIN = 140
const RAIL_MAX = 460
const RAIL_DEFAULT = 210

export function ContentBrowserPanel() {
  const [location, setLocation] = useState<Location>({ type: 'project' })
  const [places, setPlaces] = useState<Places | null>(null)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'denied' | 'unreadable'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assets, setAssets] = useState<Asset[]>(getAssets)
  const [projectOpen, setProjectOpen] = useState(true)
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null)
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT)

  // ── project assets ────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = subscribeAssets(() => setAssets([...getAssets()]))
    if (!isLoaded()) void loadAssets()
    else setAssets([...getAssets()])
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
        const next = Math.min(
          RAIL_MAX,
          Math.max(RAIL_MIN, state.startWidth + (move.clientX - state.startX)),
        )
        setRailWidth(next)
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

  // ── places + drives ───────────────────────────────────────────
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

  // ── navigation ────────────────────────────────────────────────
  const openFolder = useCallback(
    (path: string, revealInTree = true) => {
      setLocation({ type: 'folder', path })
      setSelected(new Set())
      setFocusedAssetId(null)
      // Keep the tree in step with the grid, so descending through folder cards
      // does not leave the tree pointing somewhere else entirely.
      if (revealInTree) void disk.reveal(path)
    },
    [disk],
  )

  const openProject = useCallback(() => {
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
  const importPaths = useCallback(
    (entries: Array<{ path: string; kind: MediaKind; size?: number; mtimeMs?: number }>) => {
      const added = importAssets(entries)
      setSelected(new Set())
      return added.length
    },
    [],
  )

  const importSelected = useCallback(() => {
    if (!listing) return 0
    const chosen = listing.files.filter((file) => selected.has(file.path))
    return importPaths(chosen)
  }, [listing, selected, importPaths])

  const importViaDialog = useCallback(async () => {
    if (!hasFilesystem) return
    const paths = await pickFiles()
    if (paths.length === 0) return
    // The dialog returns bare paths, so kind is re-derived here — through the
    // same shared definition main validated against, never a second regex.
    const entries = paths
      .map((path) => ({ path, kind: mediaKindOf(path) }))
      .filter((entry): entry is { path: string; kind: MediaKind } => entry.kind !== null)
    importPaths(entries)
  }, [importPaths])

  // ── project tree rows ─────────────────────────────────────────
  const projectRows = useMemo<TreeRow[]>(() => {
    const root: TreeRow = {
      id: '::project',
      label: 'Assets',
      depth: 0,
      icon: 'root',
      expandable: true,
      expanded: projectOpen,
      note: assets.length > 0 ? String(assets.length) : undefined,
      title: 'Imported project assets',
    }
    if (!projectOpen) return [root]

    if (assets.length === 0) {
      return [
        root,
        {
          id: '::project-empty',
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
        icon: asset.kind,
        expandable: false,
        expanded: false,
        note: asset.missing ? 'offline' : undefined,
        title: asset.path,
      }))
    return [root, ...leaves]
  }, [assets, projectOpen])

  const onProjectSelect = useCallback((row: TreeRow) => {
    if (row.id === '::project') {
      setLocation({ type: 'project' })
      setFocusedAssetId(null)
      return
    }
    // An asset leaf: show the project grid with that card highlighted.
    setLocation({ type: 'project' })
    setFocusedAssetId(row.id)
  }, [])

  // ── commands ──────────────────────────────────────────────────
  useEffect(() => {
    if (!hasFilesystem) return
    const handle = commands.registerAll([
      {
        id: 'content.import',
        title: 'Import Media…',
        category: 'Content',
        detail: 'Pick files to add to the project by reference',
        run: () => void importViaDialog(),
      },
      { id: 'content.project', title: 'Go to Project', category: 'Content', run: openProject },
      { id: 'content.up', title: 'Go Up One Folder', category: 'Content', run: goUp },
      { id: 'content.refresh', title: 'Refresh Folder', category: 'Content', run: refresh },
      {
        id: 'content.collapseTree',
        title: 'Collapse All Folders',
        category: 'Content',
        run: () => disk.collapseAll(),
      },
    ])
    return () => handle.dispose()
  }, [importViaDialog, openProject, goUp, refresh, disk])

  // ── rendering ─────────────────────────────────────────────────
  const crumbs = useMemo(
    () => (location.type === 'folder' ? breadcrumbsOf(location.path) : []),
    [location],
  )

  const toggle = (path: string) =>
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
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <button className="cb-btn" onClick={openProject} disabled={location.type === 'project'}>
            Project
          </button>
          <button className="cb-btn" onClick={goUp} disabled={!listing?.parent}>
            Up
          </button>
          <span className="tool-sep" />
          {location.type === 'project' ? (
            <span className="tool-value tool-value--dim">
              {assets.length} asset{assets.length === 1 ? '' : 's'}
            </span>
          ) : (
            <nav className="cb-crumbs">
              {crumbs.map((crumb) => (
                <button key={crumb.path} className="cb-crumb" onClick={() => openFolder(crumb.path)}>
                  {crumb.label}
                </button>
              ))}
            </nav>
          )}
          <span className="cb-toolbar-end">
            {selected.size > 0 && (
              <button className="cb-btn cb-btn--primary" onClick={importSelected}>
                Import {selected.size}
              </button>
            )}
            <button className="cb-btn" onClick={() => void importViaDialog()}>
              Import…
            </button>
          </span>
        </>
      }
    >
      <div className="cb" style={{ gridTemplateColumns: `${railWidth}px 4px 1fr` }}>
        <aside className="cb-rail">
          <section className="cb-tree-section">
            <h3 className="cb-rail-title">Project</h3>
            <TreeView
              rows={projectRows}
              selectedId={
                location.type === 'project' ? (focusedAssetId ?? '::project') : null
              }
              onSelect={onProjectSelect}
              onToggle={(row) => {
                if (row.id === '::project') setProjectOpen((open) => !open)
              }}
              onDragStartRow={(row, event) => {
                // Leaves are assets, so the tree is a drag source for the
                // timeline exactly like the cards are.
                if (row.id.startsWith('::')) return
                const asset = assets.find((a) => a.id === row.id)
                if (asset && !asset.missing) setAssetDragPayload(event, [asset.id])
              }}
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
        </aside>

        <div
          className="cb-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          title="Drag to resize"
        />

        <div className="cb-main">
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
              onToggle={toggle}
              onImportOne={(file) => importPaths([file])}
            />
          )}
        </div>
      </div>
    </PanelFrame>
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
    document
      .querySelector(`[data-asset-id="${focusedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
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
  onImportOne: (file: { path: string; kind: MediaKind; size: number; mtimeMs: number }) => void
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
              onDoubleClick={() => onImportOne(file)}
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
