/**
 * Verifies opening a project by double-clicking its .flux document.
 *
 *   npm run dev:renderer
 *   node scripts/verify-launch.mjs
 *
 * Unlike the other harnesses this one owns the app's lifecycle: it stops any
 * running FLUX and starts its own, because "what happens when FLUX is *not*
 * already running" is half of what is being checked. It leaves a fresh app
 * running at the launcher when it finishes.
 *
 * The command line is read out of the Windows registry rather than assumed, so
 * this checks the association `npm run register` actually wrote — not a
 * best-guess reconstruction of it.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, evaluate } from './cdp.mjs'
import { createProject } from '../electron/project.js'

const PROG_ID = 'FLUX.Project'
const { check, report } = createChecker()

if (process.platform !== 'win32') {
  console.log('  skip  file associations are Windows-only in this harness')
  process.exit(0)
}

// ── the registered command ────────────────────────────────────

function registeredCommand() {
  const raw = execFileSync(
    'reg',
    ['query', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve'],
    { encoding: 'utf8' },
  )
  return raw.split('REG_SZ')[1].trim()
}

/** Splits the registry command into the exe and its arguments. */
function launchArgs(command, document) {
  const quoted = [...command.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  return {
    exe: quoted[0],
    argv: quoted.slice(1).map((arg) => (arg === '%1' ? document : arg)),
  }
}

function electronCount() {
  return Number(
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-Process electron -EA SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' },
    ).trim(),
  )
}

function stopFlux() {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-Process electron -EA SilentlyContinue | Stop-Process -Force'],
    { stdio: 'ignore' },
  )
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-launch-'))

async function makeProject(name) {
  const result = await createProject(tmp, name, '0.0.1')
  if (!result.ok) throw new Error(`could not create ${name}: ${result.error}`)
  return result.project
}

const first = await makeProject('Launched')
const second = await makeProject('Handed Over')

let cdp = null

try {
  await check('the .flux association points at a real executable', async () => {
    const { exe, argv } = launchArgs(registeredCommand(), first.file)
    await fs.access(exe)
    assert.ok(
      argv.includes(first.file),
      `the command has no %1 for the document: ${JSON.stringify(argv)}`,
    )
  })

  await check('the registered icon exists', async () => {
    const raw = execFileSync(
      'reg',
      ['query', `HKCU\\Software\\Classes\\${PROG_ID}\\DefaultIcon`, '/ve'],
      { encoding: 'utf8' },
    )
    // The value is "<path>,<index>"; Explorer shows nothing at all if the file
    // is missing, which looks identical to the association not existing.
    const icon = raw.split('REG_SZ')[1].trim().replace(/,\d+$/, '')
    await fs.access(icon)
  })

  // ── cold start ──────────────────────────────────────────────

  stopFlux()
  await new Promise((r) => setTimeout(r, 800))

  const { exe, argv } = launchArgs(registeredCommand(), first.file)
  spawn(exe, [...argv, '--remote-debugging-port=9222'], {
    detached: true,
    stdio: 'ignore',
  }).unref()

  cdp = await attach()

  await check('opening a document with FLUX closed launches straight into it', async () => {
    const state = await evaluate(
      cdp,
      `for (let i = 0; i < 60; i++) {
         const p = window.__fluxDev.project.getProject();
         if (p) return { name: p.name, root: p.root,
                         launcher: !!document.querySelector('.launcher'),
                         app: !!document.querySelector('.app') };
         await new Promise(r => setTimeout(r, 250));
       }
       return { name: null, launcher: !!document.querySelector('.launcher') };`,
    )
    assert.equal(state.name, 'Launched', 'the double-clicked project should be open')
    assert.equal(state.root, first.root)
    assert.equal(state.app, true, 'the dock should be up')
    assert.equal(state.launcher, false, 'the launcher should have been skipped entirely')
  })

  await check('closing that project returns to the launcher and stays there', async () => {
    // The launcher asks for the launch target every time it mounts. A target
    // that survived being handed over would reopen the same project the instant
    // you closed it, and closing would be impossible.
    const state = await evaluate(
      cdp,
      `const { project } = window.__fluxDev;
       project.closeProject();
       for (let i = 0; i < 40 && !document.querySelector('.launcher'); i++)
         await new Promise(r => setTimeout(r, 100));
       // Long enough for a re-open to have happened if it were going to.
       await new Promise(r => setTimeout(r, 1500));
       return { launcher: !!document.querySelector('.launcher'),
                open: project.getProject()?.name ?? null };`,
    )
    assert.equal(state.launcher, true, 'the launcher should be on screen')
    assert.equal(state.open, null, 'the project reopened itself after being closed')
  })

  // ── a second document, while FLUX is already up ─────────────

  await check('a second document opens in the running app, not a second copy', async () => {
    const before = electronCount()
    const handed = launchArgs(registeredCommand(), second.file)
    spawn(handed.exe, handed.argv, { detached: true, stdio: 'ignore' }).unref()

    const name = await evaluate(
      cdp,
      `for (let i = 0; i < 60; i++) {
         const p = window.__fluxDev.project.getProject();
         if (p?.name === 'Handed Over') return p.name;
         await new Promise(r => setTimeout(r, 250));
       }
       return window.__fluxDev.project.getProject()?.name ?? null;`,
    )
    assert.equal(name, 'Handed Over', 'the running app should have taken the document')

    // The single-instance lock makes the newcomer quit immediately; give it a
    // moment, then confirm no extra app is left behind. Two processes editing
    // one document is a race with someone's edit as the stake.
    await new Promise((r) => setTimeout(r, 2500))
    assert.ok(
      electronCount() <= before,
      `a second FLUX survived: ${before} processes before, ${electronCount()} after`,
    )
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  if (cdp) {
    // Leave the app at the launcher rather than inside a project about to be
    // deleted, which would leave the recents list pointing at nothing.
    await evaluate(cdp, `window.__fluxDev.project.closeProject(); return true;`).catch(() => {})
    cdp.close()
  }
  await fs.rm(tmp, { recursive: true, force: true })
}

report()
