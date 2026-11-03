import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The account: who this installation is, and the key that will prove it.
 *
 * FLUX's account is local. Nothing here is sent anywhere, there is no server
 * to register with, and there is no account recovery — because there is nobody
 * to recover it from. What it is *for* is the thing that comes next: an
 * identity another device can recognise, so a workspace can be shared between
 * two machines without either of them trusting a company in the middle.
 *
 * ## The password encrypts something, or it is theatre
 *
 * A local password that only gates a screen protects nothing: the projects are
 * plain folders on the same disk and anyone sitting at the machine can open
 * them with Explorer. So the password does real work — it derives a key that
 * encrypts the account's **private key**, and that private key is the only
 * thing that can prove this account is this account.
 *
 * The consequences are honest ones and the UI says them out loud. Forgetting
 * the password loses the identity: the keypair cannot be recovered, and the
 * account would have to be made again and re-introduced to every device that
 * knew it. It loses *nothing else* — every project is a folder, every
 * workspace is a folder, and both open fine without any of this.
 *
 * ## Why scrypt and not a hash
 *
 * Because the output is a key, not a comparison. A password hash would let us
 * answer "is this the right password" and nothing more; scrypt gives 32 bytes
 * to encrypt with, and the AES-GCM tag answers the first question as a side
 * effect — a wrong password produces a key that fails authentication, which is
 * a stronger check than comparing a hash because it cannot be skipped by
 * anyone editing the JSON.
 *
 * Parameters are stored with the record rather than hardcoded at the read
 * site. An account written today must still open after the cost is raised for
 * accounts written tomorrow.
 *
 * ## Ed25519
 *
 * Small keys, no parameter choices to get wrong, and signing is the only
 * operation this will ever need: a device proves it holds the key, it never
 * encrypts to it. Node has it built in, so there is no dependency.
 *
 * ## No electron import
 *
 * Same rule as electron/project.js and electron/mediaCache.js: the directory
 * is passed in, so all of this runs against a temp directory from a plain Node
 * script with no app. See scripts/verify-account.mjs.
 */

const FILE = 'account.json'
const RECORD_VERSION = 1

/**
 * scrypt cost. N=2^17 is about 130ms on a current desktop and 128MB of memory.
 *
 * Deliberately slow, and deliberately memory-hard: the threat here is somebody
 * with the file trying passwords offline, and the only defence against that is
 * making each attempt expensive. 130ms is unnoticeable when it happens once,
 * at a moment the user is already waiting for something.
 *
 * `maxmem` has to be raised with N or Node refuses the call — the default is
 * 32MB, which N=2^17 exceeds, and the error it throws says nothing useful
 * about why.
 */
const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32 }
const MAXMEM = 256 * 1024 * 1024

const accountPath = (dir) => path.join(dir, FILE)

/** @param {string} password @param {Buffer} salt @param {{N:number,r:number,p:number,keylen:number}} params */
function deriveKey(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

/**
 * A short, readable form of the public key.
 *
 * What a person compares out loud when two devices claim to be the same
 * account. Eight bytes in four groups: long enough that matching one by
 * accident does not happen, short enough to read down a phone line.
 */
export function fingerprintOf(publicKeyBase64) {
  const digest = crypto.createHash('sha256').update(publicKeyBase64).digest('hex')
  return digest.slice(0, 16).replace(/(.{4})(?=.)/g, '$1-').toUpperCase()
}

/** Everything about an account except the part that must stay secret. */
function publicPart(record) {
  return {
    id: record.id,
    nickname: record.nickname,
    deviceName: record.deviceName,
    avatar: record.avatar ?? null,
    createdAt: record.createdAt,
    publicKey: record.publicKey,
    fingerprint: fingerprintOf(record.publicKey),
  }
}

/**
 * Reads the account, without the secret.
 *
 * The encrypted private key never crosses to the renderer — not because the
 * renderer is untrusted, but because there is no reason for it to hold
 * ciphertext it cannot use and could accidentally log.
 *
 * @returns {Promise<object | null>} null when there is no account yet, which
 *   is the first-run state rather than an error.
 */
export async function readAccount(dir) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(accountPath(dir), 'utf8'))
  } catch {
    return null
  }
  if (!raw || raw.version !== RECORD_VERSION || !raw.id || !raw.publicKey) return null
  return publicPart(raw)
}

/**
 * Makes the account, once.
 *
 * Refused if one already exists. Replacing an identity is not a thing that
 * should happen by accident — the keypair is what other devices recognise,
 * and quietly minting a new one would make this machine a stranger to all of
 * them with no indication that anything had changed.
 *
 * @returns {Promise<{ ok: true, account: object } | { ok: false, reason: string }>}
 */
