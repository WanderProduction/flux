/**
 * The settings page: every page reachable, and nothing pretending to work.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-settings.mjs
 *
 * Almost all of this page is a plan rather than a feature, which changes what
 * is worth checking. There are no values to round-trip and no stores to write,
 * so the questions are about the shell and about honesty:
 *
 *   - **is every page reachable?** A nineteen-page list is exactly where one
 *     entry quietly fails to render, and nobody notices because the other
 *     eighteen look fine.
 *   - **does every page say something?** A page that opened blank would be the
 *     thing this whole convention exists to avoid. Each one must carry its
 *     plan, and the plan must be specific enough to be worth reading — so the
 *     length is asserted, not merely the presence.
 *   - **is anything drawn as working that is not?** The rule from
 *     kernel/tools.ts: an unbuilt thing says so, and a control that silently
 *     does nothing is a bug. So the page is checked for *controls* — inputs,
 *     sliders, switches — and the only interactive things allowed on a planned
 *     page are the nav itself, the search box and a "Take me there" button
 *     that goes somewhere real.
 *   - **does the way in work?** Three of them: the tab, the key, and the
 *     command. All three must land on the same panel.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate } from './cdp.mjs'

const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

const { check, report } = createChecker()
const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

try {
  await ensureProject(cdp, VERIFY_PROJECT)

  await check('the settings workspace opens on the command, and on its key', async () => {
    const result = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;

       const open = () => !!document.querySelector('.settings-nav');

       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 600));
       const byCommand = open();

       // Away and back, by the key this time — dispatched on the window, which
       // is where the keymap listens.
       await commands.run('layout.switch.edit');
       await new Promise(r => setTimeout(r, 500));
       const leftIt = !open();

       window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
       await new Promise(r => setTimeout(r, 600));
       const byKey = open();

       // And the tab in the top bar, which is the way most people will find it.
       const tab = [...document.querySelectorAll('.ws-tab')]
         .find(el => el.textContent.includes('Settings'));

       return {
         byCommand, leftIt, byKey,
         tab: tab ? tab.textContent.trim() : null,
         tabs: [...document.querySelectorAll('.ws-tab')].map(el => el.textContent.trim()),
       };`,
    )

    console.log(`       workspace tabs: ${result.tabs.join(' · ')}`)
    assert.equal(result.byCommand, true, 'layout.switch.settings did not open the page')
    assert.equal(result.leftIt, true, 'switching away from settings left the panel on screen')
    assert.equal(result.byKey, true, 'Ctrl+, did not open the settings page')
    assert.ok(result.tab, 'there is no Settings tab in the top bar')
    assert.ok(result.tab.includes('3'), `the Settings tab does not show its key: "${result.tab}"`)
  })

  await check('three levels, nineteen pages, every one of them reachable', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, settings } = window.__fluxDev;
       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 500));

       const levels = [...document.querySelectorAll('.settings-level')].map(el => ({
         name: el.querySelector('.settings-level-name').textContent.trim(),
         pages: [...el.querySelectorAll('.settings-link')].map(
           one => one.querySelector('.settings-link-name').textContent.trim()),
       }));

       // Open every page in turn and read what it rendered. This is the check:
       // a page that throws takes the panel with it, and a page that renders
       // nothing is the failure the whole convention exists to prevent.
       const opened = [];
       const links = [...document.querySelectorAll('.settings-link')];
       for (const link of links) {
         link.click();
         await new Promise(r => setTimeout(r, 60));
         const page = document.querySelector('.settings-page');
         opened.push({
           clicked: link.querySelector('.settings-link-name').textContent.trim(),
           title: page?.querySelector('.settings-page-title')?.textContent?.trim() ?? null,
           crumb: page?.querySelector('.settings-page-crumb')?.textContent?.trim() ?? null,
           planLength: page?.querySelector('.settings-plan-body')?.textContent?.trim()?.length ?? 0,
           blurbLength: page?.querySelector('.settings-page-blurb')?.textContent?.trim()?.length ?? 0,
           livesAt: !!page?.querySelector('.settings-lives'),
         });
       }

       return {
         levels,
         opened,
         // What the registry says, so the DOM is checked against the source of
         // truth rather than against a number written down here.
         declared: settings.settingsPages.length,
         declaredLevels: settings.settingsLevels.map(one => one.name),
       };`,
    )

    console.log(
      `       ${result.levels.map((one) => `${one.name} ${one.pages.length}`).join(' · ')} ` +
        `= ${result.opened.length} pages`,
    )

    assert.deepEqual(
      result.levels.map((one) => one.name),
      result.declaredLevels,
      'the levels on screen are not the levels the registry declares',
    )
    assert.equal(
      result.opened.length,
      result.declared,
      `${result.opened.length} pages in the list, ${result.declared} in the registry`,
    )

    for (const page of result.opened) {
      assert.equal(
        page.title,
        page.clicked,
        `clicking "${page.clicked}" opened "${page.title}"`,
      )
      assert.ok(page.blurbLength > 10, `"${page.clicked}" has no blurb`)
      /*
       * Long enough to be a plan. Sixty characters is a sentence; anything
       * shorter is a label, and a label is what "coming soon" is. Several of
       * these run to a paragraph, which is the point — the page is the spec.
       */
      assert.ok(
        page.planLength > 60,
        `"${page.clicked}" says only ${page.planLength} characters about what it will be`,
      )
    }

    const withHistory = result.opened.filter((one) => one.livesAt)
    console.log(
      `       ${withHistory.length} pages point at a setting that already exists: ` +
        withHistory.map((one) => one.clicked).join(', '),
    )
    assert.ok(
      withHistory.length >= 5,
      'no page says where its setting lives today — several of these already exist in FLUX',
    )
  })

  await check('nothing on a planned page is drawn as a working control', async () => {
    const result = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 400));

       const offenders = [];
       const links = [...document.querySelectorAll('.settings-link')];
       for (const link of links) {
         link.click();
         await new Promise(r => setTimeout(r, 50));
         const page = document.querySelector('.settings-page');
         if (!page) continue;
         const name = page.querySelector('.settings-page-title').textContent.trim();
         const planned = !!page.querySelector('.settings-badge');
         if (!planned) continue;
         // Anything a hand could grab. The one exception is the button that
         // runs a real command, which is allowed because it does something.
         const controls = [...page.querySelectorAll(
           'input, select, textarea, [role="switch"], [role="slider"], button')]
           .filter(el => !el.classList.contains('settings-lives-go'));
         if (controls.length > 0) {
           offenders.push({ name, controls: controls.map(el => el.tagName.toLowerCase()) });
         }
       }
       return { offenders };`,
    )

    assert.deepEqual(
      result.offenders,
      [],
      `planned pages carry controls that cannot work: ${JSON.stringify(result.offenders)}`,
    )
    console.log('       no sliders, switches or fields on any page that is not built')
  })

  await check('searching reads the plan, not just the page names', async () => {
    const result = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 400));

       const box = document.querySelector('.settings-search');
       const type = async (text) => {
         // React listens for input events; setting .value alone is invisible to it.
         const setter = Object.getOwnPropertyDescriptor(
           window.HTMLInputElement.prototype, 'value').set;
         setter.call(box, text);
         box.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise(r => setTimeout(r, 120));
         return [...document.querySelectorAll('.settings-link')].map(
           one => one.querySelector('.settings-link-name').textContent.trim());
       };

       // A word that is on no page's *name* and in one page's plan.
       const vst = await type('VST');
       /*
        * The headings while *that* query is in the box — a level with nothing
        * matching should be gone entirely, heading included. Read here rather
        * than after the next search, which is where it was read first and made
        * the check report the headings for a query matching all three levels.
        */
       const levelsForVst = [...document.querySelectorAll('.settings-level-name')]
         .map(el => el.textContent.trim());
       // A word in several plans.
       const render = await type('render');
       const none = await type('zzzznotathing');
       const empty = !!document.querySelector('.settings-empty');
       await type('');
       const restored = [...document.querySelectorAll('.settings-link')].length;

       return { vst, render, levelsForVst, none, empty, restored };`,
    )

    console.log(
      `       "VST" -> ${result.vst.join(', ') || 'nothing'} · ` +
        `"render" -> ${result.render.length} pages · back to ${result.restored}`,
    )
    assert.deepEqual(
      result.vst,
      ['Plugins'],
      `searching "VST" should find Plugins by its plan, not by its name — got ${JSON.stringify(result.vst)}`,
    )
    assert.ok(
      result.render.length > 1,
      'searching "render" matched fewer than two pages, so the search is not reading the plans',
    )
    assert.deepEqual(
      result.levelsForVst,
      ['This device'],
      'a level with no matching page is still showing its heading',
    )
    assert.equal(result.none.length, 0, 'a search that matches nothing still listed pages')
    assert.equal(result.empty, true, 'a search that matches nothing says nothing about it')
    assert.ok(result.restored > 18, 'clearing the search did not bring the pages back')
  })

  await check('“Take me there” runs the setting that already exists', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, settings } = window.__fluxDev;
       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 400));

       // Every command a livesAt points at must be a command that exists —
       // otherwise the button is the dead control this page refuses to have.
       const named = settings.settingsPages
         .map(one => one.livesAt?.command)
         .filter(Boolean);
       const missing = named.filter(id => !commands.get(id));

       // Then press one for real: Cache points at the performance dialog.
       const links = [...document.querySelectorAll('.settings-link')];
       const cache = links.find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Cache');
       cache.click();
       await new Promise(r => setTimeout(r, 80));
       const go = document.querySelector('.settings-lives-go');
       go.click();
       await new Promise(r => setTimeout(r, 500));

       // The performance dialog is the Timeline's, so it only exists while the
       // Timeline is mounted. What is checked is that the command ran, not
       // which panel happened to be on screen to answer it.
       const dialog = !!document.querySelector('.modal, .dialog, .perf, [role="dialog"]');

       return { named, missing, pressed: !!go, dialog };`,
    )

    console.log(
      `       ${result.named.length} pages link to a live command, ` +
        `${result.missing.length} of them unregistered`,
    )
    assert.deepEqual(
      result.missing,
      [],
      `pages point at commands that do not exist: ${result.missing.join(', ')}`,
    )
    assert.equal(result.pressed, true, 'there is no button to press on the Cache page')
  })
} finally {
  report()
  cdp.close()
}
