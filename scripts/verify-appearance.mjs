/**
 * Appearance, and whether the token system is really the only mechanism.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-appearance.mjs
 *
 * Two different things are checked here and the second is the interesting one.
 *
 * **Does a choice change pixels.** Not "was it stored" and not "did the
 * attribute land" — every check reads `getComputedStyle` on a real element and
 * asserts the colour or the size it actually resolved to. A theme that set an
 * attribute nothing responded to would pass any test written against the
 * store.
 *
 * **Is the claim in theme.css true.** That file says a component which
 * hardcodes a colour has punched a hole in the skinning system. Measured when
 * this page was built, `app.css` held 54 colour literals — so the claim was
 * decoration. The audit below turns it into a check: the literals are counted,
 * grouped, and held against an allowlist with a reason for each group. New
 * ones fail the run.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { attach, createChecker, ensureProject, evaluate } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')

/**
 * What `app.css` is still allowed to hardcode, and why.
 *
 * Deliberately a budget per *reason* rather than one total, so that removing a
 * shadow does not quietly buy somebody the right to hardcode a surface.
 */
const ALLOWED = {
  /** Black at low alpha. Reads correctly over any surface, in any theme. */
  shadows: 20,
  /**
   * Content black: the viewer frame, the letterbox bars, a sequence
   * thumbnail. A picture is judged against black, not against the chrome —
   * theming these would make the app lie about the footage.
   */
  black: 4,
  /** White text and a switch knob, over an accent fill in every theme. */
  white: 3,
  /**
   * Tinted text on tinted badges, the node-map grid dot, and the two shades
   * of the loading barber pole. Cosmetic details rather than surfaces: left
   * fixed, and a theme that wanted them would have to claim them first.
   */
  details: 14,
}

const { check, report } = createChecker()

await check('the stylesheet hardcodes only what it is allowed to', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/app.css'), 'utf8')
  const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0])

  const isShadow = (v) => /^rgba?\(\s*0[\s,]/.test(v)
  const isBlack = (v) => /^#(000|000000)$/i.test(v)
  const isWhite = (v) => /^#(fff|ffffff)$/i.test(v)

  const found = {
    shadows: literals.filter(isShadow).length,
    black: literals.filter(isBlack).length,
    white: literals.filter(isWhite).length,
    details: literals.filter((v) => !isShadow(v) && !isBlack(v) && !isWhite(v)).length,
  }

  console.log(
    `       ${literals.length} literals: ` +
      Object.entries(found)
        .map(([what, n]) => `${n} ${what}`)
        .join(' · '),
  )

  for (const [what, budget] of Object.entries(ALLOWED)) {
    assert.ok(
      found[what] <= budget,
      `${found[what]} ${what} literals against a budget of ${budget} — a new hardcoded colour ` +
        `has gone in. Either make it a token in styles/theme.css or raise the budget here with ` +
        `a reason beside it.`,
    )
  }

  /*
   * And no `var(--token, #fallback)` anywhere. A fallback is how four token
   * names — `--flux-ok`, `--flux-danger`, `--flux-dim`, `--flux-line` — were
   * used for months without ever being declared: the fallback did all the
   * work, so nothing looked broken and nothing was skinnable. They are
   * declared now, and this is what stops the next one.
   */
  const fallbacks = [...css.matchAll(/var\(--flux-[a-z-]+,\s*[^)]+\)/g)].map((m) => m[0])
  assert.deepEqual(
    fallbacks,
    [],
    `a token is being used with a literal fallback, which hides whether it is declared: ` +
      fallbacks.join(', '),
  )
})

const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

