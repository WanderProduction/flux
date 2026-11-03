import { useCallback, useEffect, useState } from 'react'

import { initialsOf } from '../../kernel/account'
import { AVATAR, BANNER, dataUrlBytes } from '../../kernel/pictures'
import { formatBytes } from '../../kernel/fsBridge'
import { revealFolder } from '../../kernel/renderBridge'
import {
  describeWorkspaceError,
  editWorkspace,
  forgetProject,
  getWorkspace,
  knownWorkspaces,
  openWorkspace,
  refreshWorkspace,
  subscribeWorkspace,
  type Workspace,
} from '../../kernel/workspace'
import { PicturePicker } from '../../launcher/PicturePicker'

/**
 * Workspace — its name, its pictures, where it is, and what is in it.
 *
 * The dashboard is where a workspace is *used*; this is where it is changed.
 * Keeping them apart is deliberate — a dashboard with edit affordances on
 * every field is a dashboard you are afraid to click on, and the thing people
 * do a hundred times a day there is open a project, not rename the company.
 *
 * ## The folder is shown and cannot be changed
 *
 * Moving a workspace means moving a directory and rewriting every path that
 * points into it, and getting that half-right loses track of projects. So the
 * page shows where it is, opens it, and says plainly that moving is not built
 * — which is the rule the rest of these pages follow. The folder is also the
 * answer to "where did my workspace go", which is the question this section
 * actually gets asked.
 *
 * ## Projects are listed here as well as on the dashboard
 *
 * Not a duplicate: the dashboard answers "which one am I opening" and this
 * answers "what is in here, and where does each one live". The paths are
 * shown in full because that is the question, and the only action is to take
 * one off the list — which says, in the button's own words, that the folder is
 * not touched.
 */
export function WorkspacePage() {
  const [, bump] = useState(0)
  useEffect(() => subscribeWorkspace(() => bump((n) => n + 1)), [])
  useEffect(() => {
    void refreshWorkspace()
  }, [])

  const workspace = getWorkspace()
  if (!workspace) {
    return (
      <div className="ac">
        <p className="hk-note">
          No workspace is open. One is made on the screen in front of the editor.
        </p>
      </div>
    )
  }

  return (
    <div className="ac">
      <Details workspace={workspace} />
      <Where workspace={workspace} />
      <Projects workspace={workspace} />
    </div>
  )
}

function Details({ workspace }: { workspace: Workspace }) {
  const [title, setTitle] = useState(workspace.title)
  const [description, setDescription] = useState(workspace.description)
  const [avatar, setAvatar] = useState(workspace.avatar)
  const [banner, setBanner] = useState(workspace.banner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setTitle(workspace.title)
    setDescription(workspace.description)
    setAvatar(workspace.avatar)
    setBanner(workspace.banner)
  }, [workspace.title, workspace.description, workspace.avatar, workspace.banner])

  const changed =
    title !== workspace.title ||
    description !== workspace.description ||
    avatar !== workspace.avatar ||
    banner !== workspace.banner

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    const result = await editWorkspace({ title, description, avatar, banner })
    setBusy(false)
    if (result.ok) {
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } else {
      setError(describeWorkspaceError(result.reason))
    }
  }, [title, description, avatar, banner])

  /*
   * The pictures are stored inside workspace.json, so their size is the size
   * of the file every open reads. Worth showing: it is the one number that
   * explains why a banner is re-encoded rather than kept, and it turns an
   * invisible cost into a visible one.
   */
  const pictureBytes = dataUrlBytes(avatar) + dataUrlBytes(banner)

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">Name and marks</h3>
      <p className="ap-note">
        The pictures live inside the workspace&rsquo;s own manifest rather than beside it, so a
        workspace copied to another drive arrives complete. Every image chosen here is cropped to
        fill and re-encoded at the size it is drawn — a phone photograph goes in at megabytes and
        lands at tens of kilobytes.
      </p>

      <div className="ac-identity">
        <PicturePicker
          value={avatar}
          onChange={setAvatar}
          limits={AVATAR}
          shape="circle"
          label="Workspace picture"
          fallback={initialsOf(title || workspace.title)}
        />
        <div className="ac-fields">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">
              Description <span className="field-aside">optional</span>
            </span>
            <input
              className="field-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
      </div>

      <label className="field ac-banner">
        <span className="field-label">
          Banner <span className="field-aside">optional</span>
        </span>
        <PicturePicker
          value={banner}
          onChange={setBanner}
          limits={BANNER}
          shape="banner"
          label="Banner"
          fallback="Drop a wide image"
        />
      </label>

      <div className="ac-actions">
        <button
          className="hk-btn"
          disabled={!changed || !title.trim() || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {changed && (
          <button
            className="hk-btn"
            onClick={() => {
              setTitle(workspace.title)
              setDescription(workspace.description)
              setAvatar(workspace.avatar)
              setBanner(workspace.banner)
              setError(null)
            }}
          >
            Discard
          </button>
        )}
        {pictureBytes > 0 && (
          <span className="hk-note ac-aside">{formatBytes(pictureBytes)} of pictures</span>
        )}
        {saved && <span className="ac-ok">Saved.</span>}
        {error && <span className="ac-error">{error}</span>}
      </div>
    </section>
  )
}

