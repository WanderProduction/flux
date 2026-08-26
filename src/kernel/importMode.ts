/**
 * How imports get into the project: by copy or by reference.
 *
 *   copy — the file is copied into <project>/imports first. The project folder
 *          becomes self-contained, which is what makes it safe to archive or
 *          move to another machine, and reads come off one disk.
 *   link — the asset points at the original where it already lives. Instant and
 *          costs no space, but the project depends on that path surviving.
 *
 * Neither is right for everyone, so the default is to ask. The preference is
 * app-scoped rather than project-scoped: it is a habit of the person using
 * FLUX, not a property of any one project.
 */

import { loadStore, saveStore } from './store'

export type ImportMode = 'ask' | 'copy' | 'link'

const STORE = 'import-mode'

let mode: ImportMode = 'ask'
let loaded = false

export async function loadImportMode(): Promise<ImportMode> {
  const stored = await loadStore<ImportMode>(STORE, 'ask')
  mode = stored === 'copy' || stored === 'link' ? stored : 'ask'
  loaded = true
  return mode
}

export function getImportMode(): ImportMode {
  return mode
}

export function isImportModeLoaded(): boolean {
  return loaded
}

export function setImportMode(next: ImportMode): void {
  mode = next
  void saveStore(STORE, next)
}
