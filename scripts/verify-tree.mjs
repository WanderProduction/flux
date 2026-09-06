/**
 * Verifies the Content Browser's two rail trees: the local disk tree (drives as
 * roots, lazy expand/collapse) and the project tree.
 *
 * Drives the real rendered rows — chevrons are clicked, arrow keys dispatched as
 * real KeyboardEvents — so the app's own handlers run.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-tree.mjs [mediaDir]
 *
 * Expects fixtures in ~/flux-media-test. Clears the project's assets.
 *
 * Three rules this file learned the hard way:
 *   - Never wait for a duration, wait for a condition. A cold directory read is
 *     sometimes slower than any sleep you would guess.
 *   - Never identify a row by its label. `Users` and `Program Files` exist on
 *     most drives, so a label match silently picks a row on the wrong one.
 *     Paths are unique; use them.
 *   - Every check opens the branches it needs starting from a collapsed tree, so
 *     no check depends on state another one happened to leave behind.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  attach,
  createChecker,
  ensureProject,
  evaluate,
  requireFixtures,
  resetProject,
} from './cdp.mjs'

const MEDIA_DIR = process.argv[2] ?? path.join(os.homedir(), 'flux-media-test')
const dir = JSON.stringify(MEDIA_DIR)
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')
const PC = 'This PC'

// Written as they appear inside the evaluated page source, where `\\` is one
// backslash. C_ROOT therefore evaluates to `C:\` and C_USERS to `C:\Users`.
const C_ROOT = 'C:\\\\'
const C_USERS = 'C:\\\\Users'

const { check, report } = createChecker()
const cdp = await attach()

const HELPERS = String.raw`
  window.__tree = {
    sectionOf(title) {
      const wanted = title === 'Project Folders' ? 'Project' : title;
      const el = [...document.querySelectorAll('.cb-tree-section')]
        .find(s => s.querySelector('.cb-rail-title')?.textContent === wanted);
      if (!el) throw new Error('no rail section ' + title);
      return el;
    },
    rowsIn(title) {
      // The Project section holds one tree now: the project's real folders.
      // The synthetic Assets bin is gone - the imports folder is the bin.
      if (title === 'Project' || title === 'Project Folders') {
        return [...this.sectionOf('Project').querySelectorAll('.cb-subtree--folders .tree-row')];
      }
      return [...this.sectionOf(title).querySelectorAll('.tree-row')];
    },
    cards() {
      return [...document.querySelectorAll('.cb-grid .card')].map(c => ({
        name: c.querySelector('.card-name')?.textContent,
        badge: c.querySelector('.card-badge')?.textContent ?? null,
        missing: c.classList.contains('card--missing'),
        kind: c.querySelector('.card-kind')?.textContent,
      }));
    },
    cardByName(name) {
      return [...document.querySelectorAll('.cb-grid .card')]
        .find(c => c.querySelector('.card-name')?.textContent === name);
    },
    describe(title) {
      return this.rowsIn(title).map(r => ({
        label: r.querySelector('.tree-label')?.textContent,
        depth: Math.round((parseInt(r.style.paddingLeft) - 6) / 12),
        expanded: r.getAttribute('aria-expanded'),
        selected: r.getAttribute('aria-selected') === 'true',
        path: r.dataset.path,
      }));
    },
    byLabel(title, label) {
      return this.rowsIn(title).find(r => r.querySelector('.tree-label')?.textContent === label);
    },
    byPath(title, p) {
      return this.rowsIn(title).find(r => r.dataset.path === p);
    },
    async until(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    },
    waitForPath(title, p, timeoutMs) {
      return this.until(() => this.byPath(title, p), timeoutMs);
    },
    /** Clicks a row's chevron and waits for the expansion to actually settle. */
    async toggleByPath(title, p) {
      const row = await this.waitForPath(title, p);
      if (!row) throw new Error('no row at ' + p);
      const wasOpen = row.getAttribute('aria-expanded') === 'true';
      row.querySelector('.tree-chevron').click();
      const settled = await this.until(() => {
        const now = this.byPath(title, p);
        if (!now) return null;
        const open = now.getAttribute('aria-expanded') === 'true';
        if (open === wasOpen) return null;
        // An opening row is not done until its loading marker has cleared.
        if (open && now.classList.contains('tree-row--loading')) return null;
        return now;
      });
      if (!settled) throw new Error('row ' + p + ' never finished toggling');
      return settled;
    },
    async collapseAll() {
      await window.__fluxDev.commands.run('content.collapseTree');
      await this.until(() =>
        this.rowsIn('This PC').every(r => r.getAttribute('aria-expanded') === 'false'));
    },
    /**
     * From a fully collapsed tree, opens each path in order. Every check that
     * needs a branch open builds it this way rather than inheriting whatever the
     * previous check left behind.
     */
    async openChain(title, paths) {
      await this.collapseAll();
      for (const p of paths) await this.toggleByPath(title, p);
    },
    async key(row, key) {
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
    },
  };
  return true;
