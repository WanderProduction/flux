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

/*
 * Nothing here can run without the association, so it is checked once, up
 * front, and said plainly. Every check below launches FLUX through the command
 * Windows has on file for a .flux document.
 */
try {
  registeredCommand()
} catch {
  console.error('  FAIL the .flux association is not registered on this machine')
  console.error('       Run: npm run register')
  console.error('       A shell with a virtualized registry cannot see the key even when')
  console.error('       it is there — the Microsoft Store python alias is one such shell.')
  process.exit(1)
}

// ── the registered command ────────────────────────────────────

/**
 * The command Windows runs for a .flux document.
 *
 * Read from the registry rather than reconstructed, so this checks the
 * association `npm run register` actually wrote. A missing key is not a
 * failure of this suite — it means the association was never set up on this
 * machine — and it used to arrive as a raw ENOENT stack trace from the middle
 * of the file, which says nothing about what to do next.
 */
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

/**
 * Stops FLUX, and does not mind if it was already stopped.
 *
 * `Get-Process | Stop-Process` exits 1 when the pipeline is empty, which
 * execFileSync turns into a throw — so a suite that began with no app running
 * died on its first line, before printing a single result. "The app never
 * answered" is what that looks like from outside, which is a long way from
 * "there was nothing to kill".
 */
function stopFlux() {
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Process electron -EA SilentlyContinue | Stop-Process -Force'],
      { stdio: 'ignore' },
    )
  } catch {
    // Nothing running, or nothing this account may stop. Either way the
    // postcondition — no FLUX in the way — is what the caller wanted.
  }
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

  // ── the window comes back where it was left ──────────

  /*
   * This is the only suite that owns the app's lifecycle, so it is the only one
   * that can answer "and what happens when you start it again".
   */
  const WINDOW_STATE = path.join(os.homedir(), 'AppData', 'Roaming', 'flux', 'ui-window.json')

  const readWindowState = async () => {
    try {
      return JSON.parse(await fs.readFile(WINDOW_STATE, 'utf8'))
    } catch {
      return null
    }
  }

  /** Writes a window state, restarts FLUX, and reattaches to it. */
  const restartWith = async (state) => {
    /*
     * Stopped before the state is written, not after.
     *
     * The running app keeps its own window state up to date, so writing the
     * file first means racing it — and it wins, because it writes on the way
     * out. The first version of this check did exactly that and failed with
     * the *previous* case's bounds, which is a confusing way to be told the
     * harness has its steps in the wrong order.
     */
    if (cdp) cdp.close()
    stopFlux()
    await new Promise((r) => setTimeout(r, 1200))
    await fs.writeFile(WINDOW_STATE, JSON.stringify(state, null, 2))
    const again = launchArgs(registeredCommand(), first.file)
    spawn(again.exe, [...again.argv, '--remote-debugging-port=9222'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    cdp = await attach()
    await evaluate(
      cdp,
      `for (let i = 0; i < 80 && !window.__fluxDev; i++)
         await new Promise(r => setTimeout(r, 250));
       return true;`,
    )
  }

  /** A window manager is entitled to a frame, and Windows counts its shadow. */
  const near = (a, b) => Math.abs(a - b) <= 24

  await check('a window with no history writes down where it opened', async () => {
    /*
     * The file is deleted first, which is the whole point of the check.
     *
     * Reading whatever happens to be on disk would pass against a build that
     * never writes anything at all — the settings from the last run are still
     * sitting there. A fresh install is the case that has to work, and it is
     * the one nobody tests by hand.
     */
    if (cdp) cdp.close()
    stopFlux()
    await new Promise((r) => setTimeout(r, 1200))
    await fs.rm(WINDOW_STATE, { force: true })
    const again = launchArgs(registeredCommand(), first.file)
    spawn(again.exe, [...again.argv, '--remote-debugging-port=9222'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    cdp = await attach()
    await evaluate(
      cdp,
      `for (let i = 0; i < 80 && !window.__fluxDev; i++)
         await new Promise(r => setTimeout(r, 250));
       return true;`,
    )
    // The window is shown before it is recorded, so give the write its moment.
    await new Promise((r) => setTimeout(r, 1200))

    const state = await readWindowState()
    assert.ok(state, `nothing was written to ${WINDOW_STATE}`)
    assert.ok(
      Number.isFinite(state.bounds?.width) && state.bounds.width > 0,
      `bounds should be real: ${JSON.stringify(state.bounds)}`,
    )
    assert.equal(typeof state.maximized, 'boolean')
    assert.equal(typeof state.fullScreen, 'boolean')
  })

  await check('a window opens at the size and place it was closed at', async () => {
    /*
     * Written straight into the settings rather than dragged with a mouse. The
     * question is whether a *saved* position is honoured; driving a window
     * manager from a harness would only add ways for the check to be wrong.
     */
    const wanted = { x: 120, y: 90, width: 1180, height: 760 }
    await restartWith({ bounds: wanted, maximized: false, fullScreen: false })

    const got = await evaluate(
      cdp,
      `return { w: window.outerWidth, h: window.outerHeight,
                x: window.screenX, y: window.screenY };`,
    )
    assert.ok(
      near(got.w, wanted.width) && near(got.h, wanted.height),
      `size should be about ${wanted.width}\u00d7${wanted.height}, and it is ${got.w}\u00d7${got.h}`,
    )
    assert.ok(
      near(got.x, wanted.x) && near(got.y, wanted.y),
      `position should be about ${wanted.x},${wanted.y}, and it is ${got.x},${got.y}`,
    )
  })

  await check('a window saved on a monitor that is gone opens somewhere visible', async () => {
    /*
     * The one failure that matters. A laptop undocked, a monitor unplugged, a
     * projector put away — restoring those coordinates puts the window where
     * nobody can see or reach it, which looks exactly like an app that will not
     * start. Coordinates far outside any real desktop stand in for the missing
     * display, which is precisely what the app sees when one is unplugged.
     */
    await restartWith({
      bounds: { x: 9000, y: 6000, width: 1200, height: 800 },
      maximized: false,
      fullScreen: false,
    })

    const got = await evaluate(
      cdp,
      `return { x: window.screenX, y: window.screenY,
                w: window.outerWidth, h: window.outerHeight,
                screenW: window.screen.availWidth, screenH: window.screen.availHeight };`,
    )
    assert.ok(
      got.x < got.screenW && got.y < got.screenH && got.x + got.w > 0 && got.y + got.h > 0,
      `the window should be on a screen, and it is at ${got.x},${got.y} ` +
        `on a ${got.screenW}\u00d7${got.screenH} desktop`,
    )
  })

  await check('a maximized window comes back maximized, and remembers its real size', async () => {
    /*
     * Both halves matter. Saving the bounds *while* maximized would record the
     * screen's size, and un-maximizing next time would then give back a window
     * the size of the display rather than the one it was before.
     */
    await restartWith({
      bounds: { x: 200, y: 150, width: 1100, height: 700 },
      maximized: true,
      fullScreen: false,
    })

    const got = await evaluate(
      cdp,
      `return { w: window.outerWidth, screenW: window.screen.availWidth };`,
    )
    assert.ok(
      got.w >= got.screenW - 40,
      `maximized should fill the width: window ${got.w} against a ${got.screenW} desktop`,
    )

    const state = await readWindowState()
    assert.ok(
      near(state.bounds.width, 1100) && near(state.bounds.height, 700),
      `the un-maximized size should survive: ${JSON.stringify(state.bounds)}`,
    )
    assert.equal(state.maximized, true, 'and it is still recorded as maximized')
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
