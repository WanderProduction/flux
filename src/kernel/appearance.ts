/**
 * How the interface looks: the theme, the accent, how tight it is, how big.
 *
 * Every one of these is a set of values for the tokens in `styles/theme.css`,
 * and that is the whole mechanism. A theme is not a stylesheet and not a class
 * on every component — it is `data-flux-theme` on the root element and a block
 * of token overrides in the stylesheet. "Custom UI skins by script" from
 * VISION.md means a skin is a file that redefines those tokens and nothing
 * else, so the switcher had to work the same way or it would have been a
 * second, competing mechanism.
 *
 * ## The claim in theme.css was not true, and now it nearly is
 *
 * That file says: *if a component hardcodes a colour, it has punched a hole in
 * the skinning system.* Measured while building this page, `app.css` held
 * **54 colour literals**. Most were fine and two kinds were not:
 *
 *   - **Four token names that were never defined.** `--flux-ok`,
 *     `--flux-danger`, `--flux-dim` and `--flux-line` were used as
 *     `var(--flux-dim, #8b93a1)` and the fallback was doing all the work. A
 *     skin redefining them would in fact have worked, which makes this the
 *     worst kind of hole: not broken, just invisible. They are declared now.
 *   - **Two near-black chrome surfaces.** The viewer stage and the node map
 *     backdrop were literals, so a darker theme would have left two large
 *     rectangles at the old brightness. They are `--flux-bg-stage` and
 *     `--flux-bg-canvas` now.
 *
 * What stays literal, deliberately, is in two groups. **Content black** — the
 * viewer frame, the letterbox bars, a sequence thumbnail — because you judge a
 * picture against black and not against whatever the chrome happens to be;
 * theming those would make the app lie about the footage. And **shadows**,
 * which are black at low alpha and read correctly over any surface. The
 * appearance harness holds the allowlist and fails if the count grows, which
 * turns that paragraph from a claim into a check.
 */

import { loadStore, saveStore } from './store'

const STORE = 'appearance'

export interface ThemeOption {
  id: string
  name: string
  /** One line: who it is for, not what colour it is. */
  blurb: string
}

/**
 * Three dark themes and no light one, which is a decision rather than an
 * omission.
 *
 * An editor is dark because the picture is the brightest thing on the screen
 * and anything around it biases how you read it. A light theme for a tool
 * whose job is judging images is not a preference, it is a worse instrument —
 * so the axis offered here is *how* dark and *how* neutral, which is the axis
 * Resolve and Premiere also offer and the one people actually want.
 *
 * Neutral is the interesting one. A tinted interface shifts your perception of
 * a grade; a desaturated one does not. That is why it exists and why its
 * accent default is the grey one.
 */
export const themes: ThemeOption[] = [
  {
    id: 'default',
    name: 'Default',
    blurb: 'The shipped dark blue-grey',
  },
  {
    id: 'darker',
    name: 'Darker',
    blurb: 'Near black, for a dim room and a bright picture',
  },
  {
    id: 'neutral',
    name: 'Neutral',
    blurb: 'Desaturated grey, so the interface does not tint what you are grading',
  },
]

export interface AccentOption {
  id: string
  name: string
  /** The colour itself, for the swatch. Read from the stylesheet would be
      better and is not possible before the theme is applied. */
  swatch: string
}

export const accents: AccentOption[] = [
  { id: 'cyan', name: 'Cyan', swatch: '#4cc2ff' },
  { id: 'violet', name: 'Violet', swatch: '#a06bff' },
  { id: 'green', name: 'Green', swatch: '#46d39a' },
  { id: 'amber', name: 'Amber', swatch: '#ffb648' },
  // For colour-critical work, where a saturated accent in the corner of your
  // eye is the thing biasing your judgement.
  { id: 'grey', name: 'Grey', swatch: '#9aa3b5' },
]

export interface DensityOption {
  id: string
  name: string
  blurb: string
}

