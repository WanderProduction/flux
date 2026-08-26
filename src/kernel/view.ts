/**
 * Where the app was arranged for this project — the part of a save that makes
 * reopening feel like coming back rather than starting over.
 *
 * A .prproj remembers which workspace you were in, how far the timeline was
 * zoomed and which bin you were looking at, and so does this. It rides in the
 * document alongside the assets and the sequence.
 *
 * The one rule that makes it bearable: **view changes never mark the project
 * unsaved.** Zooming the timeline is not an edit, and a dirty dot that appears
 * because you scrolled teaches people to ignore the dirty dot. The current view
 * is simply read at save time and written with whatever else is being saved.
 */

export type BrowserLocation = { type: 'project' } | { type: 'folder'; path: string }

export interface ViewState {
  /** Active workspace id — see kernel/workspaces.ts. */
  workspace: string
  timeline: {
    /** Pixels per second. 0 means "never set", so the panel picks its default. */
    zoom: number
  }
  browser: {
    location: BrowserLocation
  }
}

export function defaultView(): ViewState {
  return {
    workspace: 'edit',
    timeline: { zoom: 0 },
    browser: { location: { type: 'project' } },
  }
}

let view: ViewState = defaultView()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeView(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getView(): ViewState {
  return view
}

/**
 * Records part of the view. Merged one level deep so a panel can report only
 * what it owns without having to know the rest of the shape.
 */
export function recordView(patch: Partial<ViewState>): void {
  const next: ViewState = {
    workspace: patch.workspace ?? view.workspace,
    timeline: { ...view.timeline, ...patch.timeline },
    browser: { ...view.browser, ...patch.browser },
  }
  // Panels report on every render pass; without this, a no-op would still wake
  // every subscriber and the timeline would re-render on its own report.
  if (JSON.stringify(next) === JSON.stringify(view)) return
  view = next
  emit()
}

/**
 * Applies a document's view. Unknown or missing pieces fall back rather than
 * being trusted, so a hand-edited .flux cannot put the app in a state that has
 * no UI — an empty workspace id would leave no panels on screen.
 */
export function setView(next: Partial<ViewState> | null | undefined): void {
  const base = defaultView()
  view = {
    workspace: typeof next?.workspace === 'string' && next.workspace ? next.workspace : base.workspace,
    timeline: { zoom: Number(next?.timeline?.zoom) || 0 },
    browser: {
      location:
        next?.browser?.location?.type === 'folder' && next.browser.location.path
          ? { type: 'folder', path: next.browser.location.path }
          : { type: 'project' },
    },
  }
  emit()
}

/** Drops view state without writing, when a project closes. */
export function resetView(): void {
  view = defaultView()
  emit()
}
