/**
 * The drag contract between anything draggable and any drop target.
 *
 * Two payloads, because a drag carries one of two very different things:
 *
 *   assets — already in the project. The drop is a placement.
 *   files  — not in the project yet. The drop is an import *and* a placement,
 *            and it has to go through the copy-or-link decision first.
 *
 * Private MIME types rather than `text/plain` for two reasons: dockview drives
 * its own panel docking through drag events, so an unlabelled drag risks being
 * read as a request to move a panel; and a drop target can then reject foreign
 * drags by simply not finding these types, instead of guessing at the payload.
 *
 * A third source needs no type of its own: files dragged in from Explorer
 * arrive as native `dataTransfer.files`, which is a shape the browser defines.
 */

import { mediaKindOf } from '../../shared/mediaTypes.js'
import type { MediaKind } from './fsBridge'

export const ASSET_DRAG_TYPE = 'application/x-flux-assets'
export const FILE_DRAG_TYPE = 'application/x-flux-files'

export interface DraggedFile {
  path: string
  kind: MediaKind
  size?: number
  mtimeMs?: number
}

export function setAssetDragPayload(event: React.DragEvent, assetIds: string[]) {
  event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(assetIds))
  event.dataTransfer.effectAllowed = 'copy'
}

export function setFileDragPayload(event: React.DragEvent, files: DraggedFile[]) {
  event.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify(files))
  event.dataTransfer.effectAllowed = 'copy'
}

export function isAssetDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(ASSET_DRAG_TYPE)
}

export function isFileDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(FILE_DRAG_TYPE)
}

/** A drag out of Explorer, or any other application. */
export function isNativeFileDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

/** True for anything the Timeline knows how to turn into a clip. */
export function isDroppableDrag(event: React.DragEvent): boolean {
  return isAssetDrag(event) || isFileDrag(event) || isNativeFileDrag(event)
}

export function readAssetDragPayload(event: React.DragEvent): string[] {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData(ASSET_DRAG_TYPE))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function readFileDragPayload(event: React.DragEvent): DraggedFile[] {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData(FILE_DRAG_TYPE))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (file): file is DraggedFile =>
        typeof file === 'object' && file !== null && typeof (file as DraggedFile).path === 'string',
    )
  } catch {
    return []
  }
}

interface FilePathBridge {
  fs?: { pathForFile?: (file: File) => string }
}

/**
 * Real paths for files dragged in from outside the app.
 *
 * A dropped `File` no longer carries `.path` — Electron removed it — so the
 * main-side `webUtils` has to translate, which is why this goes through the
 * preload bridge. Anything the app cannot decode is dropped here rather than
 * imported as a card that can never produce a picture.
 */
export function readNativeFileDrag(event: React.DragEvent): DraggedFile[] {
  const bridge = (globalThis as { flux?: FilePathBridge }).flux
  const pathForFile = bridge?.fs?.pathForFile
  if (!pathForFile) return []

  const files: DraggedFile[] = []
  for (const file of Array.from(event.dataTransfer.files)) {
    const path = pathForFile(file)
    const kind = path ? (mediaKindOf(path) as MediaKind | null) : null
    if (path && kind) files.push({ path, kind, size: file.size })
  }
  return files
}