const restore = () =>
  evaluate(cdp, `window.__fluxDev.appearance.resetAppearance(); return true;`)

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await restore()

  await check('the page is built and every control is on it', async () => {
    const result = await evaluate(
      cdp,
      `const { commands, settings } = window.__fluxDev;
       await commands.run('workspace.switch.settings');
       await new Promise(r => setTimeout(r, 600));
       const link = [...document.querySelectorAll('.settings-link')].find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Appearance');
       link.click();
       await new Promise(r => setTimeout(r, 250));

       return {
         ready: settings.getSettingsPage('account.appearance').ready,
         planned: !!document.querySelector('.settings-badge'),
         themes: [...document.querySelectorAll('.ap-card-name')].map(el => el.textContent.trim()),
         accents: document.querySelectorAll('.ap-accent').length,
         segments: document.querySelectorAll('.ap-choice').length,
         // By id, not a count: a count pins the check to however many pages
         // happened to be finished when it was written.
         built: settings.settingsPages.filter(one => one.ready).map(one => one.id),
       };`,
    )
    console.log(
      `       themes ${result.themes.join('/')} · ${result.accents} accents · ` +
        `${result.segments} segments · ${result.built} of 19 pages built`,
    )
    assert.equal(result.ready, true, 'the page is still marked as a plan')
    assert.equal(result.planned, false, 'a built page is still wearing the Planned badge')
    assert.equal(result.themes.length, 3, 'the themes are not all listed')
    assert.equal(result.accents, 5, 'the accents are not all listed')
    // Three densities and four text scales, in two segmented controls.
    assert.equal(result.segments, 7, 'density and text size are not both there')
    assert.ok(
      result.built.includes('account.appearance'),
      `the registry does not list this page as built — it lists ${result.built.join(', ')}`,
    )
  })

  await check('each theme changes what a panel is actually painted', async () => {
    const result = await evaluate(
      cdp,
      `const { appearance } = window.__fluxDev;
       const read = async (theme) => {
         appearance.setAppearance({ theme });
         await new Promise(r => setTimeout(r, 160));
         const root = getComputedStyle(document.documentElement);
         const panel = document.querySelector('.panel');
         return {
           theme: document.documentElement.dataset.fluxTheme,
           bg: root.getPropertyValue('--flux-bg').trim(),
           stage: root.getPropertyValue('--flux-bg-stage').trim(),
           // The painted value, not the token: this is what proves something
           // downstream of the attribute actually responded.
           painted: panel ? getComputedStyle(panel).backgroundColor : null,
         };
       };
       const out = {};
       for (const t of ['default', 'darker', 'neutral']) out[t] = await read(t);
       appearance.resetAppearance();
       return out;`,
    )

    for (const [name, one] of Object.entries(result)) {
      console.log(`       ${name.padEnd(8)} bg ${one.bg}  stage ${one.stage}  panel ${one.painted}`)
      assert.equal(one.theme, name, `the root does not say it is on the ${name} theme`)
      assert.ok(one.painted, 'no panel was on screen to read')
    }
    const painted = Object.values(result).map((one) => one.painted)
    assert.equal(
      new Set(painted).size,
      3,
      `three themes painted ${new Set(painted).size} distinct panel colours — ` +
        `a theme is setting an attribute nothing responds to`,
    )
    /*
     * The near-black behind the picture has to move with the theme too. It was
     * a literal until this page was built, so a darker theme left two large
     * rectangles at the old brightness — the viewer stage and the node map.
     */
    assert.equal(
      new Set(Object.values(result).map((one) => one.stage)).size,
      3,
      'the stage behind the picture is the same in every theme, so it is still hardcoded',
    )
    // Neutral means neutral: no channel may differ from any other.
    const neutral = result.neutral.painted.match(/\d+/g).slice(0, 3).map(Number)
    assert.ok(
      new Set(neutral).size === 1,
      `the neutral theme painted ${result.neutral.painted}, which is not grey — the point of ` +
        `it is that the interface cannot tint what is being graded`,
    )
  })

  await check('the accent lands on the thing the accent is for', async () => {
    const result = await evaluate(
      cdp,
      `const { appearance, commands } = window.__fluxDev;
       await commands.run('workspace.switch.settings');
       await new Promise(r => setTimeout(r, 400));

       const read = async (accent) => {
         appearance.setAppearance({ accent });
         await new Promise(r => setTimeout(r, 160));
         const root = getComputedStyle(document.documentElement);
         // A real accented element: the selected row's left edge in the nav.
         const open = document.querySelector('.settings-link--open');
         return {
           token: root.getPropertyValue('--flux-accent').trim(),
           dim: root.getPropertyValue('--flux-accent-dim').trim(),
           painted: open ? getComputedStyle(open).borderLeftColor : null,
         };
       };
       const out = {};
       for (const a of ['cyan', 'violet', 'green', 'amber', 'grey']) out[a] = await read(a);
       appearance.resetAppearance();
       return out;`,
    )

    const painted = Object.values(result).map((one) => one.painted)
    console.log(
      `       ${Object.entries(result).map(([k, v]) => `${k} ${v.token}`).join(' · ')}`,
    )
    assert.equal(
      new Set(painted).size,
      5,
      `five accents painted ${new Set(painted).size} distinct edges`,
    )
    // The dim pair has to move with it, or a filled accent button stays cyan.
    assert.equal(
      new Set(Object.values(result).map((one) => one.dim)).size,
      5,
      'the dim accent did not change with the bright one',
    )
    const grey = result.grey.painted.match(/\d+/g).slice(0, 3).map(Number)
    assert.ok(
      Math.max(...grey) - Math.min(...grey) < 40,
      `the grey accent painted ${result.grey.painted}, which is not close to neutral`,
    )
  })

  await check('density moves the chrome and text size moves the type', async () => {
    const result = await evaluate(
      cdp,
      `const { appearance } = window.__fluxDev;

       const read = async (change) => {
         appearance.setAppearance(change);
         await new Promise(r => setTimeout(r, 180));
         const topbar = document.querySelector('.topbar');
         const label = document.querySelector('.tool-label') ?? document.querySelector('.panel-toolbar');
         return {
           topbar: topbar ? Math.round(topbar.getBoundingClientRect().height) : null,
           type: label ? getComputedStyle(label).fontSize : null,
         };
       };

       const compact = await read({ density: 'compact', textScale: 100 });
       const normal = await read({ density: 'default', textScale: 100 });
       const comfy = await read({ density: 'comfortable', textScale: 100 });

       // And the type, with density held still, to prove the two are separate.
       const small = await read({ density: 'default', textScale: 90 });
       const big = await read({ density: 'default', textScale: 125 });

       appearance.resetAppearance();
       return { compact, normal, comfy, small, big };`,
    )

    console.log(
      `       topbar ${result.compact.topbar}/${result.normal.topbar}/${result.comfy.topbar}px · ` +
        `type ${result.small.type} -> ${result.big.type}`,
    )
    assert.ok(
      result.compact.topbar < result.normal.topbar && result.normal.topbar < result.comfy.topbar,
      'density did not change the top bar height in order',
    )
    /*
     * The separation is the point of having two controls. Density must not
     * touch the type, and the scale must not touch the chrome.
     */
    assert.equal(
      result.compact.type,
      result.comfy.type,
      'density changed the type size, which text size is supposed to own',
    )
    assert.ok(
      parseFloat(result.small.type) < parseFloat(result.big.type),
      'the text scale did not change the type size',
    )
    assert.equal(
      result.small.topbar,
      result.big.topbar,
      'the text scale changed the chrome, which density is supposed to own',
    )
  })

  await check('a theme swatch is painted by the theme it names', async () => {
    /*
     * The swatches carry `data-flux-theme` themselves, so each is rendered by
     * the very block it selects. That is what stops a preview drifting from
     * the theme it claims to show — the usual failure of a theme picker,
     * where the swatch is a hardcoded approximation that stops matching the
     * first time somebody edits the palette.
     */
    const result = await evaluate(
      cdp,
      `const { commands } = window.__fluxDev;
       await commands.run('workspace.switch.settings');
       await new Promise(r => setTimeout(r, 400));
       const link = [...document.querySelectorAll('.settings-link')].find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Appearance');
       link.click();
       await new Promise(r => setTimeout(r, 250));

       return [...document.querySelectorAll('.ap-swatch')].map(el => ({
         theme: el.dataset.fluxTheme,
         bg: getComputedStyle(el.querySelector('.ap-swatch-bg')).backgroundColor,
         panel: getComputedStyle(el.querySelector('.ap-swatch-panel')).backgroundColor,
       }));`,
    )

    console.log(`       ${result.map((one) => `${one.theme} ${one.bg}`).join(' · ')}`)
    assert.equal(result.length, 3, 'there are not three swatches')
    assert.equal(
      new Set(result.map((one) => one.bg)).size,
      3,
      'the swatches are all the same colour, so they are not showing their own themes',
    )
  })

  await check('text stays legible in every theme', async () => {
    /*
     * Measured rather than eyeballed, because a palette is the easiest thing
     * in an interface to make slightly worse without noticing. Three tiers
     * against the panel they sit on, in all three themes.
     *
     * The thresholds are not all WCAG's. Body and dim are held to AAA and AA
     * for normal text. **Faint is held to 2.9:1, which is the shipped
     * default's own figure** — it is below AA, that was already true before
     * this page existed, and raising the default palette is a design decision
     * for the person whose app it is rather than something to slip into a
     * settings page. What this check does enforce is that no theme may be
     * *worse* than the default; both new ones measure 3.3:1, which is above
     * the 3:1 large-text line the default misses.
     */
    const result = await evaluate(
      cdp,
      `const { appearance, commands } = window.__fluxDev;

       /*
        * Read off real elements rather than off the tokens. The tokens are
        * hex and what lands on screen is rgb(), so parsing the token strings
        * was both more code and a weaker claim — this is the colour the
        * browser actually painted, which is the thing a reader sees.
        */
       await commands.run('workspace.switch.settings');
       await new Promise(r => setTimeout(r, 500));
       const link = [...document.querySelectorAll('.settings-link')].find(
         el => el.querySelector('.settings-link-name').textContent.trim() === 'Appearance');
       link.click();
       await new Promise(r => setTimeout(r, 250));

       const channel = (v) => {
         v = v / 255;
         return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
       };
       const luminance = (css) => {
         const parts = css.match(/[0-9.]+/g);
         const [r, g, b] = parts.slice(0, 3).map(Number).map(channel);
         return 0.2126 * r + 0.7152 * g + 0.0722 * b;
       };
       const ratio = (fg, bg) => {
         const a = luminance(fg) + 0.05;
         const b = luminance(bg) + 0.05;
         return Math.round((Math.max(a, b) / Math.min(a, b)) * 10) / 10;
       };

       const out = {};
       for (const theme of ['default', 'darker', 'neutral']) {
         appearance.setAppearance({ theme });
         await new Promise(r => setTimeout(r, 170));
         const panel = getComputedStyle(document.querySelector('.panel')).backgroundColor;
         // One element per tier, each a real line of text on the page.
         const at = (sel) => getComputedStyle(document.querySelector(sel)).color;
         out[theme] = {
           body: ratio(at('.settings-page-title'), panel),
           dim: ratio(at('.ap-note'), panel),
           faint: ratio(at('.ap-card-blurb'), panel),
         };
       }
       appearance.resetAppearance();
       return out;`,
    )

    for (const [theme, r] of Object.entries(result)) {
      console.log(`       ${theme.padEnd(8)} body ${r.body}:1  dim ${r.dim}:1  faint ${r.faint}:1`)
      assert.ok(r.body >= 7, `${theme}: body text at ${r.body}:1 is below AAA`)
      assert.ok(r.dim >= 4.5, `${theme}: dim text at ${r.dim}:1 is below AA`)
      assert.ok(
        r.faint >= 2.9,
        `${theme}: faint text at ${r.faint}:1 is worse than the shipped default's 2.9:1`,
      )
    }
  })

  await check('the choice survives a restart', async () => {
    const result = await evaluate(
      cdp,
      `const { appearance, store } = window.__fluxDev;
       appearance.setAppearance({ theme: 'neutral', accent: 'grey', density: 'compact', textScale: 110 });
       await store.flushStores();
       const raw = await store.loadStore('appearance', null);

       // And rubbish in the store must not break the app: a hand-edited file
       // with nonsense in it has to come back as the shipped look.
       await store.saveStore('appearance', { theme: 'chartreuse', textScale: 900 });
       await store.flushStores();
       await appearance.loadAppearance();
       const afterJunk = { ...appearance.getAppearance() };

       appearance.resetAppearance();
       await store.flushStores();
       return { raw, afterJunk };`,
    )

    console.log(`       stored ${JSON.stringify(result.raw)}`)
    assert.equal(result.raw?.theme, 'neutral', 'the theme is not on disk')
    assert.equal(result.raw?.accent, 'grey', 'the accent is not on disk')
    assert.equal(result.raw?.density, 'compact', 'the density is not on disk')
    assert.equal(result.raw?.textScale, 110, 'the text scale is not on disk')
    assert.deepEqual(
      result.afterJunk,
      { theme: 'default', accent: 'cyan', density: 'default', textScale: 100 },
      `nonsense in the store was not cleaned up: ${JSON.stringify(result.afterJunk)}`,
    )
  })
} finally {
  await restore().catch(() => {})
  report()
  cdp.close()
}
