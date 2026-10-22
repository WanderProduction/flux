import { useEffect, useState } from 'react'

import {
  installUpdate,
  onUpdateState,
  readUpdateState,
  updateLabel,
  IDLE,
  type UpdateStatus,
} from '../kernel/updates'

/**
 * The one place FLUX mentions updates.
 *
 * It asks *and* subscribes, because the check runs at startup on its own and
 * can finish before this is mounted — a renderer that only listened would miss
 * the answer and show nothing, which is indistinguishable from there being no
 * update. Reloading the window has to be able to recover the current state,
 * since the download it is reporting on lives in the main process and survives
 * the reload.
 */
export function UpdateBadge() {
  const [status, setStatus] = useState<UpdateStatus>(IDLE)

  useEffect(() => {
    let live = true
    void readUpdateState().then((initial) => {
      if (live) setStatus(initial)
    })
    const stop = onUpdateState(setStatus)
    return () => {
      live = false
      stop()
    }
  }, [])

  const label = updateLabel(status)
  if (!label) return null

  /*
   * Only the staged state is a button.
   *
   * A download in progress has nothing to click — pressing it could only mean
   * "hurry up" — and a failed check is a fact, not an action: retrying is what
   * the next launch does anyway.
   */
  if (status.state === 'ready') {
    return (
      <button
        type="button"
        className="status-update status-update-ready"
        title={`Restart FLUX to install ${status.version}`}
        onClick={() => void installUpdate()}
      >
        {label}
      </button>
    )
  }

  return (
    <span
      className="status-update"
      title={status.error ?? status.feed?.url ?? undefined}
    >
      {label}
    </span>
  )
}
