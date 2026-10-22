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
import { SEQUENCE_EXTENSION } from '../../shared/sequenceFormat.js'
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

/**
 * Paths of any `.fluxseq` in a drop.
 *
 * A sequence is not footage and does not become a clip, so it is picked out
 * before the media path rather than after — `readNativeFileDrag` drops anything
 * that is not decodable media, which a sequence is not.
 */
export function sequenceFilesIn(event: React.DragEvent): string[] {
  const bridge = (globalThis as { flux?: FilePathBridge }).flux
  const pathForFile = bridge?.fs?.pathForFile
  if (!pathForFile || !isNativeFileDrag(event)) return []

  const found: string[] = []
  for (const file of Array.from(event.dataTransfer.files)) {
    const path = pathForFile(file)
    if (path && isSequenceFile(path)) found.push(path)
  }
  return found
}

/**
 * Whether a drop carries a sequence.
 *
 * Checked from the file *names* during dragover, where the real paths are not
 * available: a drag in progress exposes only types and item kinds. The names
 * are enough to decide whether to accept the drop, and the paths are read on
 * the drop itself.
 */
export function hasSequenceFile(event: React.DragEvent): boolean {
  if (!isNativeFileDrag(event)) return false
  return Array.from(event.dataTransfer.files).some((file) => isSequenceFile(file.name))
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

function isSequenceFile(name: string): boolean {
  return name.toLowerCase().endsWith(SEQUENCE_EXTENSION)
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

/**
 * Folders in a native drop, as real paths.
 *
 * A dropped folder arrives as a `File` with no extension, so `mediaKindOf`
 * gives it no kind and `readNativeFileDrag` above discards it — which is
 * exactly right for a `.txt` and exactly wrong for a shoot folder. The
 * entries API is what can tell the two apart: `isDirectory` is the only
 * honest answer, where guessing from a zero size would also catch every
 * empty file.
 *
 * ## It must be called before the first `await`
 *
 * `dataTransfer.items` is neutered the moment the drop handler yields — the
 * browser reclaims it at the end of the synchronous task. A folder read after
 * an `await` is a folder that always comes back empty, and the failure looks
 * like "dropping folders does not work" rather than like a timing bug. See
 * the capture at the top of the Timeline's `onDrop`.
 */
export function readDroppedFolders(event: React.DragEvent): string[] {
  const bridge = (globalThis as { flux?: FilePathBridge }).flux
  const pathForFile = bridge?.fs?.pathForFile
  if (!pathForFile || !isNativeFileDrag(event)) return []

  const items = Array.from(event.dataTransfer.items)
  const files = Array.from(event.dataTransfer.files)
  const folders: string[] = []

  items.forEach((item, index) => {
    if (item.kind !== 'file') return
    const entry = item.webkitGetAsEntry?.()
    if (!entry?.isDirectory) return
    // `items` and `files` are parallel for file-kind entries, and the path can
    // only come from the File — an entry knows its name, not where it lives.
    const file = files[index]
    const path = file ? pathForFile(file) : null
    if (path) folders.push(path)
  })

  return folders
}
