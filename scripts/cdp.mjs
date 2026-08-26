/**
 * Minimal Chrome DevTools Protocol client, shared by the verification scripts.
 *
 * The parts of FLUX that matter most only exist inside Electron — IPC, the
 * flux-asset protocol, real decoding, and now drag and drop between panels.
 * None of it can be reached from a browser tab or a Node script, so the
 * harnesses attach to the running app and drive it in place.
 *
 * Uses Node's built-in WebSocket (Node 22+); no dependencies.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { safeFolderName } from '../shared/projectNaming.js'

const DEFAULT_PORT = 9222

export async function findPageTarget(port = DEFAULT_PORT) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // app still booting
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `no page target on :${port} — start the app with "npm run dev:debug" first`,
  )
}

export function connect(url) {
  const ws = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  /** Console errors the page emits, collected so a run can fail on them. */
  const consoleErrors = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)

    // Events carry no id. Console errors are worth failing over: a React key
    // warning or an unhandled rejection is exactly what a green suite hides.
    if (!message.id) {
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(
          message.params.args.map((a) => a.description ?? a.value ?? '?').join(' '),
        )
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        )
      }
      return
    }

    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ready, send, consoleErrors, close: () => ws.close() }
}

/** Evaluate an async expression in the page and return its JSON value. */
export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`page threw: ${text}`)
  }
  return result.result.value
}

/**
 * Attach, enable Runtime events, and wait for the app to have rendered.
 *
 * Also asserts `window.__fluxDev` is present. Harnesses MUST reach kernel state
 * through it rather than by dynamic import: importing '/src/kernel/x.ts' from
 * here yields a *different module instance* than the app is running once Vite
 * has appended an HMR cache-busting query, and that instance's state reads as
 * empty. Checks then pass or fail for reasons unrelated to the app.
 */
export async function attach(port = DEFAULT_PORT) {
  const target = await findPageTarget(port)
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  // Either shell counts as "rendered": .app is the dock, .launcher is the
  // project chooser the app now starts on. Waiting only for .app made attaching
  // while at the launcher stall for the whole timeout.
  await evaluate(
    cdp,
    `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
       await new Promise(r => setTimeout(r, 250));
     return true;`,
  )

  const hasHandle = await evaluate(cdp, `return !!window.__fluxDev;`)
  if (!hasHandle) {
    cdp.close()
    throw new Error(
      'window.__fluxDev missing — is the app running a dev build? (see src/main.tsx)',
    )
  }
  return cdp
}

/**
 * Ensures a project is open, creating one in `root` if needed.
 *
 * The app now starts at the launcher, so every suite that touches a panel has
 * to get past it first. Import mode is forced to 'link' so the copy-or-link
 * dialog does not appear mid-suite and swallow a click — the copy path has its
 * own checks in verify-project.
 */
export async function ensureProject(cdp, parent, name = 'Verification') {
  // Projects now live in a folder named after them inside the chosen parent, so
  // the harness makes the parent and lets FLUX make the project folder — the
  // same split as the launcher's directory picker.
  await fs.mkdir(parent, { recursive: true })

  // Resolved here rather than inside the evaluated page source: composing a
  // Windows path through a template literal means escaping backslashes twice,
  // which is exactly the kind of quiet breakage this harness keeps hitting.
  const target = path.join(parent, safeFolderName(name))

  const result = await evaluate(
    cdp,
    `const { project, importMode } = window.__fluxDev;
     const parent = ${JSON.stringify(parent)};
     const target = ${JSON.stringify(target)};
     const name = ${JSON.stringify(name)};

     const open = project.getProject();
     if (open && open.root === target) {
       importMode.setImportMode('link');
       return { ok: true, root: open.root, reused: true };
     }

     const existing = await project.isProjectFolder(target);
     const r = existing
       ? await project.openProject(target)
       : await project.createProject(parent, name);
     if (!r.ok) return { ok: false, error: r.error };

     // Set AFTER opening: a project open resets the mode, so one project's
     // habit cannot leak into the next.
     importMode.setImportMode('link');

     for (let i = 0; i < 60 && !document.querySelector('.dock-host'); i++)
       await new Promise(res => setTimeout(res, 250));
     return { ok: true, root: r.project.root, reused: false };`,
  )
  if (!result.ok) throw new Error(`could not open a project under ${parent}: ${result.error}`)
  return result
}

