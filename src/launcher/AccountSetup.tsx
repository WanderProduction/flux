import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createAccount,
  describeAccountError,
  initialsOf,
  suggestedDeviceName,
  type AccountFailure,
} from '../kernel/account'
import { AVATAR } from '../kernel/pictures'
import { PicturePicker } from './PicturePicker'

/**
 * The very first screen FLUX ever shows: make an account.
 *
 * ## Why there is one at all, when nothing is online
 *
 * Because the thing after this one needs it. A workspace is going to be
 * shareable — between your own two machines first, and between people after
 * that — and sharing needs each end to be able to say who it is without a
 * company in the middle vouching for them. That is a keypair, and a keypair
 * needs somewhere to live and something to protect it. This screen is that.
 *
 * It is deliberately not a sign-up. There is no email, no verification, no
 * terms to accept and nothing leaves the machine. The screen says so, in those
 * words, because an app that opens with a password field and does not explain
 * itself has every user assuming the worst — and in this case the worst is
 * wrong.
 *
 * ## Two names
 *
 * A nickname for the person and a name for the machine, shown together as
 * `laptop · nikoflow`. The second one is not decoration: the first time
 * somebody runs FLUX on a tower as well as a laptop, the nickname is identical
 * on both and the device name is the only thing distinguishing two rows in a
 * workspace. Asking for it now, when it costs one field, is much easier than
 * asking for it later when there are two accounts that look the same.
 *
 * The machine's hostname is offered as the default, because it is already what
 * the person calls this computer.
 *
 * ## The password, and the warning that has to be on this screen
 *
 * It encrypts the identity key — see electron/identity.js — and there is no
 * recovery, because there is nobody to recover it from. That has to be said
 * here rather than in a settings page nobody opens, and it has to be said
 * precisely: what is lost is the *identity*, not the work. Every project and
 * every workspace is a folder that opens without any of this.
 */
export function AccountSetup() {
  const [nickname, setNickname] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    void suggestedDeviceName().then((name) => {
      if (name) setDeviceName((held) => held || name)
    })
  }, [])

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && confirm !== password
  const ready =
    nickname.trim().length > 0 &&
    deviceName.trim().length > 0 &&
    password.length >= 8 &&
    confirm === password &&
    !busy

  const submit = useCallback(async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const result = await createAccount({ nickname, deviceName, password, avatar })
    setBusy(false)
    if (!result.ok) setError(describeAccountError(result.reason as AccountFailure))
  }, [ready, nickname, deviceName, password, avatar])

  return (
    <div className="launcher">
      <div className="launcher-panel setup">
        <header className="launcher-head">
          <span className="brand launcher-brand">
            FLUX<span className="brand-dot">.</span>
          </span>
          <p className="launcher-tagline">Edit anywhere. Nothing leaves this machine.</p>
        </header>

        <form
          className="setup-body"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <h2 className="setup-title">Make an account</h2>
          <p className="setup-lede">
            It lives on this computer. There is no server to sign up to, no email, and nothing is
            sent anywhere — the account exists so that another machine can recognise this one
            later, when you want a workspace on both.
          </p>

          <div className="setup-identity">
            <PicturePicker
              value={avatar}
              onChange={setAvatar}
              limits={AVATAR}
              shape="circle"
              label="Avatar"
              fallback={nickname.trim() ? initialsOf(nickname) : 'You'}
            />

            <div className="setup-names">
              <label className="field">
                <span className="field-label">Nickname</span>
                <input
                  ref={nameRef}
                  className="field-input"
                  value={nickname}
                  placeholder="nikoflow"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setNickname(e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">This machine</span>
                <input
                  className="field-input"
                  value={deviceName}
                  placeholder="laptop"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </label>
            </div>
          </div>

          {(nickname.trim() || deviceName.trim()) && (
            <p className="setup-preview">
              You will appear as{' '}
              <strong>
                {deviceName.trim() || 'this machine'} · {nickname.trim() || 'you'}
              </strong>
            </p>
          )}

          <div className="setup-row">
            <label className="field">
              <span className="field-label">Password</span>
              <input
                className="field-input"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
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
          </div>

          {tooShort && <p className="setup-warn">Eight characters or more.</p>}
          {mismatch && <p className="setup-warn">Those two do not match.</p>}

          {/*
            The honest version of "there is no password reset". Said here, at
            the moment the password is chosen, rather than in a settings page
            nobody opens — and said precisely, because the thing most people
            will assume it means is the thing it does not mean.
          */}
          <p className="setup-note">
            The password encrypts this account&rsquo;s key, so there is no way to reset it and no
            way to recover it. Forgetting it costs you the <em>identity</em> — you would make a new
            account and introduce it to your other devices again. It costs you no work: every
            project and every workspace is an ordinary folder that opens without any of this.
          </p>

          <button className="primary-button" type="submit" disabled={!ready}>
            {busy ? 'Making the key…' : 'Create account'}
          </button>

          {error && <p className="launcher-error">{error}</p>}
        </form>
      </div>
    </div>
  )
}
