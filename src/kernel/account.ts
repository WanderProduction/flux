/**
 * The local account, as the renderer sees it.
 *
 * Which is deliberately not very much. The identity lives in the main process
 * (electron/identity.js) because that is where the private key is decrypted
 * and where it stays; this module holds the public half, the loading state,
 * and the three verbs the screens need.
 *
 * ## The account is the device
 *
 * One account per installation, with two names on it: a nickname for the
 * person and a device name for the machine. Both, not one — "nikoflow" says
 * who is editing and "laptop" says where, and when the same person has FLUX on
 * a tower and a laptop the second name is the only thing that tells two
 * entries in a workspace apart. Shown together as `laptop · nikoflow`.
 *
 * ## There is no sign-in
 *
 * Making the account asks for a password because the password encrypts the
 * identity key. Opening the app later does not, because nothing on the way to
 * the dashboard needs that key — the projects are folders and the workspaces
 * are folders, and a password prompt in front of them would be guarding
 * nothing while teaching the habit of typing it without reading. The prompt
 * belongs to the first thing that actually uses the key, which is pairing a
 * second device, and that does not exist yet.
 */

export interface Account {
  id: string
  nickname: string
  deviceName: string
  avatar: string | null
  createdAt: number
  /** Base64 SPKI. The thing another device will recognise. */
  publicKey: string
  /** A short readable form of the key, for comparing out loud. */
  fingerprint: string
}

export type AccountFailure =
  | 'no-nickname'
  | 'no-device-name'
  | 'weak-password'
  | 'already-exists'
  | 'wrong-password'
  | 'no-account'
  | 'unavailable'

export interface NewAccount {
  nickname: string
  deviceName: string
  password: string
  avatar?: string | null
}

interface AccountBridge {
  read: () => Promise<Account | null>
  suggestDeviceName: () => Promise<string>
  create: (details: NewAccount) => Promise<{ ok: boolean; account?: Account; reason?: string }>
  unlock: (password: string) => Promise<{ ok: boolean; reason?: string }>
  locked: () => Promise<boolean>
  update: (patch: Partial<Pick<Account, 'nickname' | 'deviceName' | 'avatar'>>) => Promise<{
    ok: boolean
    account?: Account
    reason?: string
  }>
  changePassword: (
    oldPassword: string,
    newPassword: string,
  ) => Promise<{ ok: boolean; reason?: string }>
}

function bridge(): AccountBridge | null {
  return (globalThis as { flux?: { account?: AccountBridge } }).flux?.account ?? null
}

/** False in a plain browser, where there is no main process to hold a key. */
export const hasAccounts = (): boolean => bridge() !== null

let account: Account | null = null
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAccount(): Account | null {
  return account
}

/**
 * Whether the answer is known yet.
 *
 * The difference between "there is no account" and "we have not looked" is the
 * difference between showing the setup screen and showing nothing for a
 * moment, and getting it wrong means the setup screen flashes on every launch
 * for people who already have one.
 */
export function accountLoaded(): boolean {
  return loaded
}

export async function loadAccount(): Promise<void> {
  const api = bridge()
  if (!api) {
    loaded = true
    emit()
    return
  }
  try {
    account = await api.read()
  } catch {
    account = null
  }
  loaded = true
  emit()
}

export async function createAccount(
  details: NewAccount,
): Promise<{ ok: true } | { ok: false; reason: AccountFailure }> {
  const api = bridge()
  if (!api) return { ok: false, reason: 'unavailable' }
  const result = await api.create(details)
  if (result.ok && result.account) {
    account = result.account
    loaded = true
    emit()
    return { ok: true }
  }
  return { ok: false, reason: (result.reason as AccountFailure) ?? 'unavailable' }
}

export async function renameAccount(
  patch: Partial<Pick<Account, 'nickname' | 'deviceName' | 'avatar'>>,
): Promise<{ ok: true } | { ok: false; reason: AccountFailure }> {
  const api = bridge()
  if (!api) return { ok: false, reason: 'unavailable' }
  const result = await api.update(patch)
  if (result.ok && result.account) {
    account = result.account
    emit()
    return { ok: true }
  }
  return { ok: false, reason: (result.reason as AccountFailure) ?? 'unavailable' }
}

/** Decrypts the identity key for this session. Nothing needs it yet. */
export async function unlockAccount(
  password: string,
): Promise<{ ok: true } | { ok: false; reason: AccountFailure }> {
  const api = bridge()
  if (!api) return { ok: false, reason: 'unavailable' }
  const result = await api.unlock(password)
  return result.ok ? { ok: true } : { ok: false, reason: (result.reason as AccountFailure) ?? 'wrong-password' }
}

export async function changeAccountPassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: AccountFailure }> {
  const api = bridge()
  if (!api) return { ok: false, reason: 'unavailable' }
  const result = await api.changePassword(oldPassword, newPassword)
  return result.ok ? { ok: true } : { ok: false, reason: (result.reason as AccountFailure) ?? 'wrong-password' }
}

/** How the account is written wherever both names are wanted. */
export function suggestedDeviceName(): Promise<string> {
  return bridge()?.suggestDeviceName().catch(() => '') ?? Promise.resolve('')
}

export function describeAccount(one: Account): string {
  return `${one.deviceName} · ${one.nickname}`
}

/** Two initials for the avatar's stand-in, before anybody uploads a picture. */
export function initialsOf(nickname: string): string {
  const words = nickname.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function describeAccountError(reason: AccountFailure): string {
  switch (reason) {
    case 'no-nickname':
      return 'A nickname is needed.'
    case 'no-device-name':
      return 'Give this machine a name.'
    case 'weak-password':
      return 'The password needs at least eight characters.'
    case 'already-exists':
      return 'There is already an account on this machine.'
    case 'wrong-password':
      return 'That password does not open the key.'
    case 'no-account':
      return 'There is no account on this machine yet.'
    default:
      return 'Accounts need the desktop app.'
  }
}
