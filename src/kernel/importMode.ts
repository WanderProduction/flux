/**
 * How imports get into the project: by copy or by reference.
 *
 *   copy — the file is copied into <project>/imports first. The project folder
 *          becomes self-contained, which is what makes it safe to archive or
 *          move to another machine, and reads come off one disk.
 *   link — the asset points at the original where it already lives. Instant and
 *          costs no space, but the project depends on that path surviving.
 *
 * Neither is right for everyone, so the default is to ask. The answer is
 * remembered PER PROJECT: an archive-everything job and a scratch edit off a
 * fast drive want opposite things, and one global setting would force the same
 * habit on both.
 */

export type ImportMode = 'ask' | 'copy' | 'link'

let mode: ImportMode = 'ask'

export function getImportMode(): ImportMode {
  return mode
}

/**
 * `persist: false` is used when applying a project document on open: the value
 * came *from* the document, so writing it back would mark a freshly-opened
 * project as unsaved.
 */
export function setImportMode(next: ImportMode, options?: { persist?: boolean }): void {
  const valid: ImportMode = next === 'copy' || next === 'link' ? next : 'ask'
  if (mode === valid) return
  mode = valid
  if (options?.persist !== false) listeners.forEach((listener) => listener())
}

/** Drops the remembered answer, for a project open or close. */
export function resetImportMode(): void {
  mode = 'ask'
}

const listeners = new Set<() => void>()

/** kernel/project.ts subscribes, so changing the mode marks the project unsaved. */
export function subscribeImportMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
