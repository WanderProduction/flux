/**
 * Checks the packaged app — the one a user actually runs.
 *
 *   npm run pack                      build release/win-unpacked
 *   npm run verify:packaged           check it
 *   npm run verify:packaged -- <exe>  check a particular build
 *
 * Every other harness drives FLUX *unpackaged*, through Vite, with the dev
 * server supplying the renderer and `window.__fluxDev` exposed. The packaged
 * app is a different program in three ways that all fail silently:
 *
 *   - the renderer comes off `file://` inside an asar, not off `http://`
 *   - a Content-Security-Policy is injected that only exists in a build —
 *     `script-src 'self'`, which Vite's dev server could never run under
 *   - the dev handle is stripped, so anything that quietly depended on it
 *     is gone
 *
 * A production build that white-screens looks exactly like a working one from
 * the outside: the process starts, the window opens, the title is right. The
 * only way to tell is to ask the page what is in it.
 *
 * Nothing here is in CI, and cannot be: packaging downloads Electron and runs
 * for minutes, and a runner has no display to open a window on.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, createChecker, findPageTarget } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_EXE = path.join(ROOT, 'release', 'win-unpacked', 'FLUX.exe')
const EXE = process.argv[2] ?? DEFAULT_EXE

/** Its own port, so a dev app on 9222 is never what gets checked by mistake. */
const PORT = 9412

if (!fs.existsSync(EXE)) {
  console.error(`  FAIL no packaged FLUX at ${EXE}`)
  console.error('       build one first:  npm run pack')
  process.exit(1)
}

const { check, report } = createChecker()
console.log(`  ${EXE}`)

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
  detached: false,
  stdio: 'ignore',
})

let cdp = null
try {
  const target = await findPageTarget(PORT)
  cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')

  /** Evaluates in the packaged page. Not `evaluate` from cdp.mjs: that one
      asserts `__fluxDev`, which a production build correctly does not have. */
  const read = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return result.result.value
  }

  await check('the renderer comes out of the bundle, not off a dev server', async () => {
    const url = await read('return location.href')
    assert.ok(
      url.startsWith('file://'),
      `the packaged app loaded ${url} — it is still reaching for Vite`,
    )
    assert.ok(url.includes('app.asar'), `loaded ${url}, which is not inside the asar`)
  })

  await check('the window has the app in it, not a white page', async () => {
    // Give the shell a moment: a build has no HMR, so the first paint is the
    // only one there is going to be.
    const shell = await read(`
      for (let i = 0; i < 60 && !document.querySelector('.app, .launcher'); i++) {
        await new Promise(r => setTimeout(r, 250));
      }
      return {
        which: document.querySelector('.launcher') ? 'launcher'
             : document.querySelector('.app') ? 'app' : 'none',
        text: document.body.innerText.trim().slice(0, 60),
      };`)
    assert.notEqual(shell.which, 'none', 'neither the launcher nor the app shell rendered')
    assert.ok(shell.text.length > 0, 'the window rendered but has no text in it')
    console.log(`       ${shell.which}: ${shell.text.split('\n')[0]}`)
  })

  await check('the preload bridge survived packaging', async () => {
    /*
     * The one thing an asar can break that a dev run cannot: the preload path
     * is resolved differently inside a package, and without the bridge the app
     * opens, renders, and can do nothing at all — no project, no files.
     */
    const bridge = await read(`return {
      present: typeof window.flux,
      fs: typeof window.flux?.fs?.list,
      project: typeof window.flux?.project?.open,
      render: typeof window.flux?.render?.start,
    };`)
    assert.equal(bridge.present, 'object', 'window.flux is missing — the preload did not load')
    assert.equal(bridge.fs, 'function', 'the filesystem bridge is missing')
    assert.equal(bridge.project, 'function', 'the project bridge is missing')
    assert.equal(bridge.render, 'function', 'the render bridge is missing')
  })

  await check('the dev handle is stripped from a build', async () => {
    /*
     * `__fluxDev` is a door into every kernel module. It is guarded by
     * `import.meta.env.DEV`, and this is the only check anywhere that the
     * guard actually works — every other harness *requires* the handle, so a
     * build that shipped it would make them all pass more easily.
     */
    const handle = await read('return typeof window.__fluxDev')
    assert.equal(handle, 'undefined', 'a production build is shipping the dev handle')
  })

  await check('the Content-Security-Policy is the built one', async () => {
    /*
     * Injected at build time only, because Vite's dev server needs an inline
     * preamble that `script-src 'self'` would kill. So this is a rule the dev
     * harnesses can never exercise: the first time it is in force is in the
     * build someone installs.
     */
    const csp = await read(`
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta ? meta.content : null;`)
    assert.ok(csp, 'the build has no CSP meta tag')
    assert.ok(csp.includes("script-src 'self'"), `CSP is "${csp}"`)
    assert.ok(csp.includes('flux-asset:'), 'the CSP does not allow the media scheme')
  })

  await check('the updater is alive in a build, with a feed to ask', async () => {
    /*
     * Three things that are only true of a package, and each of which fails
     * silently as "there is no update".
     *
     * `app-update.yml` is written by electron-builder from the `publish` block
     * and does not exist in a checkout, so a dev run cannot tell whether it is
     * being produced at all — and without it the updater has no feed and
     * reports nothing to ask.
     *
     * The state must not be 'disabled'. That is what an unpackaged app
     * correctly reports, and seeing it here would mean `app.isPackaged` is
     * false in something that was packaged.
     *
     * And it must not have fallen over on the way in: `autoUpdater` is a lazy
     * getter on a CommonJS module, so a wrong import shape gives `undefined`
     * rather than an error, and the first symptom is an app that never
     * updates. See electron/updater.js.
     */
    const manifest = path.join(path.dirname(EXE), 'resources', 'app-update.yml')
    assert.ok(
      fs.existsSync(manifest),
      `no app-update.yml beside the app — electron-builder's "publish" block is missing`,
    )

    const updates = await read(`return {
      bridge: typeof window.flux?.updates?.state,
      status: await window.flux?.updates?.state(),
    };`)
    assert.equal(updates.bridge, 'function', 'the updates bridge is missing')
    assert.notEqual(
      updates.status.state,
      'disabled',
      'a packaged FLUX reported itself as a development build',
    )
    assert.equal(
      updates.status.feed?.from,
      'app-update.yml',
      `the feed came from ${updates.status.feed?.from}, not the one built in`,
    )
    console.log(`       feed: ${fs.readFileSync(manifest, 'utf8').match(/url:\s*(\S+)/)?.[1]}`)
  })

  await check('nothing failed on the way up', async () => {
    const errors = cdp.consoleErrors ?? []
    assert.deepEqual(errors, [], `the packaged app logged: ${errors.join(' · ')}`)
  })
} finally {
  report()
  cdp?.close()
  child.kill()
}
