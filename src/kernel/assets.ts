/**
 * The project's imported assets.
 *
 * An asset is always a *reference*: an absolute path plus what we know about the
 * file. What varies is where that path points. On import the user chooses:
 *
 *   link — the path stays on the original file. Instant, touches nothing.
 *   copy — the file is copied into <project>/imports first, and the asset
 *          points at the copy, so the project folder is self-contained.
 *
 * Either way the original is never moved or altered. And either way the file
 * can still be renamed or deleted behind the project's back, so every asset
 * carries a `missing` flag and the store re-checks paths on load. Silently
 * rendering a broken card is how an NLE loses someone's footage without
 * telling them.
 */

import { assetUrl, existsMany, hasFilesystem, type MediaKind } from './fsBridge'
import { probeMedia } from './mediaProbe'

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
  /** Filled in by a probe after import; absent until then. */
  width?: number
  height?: number
  /** Seconds. Images carry the still-image default rather than nothing. */
  duration?: number
  /** True once probed and found undecodable — stops the timeline retrying forever. */
  unreadable?: boolean
  /** True when the file lives inside the project's imports folder. */
  inProject?: boolean
}

let assets: Asset[] = []
let loaded = false
const listeners = new Set<() => void>()

/**
 * Notifies only. Persistence belongs to kernel/project.ts, which listens here
 * and folds the result into the project document — one file is the project, so
 * one place decides when it is written.
 */
function emit() {
  listeners.forEach((listener) => listener())
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

/**
 * Replaces the whole list, without notifying persistence that anything changed.
 *
 * This is how a project document is applied on open. It is deliberately not
 * `importAssets`: that means "the user added these", which would immediately
 * mark the freshly-opened project as unsaved.
 */
export function setAssets(next: Asset[]): void {
  assets = Array.isArray(next) ? next : []
  loaded = true
  listeners.forEach((listener) => listener())
}

/** Re-checks every asset's path, for a project that has just been opened. */
export async function verifyAssetPaths(): Promise<void> {
  if (!hasFilesystem || assets.length === 0) return
  try {
    const present = await existsMany(assets.map((asset) => asset.path))
    assets = assets.map((asset) => ({ ...asset, missing: present[asset.path] === false }))
    listeners.forEach((listener) => listener())
  } catch (err) {
    console.warn('[flux] could not verify asset paths', err)
  }
}

export interface ImportCandidate {
  path: string
  name?: string
  kind: MediaKind
  size?: number
  mtimeMs?: number
  inProject?: boolean
  /**
   * What was already known about the file, when the caller knows it.
   *
   * A sequence file carries what was probed from its media, so opening one from
   * another project does not have to decode every clip again to find out how
   * long it is. Absent, the probe fills them in as usual.
   */
  width?: number
  height?: number
  duration?: number
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
      inProject: candidate.inProject,
      ...(candidate.width ? { width: candidate.width } : {}),
      ...(candidate.height ? { height: candidate.height } : {}),
      ...(candidate.duration ? { duration: candidate.duration } : {}),
    })
  }

  if (added.length > 0) {
    assets = [...assets, ...added]
    emit()
    // Probing is fire-and-forget: the cards appear immediately and fill in
    // their duration when it arrives, rather than the grid waiting on decode.
    added.forEach((asset) => void ensureProbed(asset.id))
  }
  return added
}

export function getAsset(id: string): Asset | undefined {
  return assets.find((asset) => asset.id === id)
}

function patchAsset(id: string, patch: Partial<Asset>) {
  let changed = false
  assets = assets.map((asset) => {
    if (asset.id !== id) return asset
    changed = true
    return { ...asset, ...patch }
  })
  if (changed) emit()
}

/**
 * Guarantees an asset knows its duration, probing if needed.
 *
 * Anything that places a clip needs this: a block on the timeline has to be as
 * long as its source, and an asset imported a moment ago may not have finished
 * probing yet.
 */
export async function ensureProbed(id: string): Promise<Asset | undefined> {
  const asset = getAsset(id)
  if (!asset || !hasFilesystem) return asset
  if (asset.duration !== undefined || asset.unreadable) return asset

  const info = await probeMedia(asset.path, asset.kind, assetUrl(asset.path))
  if (!info) {
    patchAsset(id, { unreadable: true })
    return getAsset(id)
  }

  patchAsset(id, { width: info.width, height: info.height, duration: info.duration })
  return getAsset(id)
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

/**
 * Drops everything, without writing.
 *
 * Called when a project opens or closes. This module holds its state at module
 * scope, so without an explicit reset the previous project's assets would still
 * be here when the next one loads — the timeline would show the wrong footage
 * and, worse, the first save would write it into the new project's folder. The
 * lack of a save here is the point: a reset must never touch either project.
 */
export function resetAssets(): void {
  assets = []
  loaded = false
  listeners.forEach((listener) => listener())
}

export async function recheckMissing(): Promise<void> {
  if (!hasFilesystem || assets.length === 0) return
  const present = await existsMany(assets.map((asset) => asset.path))
  assets = assets.map((asset) => ({ ...asset, missing: present[asset.path] === false }))
  emit()
}
