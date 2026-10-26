import { loadStore, saveStore } from './store'

/**
 * Named panel arrangements the user saved, and can go back to.
 *
 * Separate from `workspaces`, which are the *built-in* arrangements — Edit and
 * Export — each with one remembered layout. Those answer "what is FLUX for
 * right now". A preset answers "this is how I like it", and there can be as
 * many as someone wants: a wide timeline for assembling, a big viewer for
 * grading, a two-monitor arrangement for a long batch.
 *
 * Installation state rather than project state, and deliberately: a layout is
 * a property of the person and their screen, not of the work. Copy a project
 * to another machine and it should arrive with its sequences and its render
 * settings, not with somebody else's idea of where the Timeline goes.
 *
 * What is stored is dockview's own serialisation, opaque here on purpose — the
 * dock owns its format, and a kernel module that parsed it would have to be
 * changed every time the dock learned a new kind of group.
 */

const STORE = 'layout-presets'

export interface LayoutPreset {
  id: string
  name: string
  /** Dockview's serialised layout. Opaque. */
  layout: unknown
  savedAt: number
  /** Which workspace it was saved from, so applying one can restore that too. */
  workspace?: string
}

let presets: LayoutPreset[] = []
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
  void saveStore(STORE, presets)
}

export function subscribeLayouts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function layoutPresets(): LayoutPreset[] {
  return presets
}

export function layoutsLoaded(): boolean {
  return loaded
}

/** Reads what was saved. Called once, as the app comes up. */
export async function loadLayoutPresets(): Promise<void> {
  const stored = await loadStore<LayoutPreset[]>(STORE, [])
  presets = Array.isArray(stored) ? stored.filter((one) => one && one.id && one.name) : []
  loaded = true
  listeners.forEach((listener) => listener())
}

let counter = 0
function nextId(): string {
  counter += 1
  return `lp${Date.now().toString(36)}${counter.toString(36)}`
}

/**
 * Saves the current arrangement under a name.
 *
 * A repeated name replaces rather than making a second entry with the same
 * label: "save it again, I moved something" is what pressing it twice means,
 * and two identical rows in a menu is a thing nobody can choose between.
 */
export function saveLayoutPreset(name: string, layout: unknown, workspace?: string): LayoutPreset {
  const trimmed = name.trim() || 'Layout'
  const existing = presets.find((one) => one.name.toLowerCase() === trimmed.toLowerCase())
  const preset: LayoutPreset = {
    id: existing?.id ?? nextId(),
    name: trimmed,
    layout,
    savedAt: Date.now(),
    workspace,
  }
  presets = existing
    ? presets.map((one) => (one.id === preset.id ? preset : one))
    : [...presets, preset]
  emit()
  return preset
}

export function getLayoutPreset(id: string): LayoutPreset | undefined {
  return presets.find((one) => one.id === id)
}

export function removeLayoutPreset(id: string): boolean {
  const before = presets.length
  presets = presets.filter((one) => one.id !== id)
  if (presets.length === before) return false
  emit()
  return true
}

/** For the harnesses, and for a project that wants a clean slate. */
export function setLayoutPresets(next: LayoutPreset[]): void {
  presets = Array.isArray(next) ? next : []
  loaded = true
  emit()
}