/**
 * Waits for the app's stores to load, then resets everything a suite could have
 * left behind: assets, the sequence, and the Content Browser's own view state.
 *
 * The UI reset matters as much as the data reset. Running these suites
 * back-to-back once failed in ways that had nothing to do with the code under
 * test, purely because one suite left the browser parked in a folder and the
 * next assumed the project view.
 */
export async function resetProject(cdp) {
  const ok = await evaluate(
    cdp,
    `const { assets, sequence, commands, project, view } = window.__fluxDev;
     for (let i = 0; i < 60 && !assets.isLoaded(); i++) await new Promise(r => setTimeout(r, 250));
     if (!assets.isLoaded()) throw new Error('asset store never finished loading');

     assets.removeAssets(assets.getAssets().map(a => a.id));
     // setSequence(null) rather than clearSequence(): tracks can be added now,
     // and a suite that added ten of them would otherwise hand the next suite a
     // timeline of a completely different height.
     sequence.setSequence(null);
     // The workspace is part of the document now, so a suite that switched it
     // would otherwise hand the next suite a layout with no Content Browser.
     view.setView(null);
     // And pin the timeline scale. The zoom is saved in the document too, so a
     // suite that zoomed leaves the *next run* opening at that zoom - which
     // shows up as a check about block widths failing depending on what ran
     // before it. 60 is TimelinePanel's DEFAULT_ZOOM, in pixels per second.
     view.recordView({ timeline: { zoom: 60 } });

     // Write the cleared state through to the document, so a previous suite's
     // saved work cannot reappear after the next open.
     await project.saveProject();

     // Put the Content Browser back where a suite expects to find it.
     await commands.run('content.collapseTree');
     await commands.run('content.project');
     await new Promise(r => setTimeout(r, 300));
     return assets.getAssets().length === 0 && sequence.getSequence().clips.length === 0;`,
  )
  if (!ok) throw new Error('resetProject did not reach a clean state')
  return ok
}

/**
 * Fails loudly when the ffmpeg fixtures are absent.
 *
 * Without this a missing fixture surfaces as assets being flagged `missing`,
 * which reads like a bug in the offline-detection code rather than an empty
 * directory.
 */
export async function requireFixtures(cdp, mediaDir) {
  const result = await evaluate(
    cdp,
    `return await window.flux.fs.list(${JSON.stringify(mediaDir)});`,
  )
  if (!result.ok) {
    throw new Error(
      `fixtures missing at ${mediaDir} (${result.error}) — see the README for the ffmpeg commands`,
    )
  }
  const names = result.listing.files.map((f) => f.name)
  // long_take.mp4 is required because the short fixtures cannot prove seeking:
  // Chromium swallows them whole before anything asks it to seek, which is the
  // exact condition under which a broken asset server looks fine. voice_over.mp4
  // is required because its audio gets loud and quiet on a schedule, and a
  // waveform drawn from audio that never changes proves nothing about whether
  // it follows the audio at all.
  for (const required of ['clipA.mp4', 'still.jpg', 'long_take.mp4', 'voice_over.mp4']) {
    if (!names.includes(required)) {
      throw new Error(`fixture ${required} missing from ${mediaDir}`)
    }
  }
  return names
}

export function createChecker() {
  const state = { passed: 0 }
  const check = async (name, fn) => {
    try {
      await fn()
      console.log(`  ok   ${name}`)
      state.passed++
    } catch (err) {
      console.error(`  FAIL ${name}`)
      console.error(`       ${err.message}`)
      process.exitCode = 1
    }
  }
  const report = () =>
    console.log(`\n${state.passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
  return { check, report }
}
