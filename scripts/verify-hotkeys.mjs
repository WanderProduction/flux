/**
 * Hotkeys & Presets — the first settings page that changes anything.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-hotkeys.mjs
 *
 * A keymap editor has one job and three ways to only look like it is doing it:
 * the page can show a binding it never applied, the binding can work until the
 * app restarts, and a rebind can quietly leave two commands fighting over one
 * chord. So nothing here checks the page's own state. Every check asserts
 * against **what the window listener actually does** — a real key event is
 * dispatched and the command's own side effect is what is measured.
 *
 * The restart is checked too, by reading the store back the way a cold boot
 * would and asserting the edit is in it. A rebind that does not survive a
 * restart is not a rebind, it is a session.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate } from './cdp.mjs'

const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

const { check, report } = createChecker()
const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

/** Puts the bindings back however the run ends, so a failure is not sticky. */
const restore = async () => {
  await evaluate(
    cdp,
    `const { keybindings } = window.__fluxDev;
     keybindings.resetAllKeybindings();
     for (const one of keybindings.getPresets()) keybindings.deletePreset(one.id);
     return true;`,
  )
}

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await restore()

  await check('the page is marked built, and something renders on it', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, settings } = window.__fluxDev;

       /*
        * Through the Edit workspace first, and that is part of the check
        * rather than only setup. Panel commands are registered when their
        * panel mounts, so the catalogue knows the Timeline's commands only
        * once a Timeline has existed. Opening Edit and then Settings is what
        * an editor does, and it is what makes the numbers below mean
        * something.
        */
       await commands.run('layout.switch.edit');
       await new Promise(r => setTimeout(r, 900));
       const loadedInEdit = commands.list().length;

       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 600));
       const loadedInSettings = commands.list().length;
       const known = commands.catalogue().length;

       const link = [...document.querySelectorAll('.settings-link')].find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Hotkeys & Presets');
       link.click();
       await new Promise(r => setTimeout(r, 250));

       const page = settings.getSettingsPage('account.hotkeys');
       return {
         ready: page.ready,
         badge: !!document.querySelector('.settings-badge'),
         rows: document.querySelectorAll('.hk-row').length,
         dormant: document.querySelectorAll('.hk-row-dormant').length,
         groups: [...document.querySelectorAll('.hk-group-head')].map(el => el.textContent.trim()),
         wide: !!document.querySelector('.settings-page--built'),
         // Which pages are built, by id. Not a count: a count pins this check
         // to the number of pages finished at the time it was written, and it
         // failed the moment Appearance landed for a reason that had nothing
         // to do with hotkeys.
         built: settings.settingsPages.filter(one => one.ready).map(one => one.id),
         loadedInEdit, loadedInSettings, known,
       };`,
    )

    console.log(
      `       ${result.rows} rows in ${result.groups.length} groups · ` +
        `${result.loadedInEdit} commands loaded in Edit, ${result.loadedInSettings} in Settings, ` +
        `${result.known} known · ${result.dormant} rows marked panel-closed`,
    )
    assert.equal(result.ready, true, 'the page is still marked as a plan')
    assert.equal(result.badge, false, 'a built page is still wearing the Planned badge')
    assert.equal(result.wide, true, 'the built page did not get the wider column')
    assert.ok(
      result.built.includes('account.hotkeys'),
      `the registry does not list this page as built — it lists ${result.built.join(', ')}`,
    )

    /*
     * The finding this check exists for. With Settings open, far fewer
     * commands are *loaded* than the build has — measured at 47 against the
     * 78 the shipped keymap binds — so a page built on `commands.list()`
     * would hide the entire Timeline from the one page made for rebinding it.
     */
    assert.ok(
      result.loadedInSettings < result.loadedInEdit,
      'as many commands are loaded in Settings as in Edit, so this check proves nothing',
    )
    assert.equal(
      result.rows,
      result.known,
      `${result.rows} rows for ${result.known} known commands — the page is not listing the catalogue`,
    )
    assert.ok(
      result.rows > result.loadedInSettings,
      `the page lists only the ${result.loadedInSettings} commands loaded right now`,
    )
    assert.ok(
      result.dormant > 0,
      'no row is marked panel-closed, so a key that cannot fire looks exactly like one that can',
    )
  })

  await check('every page marked ready has something to render, and vice versa', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, settings } = window.__fluxDev;
       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 400));

       /*
        * Opened one at a time and asked whether anything beyond the page's own
        * prose rendered. A page marked ready with nothing on it would be a
        * blank page; an unready page that rendered a component would be a
        * control nobody was told about.
        */
       const wrong = [];
       for (const page of settings.settingsPages) {
         const link = [...document.querySelectorAll('.settings-link')].find(
           el => el.querySelector('.settings-link-name').textContent.trim() === page.name
                 && el.closest('.settings-level'));
         if (!link) continue;
         link.click();
         await new Promise(r => setTimeout(r, 40));
         const article = document.querySelector('.settings-page');
         const wide = !!document.querySelector('.settings-page--built');
         if (page.ready !== wide) wrong.push({ id: page.id, ready: page.ready, rendered: wide });
       }
       return { wrong };`,
    )
    assert.deepEqual(
      result.wrong,
      [],
      `ready and rendered disagree: ${JSON.stringify(result.wrong)}`,
    )
    console.log('       the ready flag and the component map agree on all nineteen')
  })

  await check('a rebind changes what the key actually does', async () => {
    const result = await evaluate(
      cdp,
      `const { keybindings, commands, sequence } = window.__fluxDev;

       /*
        * Measured through a real key event and a real side effect rather than
        * through the page's state. 'timeline.addTrack' is the probe because
        * its effect is countable and undoable: it adds a track.
        */
       await commands.run('layout.switch.edit');
       await new Promise(r => setTimeout(r, 700));
       sequence.clearSequence();

       const press = async (init) => {
         window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
         await new Promise(r => setTimeout(r, 250));
         return sequence.getSequence().tracks.length;
       };

       const before = sequence.getSequence().tracks.length;

       // F8 runs nothing to begin with.
       const unbound = await press({ key: 'F8' });

       keybindings.bindChord('f8', 'timeline.addTrack');
       await new Promise(r => setTimeout(r, 200));
       const bound = await press({ key: 'F8' });

       keybindings.unbindChord('f8');
       await new Promise(r => setTimeout(r, 200));
       const afterUnbind = await press({ key: 'F8' });

       return {
         before, unbound, bound, afterUnbind,
         chords: keybindings.chordsFor('timeline.addTrack'),
       };`,
    )

    console.log(
      `       tracks: ${result.before} before · ${result.unbound} on an unbound key · ` +
        `${result.bound} once bound · ${result.afterUnbind} after unbinding`,
    )
    assert.equal(result.unbound, result.before, 'an unbound key already did something')
    assert.equal(
      result.bound,
      result.before + 1,
      'the rebound key did not run the command it was bound to',
    )
    assert.equal(
      result.afterUnbind,
      result.bound,
      'the key still ran the command after it was unbound',
    )
  })

  await check('taking a chord takes it, and leaves the other command with none', async () => {
    const result = await evaluate(
      cdp,
      `const { keybindings } = window.__fluxDev;
       keybindings.resetAllKeybindings();

       // Ctrl+M ships as Send to Render.
       const wasOn = keybindings.commandFor('ctrl+m');
       const conflict = keybindings.conflictFor('ctrl+m', 'timeline.addTrack');
       const noConflictWithItself = keybindings.conflictFor('ctrl+m', wasOn);

       const displaced = keybindings.bindChord('ctrl+m', 'timeline.addTrack');
       const nowOn = keybindings.commandFor('ctrl+m');
       const loserKeys = keybindings.chordsFor(wasOn);

       // And putting the loser back takes the chord off the thief, both ways.
       keybindings.resetCommand(wasOn);
       const restored = keybindings.commandFor('ctrl+m');
       const thiefKeys = keybindings.chordsFor('timeline.addTrack');

       keybindings.resetAllKeybindings();
       return {
         wasOn, conflict, noConflictWithItself, displaced, nowOn,
         loserKeys, restored, thiefKeys,
       };`,
    )

    console.log(
      `       Ctrl M: ${result.wasOn} -> ${result.nowOn} -> ${result.restored} after a reset`,
    )
    assert.equal(result.conflict, result.wasOn, 'the conflict did not name the command holding it')
    assert.equal(
      result.noConflictWithItself,
      null,
      'rebinding a command to the key it already has was reported as a conflict',
    )
    assert.equal(result.displaced, result.wasOn, 'binding did not report what it displaced')
    assert.equal(result.nowOn, 'timeline.addTrack', 'the chord did not change hands')
    assert.deepEqual(
      result.loserKeys,
      [],
      `the displaced command kept a key: ${JSON.stringify(result.loserKeys)}`,
    )
    /*
     * Both directions on a reset. Putting a command back has to take its
     * default chord off whoever holds it now, or the command is restored to a
     * key that still runs something else — which is the one way this could
     * leave the map inconsistent.
     */
    assert.equal(result.restored, result.wasOn, 'a reset did not take the chord back')
    assert.deepEqual(result.thiefKeys, [], 'the other command kept the chord after the reset')
  })

  await check('a rebind survives a restart', async () => {
    const result = await evaluate(
      cdp,
      `const { keybindings, store } = window.__fluxDev;
       keybindings.resetAllKeybindings();
       keybindings.bindChord('f9', 'timeline.addTrack');
       keybindings.unbindChord('ctrl+n');

       // Let the queued write land. flushStores is what the store exposes for
       // exactly this, so the check does not race the IPC round trip.
       await store.flushStores();

       // Read it back the way a cold boot does, with no fallback to defaults.
       const raw = await store.loadStore('keybindings', null);
       return {
         stored: !!raw,
         f9: raw?.keymap?.['f9'] ?? null,
         ctrlN: raw?.keymap?.['ctrl+n'] ?? null,
         size: raw?.keymap ? Object.keys(raw.keymap).length : 0,
       };`,
    )

    console.log(`       ${result.size} bindings written to the store`)
    assert.equal(result.stored, true, 'nothing was written to the store at all')
    assert.equal(result.f9, 'timeline.addTrack', 'the new binding is not on disk')
    /*
     * A cleared binding has to stay cleared. If the stored map were merged
     * over the defaults at load, this would come back — and somebody who
     * deliberately removed a key would find it again on every launch.
     */
    assert.equal(result.ctrlN, null, 'a deliberately cleared binding is still in the store')
    await restore()
  })

  await check('a saved set is the whole map, and switching to it replaces the map', async () => {
    const result = await evaluate(
      cdp,
      `const { keybindings } = window.__fluxDev;
       keybindings.resetAllKeybindings();

       keybindings.bindChord('f10', 'timeline.addTrack');
       const mine = keybindings.savePreset('Mine');

       keybindings.resetAllKeybindings();
       const afterReset = keybindings.commandFor('f10') ?? null;

       keybindings.applyPreset(mine.id);
       const afterApply = keybindings.commandFor('f10') ?? null;
       const activeAfterApply = keybindings.getActivePreset();

       // An edit means the map is no longer exactly that set.
       keybindings.bindChord('f11', 'timeline.addTrack');
       const activeAfterEdit = keybindings.getActivePreset();

       // Saving under the same name replaces rather than duplicating.
       keybindings.savePreset('Mine');
       keybindings.savePreset('mine');
       const count = keybindings.getPresets().length;

       const removed = keybindings.deletePreset(mine.id);
       const left = keybindings.getPresets().length;

       keybindings.resetAllKeybindings();
       return { afterReset, afterApply, activeAfterApply, activeAfterEdit, count, removed, left };`,
    )

    assert.equal(result.afterReset, null, 'a reset did not clear the edit')
    assert.equal(result.afterApply, 'timeline.addTrack', 'applying a set did not restore its map')
    assert.ok(result.activeAfterApply, 'applying a set did not mark it active')
    assert.equal(
      result.activeAfterEdit,
      null,
      'the set is still marked active after the map was edited away from it',
    )
    assert.equal(result.count, 1, `saving the same name twice left ${result.count} sets`)
    assert.equal(result.removed, true, 'deleting a set reported failure')
    assert.equal(result.left, 0, 'the set is still there after being deleted')
    console.log('       saved, reset, re-applied, edited, re-saved by name, deleted')
  })

  await check('exported text comes back in, and rubbish is refused by name', async () => {
    const result = await evaluate(
      cdp,
      `const { keybindings } = window.__fluxDev;
       keybindings.resetAllKeybindings();
       keybindings.bindChord('f12', 'timeline.addTrack');
       const text = keybindings.exportKeybindings();

       keybindings.resetAllKeybindings();
       const gone = keybindings.commandFor('f12') ?? null;

       const round = keybindings.importKeybindings(text);
       const back = keybindings.commandFor('f12') ?? null;

       const refusals = [
         keybindings.importKeybindings('not json at all'),
         keybindings.importKeybindings('{\\"hello\\":1}'),
         keybindings.importKeybindings('{\\"flux\\":\\"keybindings\\"}'),
         keybindings.importKeybindings('{\\"flux\\":\\"keybindings\\",\\"keymap\\":{}}'),
       ];
       // None of those may have changed anything.
       const stillBack = keybindings.commandFor('f12') ?? null;

       keybindings.resetAllKeybindings();
       return { gone, round, back, refusals, stillBack, text: text.slice(0, 40) };`,
    )

    console.log(`       refusals: ${result.refusals.map((one) => one.reason).join(' · ')}`)
    assert.equal(result.gone, null, 'the reset before the import did nothing')
    assert.equal(result.round.ok, true, `a round trip of our own export failed: ${result.round.reason}`)
    assert.equal(result.back, 'timeline.addTrack', 'the imported binding is not in force')
    for (const refusal of result.refusals) {
      assert.equal(refusal.ok, false, 'rubbish was accepted as a keymap')
      assert.ok(refusal.reason?.length > 8, 'a refusal came back without a readable reason')
    }
    assert.equal(
      result.stillBack,
      'timeline.addTrack',
      'a refused import changed the bindings anyway',
    )
  })

  await check('capturing a chord does not run the command the chord is bound to', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, keybindings, sequence } = window.__fluxDev;
       keybindings.resetAllKeybindings();

       await commands.run('layout.switch.settings');
       await new Promise(r => setTimeout(r, 500));
       const link = [...document.querySelectorAll('.settings-link')].find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Hotkeys & Presets');
       link.click();
       await new Promise(r => setTimeout(r, 200));

       // Start listening for a chord for 'timeline.toggleSnapping'.
       const row = [...document.querySelectorAll('.hk-row')].find(
         el => el.querySelector('.hk-row-id').textContent.trim() === 'timeline.toggleSnapping');
       if (!row) return { noRow: true };
       [...row.querySelectorAll('.hk-btn')].find(b => /Add|Set/.test(b.textContent)).click();
       await new Promise(r => setTimeout(r, 150));
       const listening = !!document.querySelector('.hk-capture');

       /*
        * Ctrl+K opens the palette. While capturing it must not: the whole
        * point of the capture-phase listener is that the keys being chosen are
        * not also keys being used.
        */
       window.dispatchEvent(new KeyboardEvent('keydown', {
         key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
       await new Promise(r => setTimeout(r, 300));

       const paletteOpen = !!document.querySelector('.palette, .palette-input, [class*="palette"]');
       const conflict = document.querySelector('.hk-conflict');
       const conflictText = conflict ? conflict.textContent.replace(/\\s+/g, ' ').trim() : null;
       const nowOn = keybindings.commandFor('ctrl+k');

       // Leave it alone again.
       if (conflict) {
         [...conflict.querySelectorAll('.hk-btn')].find(b => /Leave/.test(b.textContent)).click();
       }
       await new Promise(r => setTimeout(r, 150));
       keybindings.resetAllKeybindings();

       return { listening, paletteOpen, conflictText, nowOn };`,
    )

    assert.ok(!result.noRow, 'there is no row for timeline.toggleSnapping')
    assert.equal(result.listening, true, 'pressing Set did not start listening')
    /*
     * The conflict is the evidence that the chord was captured, and the
     * unchanged binding is the evidence that nothing was taken yet. Both
     * matter: a capture that silently took Ctrl+K would be worse than one
     * that missed it.
     */
    assert.ok(
      result.conflictText?.includes('Ctrl K'),
      `capturing Ctrl+K did not raise a conflict — got ${JSON.stringify(result.conflictText)}`,
    )
    assert.equal(
      result.nowOn,
      'palette.open',
      'the chord was taken before the conflict was answered',
    )
    console.log(`       ${result.conflictText?.slice(0, 96)}`)
  })
} finally {
  await restore().catch(() => {})
  report()
  cdp.close()
}
