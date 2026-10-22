/**
 * Registers `.flux` with Windows: the FLUX icon in Explorer, and double-click
 * opens the project.
 *
 *   node scripts/register-file-type.mjs              register (dev build)
 *   node scripts/register-file-type.mjs --exe <path> register an installed FLUX
 *   node scripts/register-file-type.mjs --unregister  undo
 *
 * A packaged FLUX does this for the user at install time — that is what the
 * `fileAssociations` block in package.json is for. This script exists because
 * FLUX is not packaged yet and the association is worth having *now*: without
 * it a .flux is a blank white page in Explorer that opens nothing.
 *
 * Everything is written under HKCU, never HKLM. Per-user keys need no elevation
 * and cannot affect anyone else on the machine, and unregistering is then a
 * clean removal rather than a repair job.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROJECT_EXTENSION } from '../shared/projectFormat.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The ProgID: the indirection Windows puts between an extension and a handler. */
const PROG_ID = 'FLUX.Project'
const CLASSES = 'HKCU\\Software\\Classes'

const args = process.argv.slice(2)
const unregister = args.includes('--unregister')
const exeFlag = args.indexOf('--exe')
const exePath = exeFlag >= 0 ? args[exeFlag + 1] : null

if (process.platform !== 'win32') {
  console.error(
    `This script registers file types on Windows. On ${process.platform}, associations come\n` +
      'from the packaged app bundle (macOS) or a .desktop entry (Linux).',
  )
  process.exit(1)
}

function reg(...argv) {
  execFileSync('reg', argv, { stdio: 'pipe' })
}

function regDelete(key) {
  try {
    reg('delete', key, '/f')
  } catch {
    // Absent already. Removing what is not there is the desired end state.
  }
}

if (unregister) {
  regDelete(`${CLASSES}\\${PROG_ID}`)
  regDelete(`${CLASSES}\\${PROJECT_EXTENSION}`)
  refreshIcons()
  console.log(`unregistered ${PROJECT_EXTENSION}`)
  process.exit(0)
}

// ── what Explorer should launch ───────────────────────────────

/**
 * In dev, Electron is launched with the app directory as its first argument and
 * the document as its second. That means double-clicking a .flux only works
 * while `npm run dev` is running — the renderer is served by Vite. main.js says
 * so plainly rather than opening a blank window.
 */
function devCommand() {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electron)) {
    console.error(`Electron is not installed at ${electron}. Run npm install first.`)
    process.exit(1)
  }
  return `"${electron}" "${ROOT}" "%1"`
}

function installedCommand(exe) {
  const resolved = path.resolve(exe)
  if (!fs.existsSync(resolved)) {
    console.error(`No such executable: ${resolved}`)
    process.exit(1)
  }
  return `"${resolved}" "%1"`
}

const command = exePath ? installedCommand(exePath) : devCommand()
const icon = path.join(ROOT, 'build', 'document.ico')

if (!fs.existsSync(icon)) {
  console.error(`${icon} is missing. Run "npm run icons" first.`)
  process.exit(1)
}

// ── the keys ──────────────────────────────────────────────────

// .flux -> ProgID. OpenWithProgids as well as the default value, so FLUX shows
// up in "Open with" even if another app later claims the extension outright.
reg('add', `${CLASSES}\\${PROJECT_EXTENSION}`, '/ve', '/d', PROG_ID, '/f')
reg(
  'add',
  `${CLASSES}\\${PROJECT_EXTENSION}\\OpenWithProgids`,
  '/v',
  PROG_ID,
  '/t',
  'REG_NONE',
  '/f',
)

reg('add', `${CLASSES}\\${PROG_ID}`, '/ve', '/d', 'FLUX Project', '/f')
// Explorer reads the icon from the ProgID, which is why a .flux is blank until
// this exists — not because the .ico is wrong.
reg('add', `${CLASSES}\\${PROG_ID}\\DefaultIcon`, '/ve', '/d', `${icon},0`, '/f')
reg('add', `${CLASSES}\\${PROG_ID}\\shell\\open\\command`, '/ve', '/d', command, '/f')
reg('add', `${CLASSES}\\${PROG_ID}\\shell\\open`, '/ve', '/d', 'Open with FLUX', '/f')

/**
 * Explorer caches icons aggressively; without a nudge the new one may not
 * appear until the next sign-in, which looks exactly like the registration
 * having failed.
 */
function refreshIcons() {
  try {
    execFileSync('ie4uinit.exe', ['-show'], { stdio: 'ignore' })
  } catch {
    // Not fatal — the icon appears on the next Explorer restart either way.
  }
}

refreshIcons()

console.log(`registered ${PROJECT_EXTENSION}`)
console.log(`  icon    ${icon}`)
console.log(`  command ${command}`)
if (!exePath) {
  console.log('\nThis points at the dev build, so `npm run dev` must be running')
  console.log('for a double-clicked project to open. Undo with: npm run unregister')
  console.log('\nFor a build that opens on its own: npm run dist installs one and registers')
  console.log('.flux itself, or point this at a build you already have:')
  console.log('  npm run register -- --exe "release\\win-unpacked\\FLUX.exe"')
}
