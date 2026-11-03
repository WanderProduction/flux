/**
 * The Cache page: what is on disk, and whether the page says so.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-cache.mjs
 *
 * Two halves, and they are checked differently on purpose.
 *
 * **The measurement** is exercised against a real temp directory from plain
 * Node, with no app running — the same reason electron/mediaCache.js takes its
 * directory as an argument. Entries are written through the real writeDerived,
 * so the preamble the kind is read back out of is the one the app writes, not
 * one this file invented.
 *
 * **The page** is read out of the running app, and every check compares what
 * is drawn against what the directory actually holds. A page that showed a
 * plausible number from somewhere else would pass any test written against
 * its own state, which is the failure this is shaped to catch: the whole point
 * of the page is that the number is true.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearCache,
  measureCache,
  sourceToken,
  writeDerived,
} from '../electron/mediaCache.js'
import { attach, createChecker, ensureProject, evaluate } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { check, report } = createChecker()

// ── the measurement, against a real directory ─────────────────

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-cache-'))
const cacheDir = path.join(scratch, 'media-cache')

/** Three sources, so a kind is not accidentally one file's worth of entries. */
const sources = []
for (let i = 0; i < 3; i += 1) {
  const at = path.join(scratch, `clip-${i}.mp4`)
  await fs.writeFile(at, Buffer.alloc(1024, i + 1))
  sources.push(at)
}

/** Sizes chosen so every per-kind total is distinguishable from every other. */
const PLANTED = { index: 40_000, peaks: 8_000, thumb: 1_000 }

await check('an empty cache measures as empty, not as an error', async () => {
  const out = await measureCache(path.join(scratch, 'never-written'))
  assert.equal(out.bytes, 0)
  assert.equal(out.entries, 0)
  assert.deepEqual(out.byKind, {})
})

await check('every entry is attributed to the kind that wrote it', async () => {
  for (const source of sources) {
    const token = await sourceToken(source)
    for (const [kind, size] of Object.entries(PLANTED)) {
      const result = await writeDerived(cacheDir, source, kind, token, Buffer.alloc(size, 7))
      assert.equal(result.ok, true, `could not plant a ${kind}: ${result.reason}`)
    }
  }

  const out = await measureCache(cacheDir)
  console.log(
    `       ${out.entries} entries, ${out.bytes} bytes: ` +
      Object.entries(out.byKind)
        .map(([kind, v]) => `${kind} ${v.entries}/${v.bytes}`)
        .join(', '),
  )

  assert.equal(out.entries, 9, 'not every planted entry was counted')
  assert.equal(out.unreadable, 0, 'a freshly written entry could not be read back')
  for (const kind of Object.keys(PLANTED)) {
    assert.equal(out.byKind[kind]?.entries, 3, `${kind} did not come back as three entries`)
  }
  // The envelope adds a preamble per entry, so the kind's total is a little
  // over its payloads — but it must never be under, and the kinds must not
  // have been mixed up with each other.
  for (const [kind, size] of Object.entries(PLANTED)) {
    const got = out.byKind[kind].bytes
    assert.ok(got >= size * 3, `${kind} measured ${got}, less than the ${size * 3} planted`)
    assert.ok(got < size * 3 + 4096, `${kind} measured ${got}, far more than was planted`)
  }
  // And the whole is the sum of the parts, which is the number the page's bar
  // is drawn from.
  const summed = Object.values(out.byKind).reduce((n, v) => n + v.bytes, 0)
  assert.equal(summed, out.bytes, 'the total is not the sum of the kinds')
})

await check('clearing one kind leaves the others alone', async () => {
  const before = await measureCache(cacheDir)
  const result = await clearCache(cacheDir, 'thumb')

  assert.equal(result.removed, 3, `cleared ${result.removed} entries, expected the 3 thumbnails`)
  assert.ok(result.bytes >= PLANTED.thumb * 3, 'reported fewer bytes than the thumbnails held')

  const after = await measureCache(cacheDir)
  assert.equal(after.byKind.thumb, undefined, 'a thumbnail survived')
  assert.equal(after.byKind.index?.entries, 3, 'clearing thumbnails took an index with it')
  assert.equal(after.byKind.peaks?.entries, 3, 'clearing thumbnails took the peaks with it')
  assert.equal(
    after.bytes,
    before.bytes - result.bytes,
    'the freed bytes do not account for the difference',
  )
})