`

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await requireFixtures(cdp, MEDIA_DIR)
  await resetProject(cdp)
  await evaluate(cdp, `window.__fluxDev.commands.run('panel.focus.content'); return true;`)
  await evaluate(cdp, HELPERS)

  // ── local disk tree ───────────────────────────────────────────

  await check('the rail sections are ordered Project, Pinned, This PC, Quick', async () => {
    const titles = await evaluate(
      cdp,
      `return [...document.querySelectorAll('.cb-rail-title')].map(e => e.textContent);`,
    )
    assert.deepEqual(
      titles,
      ['Project', 'Pinned', 'This PC', 'Quick'],
      'the rail sections should read Project, Pinned, This PC, Quick in that order',
    )
  })

  await check('the Project section shows the project folder and its folders', async () => {
    const rows = await evaluate(
      cdp,
      `const t = window.__tree;
       const root = t.rowsIn('Project Folders')[0];
       // It opens itself, so the three folders are visible without a click.
       await t.until(() => t.rowsIn('Project Folders').length > 1);
       return t.rowsIn('Project Folders').map(r => ({
         label: r.querySelector('.tree-label')?.textContent,
         depth: Math.round((parseInt(r.style.paddingLeft) - 6) / 12),
       }));`,
    )
    assert.equal(rows[0].depth, 0, 'the project folder is the root')
    const children = rows.filter((r) => r.depth === 1).map((r) => r.label).sort()
    assert.deepEqual(children, ['exports', 'imports', 'project_files', 'sequences'])
  })

  await check('every mounted drive is its own collapsed root', async () => {
    const rows = await evaluate(
      cdp,
      `await window.__tree.collapseAll(); return window.__tree.describe('${PC}');`,
    )
    assert.ok(rows.length > 0, 'no drive rows rendered')
    assert.ok(rows.every((r) => r.depth === 0), 'drives should all be roots')
    assert.ok(
      rows.every((r) => /^[A-Z]:$/.test(r.label)),
      `expected drive letters, got ${JSON.stringify(rows.map((r) => r.label))}`,
    )
    assert.ok(rows.every((r) => r.expanded === 'false'), 'drives should start collapsed')
    assert.ok(
      rows.every((r) => r.path.endsWith('\\')),
      'a drive root path needs its trailing slash to be valid',
    )
  })

  await check('expanding a drive lazily loads its subfolders', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.collapseAll();
       const before = t.describe('${PC}').length;
       await t.toggleByPath('${PC}', '${C_ROOT}');
       return { before, after: t.describe('${PC}') };`,
    )
    assert.ok(result.after.length > result.before, 'expanding added no rows')
    assert.ok(result.after.filter((r) => r.depth === 1).length > 0, 'no children at depth 1')
    assert.equal(result.after[0].expanded, 'true', 'C: should report itself expanded')
  })

  await check('the tree hides Windows system folders', async () => {
    const labels = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}']);
       return t.describe('${PC}').map(r => r.label);`,
    )
    assert.ok(
      !labels.some((l) => l.startsWith('$') || l === 'System Volume Information'),
      `system folders leaked: ${labels.filter((l) => l.startsWith('$')).join(', ')}`,
    )
  })

  await check('collapsing hides the children again', async () => {
    const rows = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}']);
       await t.toggleByPath('${PC}', '${C_ROOT}');
       return t.describe('${PC}');`,
    )
    assert.ok(rows.every((r) => r.depth === 0), 'children should be gone after collapse')
  })

  await check('a nested folder expands to its own depth', async () => {
    const rows = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}', '${C_USERS}']);
       return t.describe('${PC}');`,
    )
    const depth2 = rows.filter((r) => r.depth === 2)
    assert.ok(depth2.length > 0, 'expected grandchildren under C:\\Users')
    assert.ok(
      depth2.every((r) => r.path.startsWith('C:\\Users\\')),
      'depth-2 rows should all live under C:\\Users',
    )
  })

  await check('clicking a folder row lists that folder in the grid', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}']);
       const row = await t.waitForPath('${PC}', '${C_USERS}');
       row.click();
       await t.until(() => document.querySelectorAll('.cb-crumb').length === 2);
       return {
         crumbs: [...document.querySelectorAll('.cb-crumb')].map(c => c.textContent.replace(' \u203a','')),
         selected: t.byPath('${PC}', '${C_USERS}')?.getAttribute('aria-selected'),
       };`,
    )
    assert.deepEqual(result.crumbs, ['C:', 'Users'])
    assert.equal(result.selected, 'true', 'the clicked row should be selected')
  })

  await check('arrow keys collapse, expand and move between rows', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}', '${C_USERS}']);
       const at = () => t.byPath('${PC}', '${C_USERS}');

       await t.key(at(), 'ArrowLeft');
       const afterLeft = at().getAttribute('aria-expanded');

       await t.key(at(), 'ArrowRight');
       await t.until(() => at()?.getAttribute('aria-expanded') === 'true');
       const afterRight = at().getAttribute('aria-expanded');

       await t.key(at(), 'ArrowDown');
       return { afterLeft, afterRight, focusedPath: document.activeElement?.dataset?.path };`,
    )
    assert.equal(result.afterLeft, 'false', 'ArrowLeft should collapse')
    assert.equal(result.afterRight, 'true', 'ArrowRight should expand')
    assert.ok(result.focusedPath, 'ArrowDown should move focus to a row')
    assert.notEqual(result.focusedPath, 'C:\\Users', 'focus should have moved off C:\\Users')
  })

  await check('an unreadable folder comes back as data, not an exception', async () => {
    const result = await evaluate(
      cdp,
      `return await window.flux.fs.subfolders('C:\\\\System Volume Information');`,
    )
    assert.equal(result.ok, false)
    assert.ok(['denied', 'unreadable'].includes(result.error))
  })

  await check('descending via a folder card reveals that path in the tree', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.collapseAll();

       const home = [...document.querySelectorAll('.cb-quick-item')].find(b => b.textContent === 'Home');
       home.click();
       const card = await t.until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'flux-media-test'));
       if (!card) throw new Error('fixture folder not visible in Home');
       card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

       const row = await t.waitForPath('${PC}', ${dir});
       return {
         revealed: !!row,
         selected: row?.getAttribute('aria-selected'),
         depth: row ? Math.round((parseInt(row.style.paddingLeft) - 6) / 12) : -1,
       };`,
    )
    assert.equal(result.revealed, true, 'the tree should have opened down to the fixture folder')
    assert.equal(result.selected, 'true', 'the revealed folder should be selected')
    assert.ok(result.depth >= 3, `expected a nested depth, got ${result.depth}`)
  })

  // ── the project's folders, and the bin ────────────────────────

  await check('the project tree shows the real folders and nothing invented', async () => {
    // There used to be a synthetic "Assets" node beside these, which meant two
    // lists of the same footage that agreed only some of the time.
    const labels = await evaluate(cdp, `return window.__tree.describe('Project').map(r => r.label);`)
    assert.ok(labels.includes('imports'), `expected imports, got ${JSON.stringify(labels)}`)
    assert.ok(labels.includes('exports'))
    assert.ok(labels.includes('project_files'))
    assert.ok(!labels.includes('Assets'), 'the invented Assets node should be gone')
  })

  await check('the browser opens in the project imports folder', async () => {
    const current = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('content.project');
       await window.__tree.until(() =>
         document.querySelector('.cb-crumb--current')?.textContent === 'imports');
       return document.querySelector('.cb-crumb--current')?.textContent;`,
    )
    assert.equal(current, 'imports', 'imports is the bin, and is where the browser lands')
  })

  await check('the project tree is separate from the disk tree', async () => {
    // The project's folders are its own; a drive must not leak into them.
    const labels = await evaluate(cdp, `return window.__tree.describe('Project').map(r => r.label);`)
    assert.ok(!labels.includes('C:'), 'a drive leaked into the project tree')
    assert.ok(!labels.includes('flux-media-test'), 'a disk folder leaked into the project tree')
  })

  await check('a linked asset is visible in the bin, marked as linked', async () => {
    // The property the removed bin existed for. A linked file lives outside
    // imports, so without this it would be in the project, on the timeline, and
    // findable nowhere in the browser at all.
    const cards = await evaluate(
      cdp,
      `const t = window.__tree;
       const { importPipeline, importMode, commands } = window.__fluxDev;
       importMode.setImportMode('link');
       await importPipeline.importFiles([
         { path: ${dir} + '\\\\clipA.mp4', kind: 'video' },
         { path: ${dir} + '\\\\still.jpg', kind: 'image' },
       ]);
       await commands.run('content.project');
       await t.until(() => t.cardByName('clipA.mp4'));
       return t.cards();`,
    )
    const names = cards.map((c) => c.name).sort()
    assert.deepEqual(names, ['clipA.mp4', 'still.jpg'])
    assert.ok(
      cards.every((c) => c.badge === 'linked'),
      `expected every card marked linked, got ${JSON.stringify(cards)}`,
    )
  })

  await check('an asset card can be dragged from the bin to the timeline', async () => {
    const clips = await evaluate(
      cdp,
      `const t = window.__tree;
       const { sequence, assets } = window.__fluxDev;
       sequence.clearSequence();
       await assets.ensureProbed(assets.getAssets().find(a => a.name === 'clipA.mp4').id);

       const card = t.cardByName('clipA.mp4');
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const carried = [...dt.types];
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       await t.until(() => sequence.getSequence().clips.length > 0);
       return { clips: sequence.getSequence().clips.length, carried };`,
    )
    assert.equal(clips.clips, 1, 'dragging a bin card should place a clip')
    assert.deepEqual(
      clips.carried,
      ['application/x-flux-assets'],
      'something already in the project drags by id, so the drop is a pure placement',
    )
  })

  await check('an offline asset is marked on its card', async () => {
    const card = await evaluate(
      cdp,
      `const t = window.__tree;
       const { assets, commands } = window.__fluxDev;
       assets.importAssets([{ path: ${dir} + '\\\\ghost.mp4', kind: 'video', name: 'ghost.mp4' }]);
       await assets.recheckMissing();
       await commands.run('content.project');
       // Wait for the rendered state, not merely the card: it exists from the
       // import render, before the missing flag has been applied to it.
       await t.until(() => t.cards().find(c => c.name === 'ghost.mp4')?.missing);
       return t.cards().find(c => c.name === 'ghost.mp4');`,
    )
    assert.equal(card.missing, true, 'a vanished file must be marked on the card')
  })

  await check('removing an asset takes it out of the bin', async () => {
    const after = await evaluate(
      cdp,
      `const t = window.__tree;
       const { assets } = window.__fluxDev;
       const ghost = assets.getAssets().find(a => a.name === 'ghost.mp4');
       t.cardByName('ghost.mp4').querySelector('.card-remove').click();
       await t.until(() => !assets.getAssets().some(a => a.id === ghost.id));
       return t.cards().map(c => c.name);`,
    )
    assert.ok(!after.includes('ghost.mp4'), 'the card should be gone with the asset')
  })

  // ── rail resizing ─────────────────────────────────────────────

  await check('the rail can be resized and the width is remembered', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const cb = document.querySelector('.cb');
       const widthNow = () => parseFloat(getComputedStyle(cb).gridTemplateColumns.split(' ')[0]);
       const drag = async (dx) => {
         const resizer = document.querySelector('.cb-resizer');
         const rect = resizer.getBoundingClientRect();
         resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left }));
         window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + dx }));
         window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
         await new Promise(r => setTimeout(r, 300));
         return widthNow();
       };

       // Shrink first. The width persists between runs, so starting at the
       // clamp ceiling would make a widening drag a no-op through no fault of
       // the resizer.
       const narrow = await drag(-140);
       const wide = await drag(60);
       await new Promise(r => setTimeout(r, 400));
       return { narrow, wide, stored: await window.flux.store.get('ui-content-browser') };`,
    )
    assert.ok(
      result.wide > result.narrow,
      `rail did not widen (${result.narrow} -> ${result.wide})`,
    )
    assert.ok(
      Math.abs(result.stored - result.wide) < 2,
      `stored width ${result.stored} should match the final ${result.wide}`,
    )
  })

  // ── pinning ───────────────────────────────────────────────────

  await check('pinning the open folder puts it in the Pinned section', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const { pinned } = window.__fluxDev;
       // Start clean so the assertion is about this pin, not a leftover.
       pinned.getPinned().forEach(p => pinned.unpinFolder(p.path));

       const target = ${dir};
       const home = [...document.querySelectorAll('.cb-quick-item')].find(b => b.textContent === 'Home');
       home.click();
       const card = await t.until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'flux-media-test'));
       card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       await t.until(() => document.querySelector('.cb-crumb--current')?.textContent === 'flux-media-test');

       const pinBtn = await t.until(() =>
         [...document.querySelectorAll('.cb-btn')].find(b => b.textContent === 'Pin'));
       pinBtn.click();

       const row = await t.waitForPath('Pinned', target);
       return {
         inSection: !!row,
         label: row?.querySelector('.tree-label')?.textContent,
         buttonNow: [...document.querySelectorAll('.cb-btn')].some(b => b.textContent === 'Pinned'),
         stored: pinned.getPinned().map(p => p.path),
       };`,
    )
    assert.equal(result.inSection, true, 'the folder should appear under Pinned')
    assert.equal(result.label, 'flux-media-test')
    assert.equal(result.buttonNow, true, 'the button should flip to "Pinned"')
    assert.deepEqual(result.stored, [MEDIA_DIR])
  })

  await check('a pinned folder expands like any other', async () => {
    const rows = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.toggleByPath('Pinned', ${dir});
       return t.describe('Pinned').map(r => r.label);`,
    )
    assert.ok(rows.includes('Nested'), `expected the subfolder, got ${JSON.stringify(rows)}`)
  })

  await check('unpinning removes it again', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const unpin = [...document.querySelectorAll('.cb-btn')].find(b => b.textContent === 'Pinned');
       unpin.click();
       await t.until(() => !t.byPath('Pinned', ${dir}));
       return {
         gone: !t.byPath('Pinned', ${dir}),
         stored: window.__fluxDev.pinned.getPinned().length,
       };`,
    )
    assert.equal(result.gone, true)
    assert.equal(result.stored, 0)
  })

  // ── import split button ───────────────────────────────────────

  await check('the import button offers Import Copy and Import Origin', async () => {
    const items = await evaluate(
      cdp,
      `const t = window.__tree;
       document.querySelector('.split-button-caret').click();
       const menu = await t.until(() => document.querySelector('.split-menu'));
       const labels = [...menu.querySelectorAll('.split-menu-item > span:first-child')]
         .map(e => e.textContent);
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       return labels;`,
    )
    assert.deepEqual(items, ['Import Copy', 'Import Origin'])
  })

  await check('Import Origin imports without copying, skipping the question', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const { assets, importMode } = window.__fluxDev;
       assets.removeAssets(assets.getAssets().map(a => a.id));
       // 'ask' would normally raise the dialog; the explicit menu item must not.
       importMode.setImportMode('ask');

       const card = await t.until(() => [...document.querySelectorAll('.card')]
         .find(c => c.querySelector('.card-name')?.textContent === 'clipA.mp4'));
       card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

       document.querySelector('.split-button-caret').click();
       const menu = await t.until(() => document.querySelector('.split-menu'));
       [...menu.querySelectorAll('.split-menu-item')]
         .find(b => b.textContent.startsWith('Import Origin')).click();

       await t.until(() => assets.getAssets().length > 0);
       return {
         dialogShown: !!document.querySelector('.dialog'),
         paths: assets.getAssets().map(a => ({ path: a.path, inProject: a.inProject })),
       };`,
    )
    assert.equal(result.dialogShown, false, 'an explicit choice must not ask again')
    assert.equal(result.paths.length, 1)
    assert.ok(
      result.paths[0].path.startsWith(MEDIA_DIR),
      `should point at the original, got ${result.paths[0].path}`,
    )
    assert.ok(!result.paths[0].inProject)
  })

  await check('a media card is labelled by kind, and a folder is not', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const clip = t.cards().find(c => c.name === 'clipA.mp4');
       const folderRow = t.rowsIn('Project').find(
         r => r.querySelector('.tree-label')?.textContent === 'imports');
       return { kind: clip?.kind, folder: folderRow?.querySelector('.tree-icon')?.getAttribute('class') };`,
    )
    assert.equal(result.kind, 'video', `card kind was ${result.kind}`)
    assert.ok(result.folder?.includes('tree-icon--folder'), `folder icon was ${result.folder}`)
  })

  await check('an arrow the tree has answered does not also step the playhead', async () => {
    /*
     * The bare arrows step the playhead a frame at a time, which is what they
     * do in every NLE — and the tree walks its rows with the same four keys.
     * Both listen: the tree on the focused row, the keymap on the window. So
     * without a rule, one press does both, and arrowing down the bin quietly
     * drags the playhead through the sequence.
     *
     * The rule is that a key something else has already answered is not ours,
     * which is why this dispatches a *cancelable* event: preventDefault on one
     * that is not cancelable does nothing at all, and the check would then pass
     * against a build with no guard in it.
     */
    const state = await evaluate(
      cdp,
      `const { importPipeline, importMode, assets, sequence, playback } = window.__fluxDev;
       importMode.setImportMode('link');
       await importPipeline.importFiles([{ path: ${dir} + '\\\\clipA.mp4', kind: 'video' }]);
       const one = assets.getAssets().find(a => a.name === 'clipA.mp4');
       const probed = await assets.ensureProbed(one.id);
       sequence.clearSequence();
       sequence.addClip(
         { assetId: one.id, trackId: 'V1', start: 0, duration: probed.duration });
       playback.pause();
       playback.seek(1);
       await new Promise(r => setTimeout(r, 300));

       const t = window.__tree;
       await t.openChain('${PC}', ['${C_ROOT}']);
       const row = t.byPath('${PC}', '${C_ROOT}');
       row.focus();
       const focused = document.activeElement === row;
       const before = playback.getTime();
       row.dispatchEvent(new KeyboardEvent('keydown',
         { key: 'ArrowRight', bubbles: true, cancelable: true }));
       window.dispatchEvent(new KeyboardEvent('keyup',
         { key: 'ArrowRight', bubbles: true, cancelable: true }));
       await new Promise(r => setTimeout(r, 400));
       const after = playback.getTime();

       /*
        * And the same key with nothing in its way still steps.
        *
        * Without this half, a keymap that had simply stopped listening to the
        * arrows would pass — the check would be measuring an absence and
        * calling it a rule.
        */
       window.dispatchEvent(new KeyboardEvent('keydown',
         { key: 'ArrowRight', bubbles: true, cancelable: true }));
       window.dispatchEvent(new KeyboardEvent('keyup',
         { key: 'ArrowRight', bubbles: true, cancelable: true }));
       await new Promise(r => setTimeout(r, 300));
       const stepped = playback.getTime();
       sequence.clearSequence();
       return { focused, before, after, stepped };`,
    )
    assert.equal(state.focused, true, 'setup: the row should have taken focus')
    assert.equal(state.after, state.before, 'the tree answered the arrow, so the playhead stayed')
    assert.ok(
      state.stepped > state.after,
      `and the same key with nothing in the way still steps — ${state.after} to ${state.stepped}`,
    )
  })

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
