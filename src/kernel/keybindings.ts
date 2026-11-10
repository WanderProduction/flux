/**
 * The bindings actually in force, and the named sets you can keep.
 *
 * `keymap.ts` holds the *shipped* map and the machinery that turns a key event
 * into a chord. This holds the one the user is editing: it is loaded from the
 * store at boot, written back on every change, and it is what the controller
 * in `App.tsx` is fed.
 *
 * ## Why this is a module and not state in a panel
 *
 * Three things need the same answer and none of them can ask each other. The
 * window listener has to know which command a chord runs. The palette has to
 * show the chord for a command. The Hotkeys page has to show and change both
 * directions at once. Held in a panel, the first two would be reaching into
 * the third — and the page can be closed, which would be a strange moment for
 * every key in the app to stop working.
 *
 * It also replaces a prop. The palette used to be handed `lookupChord` from
 * the app root, which worked for exactly one consumer; the second consumer is
 * what turns that into a seam.
 *
 * ## A rebind is a swap, never an addition
 *
 * The map is chord-to-command, so one chord can run one command. Binding a
 * chord that is already taken therefore *takes it* — the previous command is
 * left with no key at all, which is the honest outcome and the one every
 * editor implements. What must never happen is a silent one: `conflictFor`
 * exists so the page can name the command about to lose its key, and the page
 * says so before anything moves.
 *
 * A command may hold several chords. `Ctrl K` and `Ctrl Shift P` both open the
 * palette and both should keep working, so nothing here assumes one key per
 * command — `chordsFor` returns all of them, and the page shows all of them.
 */

import { defaultKeymap, type Keymap } from './keymap'
import { builtInPresets, isBuiltInPreset, keymapOf } from './keymapPresets'
import { loadStore, saveStore } from './store'

const STORE = 'keybindings'

/**
 * A named set of bindings.
 *
 * Stored whole rather than as a diff from the defaults. A diff is smaller and
 * is the wrong shape: the point of saving a set is that it still means the
 * same thing after FLUX ships a release that changes a default, and a diff
 * would silently absorb that change.
 */
export interface KeymapPreset {
  id: string
  name: string
  keymap: Keymap
  /** Millis. Shown as "saved <when>", and the sort order of the list. */
  savedAt: number
  /**
   * Shipped with the app rather than saved by the user.
   *
   * These live in code (kernel/keymapPresets.ts), are never written to the
   * store, and cannot be deleted or overwritten — a preset somebody can
   * destroy by saving over its name is not something the Hotkeys page can
   * offer as a way back.
   */
  builtIn?: true
  /** One line under the name. Built-ins only. */
  blurb?: string
}

interface Stored {
  keymap?: Keymap
  presets?: KeymapPreset[]
  /** The preset the current map was last loaded from, for the page to mark. */
  activePreset?: string | null
}

let keymap: Keymap = { ...defaultKeymap }
let presets: KeymapPreset[] = []
let activePreset: string | null = null
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
  void saveStore<Stored>(STORE, { keymap, presets, activePreset })
}

export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The map in force. Treat as frozen; change it through the functions here. */
export function getKeybindings(): Keymap {
  return keymap
}

export function keybindingsLoaded(): boolean {
  return loaded
}

/**
 * The built-ins first, then whatever the user has saved.
 *
 * Resolved on every call rather than kept, so a built-in follows a change to
 * `defaultKeymap` for every chord it does not itself set — which is what
 * should happen when a command moves to a different key.
 */
export function getPresets(): KeymapPreset[] {
  const shipped: KeymapPreset[] = builtInPresets.map((one) => ({
    id: one.id,
    name: one.name,
    blurb: one.blurb,
    keymap: keymapOf(one),
    savedAt: 0,
    builtIn: true,
  }))
  return [...shipped, ...presets]
}

export function getActivePreset(): string | null {
  return activePreset
}

/**
 * Reads the stored bindings, if there are any.
 *
 * Unknown chords are kept and unknown *commands* are kept too, which is
 * deliberate on both counts: a binding for a command this build does not have
 * is a binding for a command a plugin may register in a moment, and throwing
 * it away would mean a plugin's keys quietly dying whenever it was not loaded
 * at boot. The window listener already ignores a chord whose command is
 * missing, so carrying them costs nothing but the row.
 *
 * What is *not* merged in is the defaults. A user who deliberately cleared a
 * binding must not have it handed back on the next launch, so a stored map is
 * taken as the whole truth — which is also why `resetAll` exists as an
 * explicit act.
 */