export async function createAccount(dir, { nickname, deviceName, password, avatar } = {}) {
  const name = String(nickname ?? '').trim()
  const device = String(deviceName ?? '').trim()
  if (!name) return { ok: false, reason: 'no-nickname' }
  if (!device) return { ok: false, reason: 'no-device-name' }
  if (typeof password !== 'string' || password.length < 8) return { ok: false, reason: 'weak-password' }
  if (await readAccount(dir)) return { ok: false, reason: 'already-exists' }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const secretBytes = privateKey.export({ type: 'pkcs8', format: 'der' })

  const salt = crypto.randomBytes(16)
  const key = await deriveKey(password, salt, KDF)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(secretBytes), cipher.final()])

  const record = {
    version: RECORD_VERSION,
    id: crypto.randomBytes(16).toString('hex'),
    nickname: name,
    deviceName: device,
    avatar: avatar ?? null,
    createdAt: Date.now(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    secret: {
      kdf: 'scrypt',
      ...KDF,
      salt: salt.toString('base64'),
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    },
  }

  await fs.mkdir(dir, { recursive: true })
  // Written aside and renamed, for the reason mediaCache gives: a record torn
  // in half by a crash would be rejected on read, and rejected on read means
  // "there is no account" — which would offer to make a second one over the
  // top of a keypair that still exists.
  const target = accountPath(dir)
  const temp = `${target}.tmp-${process.pid}`
  await fs.writeFile(temp, JSON.stringify(record, null, 2), 'utf8')
  await fs.rename(temp, target)

  return { ok: true, account: publicPart(record) }
}

/**
 * The decrypted private key, or a reason it could not be had.
 *
 * The GCM tag is the password check. There is no separate comparison to get
 * wrong and nothing to compare against: either the derived key authenticates
 * the ciphertext or it does not.
 *
 * @returns {Promise<{ ok: true, privateKey: crypto.KeyObject } | { ok: false, reason: string }>}
 */
export async function unlockAccount(dir, password) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(accountPath(dir), 'utf8'))
  } catch {
    return { ok: false, reason: 'no-account' }
  }
  if (!raw?.secret) return { ok: false, reason: 'no-account' }

  const { secret } = raw
  try {
    const key = await deriveKey(password, Buffer.from(secret.salt, 'base64'), {
      N: secret.N,
      r: secret.r,
      p: secret.p,
      keylen: secret.keylen,
    })
    const decipher = crypto.createDecipheriv(
      secret.cipher,
      key,
      Buffer.from(secret.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    const der = Buffer.concat([
      decipher.update(Buffer.from(secret.data, 'base64')),
      decipher.final(),
    ])
    return { ok: true, privateKey: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) }
  } catch {
    // Every failure here is the same failure from the outside — a wrong
    // password and a corrupted record are indistinguishable by design, and
    // saying which would tell an attacker with the file which guesses are
    // worth continuing.
    return { ok: false, reason: 'wrong-password' }
  }
}

/**
 * Changes what the password protects without changing the identity.
 *
 * The keypair is re-encrypted rather than regenerated, which is the whole
 * point: a password is a secret about this machine, and the identity is a fact
 * about this account. Changing one must not silently change the other.
 */
export async function changePassword(dir, oldPassword, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return { ok: false, reason: 'weak-password' }
  }
  const opened = await unlockAccount(dir, oldPassword)
  if (!opened.ok) return opened

  const raw = JSON.parse(await fs.readFile(accountPath(dir), 'utf8'))
  const der = opened.privateKey.export({ type: 'pkcs8', format: 'der' })
  const salt = crypto.randomBytes(16)
  const key = await deriveKey(newPassword, salt, KDF)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(der), cipher.final()])

  raw.secret = {
    kdf: 'scrypt',
    ...KDF,
    salt: salt.toString('base64'),
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }

  const target = accountPath(dir)
  const temp = `${target}.tmp-${process.pid}`
  await fs.writeFile(temp, JSON.stringify(raw, null, 2), 'utf8')
  await fs.rename(temp, target)
  return { ok: true, account: publicPart(raw) }
}

/**
 * Renames the account, or changes its picture.
 *
 * No password: none of this is secret, and asking for one to change a display
 * name would teach people to type it without thinking — which is the habit
 * that makes the password worth having in the first place.
 */
export async function updateAccount(dir, patch = {}) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(accountPath(dir), 'utf8'))
  } catch {
    return { ok: false, reason: 'no-account' }
  }

  if (patch.nickname !== undefined) {
    const next = String(patch.nickname).trim()
    if (!next) return { ok: false, reason: 'no-nickname' }
    raw.nickname = next
  }
  if (patch.deviceName !== undefined) {
    const next = String(patch.deviceName).trim()
    if (!next) return { ok: false, reason: 'no-device-name' }
    raw.deviceName = next
  }
  if (patch.avatar !== undefined) raw.avatar = patch.avatar || null

  const target = accountPath(dir)
  const temp = `${target}.tmp-${process.pid}`
  await fs.writeFile(temp, JSON.stringify(raw, null, 2), 'utf8')
  await fs.rename(temp, target)
  return { ok: true, account: publicPart(raw) }
}

/**
 * Proves the account holds its key, over a challenge somebody else chose.
 *
 * Nothing calls this yet — pairing a second device is the feature it exists
 * for. It is here now because it is the only thing that makes the keypair more
 * than a number in a file, and because a harness that signs and verifies is
 * how we know the encrypt-decrypt round trip actually preserved a usable key
 * rather than 32 bytes that merely decrypt.
 */
export function signChallenge(privateKey, challenge) {
  return crypto.sign(null, Buffer.from(challenge), privateKey).toString('base64')
}

/** The other half, for whoever is being convinced. */
export function verifyChallenge(publicKeyBase64, challenge, signature) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return crypto.verify(null, Buffer.from(challenge), publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