export const densities: DensityOption[] = [
  { id: 'compact', name: 'Compact', blurb: 'More on screen, less room around it' },
  { id: 'default', name: 'Default', blurb: 'As shipped' },
  { id: 'comfortable', name: 'Comfortable', blurb: 'Bigger targets and more air' },
]

/**
 * Text scale, separate from density.
 *
 * Two controls because they answer different complaints. "I cannot read this"
 * is a size problem; "I cannot fit enough on screen" is a spacing one, and a
 * single slider that did both would make each of them worse to fix. Density
 * moves the chrome heights and the gutter; this moves only the type.
 */
export const TEXT_SCALES = [90, 100, 110, 125] as const

export interface Appearance {
  theme: string
  accent: string
  density: string
  /** Per cent. See TEXT_SCALES. */
  textScale: number
}

export const defaultAppearance: Appearance = {
  theme: 'default',
  accent: 'cyan',
  density: 'default',
  textScale: 100,
}

let appearance: Appearance = { ...defaultAppearance }
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  apply()
  listeners.forEach((listener) => listener())
  void saveStore(STORE, appearance)
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAppearance(): Appearance {
  return appearance
}

export function isAppearanceLoaded(): boolean {
  return loaded
}

/** Every field present and in range, whatever arrived from the store. */
function clean(raw: Partial<Appearance> | null | undefined): Appearance {
  const pick = <T extends { id: string }>(list: T[], value: unknown, fallback: string) =>
    list.some((one) => one.id === value) ? (value as string) : fallback

  const scale = Number(raw?.textScale)
  return {
    theme: pick(themes, raw?.theme, defaultAppearance.theme),
    accent: pick(accents, raw?.accent, defaultAppearance.accent),
    density: pick(densities, raw?.density, defaultAppearance.density),
    textScale: (TEXT_SCALES as readonly number[]).includes(scale)
      ? scale
      : defaultAppearance.textScale,
  }
}

/**
 * Writes the choice onto the root element.
 *
 * Attributes for the three that are sets of values the stylesheet holds, and
 * an inline custom property for the one that is a number. Attributes rather
 * than classes so a skin can target `[data-flux-theme='neutral']` without
 * guessing at a class name, and so the current choice is readable from the DOM
 * — which is also how the harness checks that a choice took effect rather than
 * merely being stored.
 */
function apply(): void {
  const root = globalThis.document?.documentElement
  if (!root) return
  root.dataset.fluxTheme = appearance.theme
  root.dataset.fluxAccent = appearance.accent
  root.dataset.fluxDensity = appearance.density
  root.style.setProperty('--flux-text-scale', String(appearance.textScale / 100))
}

/**
 * Reads the stored choice and puts it in force.
 *
 * Called from `main.tsx` before the first render rather than from a component,
 * because a theme applied after paint is a visible flash of the other one —
 * and on a near-black interface a flash of the default blue-grey is the most
 * noticeable thing the app could do on launch.
 */
export async function loadAppearance(): Promise<void> {
  const stored = await loadStore<Partial<Appearance>>(STORE, {})
  appearance = clean(stored)
  loaded = true
  apply()
  listeners.forEach((listener) => listener())
}

export function setAppearance(change: Partial<Appearance>): boolean {
  const next = clean({ ...appearance, ...change })
  if (
    next.theme === appearance.theme &&
    next.accent === appearance.accent &&
    next.density === appearance.density &&
    next.textScale === appearance.textScale
  ) {
    return false
  }
  appearance = next
  emit()
  return true
}

export function resetAppearance(): boolean {
  return setAppearance(defaultAppearance)
}

export function isDefaultAppearance(): boolean {
  return (
    appearance.theme === defaultAppearance.theme &&
    appearance.accent === defaultAppearance.accent &&
    appearance.density === defaultAppearance.density &&
    appearance.textScale === defaultAppearance.textScale
  )
}