await check('an entry whose preamble is damaged is counted, and survives a by-kind clear', async () => {
  // A crash mid-write leaves one of these. It must not be attributed to a
  // kind by guesswork — the expensive thing to rebuild is the index, and
  // guessing wrong deletes it to spare a thumbnail.
  const junk = path.join(cacheDir, 'deadbeefdeadbeefdeadbeefdeadbeef.fluxidx')
  await fs.writeFile(junk, Buffer.alloc(64, 0xff))

  const out = await measureCache(cacheDir)
  assert.equal(out.unreadable, 1, 'the damaged entry was not reported as unreadable')
  assert.equal(out.byKind['']?.entries, 1, 'the damaged entry was attributed to a kind')

  await clearCache(cacheDir, 'index')
  assert.ok(
    await fs.stat(junk).then(() => true, () => false),
    'clearing one kind deleted an entry it could not identify',
  )

  const full = await clearCache(cacheDir)
  assert.ok(full.removed >= 1, 'clearing everything left the damaged entry behind')
  const end = await measureCache(cacheDir)
  assert.equal(end.entries, 0, `${end.entries} entries survived clearing everything`)
})

await check('only cache entries are touched', async () => {
  // The directory is the app's own, but it is also a directory on somebody's
  // machine, and a clear that globbed would be a very bad bug to ship.
  const bystander = path.join(cacheDir, 'notes.txt')
  await fs.writeFile(bystander, 'not a cache entry')

  const token = await sourceToken(sources[0])
  await writeDerived(cacheDir, sources[0], 'index', token, Buffer.alloc(100, 1))

  const out = await measureCache(cacheDir)
  assert.equal(out.entries, 1, 'the bystander was counted as a cache entry')

  await clearCache(cacheDir)
  assert.equal(
    await fs.readFile(bystander, 'utf8'),
    'not a cache entry',
    'clearing the cache deleted a file that was not a cache entry',
  )
})

/*
 * One file that outlives the directory checks, so the page checks below can
 * plant entries against a real source. The cache keys on a file's size and
 * modification time, so a planted entry needs a file that genuinely exists —
 * writeDerived refuses otherwise, which is the whole point of the token.
 */
const PLANT_SOURCE = path.join(scratch, 'clip-0.mp4')
const PLANT_KIND = 'verify-cache'

// ── the page, against the directory it is describing ──────────

const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)
await ensureProject(cdp, path.join(os.homedir(), 'flux-verify-project'))

/** Opens Settings and lands on a page by its name in the side nav. */
const OPEN = (name) => `
  await window.__fluxDev.commands.run('layout.switch.settings');
  await new Promise((r) => setTimeout(r, 500));
  const link = [...document.querySelectorAll('.settings-link')].find(
    (el) => el.querySelector('.settings-link-name').textContent.trim() === ${JSON.stringify(name)});
  if (!link) throw new Error('no side-nav link called ${name}');
  link.click();
  await new Promise((r) => setTimeout(r, 400));`

