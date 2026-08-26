import { useCallback, useEffect, useMemo, useState } from 'react'

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
import { mediaKindOf } from '../../shared/mediaTypes.js'
import { PanelFrame } from './PanelFrame'
import { AssetThumb } from './AssetThumb'

/** Directory portion of a path, for revealing an asset's folder. */
function folderOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut > 0 ? filePath.slice(0, cut) : filePath
}

/**
 * Content Browser — browse the machine, import media into the project.
 *
 * Two locations share one grid: the Project (imported assets) and any folder on
 * disk. Import is by reference; see kernel/assets.ts for why nothing is copied.
 */

type Location = { type: 'project' } | { type: 'folder'; path: string }

export function ContentBrowserPanel() {
  const [location, setLocation] = useState<Location>({ type: 'project' })
  const [places, setPlaces] = useState<Places | null>(null)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'denied' | 'unreadable'>('idle')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assets, setAssets] = useState<Asset[]>(getAssets)

  // ── project assets ────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = subscribeAssets(() => setAssets([...getAssets()]))
    if (!isLoaded()) void loadAssets()
    else setAssets([...getAssets()])
    return unsubscribe
  }, [])

  // ── places rail ───────────────────────────────────────────────
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

  // ── directory listing ─────────────────────────────────────────
  const openFolder = useCallback((path: string) => {
    setLocation({ type: 'folder', path })
    setSelected(new Set())
  }, [])

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

  // ── commands (registered while this panel is mounted) ─────────
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
      {
        id: 'content.project',
        title: 'Go to Project',
        category: 'Content',
        run: openProject,
      },
      { id: 'content.up', title: 'Go Up One Folder', category: 'Content', run: goUp },
      { id: 'content.refresh', title: 'Refresh Folder', category: 'Content', run: refresh },
    ])
    return () => handle.dispose()
  }, [importViaDialog, openProject, goUp, refresh])

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
      <div className="cb">
        <aside className="cb-rail">
          <div className="cb-rail-group">
            <span className="cb-rail-title">Project</span>
            <button
              className={`cb-rail-item${location.type === 'project' ? ' cb-rail-item--active' : ''}`}
              onClick={openProject}
            >
              Assets
            </button>
          </div>

          {places && (
            <>
              <RailGroup
                title="Places"
                entries={places.places}
                location={location}
                onOpen={openFolder}
              />
              <RailGroup
                title="Drives"
                entries={places.drives}
                location={location}
                onOpen={openFolder}
              />
            </>
          )}
        </aside>

        <div className="cb-main">
          {location.type === 'project' ? (
            <ProjectGrid assets={assets} onReveal={openFolder} />
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

function RailGroup({
  title,
  entries,
  location,
  onOpen,
}: {
  title: string
  entries: FolderEntry[]
  location: Location
  onOpen: (path: string) => void
}) {
  if (entries.length === 0) return null
  return (
    <div className="cb-rail-group">
      <span className="cb-rail-title">{title}</span>
      {entries.map((entry) => (
        <button
          key={entry.path}
          className={`cb-rail-item${
            location.type === 'folder' && location.path === entry.path ? ' cb-rail-item--active' : ''
          }`}
          onClick={() => onOpen(entry.path)}
          title={entry.path}
        >
          {entry.name}
        </button>
      ))}
    </div>
  )
}

function ProjectGrid({
  assets,
  onReveal,
}: {
  assets: Asset[]
  onReveal: (path: string) => void
}) {
  if (assets.length === 0) {
    return (
      <div className="cb-empty">
        <p>No assets yet.</p>
        <p className="cb-empty-hint">
          Browse a folder on the left and import, or press <kbd>Ctrl K</kbd> and run{' '}
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
          className={`card${asset.missing ? ' card--missing' : ''}`}
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
          {listing.folders.map((folder) => (
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
