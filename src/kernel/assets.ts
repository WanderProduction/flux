/**
 * The project's imported assets.
 *
 * An asset is a *reference*: an absolute path plus what we know about the file.
 * FLUX never copies or moves the original — importing costs nothing and touches
 * nothing on disk. The consequence is that a file can be renamed, moved or
 * deleted behind the project's back, so every asset carries a `missing` flag
 * and the store re-checks the paths on load. Silently rendering a broken card
 * is how an NLE loses someone's footage without telling them.
 */

import { existsMany, hasFilesystem, type MediaKind } from './fsBridge'
import { loadStore, saveStore } from './store'

export interface Asset {
  id: string
  path: string
  name: string
  kind: MediaKind
  size: number
  mtimeMs: number
  addedAt: number
  /** True when the path did not resolve at the last check. */
  missing?: boolean
}

const STORE = 'assets'

let assets: Asset[] = []
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
  void saveStore(STORE, assets)
}

export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAssets(): Asset[] {
  return assets
}

export function isLoaded(): boolean {
  return loaded
}

/** Paths are the identity — importing the same file twice is a no-op, not a duplicate card. */
export function hasAsset(filePath: string): boolean {
  return assets.some((asset) => asset.path === filePath)
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `a${Date.now().toString(36)}${idCounter.toString(36)}`
}

export async function loadAssets(): Promise<void> {
  const stored = await loadStore<Asset[]>(STORE, [])
  assets = Array.isArray(stored) ? stored : []

  // Re-check on every load, because anything could have happened to these files
  // while FLUX was closed.
  if (hasFilesystem && assets.length > 0) {
    try {
      const present = await existsMany(assets.map((asset) => asset.path))
      assets = assets.map((asset) => ({ ...asset, missing: present[asset.path] === false }))
    } catch (err) {
      console.warn('[flux] could not verify asset paths', err)
    }
  }

  loaded = true
  listeners.forEach((listener) => listener())
}

export interface ImportCandidate {
  path: string
  name?: string
  kind: MediaKind
  size?: number
  mtimeMs?: number
}

/** Returns the assets actually added — already-imported paths are skipped. */
export function importAssets(candidates: ImportCandidate[]): Asset[] {
  const added: Asset[] = []
  const seen = new Set(assets.map((asset) => asset.path))

  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue
    seen.add(candidate.path)
    added.push({
      id: nextId(),
      path: candidate.path,
      name: candidate.name ?? basename(candidate.path),
      kind: candidate.kind,
      size: candidate.size ?? 0,
      mtimeMs: candidate.mtimeMs ?? 0,
      addedAt: Date.now(),
    })
  }

  if (added.length > 0) {
    assets = [...assets, ...added]
    emit()
  }
  return added
}

/** Removes from the project only. The file on disk is never touched. */
export function removeAssets(ids: string[]): number {
  const doomed = new Set(ids)
  const before = assets.length
  assets = assets.filter((asset) => !doomed.has(asset.id))
  const removed = before - assets.length
  if (removed > 0) emit()
  return removed
}

export async function recheckMissing(): Promise<void> {
  if (!hasFilesystem || assets.length === 0) return
  const present = await existsMany(assets.map((asset) => asset.path))
  assets = assets.map((asset) => ({ ...asset, missing: present[asset.path] === false }))
  emit()
}