try {
  await check('the page is built, and its numbers come from the disk', async () => {
    const out = await evaluate(
      cdp,
      `${OPEN('Cache')}
       const { cache } = window.__fluxDev;
       const measured = await cache.measureCaches();
       await new Promise((r) => setTimeout(r, 400));
       const text = document.querySelector('.settings-page').innerText;
       return {
         measured,
         built: Boolean(document.querySelector('.ca')),
         shown: [...document.querySelectorAll('.ca-size')].map((el) => el.textContent.trim()),
         text,
       };`,
    )

    assert.ok(out.built, 'the Cache page is not drawn as built')
    assert.ok(out.measured, 'the kernel could not measure the caches')
    console.log(
      `       media ${out.measured.media.bytes} bytes in ${out.measured.media.entries} entries, ` +
        `window ${out.measured.window.bytes} bytes`,
    )

    // The directory the page names is the one the app actually caches into.
    assert.ok(
      out.text.includes(out.measured.media.dir),
      'the page does not name the directory it measured',
    )

    // A size drawn for every kind the directory holds, plus the two totals.
    assert.ok(out.shown.length >= 2, `only ${out.shown.length} sizes on the page`)
  })

  await check('the bar is drawn against the budget the main process prunes to', async () => {
    const out = await evaluate(
      cdp,
      `${OPEN('Cache')}
       const { cache, performance: perf } = window.__fluxDev;
       const measured = await cache.measureCaches();
       return {
         budget: measured.media.budget,
         live: perf.getPerformance(),
         defaults: perf.defaultsFor(),
       };`,
    )

    console.log(
      `       bar drawn against ${Math.round(out.budget / (1024 * 1024))}MB, ` +
        `dialog shows ${out.live.diskCacheMb}MB (machine default ${out.defaults.diskCacheMb}MB)`,
    )
    assert.ok(out.budget > 0, 'the page has no budget to draw against')
    /*
     * The check that found the bug this page was built on top of. The main
     * process used to fall back to a hardcoded 256MB when nothing was pinned,
     * while the renderer's default scales with memory — so the cache was being
     * pruned to a twenty-third of the budget the app was reporting. Both sides
     * read shared/performanceDefaults.js now.
     */
    assert.equal(
      Math.round(out.budget / (1024 * 1024)),
      out.live.diskCacheMb,
      'the budget the page draws against is not the one the main process prunes to',
    )
  })

  await check('a hand-edited budget is held to the same bounds on both sides', async () => {
    /*
     * The store is a JSON file anybody can edit, and `settle()` already holds
     * what it finds to LIMITS before the dialog shows it. A main process that
     * did not would prune to a 1MB cache while the dialog said 256MB — the
     * same disagreement as the bug above, wearing a different hat.
     *
     * The pinned value is put back afterwards, whatever it was.
     */
    const out = await evaluate(
      cdp,
      `const { cache, store, performance: perf } = window.__fluxDev;
       const had = await store.loadStore('performance', null);
       try {
         await store.saveStore('performance', { ...(had ?? {}), diskCacheMb: 1 });
         await store.flushStores();
         const tiny = (await cache.measureCaches()).media.budget;

         await store.saveStore('performance', { ...(had ?? {}), diskCacheMb: 999999999 });
         await store.flushStores();
         const huge = (await cache.measureCaches()).media.budget;

         return { tiny, huge, limits: perf.LIMITS.diskCacheMb };
       } finally {
         await store.saveStore('performance', had);
         await store.flushStores();
       }`,
    )

    const mb = (bytes) => Math.round(bytes / (1024 * 1024))
    console.log(`       1MB pinned → ${mb(out.tiny)}MB, 999999999MB pinned → ${mb(out.huge)}MB`)
    assert.equal(mb(out.tiny), out.limits.min, 'a tiny pinned budget was not raised to the floor')
    assert.equal(mb(out.huge), out.limits.max, 'an absurd pinned budget was not held to the ceiling')
  })

  await check('clearing a kind changes the disk, not just the page', async () => {
    /*
     * Entries are planted rather than waited for, because the dev profile has
     * its own userData and may have cached nothing at all — and a check that
     * skips itself on a clean machine is a check that was never run.
     *
     * Planted through `window.flux.media.write`, which is the path the app
     * itself writes by: renderer to IPC to disk. So this exercises the real
     * envelope and the real preamble the kind is read back out of, not a
     * shape this file invented.
     */
    const out = await evaluate(
      cdp,
      `${OPEN('Cache')}
       const { cache } = window.__fluxDev;
       const source = ${JSON.stringify(PLANT_SOURCE)};
       const kind = ${JSON.stringify(PLANT_KIND)};
       const token = await window.flux.media.sourceToken(source);
       if (!token) throw new Error('the planted source is not on disk: ' + source);

       const wrote = await window.flux.media.write(
         source, kind, token, new Uint8Array(20000).fill(3));
       const before = await cache.measureCaches();
       const result = await cache.clearMedia(kind);
       const after = await cache.measureCaches();

       const only = (report) => Object.fromEntries(
         report.media.kinds.filter((k) => k.entries > 0).map((k) => [k.id, k.entries]));
       return {
         wrote,
         planted: before.media.kinds.find((k) => k.id === kind) ?? null,
         result,
         left: after.media.kinds.find((k) => k.id === kind) ?? null,
         othersBefore: only(before),
         othersAfter: only(after),
         totalBefore: before.media.bytes,
         totalAfter: after.media.bytes,
       };`,
    )

    assert.equal(out.wrote?.ok, true, `could not plant an entry: ${out.wrote?.reason}`)
    assert.ok(out.planted, 'a planted entry did not appear in the report at all')
    console.log(
      `       planted ${out.planted.bytes} bytes, cleared ${out.result.removed} entries / ` +
        `${out.result.bytes} bytes`,
    )

    // The report found it, named it, and sized it as more than the payload
    // (the envelope) and less than the payload plus a preamble.
    assert.equal(out.planted.entries, 1, 'the planted entry was counted more than once')
    assert.ok(out.planted.bytes >= 20_000, `the planted entry measured ${out.planted.bytes}`)
    assert.ok(out.planted.bytes < 20_000 + 4096, `the planted entry measured ${out.planted.bytes}`)

    // And clearing it actually changed the disk, by exactly what it said.
    assert.equal(out.result.removed, 1, `cleared ${out.result.removed} entries, expected 1`)
    assert.equal(out.left, null, 'the planted entry survived its own clear')
    assert.equal(
      out.totalAfter,
      out.totalBefore - out.result.bytes,
      'the total did not fall by what the clear reported freeing',
    )

    // Nothing else was touched. This is the check that matters: a clear that
    // globbed the directory would pass every assertion above.
    delete out.othersBefore[PLANT_KIND]
    assert.deepEqual(
      out.othersAfter,
      out.othersBefore,
      'clearing one kind disturbed the rest of the cache',
    )
  })

  await check('an unrecognised kind is reported as itself, not swallowed', async () => {
    // The planted kind above is not one of the four FLUX writes, and it still
    // appeared as its own row. That is deliberate: it is how a rename shows up
    // as a visible row rather than as a total that stops adding up.
    const out = await evaluate(
      cdp,
      `const { cache } = window.__fluxDev;
       const source = ${JSON.stringify(PLANT_SOURCE)};
       const token = await window.flux.media.sourceToken(source);
       await window.flux.media.write(source, 'not-a-real-kind', token, new Uint8Array(500).fill(9));
       const report = await cache.measureCaches();
       const row = report.media.kinds.find((k) => k.id === 'not-a-real-kind') ?? null;
       const known = report.media.kinds.filter((k) => k.id && k.id !== 'not-a-real-kind')
         .map((k) => k.id);
       const summed = report.media.kinds.reduce((n, k) => n + k.bytes, 0);
       await cache.clearMedia('not-a-real-kind');
       return { row, known, summed, total: report.media.bytes };`,
    )

    assert.ok(out.row, 'an unknown kind was dropped from the report')
    assert.equal(out.row.label, 'not-a-real-kind', 'an unknown kind was given a made-up label')
    assert.equal(out.summed, out.total, 'the kinds no longer add up to the total')
    assert.deepEqual(
      out.known.sort(),
      ['audio-index', 'peaks', 'thumb', 'video-index'],
      `the four kinds FLUX writes are not the four listed: ${out.known.join(', ')}`,
    )
  })

  await check('clearing the window caches frees something', async () => {
    /*
     * Pressed for real, because the two Electron APIs behind it are the only
     * part of this page that cannot be reasoned about from our own code — and
     * a Clear that quietly did nothing would look identical to one that
     * worked on a cache that happened to be small.
     *
     * Safe to run: the cost is one slower launch while Chromium fetches and
     * recompiles what it threw away. Nothing here is anybody's work.
     */
    const out = await evaluate(
      cdp,
      `const { cache } = window.__fluxDev;
       const before = (await cache.measureCaches()).window;
       const result = await cache.clearWindowCache();
       const after = (await cache.measureCaches()).window;
       return { before, result, after };`,
    )

    console.log(
      `       ${out.before.bytes} → ${out.after.bytes} bytes, reported ${out.result.bytes} freed`,
    )
    assert.ok(out.before.parts.length >= 2, 'the window cache is not broken down')
    assert.ok(
      out.after.bytes <= out.before.bytes,
      'the window caches grew while being cleared',
    )
    // It reported freeing what it actually freed, give or take whatever
    // Chromium wrote back between the two measurements.
    assert.ok(
      Math.abs(out.result.bytes - (out.before.bytes - out.after.bytes)) <= 2 * 1024 * 1024,
      `reported freeing ${out.result.bytes} but the directories fell by ` +
        `${out.before.bytes - out.after.bytes}`,
    )
  })

  await check('the page offers no control that does nothing', async () => {
    // The rule from kernel/tools.ts, applied to the one page here that has
    // real buttons: every button either runs a command that exists or is
    // wired to a handler. A clear button for a kind that is not there would
    // be a control that silently does nothing.
    const out = await evaluate(
      cdp,
      `${OPEN('Cache')}
       const { commands } = window.__fluxDev;
       const known = new Set(commands.catalogue().map((c) => c.id));
       const buttons = [...document.querySelectorAll('.settings-page button')].map((el) => ({
         label: el.textContent.trim(),
         command: el.dataset.command ?? null,
         disabled: el.disabled,
       }));
       return { buttons, missing: buttons.filter((b) => b.command && !known.has(b.command)) };`,
    )

    console.log(`       ${out.buttons.length} buttons, ${out.missing.length} pointing nowhere`)
    assert.deepEqual(out.missing, [], 'a button points at a command that does not exist')
    assert.deepEqual(
      out.buttons.filter((b) => b.disabled && !b.label),
      [],
      'a disabled button with no label is a dead control',
    )
  })

  await check('Settings still holds together with a third page built', async () => {
    const out = await evaluate(
      cdp,
      `const { settings } = window.__fluxDev;
       return {
         pages: settings.settingsPages.length,
         levels: settings.settingsLevels.length,
         ready: settings.settingsPages.filter((p) => p.ready).map((p) => p.id),
       };`,
    )

    assert.equal(out.pages, 19, `${out.pages} pages, expected nineteen`)
    assert.equal(out.levels, 3, `${out.levels} levels, expected three`)
    assert.ok(out.ready.includes('device.cache'), 'device.cache is not marked as built')
    console.log(`       built: ${out.ready.join(', ')}`)
  })
} finally {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  report()
  cdp.close()
}

void ROOT
