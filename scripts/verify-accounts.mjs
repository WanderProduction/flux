/**
 * Accounts, workspaces, and the four screens in front of the editor.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-accounts.mjs
 *
 * Three halves, which is one more than usual and worth explaining.
 *
 * **The identity**, against a real temp directory from plain Node. The thing
 * being checked is not "did it store a password" — it is that the encrypt and
 * decrypt round trip gives back a key that still *signs*, and that a signature
 * made with it verifies against the public key the record publishes. A
 * password check that only compared a hash would pass a test written against
 * the hash and still have lost the key.
 *
 * **The workspace store**, same directory, same reason: a manifest is a file
 * and files can be exercised without an app.
 *
 * **The screens**, against the running app. These are the only checks that can
 * catch the thing most likely to go wrong, which is not the crypto — it is the
 * routing. "No account" and "the account file has not been read yet" are both
 * falsy, and confusing them shows a Create Account form to somebody who has
 * had an account for months.
 *
 * The screen half adapts: on a profile with no account it drives the real
 * first run, and on one that already has an account it checks the invariants
 * that do not need a fresh machine. It says which it did.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  changePassword,
  createAccount,
  fingerprintOf,
  readAccount,
  signChallenge,
  unlockAccount,
  updateAccount,
  verifyChallenge,
} from '../electron/identity.js'
import {
  createWorkspace,
  forgetProject,
  isWorkspace,
  readWorkspace,
  rememberProject,
  updateWorkspace,
} from '../electron/workspace.js'
import { attach, createChecker, evaluate } from './cdp.mjs'

const { check, report } = createChecker()
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-account-'))

// ── the identity ──────────────────────────────────────────────

const PASSWORD = 'a good long password'

await check('a new account produces a key that signs', async () => {
  const dir = path.join(scratch, 'account')
  const started = Date.now()
  const made = await createAccount(dir, {
    nickname: 'nikoflow',
    deviceName: 'studio tower',
    password: PASSWORD,
  })
  assert.equal(made.ok, true, `could not create: ${made.reason}`)
  console.log(`       ${made.account.fingerprint}, ${Date.now() - started}ms to derive`)

  const opened = await unlockAccount(dir, PASSWORD)
  assert.equal(opened.ok, true, 'the right password did not open the key')

  // The check that matters: the decrypted key is a *usable* key, not 32 bytes
  // that merely decrypted. A round trip that corrupted the DER would still
  // satisfy any assertion written against the ciphertext.
  const challenge = 'another device says hello'
  const signature = signChallenge(opened.privateKey, challenge)
  assert.ok(
    verifyChallenge(made.account.publicKey, challenge, signature),
    'the recovered key did not produce a verifiable signature',
  )
  assert.equal(
    verifyChallenge(made.account.publicKey, `${challenge}!`, signature),
    false,
    'a signature verified against a challenge it was not made for',
  )
})

await check('the wrong password is refused, and says nothing else', async () => {
  const dir = path.join(scratch, 'account')
  const bad = await unlockAccount(dir, 'not the password')
  assert.equal(bad.ok, false, 'the wrong password opened the key')
  assert.equal(bad.reason, 'wrong-password')

  // A corrupted record must be indistinguishable from a wrong password:
  // saying which would tell anybody holding the file whether their guesses
  // are worth continuing.
  const broken = path.join(scratch, 'broken')
  await fs.mkdir(broken, { recursive: true })
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'account.json'), 'utf8'))
  raw.secret.data = Buffer.from('rubbish').toString('base64')
  await fs.writeFile(path.join(broken, 'account.json'), JSON.stringify(raw), 'utf8')
  const corrupt = await unlockAccount(broken, PASSWORD)
  assert.equal(corrupt.reason, bad.reason, 'a corrupt record is distinguishable from a bad password')
})

await check('the secret never appears in what is published', async () => {
  const dir = path.join(scratch, 'account')
  const published = await readAccount(dir)
  const text = JSON.stringify(published)
  for (const forbidden of ['secret', 'privateKey', 'salt', 'iv', 'tag']) {
    assert.ok(!text.includes(forbidden), `readAccount leaked "${forbidden}"`)
  }
  assert.ok(published.publicKey, 'the public key is not published')
  assert.equal(published.fingerprint, fingerprintOf(published.publicKey))
})

await check('an account cannot be quietly replaced', async () => {
  // Minting a second keypair over the first would make this machine a
  // stranger to every device that knew it, with nothing on screen saying so.
  const dir = path.join(scratch, 'account')
  const before = await readAccount(dir)
  const again = await createAccount(dir, {
    nickname: 'someone-else',
    deviceName: 'laptop',
    password: 'another password',
  })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already-exists')
  assert.deepEqual(await readAccount(dir), before, 'the account changed anyway')
})

await check('a weak password is refused before a key is made', async () => {
  const dir = path.join(scratch, 'weak')
  const result = await createAccount(dir, { nickname: 'a', deviceName: 'b', password: 'short' })
  assert.equal(result.reason, 'weak-password')
  assert.equal(await readAccount(dir), null, 'a record was written for a refused password')

  for (const [field, details] of [
    ['no-nickname', { nickname: '  ', deviceName: 'b', password: PASSWORD }],
    ['no-device-name', { nickname: 'a', deviceName: '', password: PASSWORD }],
  ]) {
    assert.equal((await createAccount(dir, details)).reason, field)
  }
})

await check('changing the password keeps the identity', async () => {
  const dir = path.join(scratch, 'account')
  const before = await readAccount(dir)

  const changed = await changePassword(dir, PASSWORD, 'an entirely different one')
  assert.equal(changed.ok, true, `rekey failed: ${changed.reason}`)

  const after = await readAccount(dir)
  assert.equal(after.publicKey, before.publicKey, 'changing the password changed the identity')
  assert.equal((await unlockAccount(dir, PASSWORD)).ok, false, 'the old password still works')

  const opened = await unlockAccount(dir, 'an entirely different one')
  assert.equal(opened.ok, true)
  assert.ok(
    verifyChallenge(before.publicKey, 'still me', signChallenge(opened.privateKey, 'still me')),
    'the re-encrypted key no longer signs for the published public key',
  )

  // And renaming touches neither.
  await updateAccount(dir, { nickname: 'niko', deviceName: 'laptop' })
  const renamed = await readAccount(dir)
  assert.equal(renamed.publicKey, before.publicKey, 'a rename changed the key')
  assert.equal(renamed.nickname, 'niko')
  assert.equal(renamed.deviceName, 'laptop')
})

// ── the workspace store ───────────────────────────────────────

await check('a workspace is a folder, and its projects are checked against disk', async () => {
  const parent = path.join(scratch, 'spaces')
  const made = await createWorkspace(parent, { title: 'Wander: Reels?', description: 'client work' })
  assert.equal(made.ok, true, `could not create: ${made.reason}`)

  // The illegal characters are taken out by the same rule project folders use.
  assert.equal(path.basename(made.workspace.root), 'Wander Reels')
  assert.equal(await isWorkspace(made.workspace.root), true)
  assert.equal(await isWorkspace(parent), false, 'the parent reports as a workspace')

  const root = made.workspace.root
  const real = path.join(scratch, 'a-real-project')
  await fs.mkdir(real, { recursive: true })
  await rememberProject(root, { root: real, name: 'Reel 01' })
  await rememberProject(root, { root: path.join(scratch, 'on-another-drive'), name: 'Gone' })

  const read = await readWorkspace(root)
  const byName = Object.fromEntries(read.projects.map((one) => [one.name, one]))
  console.log(`       ${read.projects.map((p) => p.name + (p.missing ? ' [missing]' : '')).join(', ')}`)
  assert.equal(byName['Reel 01'].missing, false)
  assert.equal(byName.Gone.missing, true, 'a project on a missing drive was not flagged')

  // Flagged, not removed: the usual cause is an unplugged drive, and an app
  // that tidies your projects away while the drive is out is one you stop
  // trusting.
  assert.equal(read.projects.length, 2, 'a missing project was dropped from the manifest')
})

await check('the same project is not filed twice', async () => {
  const root = path.join(scratch, 'spaces', 'Wander Reels')
  const real = path.join(scratch, 'a-real-project')
  const before = (await readWorkspace(root)).projects.length

  // Windows paths are case-insensitive, so the same folder reached two ways
  // must be one card rather than two.
  await rememberProject(root, { root: real.toUpperCase(), name: 'Reel 01 renamed' })
  const after = await readWorkspace(root)
  assert.equal(after.projects.length, before, 'the same project was filed twice')
  assert.equal(after.projects[0].name, 'Reel 01 renamed', 'the most recent is not first')
})

await check('editing a workspace leaves its id and its projects alone', async () => {
  const root = path.join(scratch, 'spaces', 'Wander Reels')
  const before = await readWorkspace(root)
  const result = await updateWorkspace(root, { title: 'Wander Production', description: '' })
  assert.equal(result.ok, true)

  const after = await readWorkspace(root)
  assert.equal(after.title, 'Wander Production')
  assert.equal(after.id, before.id, 'editing changed the workspace id')
  assert.equal(after.projects.length, before.projects.length, 'editing dropped projects')
  assert.equal((await updateWorkspace(root, { title: '   ' })).reason, 'no-title')
})

await check('forgetting a project does not touch the folder', async () => {
  const root = path.join(scratch, 'spaces', 'Wander Reels')
  const real = path.join(scratch, 'a-real-project')
  await forgetProject(root, real)

  const after = await readWorkspace(root)
  assert.ok(
    !after.projects.some((one) => one.root.toLowerCase() === real.toLowerCase()),
    'the project is still on the dashboard',
  )
  assert.ok(
    await fs.stat(real).then(() => true, () => false),
    'forgetting a project deleted its folder',
  )
})

// ── the screens ───────────────────────────────────────────────

const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

try {
  await check('the layout commands were renamed, and nothing answers to the old ones', async () => {
    /*
     * "Workspace" meant a panel arrangement until the thing that holds
     * projects took the name. Both meanings existing at once is a bug waiting
     * for somebody to read the wrong comment, so the old ids must be gone —
     * and a stored keymap pointing at one must have been moved over, because a
     * stored map is the whole truth and would otherwise bind a key to a
     * command that no longer exists.
     */
    const out = await evaluate(
      cdp,
      `const { commands, keybindings } = window.__fluxDev;
       const ids = commands.catalogue().map((one) => one.id);
       return {
         layout: ids.filter((id) => id.startsWith('layout.')).sort(),
         stale: ids.filter((id) => /^workspace\\.(switch|save|reset)/.test(id)),
         boundToLayout: Object.entries(keybindings.getKeybindings())
           .filter(([, command]) => command.startsWith('layout.'))
           .map(([chord]) => chord)
           .sort(),
         boundToStale: Object.entries(keybindings.getKeybindings())
           .filter(([, command]) => /^workspace\\.(switch|save|reset)/.test(command)),
       };`,
    )

    console.log(
      `       ${out.layout.length ? out.layout.join(', ') : 'no layout commands registered yet'}`,
    )
    assert.deepEqual(out.stale, [], 'a command still answers to the old workspace name')
    assert.deepEqual(out.boundToStale, [], 'a key is still bound to a renamed command')
    /*
     * The layout commands belong to the editor, so the catalogue only knows
     * them once a project has been open in this session — on a dashboard that
     * has never opened one the list is legitimately empty. The keymap is
     * always there, which is why the binding check below is the one that
     * cannot be skipped.
     */
    if (out.layout.length > 0) {
      for (const id of ['layout.switch.edit', 'layout.switch.export', 'layout.switch.settings']) {
        assert.ok(out.layout.includes(id), `${id} is missing`)
      }
    }
    // The three number keys and Ctrl , all still reach a layout.
    for (const chord of ['1', '2', '3', 'ctrl+,']) {
      assert.ok(out.boundToLayout.includes(chord), `${chord} no longer switches a layout`)
    }
  })

  const state = await evaluate(
    cdp,
    `const { account, workspace } = window.__fluxDev;
     return {
       hasAccount: Boolean(account.getAccount()),
       hasWorkspace: Boolean(workspace.getWorkspace()),
       loaded: account.accountLoaded() && workspace.workspaceLoaded(),
     };`,
  )
  console.log(
    `       profile: account ${state.hasAccount ? 'yes' : 'no'}, ` +
      `workspace ${state.hasWorkspace ? 'yes' : 'no'}`,
  )

  await check('the screen shown matches the state, and never flashes setup', async () => {
    const out = await evaluate(
      cdp,
      `const { account, workspace, project } = window.__fluxDev;
       const screen = () =>
         document.querySelector('.dash') ? 'dashboard'
         : document.querySelector('.setup-title')?.textContent.trim() ?? (
             document.querySelector('.launcher--waiting') ? 'waiting'
             : document.querySelector('.app') ? 'editor' : 'launcher');
       return {
         screen: screen(),
         loaded: account.accountLoaded() && workspace.workspaceLoaded(),
         hasAccount: Boolean(account.getAccount()),
         hasWorkspace: Boolean(workspace.getWorkspace()),
         hasProject: Boolean(project.getProject()),
       };`,
    )

    const expected = out.hasProject
      ? 'editor'
      : !out.loaded
        ? 'waiting'
        : !out.hasAccount
          ? 'Make an account'
          : !out.hasWorkspace
            ? 'Make a workspace'
            : 'dashboard'
    console.log(`       showing ${out.screen}`)
    assert.equal(out.screen, expected, 'the screen does not match the state behind it')
  })

  if (!state.hasAccount) {
    await check('the first run makes an account and moves on', async () => {
      const out = await evaluate(
        cdp,
        `const { account } = window.__fluxDev;
         const type = (el, value) => {
           const setter = Object.getOwnPropertyDescriptor(
             window.HTMLInputElement.prototype, 'value').set;
           setter.call(el, value);
           el.dispatchEvent(new Event('input', { bubbles: true }));
         };
         const fields = [...document.querySelectorAll('.setup-body .field-input')];
         const device = fields[1].value;
         type(fields[0], 'nikoflow');
         type(fields[2], 'a good long password');
         type(fields[3], 'mismatched');
         await new Promise((r) => setTimeout(r, 150));
         const blockedOnMismatch = document.querySelector('.primary-button').disabled;

         type(fields[3], 'a good long password');
         await new Promise((r) => setTimeout(r, 150));
         document.querySelector('.primary-button').click();
         for (let i = 0; i < 80 && !account.getAccount(); i++) {
           await new Promise((r) => setTimeout(r, 200));
         }
         const made = account.getAccount();
         return {
           suggestedDevice: device,
           blockedOnMismatch,
           made,
           next: document.querySelector('.setup-title')?.textContent.trim() ?? null,
         };`,
      )

      console.log(`       device name offered as "${out.suggestedDevice}"`)
      assert.ok(out.suggestedDevice, 'no device name was suggested from the hostname')
      assert.equal(out.blockedOnMismatch, true, 'two different passwords were accepted')
      assert.ok(out.made, 'the account was not created')
      assert.equal(out.made.nickname, 'nikoflow')
      assert.ok(out.made.fingerprint, 'the account has no fingerprint to compare')
      assert.ok(
        !JSON.stringify(out.made).includes('secret'),
        'the renderer was handed the encrypted secret',
      )
      assert.equal(out.next, 'Make a workspace', `went to "${out.next}" instead`)
    })

    await check('creating a workspace lands on the dashboard', async () => {
      const out = await evaluate(
        cdp,
        `const { workspace } = window.__fluxDev;
         const type = (el, value) => {
           const setter = Object.getOwnPropertyDescriptor(
             window.HTMLInputElement.prototype, 'value').set;
           setter.call(el, value);
           el.dispatchEvent(new Event('input', { bubbles: true }));
         };
         const fields = [...document.querySelectorAll('.setup-body .field-input')];
         const blankBefore = document.querySelector('.primary-button').disabled;
         type(fields[0], 'Wander Production');
         type(fields[1], 'Client work and reels');
         await new Promise((r) => setTimeout(r, 250));
         const planned = document.querySelector('.setup-path code').textContent;

         document.querySelector('.primary-button').click();
         for (let i = 0; i < 80 && !workspace.getWorkspace(); i++) {
           await new Promise((r) => setTimeout(r, 200));
         }
         await new Promise((r) => setTimeout(r, 400));
         const made = workspace.getWorkspace();
         return {
           blankBefore,
           planned,
           made,
           onDashboard: Boolean(document.querySelector('.dash')),
           shownTitle: document.querySelector('.dash-title')?.textContent.trim() ?? null,
         };`,
      )

      assert.equal(out.blankBefore, true, 'a workspace with no name could be created')
      assert.ok(out.made, 'the workspace was not created')
      // The path the screen promised is the path that was made. Two different
      // code paths deciding that is exactly how a launcher starts lying.
      assert.equal(out.made.root, out.planned, 'the folder created is not the one shown')
      assert.equal(out.onDashboard, true, 'the dashboard did not open')
      assert.equal(out.shownTitle, 'Wander Production')
      console.log(`       ${out.made.root}`)
    })
  } else {
    console.log('       account already on this profile — first-run checks need a fresh one')
  }

  await check('a project opened is filed under the workspace, as a card', async () => {
    const out = await evaluate(
      cdp,
      `const { project, workspace } = window.__fluxDev;
       const root = workspace.getWorkspace().root;
       // Inside the workspace folder, which exists: createProject makes the
       // project's own folder but not the parent above it.

       const before = workspace.getWorkspace().projects.length;
       const name = 'Reel ' + String(before + 1).padStart(2, '0');
       const made = await project.createProject(root, name);
       if (!made.ok) return { failed: made.error, demo: root };

       // Back to the dashboard, which is where a card would be drawn.
       project.closeProject();
       for (let i = 0; i < 40 && !document.querySelector('.dash'); i++) {
         await new Promise((r) => setTimeout(r, 150));
       }
       await workspace.refreshWorkspace();
       await new Promise((r) => setTimeout(r, 400));

       const names = [...document.querySelectorAll('.card-open .card-name')]
         .map((el) => el.textContent.trim());
       return {
         before,
         after: workspace.getWorkspace().projects.length,
         filed: workspace.getWorkspace().projects.map((one) => one.name),
         cards: names,
         count: document.querySelector('.dash-count')?.textContent.trim(),
       };`,
    )

    assert.ok(!out.failed, `could not make a project: ${out.failed} at ${out.demo}`)
    console.log(`       cards: ${out.cards.join(', ')}`)
    assert.equal(out.after, out.before + 1, 'the project was not filed under the workspace')
    assert.ok(out.filed.length > out.before, 'the project is missing from the manifest')
    // The manifest and the screen have to agree. A dashboard reading from
    // somewhere else would pass every check written against the store.
    assert.deepEqual(out.cards, out.filed, 'the cards drawn are not the projects filed')
    assert.equal(out.count, String(out.after), 'the count does not match the cards')
  })

  await check('a first workspace adopts what this installation was already doing', async () => {
    /*
     * The upgrade path, and the only one an existing user will ever take.
     *
     * Somebody who has been using FLUX for weeks launches a build with
     * accounts in it, makes a workspace, and is shown a dashboard. If that
     * dashboard is empty it reads as data loss — even though every folder is
     * exactly where they left it — because the recents list was the only
     * record of what they had been working on.
     *
     * Driven by closing the open workspace and making a second one, so this
     * runs on any profile rather than only on a fresh machine.
     */
    const out = await evaluate(
      cdp,
      `const { workspace, project, store } = window.__fluxDev;
       const first = workspace.getWorkspace();
       // Asked for rather than sliced off the root: a path separator inside a
       // template literal inside a harness is three levels of escaping, and it
       // has already cost this file one debugging round.
       const parent = await workspace.defaultParent();

       // Stand in for a history this profile may not have. Written through the
       // same store the launcher reads, then loaded the way a launch loads it.
       const planted = first.projects.filter((one) => !one.missing).slice(0, 3)
         .map((one, i) => ({ root: one.root, name: one.name, openedAt: Date.now() - i * 1000 }));
       if (planted.length === 0) return { skipped: true };
       await store.saveStore('recent-projects', planted);
       await store.flushStores();
       await project.loadRecents();

       workspace.closeWorkspace();
       for (let i = 0; i < 40 && !document.querySelector('.setup-title'); i++) {
         await new Promise((r) => setTimeout(r, 150));
       }
       const backToSetup = document.querySelector('.setup-title')?.textContent.trim();

       const made = await workspace.createWorkspace(parent, { title: 'Adopted' });
       if (!made.ok) return { failed: made.reason };
       // The seeding lives in the setup screen, which this did not go through,
       // so it is replayed here exactly as that screen replays it.
       for (const recent of [...project.getRecents()].reverse()) {
         await workspace.rememberProject({ root: recent.root, name: recent.name });
       }
       await new Promise((r) => setTimeout(r, 400));

       const seeded = workspace.getWorkspace().projects.map((one) => one.name);
       // Put the first workspace back and clear the stand-in history.
       await workspace.openWorkspace(first.root);
       await store.saveStore('recent-projects', []);
       await store.flushStores();
       return { backToSetup, planted: planted.map((one) => one.name), seeded };`,
    )

    if (out.skipped) {
      console.log('       no projects to adopt on this profile')
      return
    }
    assert.ok(!out.failed, `could not make a second workspace: ${out.failed}`)
    assert.equal(out.backToSetup, 'Make a workspace', 'closing a workspace did not offer a new one')
    console.log(`       adopted ${out.seeded.join(', ')}`)
    assert.deepEqual(
      [...out.seeded].sort(),
      [...out.planted].sort(),
      'the new workspace did not adopt what this installation had open before',
    )
  })

  await check('a project whose folder is gone says so instead of opening', async () => {
    const out = await evaluate(
      cdp,
      `const { workspace } = window.__fluxDev;
       await window.flux.workspace.remember(workspace.getWorkspace().root, {
         root: 'Z:\\\\not-a-drive\\\\Old Documentary', name: 'Old Documentary',
       });
       await workspace.refreshWorkspace();
       await new Promise((r) => setTimeout(r, 400));

       const card = [...document.querySelectorAll('.card')].find(
         (el) => el.querySelector('.card-name')?.textContent.trim() === 'Old Documentary');
       const state = {
         drawn: Boolean(card),
         disabled: card?.querySelector('.card-open')?.disabled ?? null,
         says: card?.querySelector('.card-when')?.textContent.trim() ?? null,
       };
       await workspace.forgetProject('Z:\\\\not-a-drive\\\\Old Documentary');
       return state;`,
    )

    assert.equal(out.drawn, true, 'a project on a missing drive was hidden rather than flagged')
    assert.equal(out.disabled, true, 'a missing project could still be clicked')
    assert.equal(out.says, 'folder not found', `the card says "${out.says}"`)
  })

  await check('forgetting a card leaves the project folder where it is', async () => {
    const out = await evaluate(
      cdp,
      `const { workspace } = window.__fluxDev;
       const target = workspace.getWorkspace().projects.find((one) => !one.missing);
       if (!target) return { skipped: true };

       await workspace.forgetProject(target.root);
       await new Promise((r) => setTimeout(r, 300));
       const stillThere = await window.flux.project.is(target.root);
       const gone = !workspace.getWorkspace().projects
         .some((one) => one.root === target.root);
       // Put it back, so a second run of this suite starts where this one did.
       await workspace.rememberProject({ root: target.root, name: target.name });
       return { name: target.name, gone, stillThere };`,
    )

    if (out.skipped) {
      console.log('       nothing to forget')
      return
    }
    assert.equal(out.gone, true, 'the card survived being forgotten')
    assert.equal(out.stillThere, true, 'forgetting a card deleted the project on disk')
  })
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  report()
  cdp.close()
}
