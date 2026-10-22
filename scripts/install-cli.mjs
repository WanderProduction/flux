/**
 * Puts `flux` on the PATH, so the app starts from a terminal like any other.
 *
 *   npm run cli                       point at the best FLUX this machine has
 *   npm run cli -- --exe <path>       point at a particular one
 *   npm run uncli                     take it off again
 *
 * `flux` with no arguments opens the launcher; `flux some-project.flux` opens
 * that project, because the shim passes its arguments straight through and
 * electron/main.js already reads a project path out of argv.
 *
 * ## Why this is not simply "add a folder to PATH"
 *
 * Editing PATH is the one step here that can break a machine rather than this
 * app. `setx` — the obvious tool — **truncates the value at 1024 characters**,
 * and a developer's PATH is routinely longer than that, so using it would
 * silently delete the tail of someone's environment.
 *
 * So the default is to not touch PATH at all. `%LOCALAPPDATA%\Microsoft\
 * WindowsApps` is already on the user PATH on every Windows 10 and 11 install
 * — it is where Store apps put their command aliases — and a `.cmd` dropped
 * there is on PATH the moment it is written, with nothing to undo but a file.
 *
 * Only when that folder is missing or somehow not on PATH does this fall back
 * to making its own folder and appending it, and then it writes the previous
 * value to a backup file first and appends through the registry rather than
 * through `setx`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const exeFlag = args.indexOf('--exe')
const exeArg = exeFlag >= 0 ? args[exeFlag + 1] : null

if (process.platform !== 'win32') {
  console.error(
    `This puts a .cmd shim on the Windows PATH. On ${process.platform} the equivalent is a\n` +
      'symlink into /usr/local/bin (macOS) or ~/.local/bin (Linux), pointing at the packaged app.',
  )
  process.exit(1)
}

const LOCAL = process.env.LOCALAPPDATA
if (!LOCAL) {
  console.error('LOCALAPPDATA is not set, so there is nowhere per-user to install to.')
  process.exit(1)
}

/** Where Windows already looks: Store command aliases live here, and it is on PATH. */
const WINDOWS_APPS = path.join(LOCAL, 'Microsoft', 'WindowsApps')
/** The fallback, used only when the above is not available. */
const OWN_BIN = path.join(LOCAL, 'FLUX', 'bin')

// ── finding FLUX ──────────────────────────────────────────────────

/**
 * Where a packaged FLUX might be, best first.
 *
 * The installed one wins over a build in the working tree: someone who has
 * installed FLUX means that one, and a `release/` folder is a by-product of
 * whatever they last built rather than a statement about what they run.
 */
function candidates() {
  return [
    path.join(LOCAL, 'Programs', 'FLUX', 'FLUX.exe'),
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'FLUX', 'FLUX.exe'),
    path.join(ROOT, 'release', 'win-unpacked', 'FLUX.exe'),
  ]
}

/**
 * The FLUX to point at, or null if there is none to find.
 *
 * `--exe` is an instruction, not a hint: if it names something that is not
 * there, that is an error rather than a reason to go looking. Falling back
 * would hand someone a *different* binary than the one they asked for and say
 * nothing about it — and they would find out whenever the wrong build did
 * something they did not expect.
 */
function findExe() {
  if (exeArg) {
    const resolved = path.resolve(exeArg)
    if (fs.existsSync(resolved)) return resolved
    console.error(`There is no FLUX at ${resolved}.`)
    process.exit(1)
  }
  for (const candidate of candidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ── the PATH, read and written carefully ──────────────────────────

/** The user's PATH as the registry holds it, with its type. */
function readUserPath() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8',
    })
    // `    Path    REG_EXPAND_SZ    C:\a;C:\b`
    const line = out.split('\n').find((l) => /\s(REG_[A-Z_]+)\s/.test(l) && /\bPath\b/i.test(l))
    if (!line) return null
    const match = line.match(/\s(REG_[A-Z_]+)\s+(.*)$/)
    if (!match) return null
    return { type: match[1], value: match[2].trim() }
  } catch {
    // No Path value under HKCU at all is normal on a fresh profile.
    return { type: 'REG_EXPAND_SZ', value: '' }
  }
}

