/**
 * Folders the user pinned to the rail.
 *
 * App-scoped rather than project-scoped: a pin is a place on this machine the
 * person keeps going back to — a footage drive, a music library — and having to
 * pin it again in every new project would defeat the point.
 */

import { loadStore, saveStore } from './store'

export interface PinnedFolder {
  name: string
  path: string
}

const STORE = 'pinned-folders'
const MAX_PINNED = 40

let pinned: PinnedFolder[] = []
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
  void saveStore(STORE, pinned)
}

export function subscribePinned(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPinned(): PinnedFolder[] {
  return pinned
}

export function isPinnedLoaded(): boolean {
  return loaded
}

export async function loadPinned(): Promise<void> {
  const stored = await loadStore<PinnedFolder[]>(STORE, [])
  const list = Array.isArray(stored) ? stored : []

  // Anything pinned while this read was in flight has to survive it, the same
  // race the asset store had.
  const held = new Set(pinned.map((p) => p.path))
  pinned = [...list.filter((p) => !held.has(p.path)), ...pinned]

  loaded = true
  listeners.forEach((listener) => listener())
}

export function isPinned(folderPath: string): boolean {
  return pinned.some((p) => p.path === folderPath)
}

/** Last path segment — what the rail shows. */
function basename(folderPath: string): string {
  const parts = folderPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || folderPath
}

export function pinFolder(folderPath: string): void {
  if (isPinned(folderPath)) return
  pinned = [...pinned, { name: basename(folderPath), path: folderPath }].slice(0, MAX_PINNED)
  emit()
}

export function unpinFolder(folderPath: string): void {
  if (!isPinned(folderPath)) return
  pinned = pinned.filter((p) => p.path !== folderPath)
  emit()
}

export function togglePin(folderPath: string): boolean {
  if (isPinned(folderPath)) {
    unpinFolder(folderPath)
    return false
  }
  pinFolder(folderPath)
  return true
}
