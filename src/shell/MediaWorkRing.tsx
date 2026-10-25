import { useEffect, useState } from 'react'

import {
  mediaWork,
  mediaWorkSummary,
  subscribeMediaWork,
  type WorkItem,
  type WorkKind,
} from '../kernel/mediaWork'

/**
 * What the app is preparing, as a ring you can open.
 *
 * Dropping a shoot folder leaves FLUX busy for a while making the things a
 * timeline needs but a file does not contain — a waveform, a thumbnail, a frame
 * index. All of that was invisible, and an app that is quietly busy is
 * indistinguishable from an app that is slow for no reason. That is the version
 * people report, and they are right to: without a way to look, the only
 * available conclusion is "it lags".
 *
 * So: a ring that fills as the work finishes, and behind it a list naming every
 * file and which of the three queues it is in. The ring answers "is it nearly
 * done"; the list answers "what is it actually doing", which is the question
 * underneath "why is it lagging".
 */

/** Radius and circumference of the ring, in the SVG's own units. */
const R = 7
const C = 2 * Math.PI * R

const KIND_LABEL: Record<WorkKind, string> = {
  waveform: 'waveform',
  thumbnail: 'thumbnail',
  index: 'frame index',
}

/** Running first, then waiting, then whatever finished most recently. */
const ORDER: Record<WorkItem['state'], number> = {
  running: 0,
  waiting: 1,
  failed: 2,
  done: 3,
  dropped: 4,
}

function elapsed(item: WorkItem): string {
  const from = item.startedAt ?? item.queuedAt
  const to = item.endedAt ?? Date.now()
  const seconds = Math.max(0, (to - from) / 1000)
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`
}

export function MediaWorkRing() {
  const [summary, setSummary] = useState(mediaWorkSummary)
  const [items, setItems] = useState<WorkItem[]>(mediaWork)
  const [open, setOpen] = useState(false)

  useEffect(
    () =>
      subscribeMediaWork(() => {
        setSummary(mediaWorkSummary())
        setItems(mediaWork())
      }),
    [],
  )

  /*
   * While something is running the panel redraws on a timer as well as on
   * events, so the elapsed column counts up. A decode that reports nothing for
   * eight seconds is exactly the case this panel exists for, and a frozen "0.0s"
   * beside it would say the opposite of what is happening.
   */
  const [, tick] = useState(0)
  useEffect(() => {
    if (!open || !summary.busy) return
    const timer = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(timer)
  }, [open, summary.busy])

  const percent = Math.round(summary.fraction * 100)
  const title = summary.busy
    ? `Preparing media — ${summary.finished} of ${summary.total} done, ${summary.running} running`
    : 'Nothing to prepare'

  const sorted = [...items].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || (b.endedAt ?? b.queuedAt) - (a.endedAt ?? a.queuedAt),
  )
  const live = sorted.filter((one) => one.state === 'running' || one.state === 'waiting')
  const settled = sorted.filter((one) => one.state !== 'running' && one.state !== 'waiting')

  return (
    <>
      <button
        className={`work-ring-button${summary.busy ? ' work-ring-button--busy' : ''}${
          open ? ' work-ring-button--open' : ''
        }`}
        onClick={() => setOpen((was) => !was)}
        title={`${title}\nClick to see what it is working on`}
        aria-label={title}
        aria-expanded={open}
      >
        <svg className="work-ring" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="work-ring-track" cx="9" cy="9" r={R} />
          <circle
            className="work-ring-fill"
            cx="9"
            cy="9"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C * (1 - summary.fraction)}
          />
        </svg>
        {summary.busy && <span className="work-ring-count">{summary.running + summary.waiting}</span>}
      </button>

      {open && (
        <aside className="work-peek" aria-label="Media being prepared">
          <header className="work-peek-head">
            <span className="work-peek-title">Preparing media</span>
            <span className="work-peek-sub">
              {summary.busy
                ? `${summary.finished} of ${summary.total} · ${percent}%`
                : 'nothing in flight'}
            </span>
            <button className="work-peek-close" onClick={() => setOpen(false)} title="Close">
              ×
            </button>
          </header>

          {live.length === 0 && settled.length === 0 ? (
            <p className="work-peek-note">
              Nothing has needed preparing yet. Waveforms, thumbnails and frame indexes are built
              the first time a file is shown, and kept — so this fills up when footage arrives and
              stays empty afterwards.
            </p>
          ) : (
            <div className="work-peek-list" role="list">
              {live.map((item) => (
                <Row key={item.key} item={item} />
              ))}
              {settled.length > 0 && live.length > 0 && (
                <p className="work-peek-divider">finished</p>
              )}
              {settled.slice(0, 60).map((item) => (
                <Row key={item.key} item={item} />
              ))}
            </div>
          )}
        </aside>
      )}
    </>
  )
}

function Row({ item }: { item: WorkItem }) {
  return (
    <div className={`work-row work-row--${item.state}`} role="listitem" title={item.path}>
      <span className="work-row-dot" aria-hidden="true" />
      <span className="work-row-name">{item.name}</span>
      <span className="work-row-kind">{KIND_LABEL[item.kind]}</span>
      <span className="work-row-state">
        {item.state === 'failed' ? (item.note ?? 'failed') : item.state}
      </span>
      <span className="work-row-time">{elapsed(item)}</span>
    </div>
  )
}