/**
 * Command ids that have been renamed, old to new.
 *
 * A stored keymap is the whole truth — deliberately, so a binding somebody
 * cleared stays cleared — and the cost of that is this table. Without it, the
 * layout commands kept their keys for exactly as long as nobody had ever
 * opened the Hotkeys page: anyone who had saved a map would find `1`, `2` and
 * `3` bound to commands that no longer exist, with nothing on screen to say
 * why. Presets have the same problem and get the same treatment, since a
 * preset is a whole map too.
 *
 * Entries are kept, not deleted once "everybody has migrated" — there is no
 * way to know that, and a line in a table is cheaper than a key that stops
 * working on one person's machine.
 */
const RENAMED: Record<string, string> = {
  'workspace.switch.edit': 'layout.switch.edit',
  'workspace.switch.export': 'layout.switch.export',
  'workspace.switch.settings': 'layout.switch.settings',
  'workspace.save': 'layout.save',
  'workspace.reset': 'layout.reset',
}

/** The same map with renamed commands moved over. Untouched when none apply. */
function migrate(map: Keymap): Keymap {
  let moved = false
  const out: Keymap = {}
  for (const [chord, command] of Object.entries(map)) {
    const renamed = RENAMED[command]
    if (renamed) moved = true
    out[chord] = renamed ?? command
  }
  return moved ? out : map
}

export async function loadKeybindings(): Promise<void> {
  const stored = await loadStore<Stored>(STORE, {})

  if (stored.keymap && typeof stored.keymap === 'object') {
    keymap = migrate({ ...stored.keymap })
  }
  if (Array.isArray(stored.presets)) {
    presets = stored.presets
      .filter(
        (one): one is KeymapPreset =>
          !!one && typeof one.id === 'string' && typeof one.name === 'string' && !!one.keymap,
      )
      .map((one) => ({ ...one, keymap: migrate(one.keymap) }))
  }
  activePreset = typeof stored.activePreset === 'string' ? stored.activePreset : null

  loaded = true
  // Not `emit`: nothing changed that needs writing back, and writing the file
  // we just read would be the one moment a corrupt read could overwrite a good
  // file with its own fallback.
  listeners.forEach((listener) => listener())
}

/** Every chord bound to this command, in the order the map holds them. */
export function chordsFor(commandId: string): string[] {
  return Object.keys(keymap).filter((chord) => keymap[chord] === commandId)
}

/** The command a chord runs, or undefined. */
export function commandFor(chord: string): string | undefined {
  return keymap[chord]
}

/**
 * The command that would lose this chord if it were bound now.
 *
 * Null when the chord is free, and null when it already runs this very
 * command — rebinding something to the key it already has is not a conflict,
 * it is a no-op, and warning about it would be noise.
 */
export function conflictFor(chord: string, commandId: string): string | null {
  const holder = keymap[chord]
  if (!holder || holder === commandId) return null
  return holder
}

/**
 * Gives a chord to a command, taking it from whoever had it.
 *
 * @returns the command that lost it, or null.
 */
export function bindChord(chord: string, commandId: string): string | null {
  if (!chord || keymap[chord] === commandId) return null
  const displaced = keymap[chord] ?? null
  keymap = { ...keymap, [chord]: commandId }
  // Edited by hand, so it is no longer exactly the set it came from.
  activePreset = null
  emit()
  return displaced
}

/** Removes a chord, leaving whatever held it with one fewer key. */
export function unbindChord(chord: string): boolean {
  if (!(chord in keymap)) return false
  const next = { ...keymap }
  delete next[chord]
  keymap = next
  activePreset = null
  emit()
  return true
}

/**
 * Puts one command back to the keys it ships with.
 *
 * Both directions, which is the part worth being careful about: the command's
 * current chords go, *and* the chords it has by default are taken back from
 * whoever holds them now. Doing only the first would leave the command with
 * nothing whenever its default had been given away.
 */
export function resetCommand(commandId: string): boolean {
  const mine = chordsFor(commandId)
  const defaults = Object.keys(defaultKeymap).filter((chord) => defaultKeymap[chord] === commandId)
  if (mine.length === 0 && defaults.length === 0) return false

  const next = { ...keymap }
  for (const chord of mine) delete next[chord]
  for (const chord of defaults) next[chord] = commandId

  keymap = next
  activePreset = null
  emit()
  return true
}

