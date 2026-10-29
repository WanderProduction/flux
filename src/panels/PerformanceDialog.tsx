import { useEffect, useRef, useState } from 'react'

import {
  LIMITS,
  defaultsFor,
  getChosen,
  getMachine,
  getPerformance,
  resetPerformance,
  setPerformance,
  subscribePerformance,
  type PerformanceSettings,
} from '../kernel/performance'

/**
 * How much of this machine FLUX is allowed to spend.
 *
 * Every one of these was a constant until it was measured. The decoder pool
 * is the one worth opening this dialog for: it was six, because of a line of
 * reasoning about hardware decoders that turned out not to hold, and on real
 * 97 Mbps camera footage the first pass over a timeline it had not seen
 * dropped to 23fps with a 1.2-second freeze. At thirty-two it is 32fps and
 * the worst gap is 84 milliseconds. Nothing else about the app changed.
 *
 * Each row says what the machine would choose, so "Follow this machine" is a
 * visible state rather than a number that happens to match today. Something
 * pinned to a value stays there when the computer changes; something left
 * following moves with it.
 */
export function PerformanceDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const [, bump] = useState(0)

  useEffect(() => subscribePerformance(() => bump((n) => n + 1)), [])
  useEffect(() => {
    panel.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const now = getPerformance()
  const machine = getMachine()
  const defaults = defaultsFor()
  const chosen = getChosen()
  const gb = machine.totalMemoryBytes / 1024 ** 3

  const rows: {
    key: keyof PerformanceSettings
    label: string
    detail: string
    unit: string
    step: number
  }[] = [
    {
      key: 'decoderPool',
      label: 'Clips kept open',
      detail:
        'Decoders held for clips the playhead has left. The one that decides whether arriving somewhere new costs a freeze.',
      unit: 'clips',
      step: 1,
    },
    {
      key: 'warmRadius',
      label: 'Clips opened ahead',
      detail:
        'How far either side of the playhead clips are opened before they are needed. One covers a cut; three covers an edit.',
      unit: 'either side',
      step: 1,
    },
    {
      key: 'frameMemoryMb',
      label: 'Frames held in memory',
      detail:
        'Per clip, for playing backwards. Only clips actually played backwards hold any.',
      unit: 'MB',
      step: 64,
    },
    {
      key: 'diskCacheMb',
      label: 'Cache on disk',
      detail:
        'Indexes, waveforms and thumbnails. Applied the next time FLUX starts.',
      unit: 'MB',
      step: 256,
    },
  ]

  return (
    <div className="seq-settings-scrim" onClick={onClose}>
      <div
        className="seq-settings"
        ref={panel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Performance"
      >
        <div className="seq-settings-head">
          <span className="seq-settings-title">Performance</span>
          <span className="seq-settings-sub">
            this machine: {gb.toFixed(0)} GB · {machine.cpuCount} cores
          </span>
          <button className="cb-btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="seq-settings-body">
          <div className="seq-settings-group">
            <span className="seq-settings-legend">What FLUX may spend</span>

            {rows.map((row) => {
              const pinned = chosen[row.key] !== undefined
              const limit = LIMITS[row.key]
              return (
                <label className="seq-field perf-field" key={row.key}>
                  <span>{row.label}</span>
                  <input
                    type="number"
                    min={limit.min}
                    max={limit.max}
                    step={row.step}
                    value={now[row.key]}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      if (Number.isFinite(value)) setPerformance({ [row.key]: value })
                    }}
                  />
                  <span className="perf-unit">{row.unit}</span>
                  <span className="perf-note">
                    {pinned ? (
                      <button
                        className="cb-btn cb-btn--quiet"
                        onClick={(e) => {
                          e.preventDefault()
                          setPerformance({ [row.key]: null })
                        }}
                        title={`Back to ${defaults[row.key]}, and follow this machine`}
                      >
                        pinned — follow this machine ({defaults[row.key]})
                      </button>
                    ) : (
                      <span className="perf-following">following this machine</span>
                    )}
                  </span>
                  <span className="perf-detail">{row.detail}</span>
                </label>
              )
            })}
          </div>

          <div className="seq-settings-group">
            <span className="seq-settings-legend">Why these numbers</span>
            <p className="perf-prose">
              Measured on real camera footage rather than chosen: a first pass over a timeline
              nothing had opened yet ran at 23 fps with a 1.2 second freeze when six clips were
              kept open, and at 32 fps with an 84 ms worst gap when thirty-two were. Sixty-four
              decoders opened at once with no measurable cost per frame, so the old limit of six
              was guarding a ceiling that was not there.
            </p>
            <p className="perf-prose">
              Playing the same stretch twice was always smooth, which is why this reads as
              occasional rather than constant — it is the cost of arriving somewhere new.
            </p>
            <div className="seq-field">
              <span />
              <button className="cb-btn" onClick={() => resetPerformance()}>
                Follow this machine for everything
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
