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
 * Every one of these was a constant until it was measured, and the decoder
 * pool has now been measured twice in opposite directions. It was six, on the
 * reasoning that hardware decoders are few; that was overruled by opening
 * sixty-four sources at once for one frame each, which cost nothing; and that
 * in turn was wrong, because sixty-four held open is not sixty-four
 * streaming. On HEVC, twenty-four open lose a tenth of the frame rate by the
 * third pass over the same timeline. Twelve is the default and the ceiling
 * belongs to the GPU, not to this machine.
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
        'Decoders held for clips the playhead has left. Bounded by how many streams the GPU will decode at once — past about a dozen, HEVC loses frames the longer it plays.',
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
              Measured on real camera footage rather than chosen. Playback delivers 98% of what
              the footage holds — 29.7 of 29.97 fps on 30p, 49.3 of 50 on 50p — so these are
              about keeping that, not about reaching for more.
            </p>
            <p className="perf-prose">
              Clips kept open is the one with a real ceiling, and it is the GPU's rather than
              this machine's: how many streams it will decode at once, which is far fewer for
              HEVC than for H.264 and cannot be asked for from in here. Measured on HEVC, seven
              and thirteen open held 49 fps flat over three passes, while twenty-four fell to
              44 by the third with ten gaps over 100 ms. Raising it does not fail, it slowly
              gets worse, so twelve sits below the cliff instead of on it.
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
