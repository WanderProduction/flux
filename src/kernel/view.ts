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

import {
  DEFAULT_PAUSED_RESOLUTION,
  DEFAULT_PLAYBACK_RESOLUTION,
  RESOLUTIONS,
} from './viewer'

export type BrowserLocation = { type: 'project' } | { type: 'folder'; path: string }

export interface ViewState {
  /** Active workspace id — see kernel/workspaces.ts. */
  workspace: string
  timeline: {
    /** Pixels per second. 0 means "never set", so the panel picks its default. */
    zoom: number
    /**
     * Whether edges snap to their neighbours, the playhead and zero.
     *
     * A mode rather than a held key, which is what every NLE settled on — and
     * here it is also what frees `Alt` to mean "duplicate" while dragging, the
     * one gesture that cannot be spelled any other way. Optional so a project
     * saved before it existed opens with snapping on rather than off.
     */
    snapping?: boolean
    /** Whether pausing selects the clip under the playhead. Off unless asked for. */
    autoSelect?: boolean
    /**
     * Where the playhead was left.
     *
     * Reopening a project at zero makes the work look lost: the clips are all
     * there, but the viewer is showing the first frame of the first shot
     * rather than the moment that was being worked on, and the first
     * impression is that something did not save. Coming back to the same frame
     * is what makes a reopen feel like returning.
     *
     * Read at save time rather than recorded as it moves — a playhead reports
     * thirty times a second, and the view is not a thing to write that often.
     * Optional, so a project saved before this opens at zero as it always did.
     */
    playhead?: number
    /**
     * Whether the view travels with the playhead during playback.
     *
     * On by default, which is what an NLE does and what makes a long timeline
     * watchable. Off is a real working mode rather than an escape hatch:
     * watching one stretch of the timeline while another plays is how you
     * compare two takes, and a view that snaps back to the playhead makes it
     * impossible.
     */
    follow?: boolean
  }
  browser: {
    location: BrowserLocation
  }
  /**
   * The Viewer's two resolution preferences — see kernel/viewer.ts.
   *
   * Here rather than in SequenceSettings because they are about this machine
   * keeping up, not about the work: the same project on a faster computer
   * wants a different answer, and the render never reads them at all. Optional
   * so a project saved before they existed opens with the defaults.
   */
  viewer?: {
    playbackResolution: number
    pausedResolution: number
  }
}

export function defaultView(): ViewState {
  return {
    workspace: 'edit',
    timeline: { zoom: 0, follow: true },
    browser: { location: { type: 'project' } },
    viewer: {
      playbackResolution: DEFAULT_PLAYBACK_RESOLUTION,
      pausedResolution: DEFAULT_PAUSED_RESOLUTION,
    },
  }
}

/** A stored resolution, or the default if it is not one this app offers. */
function oneOf(value: unknown, fallback: number): number {
  return RESOLUTIONS.some((r) => r.value === value) ? (value as number) : fallback
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
    viewer: { ...view.viewer, ...patch.viewer } as ViewState['viewer'],
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
    /*
     * Every field read back, not only the zoom.
     *
     * `snapping` and `autoSelect` were written on every save and dropped here
     * on every open, which is the failure the viewer comment below warns
     * about: a preference that looks like it works until the next time the
     * project is opened. Both are optional in the type and both have a
     * non-false default, so the bug was invisible to anyone who liked the
     * defaults.
     */
    timeline: {
      zoom: Number(next?.timeline?.zoom) || 0,
      snapping: next?.timeline?.snapping !== false,
      autoSelect: next?.timeline?.autoSelect === true,
      follow: next?.timeline?.follow !== false,
      // Not clamped to the sequence here: this module does not know how long
      // the sequence is, and a playhead past the end is seeked, which does.
      playhead: Number.isFinite(next?.timeline?.playhead)
        ? Math.max(0, Number(next?.timeline?.playhead))
        : 0,
    },
    browser: {
      location:
        next?.browser?.location?.type === 'folder' && next.browser.location.path
          ? { type: 'folder', path: next.browser.location.path }
          : { type: 'project' },
    },
    /*
     * Read back rather than dropped.
     *
     * A preference that is written on every save and silently reset on every
     * open is worse than one that was never stored: it looks like it works
     * until the next time the project is opened. `oneOf` keeps a hand-edited
     * .flux from putting a resolution in here that nothing can render.
     */
    viewer: {
      playbackResolution: oneOf(next?.viewer?.playbackResolution, base.viewer!.playbackResolution),
      pausedResolution: oneOf(next?.viewer?.pausedResolution, base.viewer!.pausedResolution),
    },
  }
  emit()
}

/** Drops view state without writing, when a project closes. */
export function resetView(): void {
  view = defaultView()
  emit()
}
