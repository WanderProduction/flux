/**
 * What the main process knows about a newer FLUX, as the window needs it.
 *
 * All the deciding happens in electron/updater.js — which feed to ask, when to
 * download, what counts as newer. This is only the wire, and deliberately so:
 * the renderer can be reloaded at any moment, and anything it decided about an
 * update in progress would be forgotten while the download carried on.
 */

/**
 * - `disabled`  nothing to update: a dev build, run from a checkout
 * - `checking`  asking the feed
 * - `current`   asked, and this is the newest there is
 * - `downloading` a newer one exists and is coming down
 * - `ready`     downloaded and staged; restarting installs it
 * - `error`     the feed could not be reached, or refused
 *
 * `idle` is the state before the first answer arrives, which is the one a
 * window sees for the first second of its life.
 */
export type UpdateState =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'current'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** The version being offered, when there is one. */
  version: string | null
  percent: number
  error: string | null
  /** Which feed was actually used, so "no updates" can be told from "wrong URL". */
  feed: { url: string | null; from: string } | null
}

interface UpdatesBridge {
  state: () => Promise<UpdateStatus>
  check: () => Promise<UpdateStatus>
  install: () => Promise<boolean>
  onState: (handler: (status: UpdateStatus) => void) => () => void
}

interface FluxBridge {
  updates?: UpdatesBridge
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const hasUpdates = Boolean(bridge?.updates)

export const IDLE: UpdateStatus = {
  state: 'idle',
  version: null,
  percent: 0,
  error: null,
  feed: null,
}

export const readUpdateState = (): Promise<UpdateStatus> =>
  bridge?.updates ? bridge.updates.state() : Promise.resolve(IDLE)

export const checkForUpdate = (): Promise<UpdateStatus> =>
  bridge?.updates ? bridge.updates.check() : Promise.resolve(IDLE)

export const installUpdate = (): Promise<boolean> =>
  bridge?.updates ? bridge.updates.install() : Promise.resolve(false)

/** Returns its own unsubscribe, so a remount does not stack listeners. */
export const onUpdateState = (handler: (status: UpdateStatus) => void): (() => void) =>
  bridge?.updates ? bridge.updates.onState(handler) : () => {}

/**
 * What the status bar should say, or null when there is nothing worth a word.
 *
 * `current`, `idle` and `disabled` all return null. An editor's status bar is
 * not the place to announce that everything is normal — a permanent "up to
 * date" is noise that trains people to stop reading the line it sits on, and
 * then the one time it says something that matters they will not see it.
 */
export function updateLabel(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'checking':
      return null // over in a moment; a flicker is worse than silence
    case 'downloading':
      return status.percent > 0
        ? `downloading ${status.version ?? 'update'} — ${status.percent}%`
        : `update ${status.version ?? ''} available`.trim()
    case 'ready':
      return `${status.version} ready — restart to install`
    case 'error':
      /*
       * Nothing. A feed that cannot be reached is the *resting state* of a
       * FLUX whose updates come off a folder on one machine — the server is
       * only running when someone is shipping a build, so an app that said
       * "update check failed" would say it on nearly every launch.
       *
       * That is the same argument as the one against a permanent "up to
       * date", and it bites harder: a standing failure in the one line that
       * reports real problems teaches you to stop reading it. The error is
       * kept in the state rather than thrown away, so a deliberate check can
       * still answer for itself.
       */
      return null
    default:
      return null
  }
}
