import { useCallback, useEffect, useRef, useState } from 'react'

import { getAccount, initialsOf } from '../kernel/account'
import { AVATAR, BANNER } from '../kernel/pictures'
import {
  createWorkspace,
  defaultParent,
  describeWorkspaceError,
  knownWorkspaces,
  openWorkspace,
  rememberProject,
} from '../kernel/workspace'
import { getRecents, pickDirectory } from '../kernel/project'
import { folderIn } from '../../shared/projectNaming.js'
import { PicturePicker } from './PicturePicker'

/**
 * The second screen: make a workspace, or be invited to one.
 *
 * A workspace is where projects live together — the thing you would call "the
 * agency", "freelance", or "the documentary". It exists as a layer above the
 * project because the question "what am I working on" and the question "who
 * is this for" have different answers and different lifetimes, and because
 * the sharing that comes later is per-workspace rather than per-project.
 *
 * ## The custom folder, and why it is offered this early
 *
 * By default a workspace goes in FLUX's own data folder, which is right for
 * somebody who has not thought about it: one place, no decision. But the
 * people who *have* thought about it have a specific answer — the fast disk,
 * or the NAS the rest of the room can reach — and a workspace is not something
 * you want to move after it has twenty projects filed under it. So the choice
 * is here, as one optional line, rather than in a settings page discovered
 * afterwards.
 *
 * ## Being invited is not built, and says so
 *
 * The rule from kernel/tools.ts, which the settings pages follow too: an
 * unbuilt thing states that it is unbuilt and says what it will be. There is
 * no disabled field here and no button that does nothing — there is a
 * paragraph, and a paragraph cannot be mistaken for a feature.
 */
export function WorkspaceSetup() {
  const account = getAccount()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [parent, setParent] = useState<string>('')
  const [custom, setCustom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const existing = knownWorkspaces()

  useEffect(() => {
    titleRef.current?.focus()
    void defaultParent().then(setParent)
  }, [])

  const planned = parent && title.trim() ? folderIn(parent, title) : null

  const choose = useCallback(async () => {
    const chosen = await pickDirectory()
    if (chosen) {
      setParent(chosen)
      setCustom(true)
    }
  }, [])

  const useDefault = useCallback(async () => {
    setParent(await defaultParent())
    setCustom(false)
  }, [])

  const submit = useCallback(async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    const result = await createWorkspace(custom ? parent : null, {
      title,
      description,
      avatar,
      banner,
    })
    if (!result.ok) {
      setBusy(false)
      setError(describeWorkspaceError(result.reason))
      return
    }

    /*
     * Everything this installation has opened before, filed under the first
     * workspace it makes.
     *
     * Without this the dashboard greets somebody who has been using FLUX for
     * weeks with an empty screen and no sign of their work, which reads as
     * data loss even though every folder is exactly where they left it. The
     * recents list is the only record of what they have been working on, so it
     * is the right thing to seed from — and it only ever happens once, because
     * after this there is a workspace and new projects file themselves.
     */
    for (const recent of [...getRecents()].reverse()) {
      await rememberProject({ root: recent.root, name: recent.name, file: recent.file })
    }
    setBusy(false)
  }, [title, description, avatar, banner, custom, parent, busy])

  return (
    <div className="launcher">
      <div className="launcher-panel setup setup--wide">
        <header className="launcher-head">
          <span className="brand launcher-brand">
            FLUX<span className="brand-dot">.</span>
          </span>
          {account && (
            <p className="launcher-tagline">
              {account.avatar ? (
                <img className="who-avatar" src={account.avatar} alt="" />
              ) : (
                <span className="who-avatar who-avatar--empty">{initialsOf(account.nickname)}</span>
              )}
              {account.deviceName} · {account.nickname}
            </p>
          )}
        </header>

        <form
          className="setup-body"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <h2 className="setup-title">Make a workspace</h2>
          <p className="setup-lede">
            A workspace holds projects, and later the people you share them with. One is enough to
            start — &ldquo;Freelance&rdquo; is a perfectly good answer.
          </p>

          <div className="setup-identity">
            <PicturePicker
              value={avatar}
              onChange={setAvatar}
              limits={AVATAR}
              shape="circle"
              label="Workspace picture"
              fallback={title.trim() ? initialsOf(title) : 'Logo'}
            />
            <div className="setup-names">
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  ref={titleRef}
                  className="field-input"
                  value={title}
                  placeholder="Wander Production"
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
                  placeholder="Client work and reels"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>
          </div>

          <label className="field">
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

          <div className="setup-where">
            <span className="field-label">Folder</span>
            <p className="setup-path">
              <code>{planned ?? parent ?? '…'}</code>
            </p>
            <p className="setup-note setup-note--tight">
              {custom ? (
                <>
                  A folder you chose. Worth doing for a fast disk or a drive the rest of the room
                  can reach — the workspace is a folder like any other, so it can be backed up and
                  moved.{' '}
                  <button type="button" className="link-button" onClick={() => void useDefault()}>
                    Use the default instead
                  </button>
                </>
              ) : (
                <>
                  FLUX&rsquo;s own folder, which is the right answer unless you have a reason.{' '}
                  <button type="button" className="link-button" onClick={() => void choose()}>
                    Choose a different one…
                  </button>
                </>
              )}
            </p>
          </div>

          <button className="primary-button" type="submit" disabled={!title.trim() || busy}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>

          {error && <p className="launcher-error">{error}</p>}

          {existing.length > 0 && (
            <section className="setup-existing">
              <h3 className="setup-subtitle">Or open one you already have</h3>
              <ul className="setup-list">
                {existing.map((root) => (
                  <li key={root}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void openWorkspace(root)}
                    >
                      {root}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="setup-planned">
            <h3 className="setup-subtitle">Being invited to one</h3>
            <p className="setup-note">
              Not built yet. It will be the other way in: somebody shares a workspace, your account
              proves it is you — that is what the key made on the last screen is for — and the
              workspace appears here beside your own. Until then every workspace is one you made.
            </p>
          </section>
        </form>
      </div>
    </div>
  )
}
