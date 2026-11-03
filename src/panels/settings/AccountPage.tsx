import { useCallback, useEffect, useState } from 'react'

import {
  changeAccountPassword,
  describeAccountError,
  getAccount,
  initialsOf,
  renameAccount,
  subscribeAccount,
  type Account,
} from '../../kernel/account'
import { AVATAR } from '../../kernel/pictures'
import { PicturePicker } from '../../launcher/PicturePicker'

/**
 * Account — the names, the picture, the password, and the key.
 *
 * All of this existed underneath before this page did: `updateAccount` and
 * `changePassword` were written and covered by the suite, and nothing called
 * them. Which meant a typo in a nickname was permanent, and that is the kind
 * of gap that makes an app feel like a prototype — not because the feature is
 * hard, but because being unable to fix a typo tells you nobody has used it.
 *
 * ## Saving, and why the names are not live-bound
 *
 * The Appearance page writes on every click because a theme is its own
 * preview. A nickname is not: it is a value with an invalid state halfway
 * through typing, and saving on every keystroke would write "n", "ni", "nik"
 * to disk and show each of them to every workspace this account is in. So the
 * fields are a draft and Save commits them, with the button disabled until
 * something has actually changed.
 *
 * ## The key is shown, and it is the point
 *
 * The fingerprint is the only part of the identity a person can meaningfully
 * handle: it is what you read down a phone line when two devices claim to be
 * the same account. It is on the page for the day that matters, which is the
 * day a second device appears — not useful today, and unreasonably hard to
 * find later if it were not here.
 *
 * ## Changing the password re-encrypts; it does not re-key
 *
 * Said on the page as well as in the code, because it is the question anybody
 * careful will ask: does changing my password make my other devices stop
 * recognising me? It does not. The keypair is re-encrypted under the new
 * password and the identity is untouched.
 */
export function AccountPage() {
  const [, bump] = useState(0)
  useEffect(() => subscribeAccount(() => bump((n) => n + 1)), [])

  const account = getAccount()
  if (!account) {
    return (
      <div className="ac">
        <p className="hk-note">
          There is no account on this machine. One is made on first launch, before any workspace
          exists.
        </p>
      </div>
    )
  }

  return (
    <div className="ac">
      <Identity account={account} />
      <Password />
      <Key account={account} />

      <section className="ap-row">
        <h3 className="hk-group-head">What opens on launch</h3>
        <p className="ap-note">
          Not built. FLUX always lands on the dashboard, and a project is opened by clicking it.
          The setting worth having is &ldquo;reopen what I was last editing&rdquo;, and it has to
          wait for a decision this page cannot make alone: whether an unsaved project should
          reopen with its changes, or whether reopening one that was left dirty is how you lose
          work without touching anything.
        </p>
      </section>
    </div>
  )
}

function Identity({ account }: { account: Account }) {
  const [nickname, setNickname] = useState(account.nickname)
  const [deviceName, setDeviceName] = useState(account.deviceName)
  const [avatar, setAvatar] = useState(account.avatar)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Reset the draft whenever the stored account changes under it, so a save
  // elsewhere does not leave this form showing a value nothing holds.
  useEffect(() => {
    setNickname(account.nickname)
    setDeviceName(account.deviceName)
    setAvatar(account.avatar)
  }, [account.nickname, account.deviceName, account.avatar])

  const changed =
    nickname !== account.nickname ||
    deviceName !== account.deviceName ||
    avatar !== account.avatar
  const valid = nickname.trim().length > 0 && deviceName.trim().length > 0

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    const result = await renameAccount({ nickname, deviceName, avatar })
    setBusy(false)
    if (result.ok) {
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } else {
      setError(describeAccountError(result.reason))
    }
  }, [nickname, deviceName, avatar])

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">You, on this machine</h3>
      <p className="ap-note">
        Two names on purpose. The nickname is you; the device name is this computer, and it is
        what tells a tower and a laptop apart in a workspace where both are signed in under the
        same nickname.
      </p>

      <div className="ac-identity">
        <PicturePicker
          value={avatar}
          onChange={setAvatar}
          limits={AVATAR}
          shape="circle"
          label="Avatar"
          fallback={initialsOf(nickname || account.nickname)}
        />

        <div className="ac-fields">
          <label className="field">
            <span className="field-label">Nickname</span>
            <input
              className="field-input"
              value={nickname}
              spellCheck={false}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">This machine</span>
            <input
              className="field-input"
              value={deviceName}
              spellCheck={false}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </label>
        </div>
      </div>

      <p className="ac-preview">
        Shown as{' '}
        <strong>
          {deviceName.trim() || account.deviceName} · {nickname.trim() || account.nickname}
        </strong>
      </p>

      <div className="ac-actions">
        <button className="hk-btn" disabled={!changed || !valid || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {changed && (
          <button
            className="hk-btn"
            onClick={() => {
              setNickname(account.nickname)
              setDeviceName(account.deviceName)
              setAvatar(account.avatar)
              setError(null)
            }}
          >
            Discard
          </button>
        )}
        {saved && <span className="ac-ok">Saved.</span>}
        {error && <span className="ac-error">{error}</span>}
      </div>
    </section>
  )
}

function Password() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const tooShort = next.length > 0 && next.length < 8
  const mismatch = confirm.length > 0 && confirm !== next
  const ready = current.length > 0 && next.length >= 8 && confirm === next && !busy

  const submit = useCallback(async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const result = await changeAccountPassword(current, next)
    setBusy(false)
    if (result.ok) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
      window.setTimeout(() => setDone(false), 3000)
    } else {
      setError(describeAccountError(result.reason))
    }
  }, [ready, current, next])

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">Password</h3>
      <p className="ap-note">
        It encrypts the identity key below and nothing else — the projects are ordinary folders
        and open without it. Changing it <em>re-encrypts</em> the same key rather than making a
        new one, so every device that already recognises this account still does. There is still
        no way to recover a forgotten one.
      </p>

      <form
        className="ac-password"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="field">
          <span className="field-label">Current</span>
          <input
            className="field-input"
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">New</span>
          <input
            className="field-input"
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Again</span>
          <input
            className="field-input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
      </form>

      <div className="ac-actions">
        <button className="hk-btn" disabled={!ready} onClick={() => void submit()}>
          {busy ? 'Re-encrypting…' : 'Change password'}
        </button>
        {tooShort && <span className="ac-error">Eight characters or more.</span>}
        {!tooShort && mismatch && <span className="ac-error">Those two do not match.</span>}
        {done && <span className="ac-ok">Changed. The key is unchanged.</span>}
        {error && <span className="ac-error">{error}</span>}
      </div>
    </section>
  )
}

function Key({ account }: { account: Account }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(account.fingerprint)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [account.fingerprint])

  return (
    <section className="ap-row">
      <h3 className="hk-group-head">This account&rsquo;s key</h3>
      <p className="ap-note">
        An Ed25519 keypair made when the account was. The fingerprint is the short form — what
        you read out loud to check that a device claiming to be this account really is it. The
        day that matters is the day a second device appears; it is here now because it would be
        unreasonably hard to find later.
      </p>

      <div className="ac-key">
        <code className="ac-fingerprint">{account.fingerprint}</code>
        <button className="hk-btn hk-btn--small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <p className="hk-note ac-born">
        Made {new Date(account.createdAt).toLocaleDateString()}. The private half is encrypted on
        this machine and never leaves it — not to a server, and not even to this window.
      </p>
    </section>
  )
}
