/**
 * Drives the running Electron renderer over the Chrome DevTools Protocol.
 *
 * The Content Browser's hard parts only exist inside Electron: the IPC handlers,
 * the flux-asset protocol, and real decoding of real files. None of that can be
 * checked from a browser tab or a Node script, so this attaches to the live app
 * and exercises them in place.
 *
 * Start the app with a debugging port first:
 *   npx electron . --remote-debugging-port=9222
 *   node scripts/verify-renderer.mjs [mediaDir]
 *
 * Note: this CLEARS the project's asset list so the run is repeatable. Harmless
 * while assets are references to fixture files; revisit before there is a real
 * project worth losing.
 *
 * Uses Node's built-in WebSocket (Node 22+); no dependencies.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { ensureProject, resetProject } from './cdp.mjs'

/*
 * This suite talks to the DevTools endpoint itself rather than through
 * cdp.mjs's `attach`, so it needs its own copy of the override — see
 * electron/main.js for why the port moves at all. Without this it is the one
 * harness that still goes to 9222, which on a second worktree means verifying
 * the first one's app.
 */
const PORT = Number(process.env.FLUX_DEBUG_PORT) || 9222
const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')

// ── CDP plumbing ──────────────────────────────────────────────

async function findPageTarget() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // app still booting
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no page target on :${PORT} — is Electron running with --remote-debugging-port?`)
}

function connect(url) {
  const ws = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  /** Console errors the page emits, collected for the final check. */
  const consoleErrors = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)

    // Events carry no id. Console errors are worth failing the run over: a
    // React key warning or an unhandled rejection is exactly the kind of thing
    // a green suite otherwise hides.
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
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const text =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`page threw: ${text}`)
  }
  return result.result.value
}

// ── test harness ──────────────────────────────────────────────

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    process.exitCode = 1
  }
}

const target = await findPageTarget()
const cdp = connect(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')

/*
 * A window of a known size, for the same reason verify-timeline pins one.
 *
 * The dev app remembers its size between runs, dockview lays the panels out
 * differently as it narrows, and anything that reaches for an element by
 * where it is on screen then depends on the shape the app was last left in.
 * 1600x950 is what FLUX opens at with no history.
 */
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 950,
  deviceScaleFactor: 1,
  mobile: false,
})
await new Promise((resolve) => setTimeout(resolve, 400))

const dir = JSON.stringify(MEDIA_DIR)
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

try {
  // Wait for React to have rendered something before poking at it.
  await evaluate(
    cdp,
    `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
       await new Promise(r => setTimeout(r, 250));
     return true;`,
  )

  // The app starts at the launcher now, so open a project before touching a
  // panel. ensureProject also forces import mode to 'link' so the copy-or-link
  // dialog cannot appear mid-suite; the copy path is checked in verify-project.
  await ensureProject(cdp, VERIFY_PROJECT)
  /*
   * Then back to a known project, through the same reset every other suite
   * uses. This suite used to clear the asset store by hand and write the
   * cleared list through `saveStore`, which did nothing for two reasons:
   * assets are not installation state, so they are not in that store at all,
   * and `saveStore` takes two arguments — the `project` scope it was passed
   * was dropped on the floor. The clear held in memory and never reached the
   * document, so the reopen in "the kept layout is what comes back" loaded
   * the previous suite's assets straight back in and two checks below
   * compared against a list that still had verify:timeline's footage in it.
   *
   * resetProject saves the cleared state, so the document and memory agree
   * however many times the project is closed and opened after this. It also
   * puts the app in the Edit workspace, which everything below assumes: a
   * project can be saved sitting in Export, where there is no Content
   * Browser, and `ensureProject` alone does not guarantee one is on screen.
   */
  await resetProject(cdp)

  await check('preload bridge exposes the filesystem API', async () => {
    const api = await evaluate(cdp, `return Object.keys(window.flux?.fs ?? {}).sort();`)
    assert.deepEqual(api, [
      'assetUrl',
      'exists',
      'list',
      'pathForFile',
      'pickDirectory',
      'pickFiles',
      // Where a render writes, and the footage scan behind batch import.
      'pickOutputDirectory',
      'pickProjectFile',
      'places',
      'scan',
      'subfolders',
    ])
  })

  await check('preload bridge exposes the project API', async () => {
    // Pinned because the surface is the whole contract with the OS side, and a
    // rename here fails silently: the renderer calls undefined and the project
    // simply never saves.
    const api = await evaluate(cdp, `return Object.keys(window.flux?.project ?? {}).sort();`)
    assert.deepEqual(api, [
      'copyIntoImports',
      'create',
      'deleteSequence',
      'importSequence',
      'is',
      'launchTarget',
      'listSequences',
      'onOpenTarget',
      'onSaveAndClose',
      'open',
      // The render queue lives beside the document rather than inside it.
      'readQueue',
      'save',
      'saveSequence',
      'setUnsaved',
      'writeQueue',
    ])
  })

  await check('fs:places returns real folders and drives over IPC', async () => {
    const places = await evaluate(cdp, `return await window.flux.fs.places();`)
    assert.ok(places.places.length > 0, 'expected named places')
    assert.ok(places.drives.length > 0, 'expected drives')
    assert.ok(
      places.places.every((p) => p.name && path.isAbsolute(p.path)),
      'places should carry absolute paths',
    )
  })

  await check('fs:list reads the test folder through IPC', async () => {
    const result = await evaluate(cdp, `return await window.flux.fs.list(${dir});`)
    assert.equal(result.ok, true, 'listing should succeed')
    const names = result.listing.files.map((f) => f.name)
    assert.deepEqual(names, [
      'clipA.mp4',
      'corrupt.mp4',
      'foreign_audio.mp4',
      'layer_blue.mp4',
      'layer_red.mp4',
      'long_take.mp4',
      'open_gop.mp4',
      // One per uncompressed sample layout the demuxer has to read.
      'pcm_fl32.mov',
      'pcm_in24.mov',
      'pcm_sowt.mov',
      'pcm_twos.mov',
      'photo.png',
      'render.webm',
      // Coded landscape with a matrix of 90, and four coloured quadrants, so
      // that a clip drawn the wrong way up can be told from one drawn right.
      'rotated.mp4',
      'shot_B.mp4',
      'still.jpg',
      'voice_over.mp4',
    ])
    assert.ok(!names.includes('notes.txt'), 'non-media must not be listed')
    assert.deepEqual(
      result.listing.folders.map((f) => f.name),
      ['Nested'],
    )
  })

  await check('fs:list reports permission failures as data, not a crash', async () => {
    const result = await evaluate(
      cdp,
      `return await window.flux.fs.list('C:\\\\System Volume Information');`,
    )
    assert.equal(result.ok, false)
    assert.ok(['denied', 'unreadable'].includes(result.error), `got ${result.error}`)
  })

  await check('flux-asset protocol serves a real image', async () => {
    const result = await evaluate(
      cdp,
      `const url = window.flux.fs.assetUrl(${dir} + '\\\\photo.png');
       const res = await fetch(url);
       return { status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength };`,
    )
    assert.equal(result.status, 200)
    assert.ok(result.bytes > 1000, `expected real bytes, got ${result.bytes}`)
  })

  await check('flux-asset protocol answers a byte range', async () => {
    /*
     * The single most consequential thing this protocol does, and the reason it
     * is checked here rather than only against the module: a <video> decides
     * whether a source is seekable from these headers. Answer a Range with a
     * plain 200 and Chromium concludes the file cannot be seeked, `currentTime`
     * assignments silently do nothing, and the viewer shows the first couple of
     * seconds of every clip and no more.
     *
     * Deliberately *not* checked by watching a video seek. Chromium buffers a
     * small file whole and then seeks inside it perfectly well with no range
     * support at all, so a media-level check passes or fails on the fixture's
     * size rather than on the code. This asks the question directly.
     */
    const result = await evaluate(
      cdp,
      `const url = window.flux.fs.assetUrl(${dir} + '\\\\clipA.mp4');
       const whole = await fetch(url);
       const wholeBytes = new Uint8Array(await whole.arrayBuffer());
       const part = await fetch(url, { headers: { Range: 'bytes=200-299' } });
       const partBytes = new Uint8Array(await part.arrayBuffer());
       let matches = partBytes.length === 100;
       for (let i = 0; matches && i < partBytes.length; i++) {
         if (partBytes[i] !== wholeBytes[200 + i]) matches = false;
       }
       return {
         acceptRanges: whole.headers.get('accept-ranges'),
         contentLength: whole.headers.get('content-length'),
         status: part.status,
         contentRange: part.headers.get('content-range'),
         bytes: partBytes.length,
         matches,
         size: wholeBytes.length,
       };`,
    )
    assert.equal(result.acceptRanges, 'bytes', 'without this the source is not seekable at all')
    assert.equal(result.contentLength, String(result.size))
    assert.equal(result.status, 206, 'a 200 to a Range request means "you cannot seek me"')
    assert.equal(result.contentRange, `bytes 200-299/${result.size}`)
    assert.equal(result.bytes, 100, 'only the bytes that were asked for')
    assert.equal(result.matches, true, 'and the right ones')
  })

  await check('flux-asset protocol refuses an impossible range', async () => {
    const result = await evaluate(
      cdp,
      `const url = window.flux.fs.assetUrl(${dir} + '\\\\clipA.mp4');
       const res = await fetch(url, { headers: { Range: 'bytes=99999999-' } });
       return { status: res.status, contentRange: res.headers.get('content-range') };`,
    )
    assert.equal(result.status, 416)
    assert.ok(result.contentRange?.startsWith('bytes */'))
  })

  await check('flux-asset protocol refuses a non-media file', async () => {
    const status = await evaluate(
      cdp,
      `const url = window.flux.fs.assetUrl(${dir} + '\\\\notes.txt');
       const res = await fetch(url);
       return res.status;`,
    )
    assert.equal(status, 403, 'a .txt must not be readable through the protocol')
  })

  await check('flux-asset protocol refuses a sensitive path outside the allowlist', async () => {
    const status = await evaluate(
      cdp,
      `const res = await fetch(window.flux.fs.assetUrl('C:\\\\Windows\\\\win.ini'));
       return res.status;`,
    )
    assert.equal(status, 403)
  })

  await check('image thumbnail decodes to a real JPEG data URL', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${dir} + '\\\\still.jpg';
       const thumb = await t.requestThumbnail(p, 'image', window.flux.fs.assetUrl(p));
       return { ok: typeof thumb === 'string', prefix: thumb?.slice(0, 22), length: thumb?.length };`,
    )
    assert.equal(result.ok, true, 'expected a data URL')
    assert.ok(result.prefix.startsWith('data:image/jpeg'), `got ${result.prefix}`)
    assert.ok(result.length > 500, 'thumbnail looks empty')
  })

  await check('video thumbnail decodes a frame from an mp4', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${dir} + '\\\\clipA.mp4';
       const thumb = await t.requestThumbnail(p, 'video', window.flux.fs.assetUrl(p));
       return { ok: typeof thumb === 'string', prefix: thumb?.slice(0, 22), length: thumb?.length };`,
    )
    assert.equal(result.ok, true, 'mp4 should produce a thumbnail')
    assert.ok(result.prefix.startsWith('data:image/jpeg'), `got ${result.prefix}`)
    assert.ok(result.length > 500)
  })

  await check('video thumbnail decodes a vp9 webm', async () => {
    const ok = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${dir} + '\\\\render.webm';
       return typeof (await t.requestThumbnail(p, 'video', window.flux.fs.assetUrl(p))) === 'string';`,
    )
    assert.equal(ok, true)
  })

  await check('an undecodable file resolves to null instead of hanging', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${dir} + '\\\\corrupt.mp4';
       const started = performance.now();
       const thumb = await t.requestThumbnail(p, 'video', window.flux.fs.assetUrl(p));
       return { thumb, ms: performance.now() - started };`,
    )
    assert.equal(result.thumb, null, 'a corrupt file must resolve null, not a thumbnail')
    assert.ok(result.ms < 16000, `took ${Math.round(result.ms)}ms — deadline did not fire`)
  })

  await check('a failed decode is cached, so it is not retried forever', async () => {
    const ms = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${dir} + '\\\\corrupt.mp4';
       const started = performance.now();
       await t.requestThumbnail(p, 'video', window.flux.fs.assetUrl(p));
       return performance.now() - started;`,
    )
    assert.ok(ms < 50, `second request took ${Math.round(ms)}ms — not cached`)
  })

  await check('concurrent requests are queued, not stampeded', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const files = ['clipA.mp4','shot_B.mp4','render.webm','still.jpg','photo.png'];
       files.forEach(f => t.invalidateThumbnail(${dir} + '\\\\' + f));
       const results = await Promise.all(files.map(f => {
         const p = ${dir} + '\\\\' + f;
         return t.requestThumbnail(p, f.match(/mp4|webm/) ? 'video' : 'image', window.flux.fs.assetUrl(p));
       }));
       return results.map(r => typeof r === 'string');`,
    )
    assert.deepEqual(result, [true, true, true, true, true], 'all five should decode')
  })

  // ── UI layer ────────────────────────────────────────────────

  await check('Content Browser panel is mounted in the Edit workspace', async () => {
    const tabs = await evaluate(
      cdp,
      `return [...document.querySelectorAll('.dv-tab')].map(e => e.textContent.trim());`,
    )
    assert.ok(tabs.includes('Content Browser'), `tabs were ${JSON.stringify(tabs)}`)
  })

  await check('the status bar names the sequence that is open', async () => {
    /*
     * It said "Sequence 1" literally, from back when a project had exactly one
     * and its name could not change \u2014 so it went on saying it through every
     * rename and every switch between tabs. Nothing failed, because nothing was
     * looking: a label that is a constant is invisible to a suite that only
     * ever reads it once.
     */
    const state = await evaluate(
      cdp,
      `const { sequence } = window.__fluxDev;
       const scope = () => document.querySelector('.status-scope')?.textContent?.trim() ?? null;

       sequence.renameSequence(sequence.getActiveSequenceId(), 'Reel Two');
       await new Promise(r => setTimeout(r, 500));
       const renamed = scope();

       const other = sequence.createSequence({ name: 'B Roll' });
       await new Promise(r => setTimeout(r, 500));
       const switched = scope();

       sequence.removeSequence(other.id);
       sequence.renameSequence(sequence.getActiveSequenceId(), 'Sequence 1');
       await new Promise(r => setTimeout(r, 400));
       return { renamed, switched };`,
    )
    assert.ok(
      state.renamed?.endsWith('Reel Two'),
      `a rename should reach the status bar, and it reads "${state.renamed}"`,
    )
    assert.ok(
      state.switched?.endsWith('B Roll'),
      `and so should switching to another, but it reads "${state.switched}"`,
    )
  })

  await check('the panel layout keeps itself, without being asked to', async () => {
    /*
     * It used to wait for Ctrl Alt S, which meant the ordinary way to lose a
     * layout was to spend ten minutes arranging one and then close the app \u2014
     * and nothing on screen said that would happen. Everything else about where
     * you were is remembered without being asked; the panels should be too.
     *
     * Driven by *removing* a panel rather than dragging a splitter: a drag is a
     * gesture a harness can only approximate, and the question here is whether
     * a change to the arrangement is written down at all, not which change.
     */
    const state = await evaluate(
      cdp,
      `const tabs = () =>
         [...document.querySelectorAll('.dv-tab')].map(e => e.textContent.trim()).sort();
       const before = tabs();

       const panelsIn = async () => {
         const saved = await window.flux.store.get('workspaces');
         return JSON.stringify(saved?.edit ?? null);
       };

       // Close the Viewer, then wait past the debounce that batches a drag.
       const viewer = [...document.querySelectorAll('.dv-tab')]
         .find(e => e.textContent.trim() === 'Viewer');
       viewer?.querySelector('.dv-default-tab-action')?.click();
       await new Promise(r => setTimeout(r, 1400));

       const written = await panelsIn();
       return { before, after: tabs(), written };`,
    )
    assert.ok(state.before.includes('Viewer'), `setup: ${JSON.stringify(state.before)}`)
    assert.ok(
      !state.after.includes('Viewer'),
      `the Viewer should have closed, and the tabs are ${JSON.stringify(state.after)}`,
    )
    assert.ok(state.written && state.written !== 'null', 'a layout should have been written')
    assert.ok(
      !state.written.includes('"viewer"'),
      'and what was written is the arrangement as it is now, without the Viewer',
    )
  })

  await check('the kept layout is what comes back', async () => {
    // Written down is not the same as restored. This is the half that would
    // still be broken if the layout were saved and then ignored on the way in.
    const state = await evaluate(
      cdp,
      `const { project } = window.__fluxDev;
       const root = project.getProject().root;
       project.closeProject();
       for (let i = 0; i < 60 && !document.querySelector('.launcher'); i++)
         await new Promise(r => setTimeout(r, 100));
       await project.openProject(root);
       for (let i = 0; i < 80 && !document.querySelector('.app'); i++)
         await new Promise(r => setTimeout(r, 100));
       await new Promise(r => setTimeout(r, 900));
       return [...document.querySelectorAll('.dv-tab')]
         .map(e => e.textContent.trim()).sort();`,
    )
    assert.ok(
      !state.includes('Viewer'),
      `the arrangement should come back as it was left, and the tabs are ${JSON.stringify(state)}`,
    )
    assert.ok(state.length > 0, 'with the panels that were still there')

    // Put it back, so the checks after this one get the workspace they expect.
    await evaluate(
      cdp,
      `await window.__fluxDev.commands.run('workspace.reset');
       await new Promise(r => setTimeout(r, 900));
       return true;`,
    )
  })

  await check('panel registers its commands while mounted', async () => {
    const ids = await evaluate(
      cdp,
      `document.querySelector('.palette-hint').click();
       // Poll for the rows rather than sampling once: the palette reads the
       // registry on open, and a cold first render can land after a fixed wait.
       let rows = [];
       for (let i = 0; i < 60; i++) {
         rows = [...document.querySelectorAll('.palette-row')]
           .map(r => r.querySelector('.palette-title')?.textContent);
         if (rows.includes('Import Media…')) break;
         await new Promise(r => setTimeout(r, 100));
       }

       // Close it through the app's own path. Escape is handled on the palette
       // element, so dispatching at document left it open, and the next check
       // used to paper over that by deleting the scrim node - which React then
       // re-created on its next render.
       document.querySelector('.palette')
         ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       for (let i = 0; i < 40 && document.querySelector('.palette'); i++)
         await new Promise(r => setTimeout(r, 100));
       if (document.querySelector('.palette')) throw new Error('palette would not close');
       return rows;`,
    )
    assert.ok(ids.includes('Import Media…'), 'Import command missing from palette')
    assert.ok(ids.includes('Go Up One Folder'), 'Go Up command missing from palette')
  })

  await check('clicking Home in the rail lists that folder as cards', async () => {
    const result = await evaluate(
      cdp,
      `const crumbNow = () => document.querySelector('.cb-crumb--current')?.textContent ?? null;
       // Compared against where we already were. An earlier suite can leave the
       // browser parked in some other folder, and any condition that does not
       // reference the starting point is satisfied before the click lands -
       // returning the previous folder's contents.
       const before = crumbNow();

       const home = [...document.querySelectorAll('.cb-quick-item')].find(b => b.textContent === 'Home');
       if (!home) throw new Error('no Home quick link');
       home.click();

       for (let i = 0; i < 80; i++) {
         if (crumbNow() !== before && document.querySelector('.card')) break;
         await new Promise(r => setTimeout(r, 250));
       }
       if (crumbNow() === before) throw new Error('navigation to Home never happened');
       return [...document.querySelectorAll('.card-name')].map(e => e.textContent);`,
    )
    assert.ok(result.includes('flux-media-test'), 'test folder should appear in Home')
  })

  await check('double-clicking a folder card navigates into it', async () => {
    const names = await evaluate(
      cdp,
      `const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'flux-media-test');
       card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       for (let i = 0; i < 40; i++) {
         const found = [...document.querySelectorAll('.card-name')].map(e => e.textContent);
         if (found.includes('clipA.mp4')) return found;
         await new Promise(r => setTimeout(r, 250));
       }
       return [...document.querySelectorAll('.card-name')].map(e => e.textContent);`,
    )
    assert.ok(names.includes('clipA.mp4'), `expected media cards, got ${JSON.stringify(names)}`)
    assert.ok(names.includes('Nested'), 'subfolder should be listed')
    assert.ok(!names.includes('notes.txt'), 'non-media must not appear as a card')
  })

  await check('cards render decoded thumbnails, not placeholders', async () => {
    const result = await evaluate(
      cdp,
      `for (let i = 0; i < 60; i++) {
         const imgs = [...document.querySelectorAll('.card img.thumb')];
         if (imgs.length >= 5) return { count: imgs.length, allData: imgs.every(i => i.src.startsWith('data:image/jpeg')) };
         await new Promise(r => setTimeout(r, 250));
       }
       const imgs = [...document.querySelectorAll('.card img.thumb')];
       return { count: imgs.length, allData: imgs.every(i => i.src.startsWith('data:image/jpeg')) };`,
    )
    assert.ok(result.count >= 5, `only ${result.count} thumbnails rendered`)
    assert.equal(result.allData, true, 'thumbnails should be JPEG data URLs')
  })

  await check('the corrupt file shows "no preview" rather than a broken image', async () => {
    const label = await evaluate(
      cdp,
      `const card = [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'corrupt.mp4');
       return card?.querySelector('.thumb--failed')?.textContent ?? null;`,
    )
    assert.equal(label, 'no preview')
  })

  await check('selecting cards and importing adds them to the project', async () => {
    const result = await evaluate(
      cdp,
      `const wanted = ['clipA.mp4', 'still.jpg'];
       for (const name of wanted) {
         [...document.querySelectorAll('.card')]
           .find(c => c.querySelector('.card-name')?.textContent === name)
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await new Promise(r => setTimeout(r, 60));
       }
       const btn = [...document.querySelectorAll('.cb-btn')].find(b => b.textContent.startsWith('Import '));
       const label = btn?.textContent;
       btn?.click();
       await new Promise(r => setTimeout(r, 300));
       const assets = window.__fluxDev.assets;
       return { label, names: assets.getAssets().map(a => a.name).sort() };`,
    )
    assert.equal(result.label, 'Import 2', `button read "${result.label}"`)
    assert.deepEqual(result.names, ['clipA.mp4', 'still.jpg'])
  })

  await check('imported assets keep the original path — nothing is copied', async () => {
    const paths = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       return assets.getAssets().map(a => a.path);`,
    )
    assert.ok(paths.length > 0)
    assert.ok(
      paths.every((p) => p.startsWith(MEDIA_DIR)),
      `assets should point at the originals, got ${JSON.stringify(paths)}`,
    )
  })

  await check('re-importing the same file does not duplicate the card', async () => {
    const count = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       const before = assets.getAssets().length;
       assets.importAssets([{ path: ${dir} + '\\\\clipA.mp4', kind: 'video' }]);
       return { before, after: assets.getAssets().length };`,
    ).then((r) => r)
    assert.equal(count.after, count.before, 'duplicate import should be a no-op')
  })

  await check('the project bin renders the imported assets', async () => {
    // `imports` is the bin. Linked assets live elsewhere on disk and are shown
    // here anyway, which is the whole reason the view is not a plain listing.
    const names = await evaluate(
      cdp,
      `await window.__fluxDev.commands.run('content.project');
       // Wait for the *navigation*, not for cards: the folder we are leaving
       // already has cards, so counting them returns the old view instantly.
       for (let i = 0; i < 60; i++) {
         if (document.querySelector('.cb-crumb--current')?.textContent === 'imports') break;
         await new Promise(r => setTimeout(r, 100));
       }
       await new Promise(r => setTimeout(r, 400));
       // Media only. The bin holds the project's sequences too — they are
       // things it contains as much as the footage is — and this check is
       // about what was imported.
       return [...document.querySelectorAll('.card:not(.card--sequence) .card-name')]
         .map(e => e.textContent).sort();`,
    )
    assert.deepEqual(names, ['clipA.mp4', 'still.jpg'])
    const sequences = await evaluate(
      cdp,
      `return [...document.querySelectorAll('.card--sequence .card-name')]
         .map(e => e.textContent);`,
    )
    assert.deepEqual(sequences, ['Sequence 1'], 'and the sequence is there beside them')
  })

  /** Reopen the verification project and read back what the document held. */
  async function namesAfterReload() {
    await new Promise((r) => setTimeout(r, 2500))
    // A reload lands on the launcher, since FLUX does not silently reopen the
    // last project. Persistence is only observable once it is opened again.
    await ensureProject(cdp, VERIFY_PROJECT)
    return evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app, .launcher'); i++)
         await new Promise(r => setTimeout(r, 250));
       const assets = window.__fluxDev.assets;
       for (let i = 0; i < 40 && !assets.isLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       return assets.getAssets().map(a => a.name).sort();`,
    )
  }

  await check('an unsaved import does not come back after a reload', async () => {
    // There is no autosave, and this pins down what that costs rather than
    // leaving it to be discovered: work that was never saved is gone when the
    // app goes away. It is why closing over unsaved work has to ask first --
    // see the close guard in electron/main.js.
    await evaluate(
      cdp,
      `const { assets, project, store } = window.__fluxDev;
       // Baseline: an empty document on disk, so this measures the import and
       // not whatever a previous suite happened to leave saved.
       assets.removeAssets(assets.getAssets().map(a => a.id));
       await new Promise(r => setTimeout(r, 150));
       const cleared = await project.saveProject();
       if (!cleared.ok) throw new Error('save failed: ' + cleared.error);

       assets.importAssets([
         { path: ${dir} + '\\\\clipA.mp4', kind: 'video' },
         { path: ${dir} + '\\\\still.jpg', kind: 'image' },
       ]);
       await new Promise(r => setTimeout(r, 150));
       if (!project.isDirty()) throw new Error('the import should have been unsaved work');

       await store.flushStores();
       location.reload();
       return true;`,
    )
    assert.deepEqual(await namesAfterReload(), [], 'unsaved imports must not reappear')
  })

  await check('saved assets survive a reload', async () => {
    await evaluate(
      cdp,
      `const { assets, project, store } = window.__fluxDev;
       assets.importAssets([
         { path: ${dir} + '\\\\clipA.mp4', kind: 'video' },
         { path: ${dir} + '\\\\still.jpg', kind: 'image' },
       ]);
       await new Promise(r => setTimeout(r, 150));
       const saved = await project.saveProject();
       if (!saved.ok) throw new Error('save failed: ' + saved.error);
       await store.flushStores();
       location.reload();
       return true;`,
    )
    assert.deepEqual(
      await namesAfterReload(),
      ['clipA.mp4', 'still.jpg'],
      'assets should reload from the document',
    )
  })

  await check('a deleted original is flagged missing, not silently broken', async () => {
    const result = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       assets.importAssets([{ path: ${dir} + '\\\\ghost.mp4', kind: 'video', name: 'ghost.mp4' }]);
       await assets.recheckMissing();
       const ghost = assets.getAssets().find(a => a.name === 'ghost.mp4');
       return { missing: ghost?.missing, realStillFine: assets.getAssets().find(a => a.name === 'clipA.mp4')?.missing };`,
    )
    assert.equal(result.missing, true, 'a vanished file must be marked missing')
    assert.equal(result.realStillFine, false, 'present files must not be flagged')
  })

  await check('removing an asset clears it from the project', async () => {
    const remaining = await evaluate(
      cdp,
      `const assets = window.__fluxDev.assets;
       const ghost = assets.getAssets().find(a => a.name === 'ghost.mp4');
       assets.removeAssets([ghost.id]);
       return assets.getAssets().map(a => a.name).sort();`,
    )
    assert.deepEqual(remaining, ['clipA.mp4', 'still.jpg'])
  })

  await check('rapid writes to one store key land in order', async () => {
    // Regression: each save is a separate IPC round trip with no ordering
    // guarantee, so a later write could land before an earlier one and leave
    // stale content on disk. The app showed the new state, the file held the
    // old one, and the difference only surfaced after a restart.
    const result = await evaluate(
      cdp,
      `const { store } = window.__fluxDev;
       // A big payload followed immediately by a small one. Unordered, the slow
       // write finishes last and wins; ordered, the small one is final. Two
       // equal-sized writes would usually land in order by luck and prove
       // nothing — an earlier version of this probe did exactly that and stayed
       // green against the broken implementation.
       const big = Array.from({ length: 60000 }, (_, i) => ({ i, pad: 'xxxxxxxxxxxxxxxxxxxx' }));
       store.saveStore('order-probe', { tag: 'first', big });
       store.saveStore('order-probe', { tag: 'last' });
       await store.flushStores();
       return await window.flux.store.get('order-probe');`,
    )
    assert.equal(result.tag, 'last', `the later write should win, got tag=${result.tag}`)
  })

  await check('each workspace keeps its own panels, switch after switch', async () => {
    /*
     * The bug this exists for only appears once there are two workspaces, and
     * it appears on the *second* switch.
     *
     * Layout changes are saved on a debounce, and the save used to read the
     * active id from a render closure — so a change arriving just after a
     * switch was filed under whichever workspace was open *before*. Each
     * layout therefore got written under the other's name, and going back to
     * one you had already visited produced the other one's panels. With a
     * single workspace it is invisible, which is exactly why it survived.
     */
    const state = await evaluate(
      cdp,
      `const { commands, view } = window.__fluxDev;
       const tabs = () => [...document.querySelectorAll('.dv-tab')].map(e => e.textContent.trim()).sort();
       const go = async (id) => {
         await commands.run('workspace.switch.' + id);
         // Past the debounce, so a late save lands before the next switch.
         await new Promise(r => setTimeout(r, 900));
         return { workspace: view.getView().workspace, tabs: tabs() };
       };
       const edit = await go('edit');
       const exported = await go('export');
       const backToEdit = await go('edit');
       const backToExport = await go('export');
       // Put it back: every check after this one wants the Edit panels, and a
       // check that leaves another workspace open breaks all of them.
       await go('edit');
       return { edit, exported, backToEdit, backToExport };`,
    )
    assert.equal(state.exported.workspace, 'export')
    assert.ok(
      state.exported.tabs.includes('To render'),
      `Export showed ${state.exported.tabs.join(', ')}`,
    )
    assert.deepEqual(
      state.backToEdit.tabs,
      state.edit.tabs,
      'going back to Edit did not bring Edit’s panels back',
    )
    assert.deepEqual(
      state.backToExport.tabs,
      state.exported.tabs,
      'the second visit to Export showed another workspace’s panels',
    )
  })

  /*
   * Scrolling a long bin asks for far more than it ever looks at, so a queued
   * decode has to be droppable. Checked here rather than inferred: the queue is
   * the one place where "it is only waiting" and "it is already running" look
   * identical from outside, and the difference is the whole point.
   */
  await check('a queued thumbnail is dropped when nothing is asking for it', async () => {
    const result = await evaluate(
      cdp,
      `const { thumbnails } = window.__fluxDev;
       const names = ['clipA.mp4', 'shot_B.mp4', 'long_take.mp4', 'rotated.mp4',
                      'layer_red.mp4', 'layer_blue.mp4'];
       const paths = names.map(n => ${dir} + '/' + n);

       // From scratch: a cached result never reaches the queue at all.
       for (const p of paths) thumbnails.invalidateThumbnail(p);

       const jobs = paths.map(p => thumbnails.requestThumbnail(p, 'video', window.flux.fs.assetUrl(p)));
       // Three run at once, so asking for six leaves three waiting.
       const queued = thumbnails.thumbnailsWaiting();

       const dropped = paths.slice(3);
       for (const p of dropped) thumbnails.abandonThumbnail(p);
       const left = thumbnails.thumbnailsWaiting();

       // The dropped ones settle rather than hanging, and settle as "no answer"
       // rather than as "this file has no thumbnail".
       const settled = await Promise.all(jobs.slice(3));
       const remembered = dropped.map(p => thumbnails.cachedThumbnail(p));

       return {
         queued,
         left,
         settled: settled.map(v => v === null),
         remembered: remembered.map(v => v === undefined),
       };`,
    )

    assert.ok(result.queued > 0, 'asking for six at once should leave some waiting')
    assert.equal(result.left, 0, `${result.left} jobs were still queued after being dropped`)
    assert.deepEqual(result.settled, [true, true, true], 'a dropped request must still settle')
    assert.deepEqual(
      result.remembered,
      [true, true, true],
      'a dropped request must not be remembered as a file with no thumbnail',
    )
  })

  /*
   * The ring is driven from the registry rather than from real decodes here,
   * and deliberately: what is being checked is that a count becomes a drawn arc
   * and a list of rows, which a real bulk drop would prove only incidentally and
   * much more slowly. That the queues report at all is checked where they are.
   */
  await check('the ring fills as work finishes, and the peek names what is in flight', async () => {
    const state = await evaluate(
      cdp,
      `const { mediaWork } = window.__fluxDev;
       const arc = () => {
         const fill = document.querySelector('.work-ring-fill');
         if (!fill) return null;
         const whole = Number(fill.getAttribute('stroke-dasharray'));
         const left = Number(fill.getAttribute('stroke-dashoffset'));
         return Math.round(((whole - left) / whole) * 100);
       };
       const settle = () => new Promise(r => setTimeout(r, 120));

       mediaWork.clearMediaWork();
       await settle();
       const idle = { arc: arc(), busy: !!document.querySelector('.work-ring-button--busy') };

       // Four jobs across the three queues, so the panel has to name all of them.
       mediaWork.workQueued('waveform', 'C:/take/one.mov');
       mediaWork.workQueued('thumbnail', 'C:/take/two.mov');
       mediaWork.workQueued('index', 'C:/take/three.mov');
       mediaWork.workQueued('waveform', 'C:/take/four.mov');
       mediaWork.workStarted('waveform', 'C:/take/one.mov');
       await settle();
       const started = {
         arc: arc(),
         busy: !!document.querySelector('.work-ring-button--busy'),
         count: document.querySelector('.work-ring-count')?.textContent,
       };

       document.querySelector('.work-ring-button').click();
       await settle();

       mediaWork.workEnded('waveform', 'C:/take/one.mov', 'done');
       mediaWork.workEnded('thumbnail', 'C:/take/two.mov', 'failed', 'the file is not a video');
       await settle();

       const rows = [...document.querySelectorAll('.work-row')].map(el => ({
         name: el.querySelector('.work-row-name')?.textContent,
         kind: el.querySelector('.work-row-kind')?.textContent,
         state: el.querySelector('.work-row-state')?.textContent,
       }));

       const half = arc();

       mediaWork.workEnded('index', 'C:/take/three.mov', 'done');
       mediaWork.workEnded('waveform', 'C:/take/four.mov', 'dropped');
       await settle();
       const whenDone = { arc: arc(), busy: !!document.querySelector('.work-ring-button--busy') };

       document.querySelector('.work-peek-close').click();
       await settle();
       const closed = !document.querySelector('.work-peek');

       mediaWork.clearMediaWork();
       return { idle, started, rows, half, whenDone, closed };`,
    )

    // Idle reads as finished rather than as empty: an unfilled ring sitting
    // there all session would be a warning nobody can clear.
    assert.equal(state.idle.arc, 100, 'an idle ring should be full')
    assert.equal(state.idle.busy, false)

    assert.equal(state.started.arc, 0, 'nothing finished yet, so no arc')
    assert.equal(state.started.busy, true, 'four jobs in flight and the ring is not lit')
    assert.equal(state.started.count, '4', `the badge read "${state.started.count}"`)

    assert.equal(state.half, 50, 'two of four finished should be half an arc')

    const named = state.rows.map((row) => `${row.name} ${row.kind}`)
    assert.ok(named.includes('one.mov waveform'), `rows: ${named.join(', ')}`)
    assert.ok(named.includes('two.mov thumbnail'), `rows: ${named.join(', ')}`)
    assert.ok(named.includes('three.mov frame index'), `rows: ${named.join(', ')}`)

    // A failure says why, in the row, rather than only being a colour.
    const failed = state.rows.find((row) => row.name === 'two.mov')
    assert.equal(failed?.state, 'the file is not a video')

    assert.equal(state.whenDone.arc, 100)
    assert.equal(state.whenDone.busy, false, 'the ring stayed lit with nothing left to do')
    assert.equal(state.closed, true, 'the peek did not close')
  })

  /*
   * The one derived thing FLUX used to forget on every launch. Waveforms and
   * frame indexes have always been written down; thumbnails lived in a Map and
   * nothing else, so reopening a project re-decoded a frame of every file it
   * showed — the most visible work the app does and the least necessary.
   *
   * Checked through a reload rather than by clearing the Map, because the Map
   * going away is the whole of what a relaunch does to this, and a check that
   * reached in to empty it would be checking something else.
   */
  await check('a thumbnail is written down and survives a reload', async () => {
    const written = await evaluate(
      cdp,
      `const { thumbnails } = window.__fluxDev;
       const path = ${dir} + '/clipA.mp4';
       thumbnails.invalidateThumbnail(path);
       const made = await thumbnails.requestThumbnail(path, 'video', window.flux.fs.assetUrl(path));
       /*
        * Straight from the cache the app writes to, not from the module's Map
        * — and polled, because the write is deliberately not awaited. A
        * thumbnail appears on screen the moment it is decoded; making the card
        * wait for a disk write would be paying for the cache twice.
        */
       const token = await window.flux.media.sourceToken(path);
       let bytes = null;
       for (let i = 0; i < 20 && !bytes; i++) {
         bytes = await window.flux.media.read(path, 'thumb', token);
         if (!bytes) await new Promise(r => setTimeout(r, 100));
       }
       return {
         made: typeof made === 'string' && made.startsWith('data:image/'),
         stored: bytes ? bytes.length : 0,
         same: bytes ? new TextDecoder().decode(bytes) === made : false,
       };`,
    )
    assert.ok(written.made, 'no thumbnail was decoded to begin with')
    assert.ok(written.stored > 0, 'the thumbnail was decoded but never written to the media cache')
    assert.ok(written.same, 'what was written is not what was decoded')

    // From inside the page, like the other reload checks here: a CDP reload
    // swaps the execution context underneath every later evaluate.
    await evaluate(cdp, `location.reload(); return true;`)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await ensureProject(cdp, VERIFY_PROJECT)
    const live = await evaluate(
      cdp,
      `for (let i = 0; i < 60 && !window.__fluxDev; i++) await new Promise(r => setTimeout(r, 250));
       return Boolean(window.__fluxDev);`,
    )
    assert.ok(live, 'the app did not come back after the reload')

    const after = await evaluate(
      cdp,
      `const { thumbnails } = window.__fluxDev;
       const path = ${dir} + '/clipA.mp4';
       // Nothing in memory: this is a fresh page.
       const cold = thumbnails.cachedThumbnail(path);
       const at = performance.now();
       const back = await thumbnails.requestThumbnail(path, 'video', window.flux.fs.assetUrl(path));
       return {
         cold: cold === undefined,
         back: typeof back === 'string' && back.startsWith('data:image/'),
         ms: performance.now() - at,
       };`,
    )
    assert.ok(after.cold, 'setup: the page was not actually fresh')
    assert.ok(after.back, 'the thumbnail did not come back after a reload')
    console.log(`       read back in ${Math.round(after.ms)}ms`)
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    // "no thumbnail for …" is an expected console.warn for the deliberately
    // corrupt fixture and arrives as a warning, not an error, so it is absent
    // from this list by construction.
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  // Cleared, or it outlives the harness and the next person to open the app
  // finds the window stuck at this size.
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  cdp.close()
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
