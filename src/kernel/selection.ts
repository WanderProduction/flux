/**
 * What is selected on the timeline.
 *
 * This lived inside the Timeline panel as `useState<Set<string>>` for as long
 * as the Timeline was the only thing that cared. It is not any more: Render
 * builds its queue from the selected clips, and a panel cannot read another
 * panel's state. The same reasoning kernel/tools.ts gives for the tool in hand
 * — a mode that a panel owned would be a mode every other panel had to reach
 * into, and closing that panel would leave the app holding nothing.
 *
 * So the Timeline still *drives* the selection, and now it no longer owns it.
 * Closing the Timeline no longer throws away what you had selected, which is
 * the behaviour you want the moment a second panel acts on it.
 *
 * ## It prunes itself
 *
 * A selection outlives the clips in it. Undo takes clips away; so does
 * deleting, and so does switching to a sequence that never had them. A
 * selection still pointing at a clip that is gone makes `Delete` and every
 * other command quietly do nothing — which reads as the app ignoring you.
 *
 * The Timeline used to prune in its own `subscribeSequence` handler. That only
 * worked while the Timeline was open, which was fine when it was also the only
 * owner and is not fine now. The pruning lives here, driven by the same
 * subscription, so it holds whether or not anything is on screen.
 *
 * Deliberately **not** in sequence.ts, even though that is what owns clips: a
 * sequence is the document, and what someone happens to have highlighted is
 * not part of it. Keeping them apart is also what lets the selection be
 * replaced wholesale when the sequence changes without the document hearing
 * about it.
 */

import { getSequence, subscribeSequence } from './sequence'

let selected: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The ids held right now. Always current — no ref needed to read it. */
export function getSelection(): ReadonlySet<string> {
  return selected
}

export function isSelected(id: string): boolean {
  return selected.has(id)
}

export function selectionSize(): number {
  return selected.size
}

/**
 * Replaces the selection.
 *
 * Takes the whole set rather than offering add/remove, because every gesture on
 * the timeline computes the set it wants: a click replaces, a shift-click
 * extends a range, a ctrl-click toggles one, a rubber band takes a region.
 * Expressing those as mutations would mean the store re-deriving what the
 * gesture already knew, and getting it subtly different.
 *
 * A no-op set does not notify. Pointer handlers re-assert the same selection
 * constantly — a drag that has not left the clip it started on, a click on
 * something already selected — and a notification per pointer move is a render
 * per pointer move.
 */
export function setSelection(ids: Iterable<string>): void {
  const next = ids instanceof Set ? (ids as Set<string>) : new Set(ids)
  if (same(next, selected)) return
  selected = next
  emit()
}

export function clearSelection(): void {
  setSelection(new Set())
}

function same(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/**
 * Drops anything that is no longer on the active sequence.
 *
 * Runs on every sequence change, which is more often than it needs to and
 * costs a set build over the clip list. The alternative is for every mutation
 * to remember to say what it removed, which is the kind of bookkeeping that is
 * correct until somebody adds a nineteenth way to remove a clip.
 */
subscribeSequence(() => {
  if (selected.size === 0) return
  const alive = new Set(getSequence().clips.map((clip) => clip.id))
  let gone = false
  for (const id of selected) {
    if (!alive.has(id)) {
      gone = true
      break
    }
  }
  if (!gone) return
  selected = new Set([...selected].filter((id) => alive.has(id)))
  emit()
})
