import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getAccount, initialsOf } from '../kernel/account'
import {
  createProject,
  describeProjectError,
  isProjectFolder,
  launchTarget,
  openProject,
  pickDirectory,
  pickProjectFile,
  type ProjectError,
} from '../kernel/project'
import {
  closeWorkspace,
  forgetProject,
  getWorkspace,
  knownWorkspaces,
  openWorkspace,
  refreshWorkspace,
  subscribeWorkspace,
  type WorkspaceProject,
} from '../kernel/workspace'
import { UpdateBadge } from '../shell/UpdateBadge'
import { folderIn } from '../../shared/projectNaming.js'

/**
 * The workspace dashboard: every project in this workspace, as a card.
 *
 * This replaces the old project launcher, and the difference is what the
 * screen is *about*. The launcher was a form with a list of recents beside it:
 * the primary thing was "make a project" and your existing work was a sidebar.
 * Opening FLUX is almost never "make a new project" — it is "carry on with the
 * one from yesterday" — so the work is the screen, and creating is a card at
 * the front of it.
 *
 * ## Cards, and what has to be on one
 *
 * The name, large enough to read at a glance, and the path small enough not to
 * compete with it. A project whose folder is not there says so on the card and
 * cannot be clicked, because the usual cause is an unplugged drive and the
 * right response is to plug it in — not to be dropped into an error.
 *
 * ## The list is the workspace's, not a recents list
 *
 * A recents list is a record of what this installation has touched. A
 * workspace's project list is a fact about the workspace, kept in its folder,
 * and the same on any machine that opens it. That is the whole point of the
 * layer: when a workspace is shared, the projects come with it.
 */
export function WorkspaceDashboard() {
  const [, bump] = useState(0)
  useEffect(() => subscribeWorkspace(() => bump((n) => n + 1)), [])

  const workspace = getWorkspace()
  const account = getAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    // Re-read on mount: a project may have been created or opened since this
    // screen was last on, and the manifest on disk is the truth.
    void refreshWorkspace()

    // Launched by double-clicking a .flux document — open it rather than
    // making somebody find it again in a grid.
    void launchTarget().then((target) => {
      if (target) void openProject(target)
    })
  }, [])

  const open = useCallback(
    async (root: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      const result = await openProject(root)
      setBusy(false)
      if (!result.ok) setError(describeProjectError(result.error))
    },
    [busy],
  )

  const browse = useCallback(async () => {
    const chosen = await pickProjectFile()
    if (chosen) await open(chosen)
  }, [open])

  if (!workspace) return null

  const projects = workspace.projects
  const others = knownWorkspaces().filter((root) => root !== workspace.root)

  return (
    <div className="dash">
      {workspace.banner && (
        <div className="dash-banner" style={{ backgroundImage: `url(${workspace.banner})` }} />
      )}

      <header className={`dash-head${workspace.banner ? ' dash-head--over' : ''}`}>
        <div className="dash-identity">
          {workspace.avatar ? (
            <img className="dash-avatar" src={workspace.avatar} alt="" />
          ) : (
            <span className="dash-avatar dash-avatar--empty">{initialsOf(workspace.title)}</span>
          )}
          <div className="dash-titles">
            <h1 className="dash-title">{workspace.title}</h1>
            {workspace.description && <p className="dash-desc">{workspace.description}</p>}
          </div>
        </div>

        <div className="dash-who">
          {account && (
            <span className="who" title={`Key ${account.fingerprint}`}>
              {account.avatar ? (
                <img className="who-avatar" src={account.avatar} alt="" />
              ) : (
                <span className="who-avatar who-avatar--empty">
                  {initialsOf(account.nickname)}
                </span>
              )}
              <span className="who-name">
                {account.deviceName} · {account.nickname}
              </span>
            </span>
          )}
          {/*
            Switching away is a plain link rather than a menu: there is one
            workspace for almost everybody, and a chooser for a list of one is
            furniture. It appears only when there is somewhere to go.
          */}
          {others.length > 0 && (
            <select
              className="dash-switch"
              value={workspace.root}
              onChange={(e) => void openWorkspace(e.target.value)}
              aria-label="Switch workspace"
            >
              <option value={workspace.root}>{workspace.title}</option>
              {others.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          )}
          <button className="link-button" onClick={closeWorkspace}>
            New workspace
          </button>
        </div>
      </header>

      <main className="dash-body">
        <div className="dash-bar">
          <h2 className="dash-section">
            Projects
            <span className="dash-count">{projects.length}</span>
          </h2>
          <button className="ghost-button" onClick={() => void browse()}>
            Open a .flux project…
          </button>
        </div>

        <ul className="cards">
          <li className="card card--new">
            <button className="card-new" onClick={() => setCreating(true)}>
              <span className="card-plus">+</span>
              <span className="card-name">New project</span>
            </button>
          </li>

          {projects.map((project) => (
            <ProjectCard
              key={project.root}
              project={project}
              busy={busy}
              onOpen={() => void open(project.root)}
              onForget={() => void forgetProject(project.root)}
            />
          ))}
        </ul>

        {projects.length === 0 && (
          <p className="dash-empty">
            Nothing in this workspace yet. A project made here is filed under it automatically.
          </p>
        )}

        {error && <p className="launcher-error">{error}</p>}
      </main>

      <footer className="dash-foot">
        <UpdateBadge />
      </footer>

      {creating && <NewProject onDone={() => setCreating(false)} />}
    </div>
  )
}

