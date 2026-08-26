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
      const el = [...document.querySelectorAll('.cb-tree-section')]
        .find(s => s.querySelector('.cb-rail-title')?.textContent === title);
      if (!el) throw new Error('no rail section ' + title);
      return el;
    },
    rowsIn(title) {
      return [...this.sectionOf(title).querySelectorAll('.tree-row')];
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

  await check('the rail shows a Project tree and a This PC tree', async () => {
    const titles = await evaluate(
      cdp,
      `return [...document.querySelectorAll('.cb-rail-title')].map(e => e.textContent);`,
    )
    assert.ok(titles.includes('Project'), `got ${JSON.stringify(titles)}`)
    assert.ok(titles.includes('This PC'), `got ${JSON.stringify(titles)}`)
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

  // ── project tree ──────────────────────────────────────────────

  await check('the project tree is empty before anything is imported', async () => {
    const rows = await evaluate(cdp, `return window.__tree.describe('Project');`)
    assert.equal(rows[0].label, 'Assets')
    assert.ok(
      rows.some((r) => r.label === 'nothing imported'),
      `expected an empty note, got ${JSON.stringify(rows.map((r) => r.label))}`,
    )
  })

  await check('imported files appear as leaves under the project root', async () => {
    const rows = await evaluate(
      cdp,
      `const t = window.__tree;
       window.__fluxDev.assets.importAssets([
         { path: ${dir} + '\\\\clipA.mp4', kind: 'video' },
         { path: ${dir} + '\\\\still.jpg', kind: 'image' },
       ]);
       await t.until(() => t.rowsIn('Project').length === 3);
       return t.describe('Project');`,
    )
    assert.deepEqual(
      rows.map((r) => r.label),
      ['Assets', 'clipA.mp4', 'still.jpg'],
    )
    assert.ok(rows.slice(1).every((r) => r.depth === 1), 'assets sit one level under the root')
  })

  await check('the project tree is separate from the disk tree', async () => {
    // A project asset is a reference, not a location: the folder it happens to
    // live in must not appear in the project tree.
    const labels = await evaluate(cdp, `return window.__tree.describe('Project').map(r => r.label);`)
    assert.ok(!labels.includes('C:'), 'a drive leaked into the project tree')
    assert.ok(!labels.includes('flux-media-test'), 'a disk folder leaked into the project tree')
  })

  await check('collapsing the project root hides its assets', async () => {
    const labels = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.toggleByPath('Project', '::project');
       return t.describe('Project').map(r => r.label);`,
    )
    assert.deepEqual(labels, ['Assets'])
  })

  await check('clicking an asset leaf selects that card in the project grid', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       await t.toggleByPath('Project', '::project');
       const leaf = await t.until(() => t.byLabel('Project', 'still.jpg'));
       leaf.click();
       await t.until(() => document.querySelector('.card--selected'));
       return {
         card: document.querySelector('.card--selected .card-name')?.textContent,
         inProject: !document.querySelector('.cb-crumb'),
       };`,
    )
    assert.equal(result.card, 'still.jpg', 'the matching card should be highlighted')
    assert.equal(result.inProject, true, 'the grid should have switched to the project')
  })

  await check('an asset leaf can be dragged from the tree to the timeline', async () => {
    const clips = await evaluate(
      cdp,
      `const t = window.__tree;
       const { sequence, assets } = window.__fluxDev;
       sequence.clearSequence();
       await assets.ensureProbed(assets.getAssets().find(a => a.name === 'clipA.mp4').id);

       const row = t.byLabel('Project', 'clipA.mp4');
       const lane = document.querySelectorAll('.tl-lane')[1];
       const dt = new DataTransfer();
       row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
       const rect = lane.getBoundingClientRect();
       lane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       lane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: rect.left }));
       await t.until(() => sequence.getSequence().clips.length > 0);
       return sequence.getSequence().clips.length;`,
    )
    assert.equal(clips, 1, 'dragging a tree leaf should place a clip')
  })

  await check('an offline asset is marked in the project tree', async () => {
    const result = await evaluate(
      cdp,
      `const t = window.__tree;
       const { assets } = window.__fluxDev;
       assets.importAssets([{ path: ${dir} + '\\\\ghost.mp4', kind: 'video', name: 'ghost.mp4' }]);
       await assets.recheckMissing();
       // Wait for the rendered note, not merely for the row: the row exists from
       // the import render, before the missing flag has been applied to it.
       const note = await t.until(() =>
         t.byLabel('Project', 'ghost.mp4')?.querySelector('.tree-note')?.textContent);
       return { note, missing: assets.getAssets().find(a => a.name === 'ghost.mp4')?.missing };`,
    )
    assert.equal(result.missing, true, 'the asset itself should be flagged missing')
    assert.equal(result.note, 'offline', 'the tree row should show the offline marker')
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

  await check('the page logged no console errors or uncaught exceptions', () => {
    assert.deepEqual(cdp.consoleErrors, [])
  })
} finally {
  cdp.close()
}

report()