function onPath(dir) {
  const parts = (process.env.PATH ?? '').split(';')
  const user = readUserPath()?.value ?? ''
  const all = [...parts, ...user.split(';')]
  return all.some((p) => p && path.resolve(p.replace(/"/g, '')).toLowerCase() === dir.toLowerCase())
}

/**
 * Appends a directory to the user PATH, through the registry.
 *
 * Never `setx`: it truncates at 1024 characters, and a PATH longer than that
 * is ordinary on a developer machine — using it would quietly cut the end off
 * someone's environment. The previous value is written to a file first, so
 * there is something to paste back if this goes wrong anyway.
 */
function addToPath(dir) {
  const current = readUserPath()
  if (!current) {
    console.error('Could not read the user PATH, so nothing was changed.')
    process.exit(1)
  }

  const backup = path.join(LOCAL, 'FLUX', `path-before-${Date.now()}.txt`)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.writeFileSync(backup, current.value, 'utf8')

  const next = current.value ? `${current.value.replace(/;+$/, '')};${dir}` : dir
  execFileSync('reg', [
    'add', 'HKCU\\Environment', '/v', 'Path', '/t', current.type, '/d', next, '/f',
  ])
  console.log(`  PATH  + ${dir}`)
  console.log(`        previous value saved to ${backup}`)
  return true
}

function removeFromPath(dir) {
  const current = readUserPath()
  if (!current?.value) return false
  const kept = current.value
    .split(';')
    .filter((p) => p && path.resolve(p.replace(/"/g, '')).toLowerCase() !== dir.toLowerCase())
  if (kept.length === current.value.split(';').filter(Boolean).length) return false
  execFileSync('reg', [
    'add', 'HKCU\\Environment', '/v', 'Path', '/t', current.type, '/d', kept.join(';'), '/f',
  ])
  console.log(`  PATH  - ${dir}`)
  return true
}

// ── the shim ──────────────────────────────────────────────────────

/**
 * `start ""` rather than running the exe directly, so the terminal comes back
 * immediately instead of being held for as long as FLUX is open. The empty
 * quotes are the window title `start` insists on when its first argument is
 * quoted — without them it treats the path as the title and opens nothing.
 *
 * `%*` passes everything through, which is what makes `flux project.flux`
 * work: main.js already reads a project path out of argv.
 */
function shimFor(exe) {
  return ['@echo off', `start "" "${exe}" %*`, ''].join('\r\n')
}

function shimDir() {
  if (fs.existsSync(WINDOWS_APPS) && onPath(WINDOWS_APPS)) return { dir: WINDOWS_APPS, own: false }
  return { dir: OWN_BIN, own: true }
}

// ── do it ─────────────────────────────────────────────────────────

const { dir, own } = shimDir()
const shim = path.join(dir, 'flux.cmd')

if (uninstall) {
  let removed = false
  for (const candidate of [path.join(WINDOWS_APPS, 'flux.cmd'), path.join(OWN_BIN, 'flux.cmd')]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate)
      console.log(`  removed ${candidate}`)
      removed = true
    }
  }
  removeFromPath(OWN_BIN)
  console.log(removed ? '\n`flux` is gone. Open a new terminal.' : '\nThere was no `flux` to remove.')
  process.exit(0)
}

const exe = findExe()
if (!exe) {
  console.error('No packaged FLUX found. Looked in:\n')
  for (const candidate of candidates()) console.error(`  ${candidate}`)
  console.error('\nBuild one first:\n')
  console.error('  npm run pack     a folder you can run from   (release/win-unpacked)')
  console.error('  npm run dist     an installer                (release/FLUX Setup *.exe)')
  console.error('\nor point at one you already have:  npm run cli -- --exe <path>')
  process.exit(1)
}

fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(shim, shimFor(exe), 'utf8')
console.log(`  flux  -> ${exe}`)
console.log(`        ${shim}`)

if (own && !onPath(dir)) addToPath(dir)

console.log(
  own
    ? '\nOpen a new terminal, then `flux`.'
    : '\nThat folder is already on PATH, so `flux` works in a new terminal right away.',
)
console.log('`flux <project>.flux` opens a project directly.')