/** Everything back to the shipped map. */
export function resetAllKeybindings(): void {
  keymap = { ...defaultKeymap }
  activePreset = null
  emit()
}

/** True when the map in force is exactly the one FLUX ships. */
export function isDefaultKeymap(): boolean {
  const mine = Object.keys(keymap)
  const theirs = Object.keys(defaultKeymap)
  if (mine.length !== theirs.length) return false
  return mine.every((chord) => keymap[chord] === defaultKeymap[chord])
}

/** How many chords differ from the shipped map, for the page to report. */
export function changedCount(): number {
  const chords = new Set([...Object.keys(keymap), ...Object.keys(defaultKeymap)])
  let changed = 0
  for (const chord of chords) if (keymap[chord] !== defaultKeymap[chord]) changed += 1
  return changed
}

// ── named sets ───────────────────────────────────────────────────

let nextPresetId = 0

/** Saves the map in force under a name, replacing a set of the same name. */
export function savePreset(name: string): KeymapPreset | null {
  const clean = name.trim()
  if (!clean) return null
  /*
   * Not over a shipped one. "Premiere Pro" has to go on meaning Premiere Pro,
   * or the way back from an experiment is gone — and the page can say so,
   * where a silently renamed save could not.
   */
  if (builtInPresets.some((one) => one.name.toLowerCase() === clean.toLowerCase())) return null

  const existing = presets.find((one) => one.name.toLowerCase() === clean.toLowerCase())
  const preset: KeymapPreset = {
    id: existing?.id ?? `kp${Date.now().toString(36)}${nextPresetId++}`,
    name: clean,
    keymap: { ...keymap },
    savedAt: Date.now(),
  }

  presets = existing
    ? presets.map((one) => (one.id === existing.id ? preset : one))
    : [...presets, preset]
  activePreset = preset.id
  emit()
  return preset
}

/**
 * Makes a saved set the one in force.
 *
 * Whole, not merged: a set is "the bindings I want", and merging it over the
 * current map would leave behind any key the set deliberately does not have.
 */
export function applyPreset(id: string): boolean {
  const preset = getPresets().find((one) => one.id === id)
  if (!preset) return false
  keymap = { ...preset.keymap }
  activePreset = preset.id
  emit()
  return true
}

export function deletePreset(id: string): boolean {
  // A shipped preset is the way back to a known keyboard. Letting it be
  // deleted would make that a one-way door.
  if (isBuiltInPreset(id)) return false
  if (!presets.some((one) => one.id === id)) return false
  presets = presets.filter((one) => one.id !== id)
  if (activePreset === id) activePreset = null
  emit()
  return true
}

/**
 * The map in force, as the text of a file somebody can keep.
 *
 * Export and import are a clipboard round trip rather than a file dialog, and
 * that is a deliberate smaller first step: the main process has pickers for
 * opening files but nothing for choosing where to *save* one, so a file export
 * would need a new IPC channel and a dialog before it could do anything. The
 * text is the same either way, so the file version is a second route to this
 * same function rather than a different feature.
 */
export function exportKeybindings(): string {
  return JSON.stringify({ flux: 'keybindings', version: 1, keymap }, null, 2)
}

export type ImportResult =
  | { ok: true; bound: number }
  | { ok: false; reason: string }

/**
 * Replaces the map in force from exported text.
 *
 * Every problem is reported rather than repaired, for the reason
 * `shared/editDocument.js` gives about cut lists: a keymap half-read is worse
 * than one refused, because the half that arrived is indistinguishable from
 * the half that did not.
 */
export function importKeybindings(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'that is not JSON' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'that is not an object' }

  const body = parsed as { flux?: unknown; keymap?: unknown }
  if (body.flux !== 'keybindings') {
    return { ok: false, reason: 'that file is not a FLUX keymap' }
  }
  if (!body.keymap || typeof body.keymap !== 'object') {
    return { ok: false, reason: 'the file has no bindings in it' }
  }

  const incoming = body.keymap as Record<string, unknown>
  const next: Keymap = {}
  for (const [chord, commandId] of Object.entries(incoming)) {
    if (typeof chord === 'string' && chord && typeof commandId === 'string' && commandId) {
      next[chord] = commandId
    }
  }
  if (Object.keys(next).length === 0) {
    return { ok: false, reason: 'none of the bindings in that file are usable' }
  }

  keymap = next
  activePreset = null
  emit()
  return { ok: true, bound: Object.keys(next).length }
}
