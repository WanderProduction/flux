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

const PORT = 9222
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

const dir = JSON.stringify(MEDIA_DIR)

try {
  // Wait for React to have rendered something before poking at it.
  await evaluate(
    cdp,
    `for (let i = 0; i < 40 && !document.querySelector('.app'); i++)
       await new Promise(r => setTimeout(r, 250));
     return true;`,
  )

  // Start from an empty project so the run is repeatable. This clears the
  // real asset store — fine for a dev fixture app, and the header says so.
  await evaluate(
    cdp,
    `const assets = window.__fluxDev.assets;
     for (let i = 0; i < 40 && !assets.isLoaded(); i++) await new Promise(r => setTimeout(r, 250));
     assets.removeAssets(assets.getAssets().map(a => a.id));
     return true;`,
  )

  await check('preload bridge exposes the filesystem API', async () => {
    const api = await evaluate(cdp, `return Object.keys(window.flux?.fs ?? {}).sort();`)
    assert.deepEqual(api, ['assetUrl', 'exists', 'list', 'pickFiles', 'places', 'subfolders'])
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
      'photo.png',
      'render.webm',
      'shot_B.mp4',
      'still.jpg',
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

  await check('panel registers its commands while mounted', async () => {
    const ids = await evaluate(
      cdp,
      `document.querySelector('.palette-hint').click();
       await new Promise(r => setTimeout(r, 120));
       const rows = [...document.querySelectorAll('.palette-row')]
         .map(r => r.querySelector('.palette-title')?.textContent);
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
       return rows;`,
    )
    assert.ok(ids.includes('Import Media…'), 'Import command missing from palette')
    assert.ok(ids.includes('Go Up One Folder'), 'Go Up command missing from palette')
  })

  await check('clicking Home in the rail lists that folder as cards', async () => {
    const result = await evaluate(
      cdp,
      `document.querySelector('.palette-scrim')?.remove();
       const home = [...document.querySelectorAll('.cb-quick-item')].find(b => b.textContent === 'Home');
       home.click();
       for (let i = 0; i < 40 && !document.querySelector('.card'); i++)
         await new Promise(r => setTimeout(r, 250));
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

  await check('the Project view renders the imported assets', async () => {
    const names = await evaluate(
      cdp,
      `[...document.querySelectorAll('.tree-label')].find(e => e.textContent === 'Assets').closest('.tree-row').click();
       await new Promise(r => setTimeout(r, 400));
       return [...document.querySelectorAll('.card-name')].map(e => e.textContent).sort();`,
    )
    assert.deepEqual(names, ['clipA.mp4', 'still.jpg'])
  })

  await check('assets survive a reload (persisted to the Electron store)', async () => {
    // Flush pending writes before reloading. saveStore is fire-and-forget so
    // the UI never blocks on disk, which means a reload can outrun the write.
    await evaluate(
      cdp,
      `await window.__fluxDev.store.flushStores(); location.reload(); return true;`,
    )
    await new Promise((r) => setTimeout(r, 2500))
    const names = await evaluate(
      cdp,
      `for (let i = 0; i < 40 && !document.querySelector('.app'); i++)
         await new Promise(r => setTimeout(r, 250));
       const assets = window.__fluxDev.assets;
       for (let i = 0; i < 40 && !assets.isLoaded(); i++) await new Promise(r => setTimeout(r, 250));
       return assets.getAssets().map(a => a.name).sort();`,
    )
    assert.deepEqual(names, ['clipA.mp4', 'still.jpg'], 'assets should reload from disk')
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

  await check('the page logged no console errors or uncaught exceptions', () => {
    // "no thumbnail for …" is an expected console.warn for the deliberately
    // corrupt fixture and arrives as a warning, not an error, so it is absent
    // from this list by construction.
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
