import { getRenderState } from '../kernel/renderQueue'
import { formatDuration } from '../kernel/renderBridge'

/**
 * How far along a batch is — measured in footage, not in rows.
 *
 * "4 of 9" is the number a queue is tempted to show and almost the only one
 * that cannot be trusted here: these clips run from three seconds to two
 * minutes, so four rows out of nine can be a tenth of the work or nine tenths
 * of it. The main process has always counted the honest thing — seconds of
 * footage encoded against seconds to encode, and the rate it is managing — and
 * sent it out with every event. Until now the renderer dropped it on the floor
 * and counted rows instead.
 *
 * The estimate is deliberately absent for the first couple of seconds rather
 * than wild: `state.remaining` is null until there is enough rate to divide by,
 * and a number that swings from "4 minutes" to "40 seconds" while someone
 * watches teaches them not to believe the next one.
 */
export function RenderProgress({ rendering }: { rendering: boolean }) {
  const state = getRenderState()
  if (!rendering || !state || state.totalSeconds <= 0) return null

  const fraction = Math.min(1, Math.max(0, state.encodedSeconds / state.totalSeconds))
  const percent = Math.round(fraction * 100)
  const finished = state.counts.done + state.counts.skipped

  return (
    <div className="render-progress">
      <div
        className="render-progress-track"
        role="progressbar"
        aria-label="render progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="render-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="render-progress-line">
        <span className="render-progress-percent">{percent}%</span>
        <span>
          {finished} of {state.jobs} done
        </span>
        {state.counts.failed > 0 && <span className="batch-bad">{state.counts.failed} failed</span>}
        <span>
          {state.remaining === null
            ? 'working out how long'
            : `${formatDuration(state.remaining)} left`}
        </span>
        {/*
          Only once there is a real saving to report. The ratio is 0 until the
          first file lands, and "0.0× smaller" beside a bar that is moving
          reads as an encode that is doing nothing.
        */}
        {state.ratio !== null && state.ratio > 0 && (
          <span>{state.ratio.toFixed(1)}× smaller so far</span>
        )}
      </p>
    </div>
  )
}

/**
 * One clip's own bar, on the row encoding it.
 *
 * The batch bar above answers "how long until I can go and use these"; this
 * answers "which of the two in flight is nearly done", which the totals cannot
 * — and it is also the only thing on screen that moves when a single very long
 * clip is the whole of what is left.
 */
export function JobProgress({ progress }: { progress: number | undefined }) {
  if (progress === undefined) return null
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  return (
    <div
      className="job-progress"
      role="progressbar"
      aria-label="clip progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="job-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