function ProjectCard({
  project,
  busy,
  onOpen,
  onForget,
}: {
  project: WorkspaceProject
  busy: boolean
  onOpen: () => void
  onForget: () => void
}) {
  const when = project.openedAt ?? project.addedAt
  return (
    <li className={`card${project.missing ? ' card--missing' : ''}`}>
      <button className="card-open" disabled={project.missing || busy} onClick={onOpen} title={project.root}>
        <span className="card-name">{project.name}</span>
        <span className="card-path">{project.root}</span>
        <span className="card-when">
          {project.missing ? 'folder not found' : when ? agoOf(when) : ''}
        </span>
      </button>
      {/*
        "Remove" on a project card reads as "delete my work" to anybody who has
        not thought about it, so the title says what it actually does. Being
        wrong about that once is unforgivable.
      */}
      <button
        className="card-forget"
        title="Take it off this dashboard. The folder is not touched."
        onClick={onForget}
      >
        ×
      </button>
    </li>
  )
}

/**
 * Making a project, in a sheet over the dashboard.
 *
 * It is the old launcher's left-hand column, unchanged in behaviour: a name, a
 * folder, and the path it is about to create shown before it creates it. The
 * check for an occupied folder re-runs as the name is typed, because telling
 * somebody the name is taken after they press Create wastes the trip.
 */
function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState<string | null>(null)
  const [occupied, setOccupied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => nameRef.current?.focus(), [])

  const planned = useMemo(
    () => (directory && name.trim() ? folderIn(directory, name) : null),
    [directory, name],
  )

  useEffect(() => {
    if (!planned) {
      setOccupied(false)
      return
    }
    let cancelled = false
    void isProjectFolder(planned).then((taken) => {
      if (!cancelled) setOccupied(taken)
    })
    return () => {
      cancelled = true
    }
  }, [planned])

  const fail = (err: ProjectError) => setError(describeProjectError(err))

  const create = useCallback(async () => {
    if (!directory || busy) return
    setBusy(true)
    setError(null)
    const result = await createProject(directory, name)
    setBusy(false)
    if (!result.ok) fail(result.error)
  }, [directory, name, busy])

  const openInstead = useCallback(async () => {
    if (!planned) return
    const result = await openProject(planned)
    if (!result.ok) fail(result.error)
  }, [planned])

  const canCreate = Boolean(directory) && Boolean(name.trim()) && !occupied && !busy

  return (
    <div className="sheet" role="dialog" aria-label="New project">
      <div className="sheet-panel">
        <h2 className="sheet-title">New project</h2>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            ref={nameRef}
            className="field-input"
            value={name}
            placeholder="Untitled"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) void create()
            }}
          />
        </label>

        <label className="field">
          <span className="field-label">Folder</span>
          <button
            className="field-input field-input--button"
            onClick={() => void pickDirectory().then((d) => d && setDirectory(d))}
          >
            {directory ?? <span className="field-placeholder">Choose a folder…</span>}
          </button>
        </label>

        {planned && !occupied && (
          <p className="launcher-note">
            Creates <code>{planned}</code>
            <br />
            holding <code>project_files</code>, <code>imports</code> and <code>exports</code>.
          </p>
        )}

        {occupied && planned && (
          <p className="launcher-warn">
            There is already a project at <code>{planned}</code>.{' '}
            <button className="link-button" onClick={() => void openInstead()}>
              Open it instead
            </button>
          </p>
        )}

        <div className="sheet-actions">
          <button className="ghost-button" onClick={onDone}>
            Cancel
          </button>
          <button className="primary-button" disabled={!canCreate} onClick={() => void create()}>
            {busy ? 'Working…' : 'Create project'}
          </button>
        </div>

        {error && <p className="launcher-error">{error}</p>}
      </div>
    </div>
  )
}

/** Roughest useful form. A card wants "yesterday", not a timestamp. */
function agoOf(stamp: number): string {
  const hours = (Date.now() - stamp) / 3_600_000
  if (hours < 1) return 'just now'
  if (hours < 20) return `${Math.round(hours)}h ago`
  const days = hours / 24
  if (days < 2) return 'yesterday'
  if (days < 30) return `${Math.round(days)} days ago`
  const months = days / 30
  return months < 18 ? `${Math.round(months)} months ago` : `${Math.round(months / 12)} years ago`
}
