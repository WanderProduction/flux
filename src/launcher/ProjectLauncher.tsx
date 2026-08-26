import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createProject,
  describeProjectError,
  forgetRecent,
  getRecents,
  isProjectFolder,
  loadRecents,
  openProject,
  pickDirectory,
  subscribeProject,
  type ProjectError,
  type RecentProject,
} from '../kernel/project'

/**
 * The first screen: create a project, or open one.
 *
 * FLUX always lands here rather than reopening the last project silently. In an
 * app where a stray edit lands in whatever was open, "which project am I in?"
 * should never be a question you answer by looking at the timeline — the same
 * reason Premiere and Resolve both start at a chooser.
 */

const PROJECT_DIRS_BLURB = 'project_files · imports · exports'

export function ProjectLauncher() {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentProject[]>(getRecents)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Set when the chosen folder already holds a project — offer to open it. */
  const [occupied, setOccupied] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const unsubscribe = subscribeProject(() => setRecents([...getRecents()]))
    void loadRecents()
    nameRef.current?.focus()
    return unsubscribe
  }, [])

  const fail = (err: ProjectError) => setError(describeProjectError(err))

  const chooseDirectory = useCallback(async () => {
    setError(null)
    const chosen = await pickDirectory()
    if (!chosen) return
    setDirectory(chosen)
    // Check straight away rather than on submit: telling someone the folder is
    // taken *after* they hit Create wastes the trip.
    setOccupied(await isProjectFolder(chosen))
  }, [])

  const create = useCallback(async () => {
    if (!directory || busy) return
    setBusy(true)
    setError(null)
    const result = await createProject(directory, name)
    setBusy(false)
    if (!result.ok) fail(result.error)
  }, [directory, name, busy])

  const open = useCallback(
    async (root: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      const result = await openProject(root)
      setBusy(false)
      if (!result.ok) fail(result.error)
    },
    [busy],
  )

  const browseAndOpen = useCallback(async () => {
    const chosen = await pickDirectory()
    if (chosen) await open(chosen)
  }, [open])

  const canCreate = Boolean(directory) && !occupied && !busy

  return (
    <div className="launcher">
      <div className="launcher-panel">
        <header className="launcher-head">
          <span className="brand launcher-brand">
            FLUX<span className="brand-dot">.</span>
          </span>
          <p className="launcher-tagline">A keyboard-driven media engine</p>
        </header>

        <div className="launcher-body">
          <section className="launcher-col">
            <h2 className="launcher-title">New project</h2>

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
              <button className="field-input field-input--button" onClick={() => void chooseDirectory()}>
                {directory ?? <span className="field-placeholder">Choose a folder…</span>}
              </button>
            </label>

            {directory && !occupied && (
              <p className="launcher-note">
                FLUX will create <code>{PROJECT_DIRS_BLURB}</code> here.
              </p>
            )}

            {occupied && (
              <p className="launcher-warn">
                There is already a project in that folder.{' '}
                <button className="link-button" onClick={() => void open(directory!)}>
                  Open it instead
                </button>
              </p>
            )}

            <button className="primary-button" disabled={!canCreate} onClick={() => void create()}>
              {busy ? 'Working…' : 'Create project'}
            </button>

            <button className="ghost-button" onClick={() => void browseAndOpen()}>
              Open an existing project…
            </button>

            {error && <p className="launcher-error">{error}</p>}
          </section>

          <section className="launcher-col launcher-col--recents">
            <h2 className="launcher-title">Recent</h2>
            {recents.length === 0 ? (
              <p className="launcher-empty">Nothing yet.</p>
            ) : (
              <ul className="recent-list">
                {recents.map((recent) => (
                  <li key={recent.root} className={recent.missing ? 'recent recent--missing' : 'recent'}>
                    <button
                      className="recent-open"
                      disabled={recent.missing || busy}
                      onClick={() => void open(recent.root)}
                      title={recent.root}
                    >
                      <span className="recent-name">{recent.name}</span>
                      <span className="recent-path">{recent.root}</span>
                      {recent.missing && <span className="recent-tag">folder missing</span>}
                    </button>
                    <button
                      className="recent-forget"
                      title="Remove from this list (the folder is untouched)"
                      onClick={() => forgetRecent(recent.root)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