function Where({ workspace }: { workspace: Workspace }) {
  const others = knownWorkspaces().filter((root) => root !== workspace.root)

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">Where it is</h3>
      <p className="ap-note">
        A folder with a <code>workspace.json</code> in it, like a project. Copy it to another
        drive and it arrives whole; back it up with anything that backs up files.
      </p>

      <div className="ac-key">
        <code className="ac-path">{workspace.root}</code>
        <button className="hk-btn hk-btn--small" onClick={() => void revealFolder(workspace.root)}>
          Open the folder
        </button>
      </div>

      <p className="hk-note ac-born">
        Made {new Date(workspace.createdAt).toLocaleDateString()}. <strong>Moving it is not
        built</strong> — that means moving the directory and rewriting every path that points
        into it, and a half-finished version of that loses track of projects. Today the folder is
        chosen once, when the workspace is made.
      </p>

      {others.length > 0 && (
        <>
          <p className="ap-note ac-others-head">
            Other workspaces this machine knows about. Switching changes what the dashboard shows
            and nothing else.
          </p>
          <ul className="ac-others">
            {others.map((root) => (
              <li key={root}>
                <button className="hk-btn hk-btn--small" onClick={() => void openWorkspace(root)}>
                  Open
                </button>
                <code className="ac-path">{root}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Projects({ workspace }: { workspace: Workspace }) {
  const [armed, setArmed] = useState<string | null>(null)
  const projects = workspace.projects

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">
        Projects
        <span className="ac-count">{projects.length}</span>
      </h3>
      <p className="ap-note">
        Where each one actually lives. Projects are mostly not inside the workspace folder —
        they are wherever you put them — so the list keeps the path, and a project on a drive
        that is not plugged in is marked rather than quietly dropped.
      </p>

      {projects.length === 0 ? (
        <p className="hk-note">Nothing filed here yet.</p>
      ) : (
        <ul className="ac-projects">
          {projects.map((project) => (
            <li key={project.root} className={project.missing ? 'ac-project ac-project--missing' : 'ac-project'}>
              <div className="ac-project-main">
                <span className="ac-project-name">{project.name}</span>
                <code className="ac-path">{project.root}</code>
              </div>
              {project.missing && <span className="ac-project-tag">drive not found</span>}
              {armed === project.root ? (
                <>
                  <button
                    className="hk-btn hk-btn--small hk-btn--warn"
                    onClick={() => {
                      setArmed(null)
                      void forgetProject(project.root)
                    }}
                  >
                    Remove from the list
                  </button>
                  <button className="hk-btn hk-btn--small" onClick={() => setArmed(null)}>
                    Keep
                  </button>
                </>
              ) : (
                /*
                 * Two clicks, and the second one spells out what it does. On a
                 * row labelled with somebody's work, "Remove" reads as "delete
                 * my footage" — and being wrong about that once is
                 * unforgivable, so the button says which thing it means rather
                 * than relying on a tooltip nobody hovers.
                 */
                <button className="hk-btn hk-btn--small" onClick={() => setArmed(project.root)}>
                  Remove…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="hk-note ac-born">
        Removing takes a project off this list and off the dashboard. The folder, the media and
        the <code>.flux</code> document are not touched — open it again from the dashboard and it
        comes back.
      </p>

      <p className="ap-note ac-others-head">
        <strong>Ordering and archiving are not built.</strong> The list is most-recently-opened
        first, which is the right default and the wrong answer for somebody with forty projects
        and six they care about.
      </p>
    </section>
  )
}
