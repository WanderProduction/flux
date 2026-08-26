/**
 * Verifies the launcher and the copy-on-import flow in the running app.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-project.mjs
 *
 * Creates and deletes its own project folders under the OS temp directory, and
 * leaves the app back at the launcher.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, evaluate } from './cdp.mjs'

const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-ui-project-'))
// The parent the user would pick; FLUX creates <parent>/<name> inside it.
const parent = tmp
const projectA = path.join(tmp, 'Alpha')
const projectB = path.join(tmp, 'Beta')

const js = (value) => JSON.stringify(value)

const { check, report } = createChecker()
const cdp = await attach()

/** Back to a known starting point: no project open, launcher on screen. */
async function toLauncher() {
  await evaluate(
    cdp,
    `window.__fluxDev.project.closeProject();
     for (let i = 0; i < 40 && !document.querySelector('.launcher'); i++)
       await new Promise(r => setTimeout(r, 100));
     return true;`,
  )
}

try {
  await toLauncher()

  await check('the launcher is what the app shows with no project open', async () => {
    const state = await evaluate(
      cdp,
      `return {
         launcher: !!document.querySelector('.launcher'),
         dock: !!document.querySelector('.dock-host'),
         title: document.querySelector('.launcher-title')?.textContent,
       };`,
    )
    assert.equal(state.launcher, true, 'launcher should be on screen')
    assert.equal(state.dock, false, 'the dock must not be mounted without a project')
    assert.equal(state.title, 'New project')
  })

  await check('creating a project enters the app and shows its name', async () => {
    const state = await evaluate(
      cdp,
      `const r = await window.__fluxDev.project.createProject(${js(parent)}, 'Alpha');
       if (!r.ok) throw new Error(r.error);
       for (let i = 0; i < 60 && !document.querySelector('.dock-host'); i++)
         await new Promise(res => setTimeout(res, 100));
       return {
         dock: !!document.querySelector('.dock-host'),
         launcher: !!document.querySelector('.launcher'),
         chip: document.querySelector('.project-chip')?.textContent,
       };`,
    )
    assert.equal(state.dock, true, 'the dock should be mounted')
    assert.equal(state.launcher, false, 'the launcher should be gone')
    assert.equal(state.chip, 'Alpha')
  })

  await check('a folder named after the project holds the three folders', async () => {
    // The parent must contain the project folder, not the project's contents:
    // without this, picking Downloads once would scatter project_files /
    // imports / exports straight into Downloads.
    const inParent = await fs.readdir(parent)
    assert.ok(inParent.includes('Alpha'), `expected an Alpha folder, got ${inParent.join(', ')}`)
    assert.ok(
      !inParent.includes('project_files'),
      'project folders leaked into the parent directory',
    )

    const entries = await fs.readdir(projectA)
    assert.deepEqual(entries.sort(), ['exports', 'imports', 'project_files'])
  })

  await check('the project root is the named folder', async () => {
    const root = await evaluate(cdp, `return window.__fluxDev.project.getProject()?.root;`)
    assert.equal(root, projectA)
  })

  await check('project state is written into the project, not userData', async () => {
    await evaluate(
      cdp,
      `const { assets, store } = window.__fluxDev;
       assets.importAssets([{ path: ${js(path.join(MEDIA_DIR, 'clipA.mp4'))}, kind: 'video' }]);
       await store.flushStores();
       return true;`,
    )
    const stored = JSON.parse(
      await fs.readFile(path.join(projectA, 'project_files', 'assets.json'), 'utf8'),
    )
    assert.equal(stored.length, 1)
    assert.equal(stored[0].name, 'clipA.mp4')
  })

  await check('closing a project returns to the launcher', async () => {
    const state = await evaluate(
      cdp,
      `window.__fluxDev.project.closeProject();
       for (let i = 0; i < 40 && !document.querySelector('.launcher'); i++)
         await new Promise(r => setTimeout(r, 100));
       return {
         launcher: !!document.querySelector('.launcher'),
         assets: window.__fluxDev.assets.getAssets().length,
       };`,
    )
    assert.equal(state.launcher, true)
    assert.equal(state.assets, 0, 'closing must drop the project state')
  })

  await check('a second project does not inherit the first project\'s assets', async () => {
    // The stores hold module-scope state, so without an explicit reset on open
    // Beta would show Alpha's footage — and the first save would write it into
    // Beta's folder.
    const names = await evaluate(
      cdp,
      `const { project, assets } = window.__fluxDev;
       const r = await project.createProject(${js(parent)}, 'Beta');
       if (!r.ok) throw new Error(r.error);
       for (let i = 0; i < 60 && !assets.isLoaded(); i++) await new Promise(res => setTimeout(res, 100));
       return assets.getAssets().map(a => a.name);`,
    )
    assert.deepEqual(names, [], `Beta should be empty, got ${JSON.stringify(names)}`)
  })

  await check('reopening the first project brings its assets back', async () => {
    const names = await evaluate(
      cdp,
      `const { project, assets } = window.__fluxDev;
       const r = await project.openProject(${js(projectA)});
       if (!r.ok) throw new Error(r.error);
       for (let i = 0; i < 60 && !assets.isLoaded(); i++) await new Promise(res => setTimeout(res, 100));
       return assets.getAssets().map(a => a.name);`,
    )
    assert.deepEqual(names, ['clipA.mp4'])
  })

  await check('Beta was never polluted by Alpha on disk', async () => {
    const betaAssets = path.join(projectB, 'project_files', 'assets.json')
    try {
      const stored = JSON.parse(await fs.readFile(betaAssets, 'utf8'))
      assert.deepEqual(stored, [], `Beta's assets file holds ${JSON.stringify(stored)}`)
    } catch (err) {
      // Never written at all is equally correct.
      if (err.code !== 'ENOENT') throw err
    }
  })

  await check('both projects are in the recents list', async () => {
    const recents = await evaluate(
      cdp,
      `return window.__fluxDev.project.getRecents().map(r => r.name);`,
    )
    assert.ok(recents.includes('Alpha'), `got ${JSON.stringify(recents)}`)
    assert.ok(recents.includes('Beta'), `got ${JSON.stringify(recents)}`)
  })

  await check('creating over an existing project is refused in the app too', async () => {
    const error = await evaluate(
      cdp,
      `const r = await window.__fluxDev.project.createProject(${js(parent)}, 'Alpha');
       return r.ok ? null : r.error;`,
    )
    assert.equal(error, 'already-a-project')
  })

  // ── copy on import ────────────────────────────────────────────

  // Page-side helper: waits on a condition rather than a duration.
  const UNTIL = `
    window.__until = async (fn, ms = 20000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const v = fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    };
  `

  await check('importing with no preference set puts the question on screen', async () => {
    const state = await evaluate(
      cdp,
      UNTIL +
        `const { importMode, project, assets } = window.__fluxDev;
       await project.openProject(${js(projectA)});
       importMode.setImportMode('ask');
       assets.removeAssets(assets.getAssets().map(a => a.id));
       await window.__fluxDev.commands.run('content.collapseTree');

       // Navigate the grid to the fixtures the way a user would.
       const home = [...document.querySelectorAll('.cb-quick-item')].find(b => b.textContent === 'Home');
       home.click();
       const folder = await window.__until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'flux-media-test'));
       folder.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

       // Clear any selection a previous check left behind, so the count in the
       // dialog title is deterministic.
       for (const sel of document.querySelectorAll('.card--selected')) {
         sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
       }
       await window.__until(() => !document.querySelector('.card--selected')) ?? null;

       const card = await window.__until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'clipA.mp4'));
       card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

       const importBtn = await window.__until(() =>
         [...document.querySelectorAll('.cb-btn')].find(b => b.textContent.startsWith('Import 1')));
       importBtn.click();

       const dialog = await window.__until(() => document.querySelector('.dialog'));
       return {
         shown: !!dialog,
         title: dialog?.querySelector('.dialog-title')?.textContent,
         choices: [...document.querySelectorAll('.choice-name')].map(e => e.textContent),
         imported: assets.getAssets().length,
       };`,
    )
    assert.equal(state.shown, true, 'the copy-or-link dialog should be up')
    assert.equal(state.title, 'Import 1 file')
    assert.deepEqual(state.choices, [
      'Copy into the project',
      'Leave the files where they are',
    ])
    assert.equal(state.imported, 0, 'nothing should be imported until the question is answered')
  })

  await check('choosing copy from the dialog copies the file and imports it', async () => {
    const result = await evaluate(
      cdp,
      `const { assets } = window.__fluxDev;
       const copyBtn = [...document.querySelectorAll('.choice')]
         .find(c => c.querySelector('.choice-name')?.textContent === 'Copy into the project');
       copyBtn.click();
       const done = await window.__until(() => assets.getAssets().length > 0, 30000);
       return assets.getAssets().map(a => ({ path: a.path, inProject: a.inProject }));`,
    )
    assert.equal(result.length, 1, 'the choice should have completed the import')
    assert.ok(
      result[0].path.startsWith(path.join(projectA, 'imports')),
      `expected a path in imports, got ${result[0].path}`,
    )
    assert.equal(result[0].inProject, true)
  })

  await check('dismissing the dialog imports nothing', async () => {
    const count = await evaluate(
      cdp,
      `const { assets, importMode } = window.__fluxDev;
       importMode.setImportMode('ask');
       assets.removeAssets(assets.getAssets().map(a => a.id));

       const card = await window.__until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'still.jpg'));
       card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
       const importBtn = await window.__until(() =>
         [...document.querySelectorAll('.cb-btn')].find(b => b.textContent.startsWith('Import 1')));
       importBtn.click();

       const scrim = await window.__until(() => document.querySelector('.palette-scrim'));
       scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
       await new Promise(r => setTimeout(r, 500));
       return { open: !!document.querySelector('.dialog'), imported: assets.getAssets().length };`,
    )
    assert.equal(count.open, false, 'the dialog should have closed')
    assert.equal(count.imported, 0, 'cancelling must not import')
  })

  await check('copying an import puts the file in imports and points the asset at it', async () => {
    const result = await evaluate(
      cdp,
      `const { project, assets, store } = window.__fluxDev;
       assets.removeAssets(assets.getAssets().map(a => a.id));
       const copy = await project.copyIntoImports(${js(path.join(MEDIA_DIR, 'clipA.mp4'))});
       if (!copy.ok) throw new Error('copy failed: ' + copy.error);
       assets.importAssets([{ path: copy.path, kind: 'video', size: copy.size, inProject: true }]);
       await store.flushStores();
       return assets.getAssets().map(a => ({ path: a.path, inProject: a.inProject }));`,
    )
    assert.equal(result.length, 1)
    assert.ok(
      result[0].path.startsWith(path.join(projectA, 'imports')),
      `asset should point into imports, got ${result[0].path}`,
    )
    assert.equal(result[0].inProject, true)

    // Not an exact listing: an earlier check already copied clipA.mp4, so this
    // one correctly lands as "clipA (1).mp4". What matters is that the file the
    // asset points at is really there.
    const imports = await fs.readdir(path.join(projectA, 'imports'))
    assert.ok(
      imports.includes(path.basename(result[0].path)),
      `${path.basename(result[0].path)} not found in ${JSON.stringify(imports)}`,
    )
  })

  await check('the copied file is a real playable copy, not a stub', async () => {
    const copied = path.join(projectA, 'imports', 'clipA.mp4')
    const [a, b] = await Promise.all([fs.stat(copied), fs.stat(path.join(MEDIA_DIR, 'clipA.mp4'))])
    assert.equal(a.size, b.size, 'copy and original should be the same size')

    // And the renderer can actually decode it through the protocol.
    const thumb = await evaluate(
      cdp,
      `const t = window.__fluxDev.thumbnails;
       const p = ${js(copied)};
       t.invalidateThumbnail(p);
       const url = window.flux.fs.assetUrl(p);
       return typeof (await t.requestThumbnail(p, 'video', url)) === 'string';`,
    )
    assert.equal(thumb, true, 'the copied file should decode')
  })

  await check('the original is left where it was', async () => {
    await fs.access(path.join(MEDIA_DIR, 'clipA.mp4'))
  })

  await check('a remembered choice stops the dialog appearing', async () => {
    const mode = await evaluate(
      cdp,
      `const { importMode, store } = window.__fluxDev;
       importMode.setImportMode('link');
       await store.flushStores();
       await importMode.loadImportMode();
       return importMode.getImportMode();`,
    )
    assert.equal(mode, 'link')
  })

  await check('the palette can put the question back', async () => {
    const mode = await evaluate(
      cdp,
      `await window.__fluxDev.commands.run('content.resetImportMode');
       return window.__fluxDev.importMode.getImportMode();`,
    )
    assert.equal(mode, 'ask')
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  // Leave the app at the launcher and take the temp projects with us.
  await toLauncher().catch(() => {})
  await evaluate(cdp, `window.__fluxDev.importMode.setImportMode('link'); return true;`).catch(
    () => {},
  )
  cdp.close()
  await fs.rm(tmp, { recursive: true, force: true })
}

report()
