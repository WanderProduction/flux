import { useCallback, useEffect, useRef, useState } from 'react'

import {
  clearMedia,
  clearWindowCache,
  hasCacheReport,
  measureCaches,
  revealCache,
  type CacheReport,
} from '../../kernel/cache'
import { formatBytes } from '../../kernel/fsBridge'

/**
 * Cache — what is on disk, and a way to be rid of it.
 *
 * The three questions people actually ask about a cache are where it is, how
 * big it has got, and how to empty it. Until this page existed FLUX could
 * answer none of them, and the honest answer was "open AppData and look" —
 * which is the answer every editor has been mocked for giving.
 *
 * ## What this page deliberately does not do
 *
 * Set the budgets. How many decoders may be open, how much decoded picture may
 * be held, how far ahead to warm and how much disk the cache may use are all
 * in the performance dialog already, measured against the machine, and the
 * main process reads the disk figure straight out of the store to prune to it
 * at startup. Putting a second slider here would mean two places to change one
 * number, and the one that lost would be whichever the user did not open.
 *
 * So the section above is `livesAt` pointing at that dialog, and this page
 * owns the half nothing owned: the measurement.
 *
 * ## Two caches, two owners
 *
 * The media cache is ours. We chose its layout, its staleness rule and its
 * budget, and every entry in it names the kind of thing it holds — so it can
 * be reported and cleared by kind, and somebody who wants the thumbnails gone
 * does not have to throw away the frame indexes that cost twenty-two
 * milliseconds a clip to rebuild.
 *
 * The window's caches are Chromium's: fetched files and V8's compiled code. We
 * chose nothing about them, including how large they get. They are on this
 * page because of what measuring them turned up — 619MB of them against 30MB
 * of ours on the machine this was built on. A page that reported only the
 * cache we designed would have been wrong by a factor of twenty, and would
 * have sent anybody short of disk looking in the wrong place.
 */
export function CachePage() {
  const [report, setReport] = useState<CacheReport | null>(null)
  const [busy, setBusy] = useState(true)
  /** Which destructive button is one click from doing it. */
  const [armed, setArmed] = useState<string | null>(null)
  /** What the last clear freed, so the page says something happened. */
  const [freed, setFreed] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const measure = useCallback(async (quiet = false) => {
    // A Recheck drops the last "freed N" line: it is a note about something
    // that just happened, and leaving it above a fresh measurement makes it
    // read as a note about this one.
    if (!quiet) setFreed(null)
    setBusy(true)
    const next = await measureCaches()
    if (!alive.current) return
    setReport(next)
    setBusy(false)
  }, [])

  useEffect(() => {
    void measure()
  }, [measure])

  /*
   * Every clear re-measures rather than subtracting what it reported freeing.
   * Doing the arithmetic in the page would be faster and would drift: the
   * directory is also being written to by whatever is open behind this panel,
   * and a number that is nearly right is worse here than a number that waited
   * 200ms to be right.
   */
  const clearKind = useCallback(
    async (kind?: string) => {
      setArmed(null)
      setBusy(true)
      const result = await clearMedia(kind)
      if (!alive.current) return
      setFreed(
        result.removed === 0 ? 'There was nothing to clear.' : `Freed ${formatBytes(result.bytes)}.`,
      )
      await measure(true)
    },
    [measure],
  )

  const clearWindow = useCallback(async () => {
    setArmed(null)
    setBusy(true)
    const result = await clearWindowCache()
    if (!alive.current) return
    setFreed(
      result.bytes === 0 ? 'There was nothing to clear.' : `Freed ${formatBytes(result.bytes)}.`,
    )
    await measure(true)
  }, [measure])

  if (!hasCacheReport()) {
    return (
      <div className="ca">
        <p className="ca-note">
          The caches live beside the app rather than in the page, so this reads them over the
          desktop bridge. Running in a plain browser there is nothing to report.
        </p>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="ca">
        <p className="ca-note">{busy ? 'Measuring…' : 'The caches could not be read.'}</p>
      </div>
    )
  }

  const { media, window: chrome } = report
  const share = media.budget > 0 ? Math.min(1, media.bytes / media.budget) : 0

  return (
    <div className="ca">
      <section className="ca-group">
        <header className="ca-group-head">
          <h3 className="ca-title">What FLUX has worked out</h3>
          <span className="ca-size">
            {formatBytes(media.bytes)} <span className="ca-of">of {formatBytes(media.budget)}</span>
          </span>
        </header>

        {/*
          The bar is drawn against the budget the *main process* prunes to, not
          against a constant repeated here — the two have to be the same number
          or the page would show a cache comfortably inside a limit it is in
          fact being trimmed to.
        */}
        <div
          className="ca-bar"
          role="img"
          aria-label={`${Math.round(share * 100)}% of the disk budget`}
        >
          <span className="ca-bar-fill" style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
        </div>

        <p className="ca-where">
          <code className="ca-path">{media.dir}</code>
          <button className="ca-link" onClick={() => void revealCache()}>
            Open the folder
          </button>
        </p>

        <p className="ca-note">
          Sample tables, waveforms and thumbnails, worked out once rather than once per open and
          shared by every project that cuts the same footage. None of it is your work: throwing it
          away costs a slower next open and nothing else. Entries for footage that has changed are
          already ignored, so a stale cache is not a thing that happens here.
        </p>

        {media.entries === 0 ? (
          <p className="ca-empty">Nothing cached yet.</p>
        ) : (
          <ul className="ca-rows">
            {media.kinds.map((kind) => (
              <li className="ca-row" key={kind.id}>
                <div className="ca-row-main">
                  <span className="ca-row-name">{kind.label}</span>
                  <span className="ca-row-note">{kind.note}</span>
                </div>
                <span className="ca-row-count">
                  <span className="ca-size">{formatBytes(kind.bytes)}</span>
                  <span className="ca-row-entries">
                    {kind.entries === 1 ? '1 entry' : `${kind.entries} entries`}
                  </span>
                </span>
                {/*
                  No button for a kind with nothing in it. A disabled Clear is
                  the dead control kernel/tools.ts was written to avoid — and
                  the row is still worth showing, because a cache that has only
                  ever thumbnailed is not a cache that cannot do the rest.
                */}
                {kind.entries > 0 ? (
                  <button className="ca-clear" onClick={() => void clearKind(kind.id)} disabled={busy}>
                    Clear
                  </button>
                ) : (
                  <span className="ca-clear-spacer" />
                )}
              </li>
            ))}
          </ul>
        )}

        <footer className="ca-group-foot">
          {media.newest > 0 && <span className="ca-stamp">Last used {ago(media.newest)}</span>}
          {media.unreadable > 0 && (
            <span className="ca-stamp ca-stamp--odd">
              {media.unreadable === 1
                ? '1 entry has an unreadable header — usually a write cut short by a crash'
                : `${media.unreadable} entries have unreadable headers — usually writes cut short by a crash`}
            </span>
          )}
          <span className="ca-actions">
            <button className="ca-recheck" onClick={() => void measure()} disabled={busy}>
              {busy ? 'Measuring…' : 'Recheck'}
            </button>
            {media.entries > 0 && (
              <Danger
                id="media"
                armed={armed}
                arm={setArmed}
                busy={busy}
                label="Clear everything"
                confirm={`Clear all ${formatBytes(media.bytes)}?`}
                onConfirm={() => void clearKind()}
              />
            )}
          </span>
        </footer>
      </section>

      <section className="ca-group">
        <header className="ca-group-head">
          <h3 className="ca-title">What the window keeps</h3>
          <span className="ca-size">{formatBytes(chrome.bytes)}</span>
        </header>

        <p className="ca-note">
          Chromium&rsquo;s, not ours — the files the interface has fetched and the compiled form of
          the app&rsquo;s own code, kept so a launch does not compile it again. FLUX chooses
          nothing about these, including how large they get, which is why they are worth a number:
          on the machine this page was built on they were twenty times the size of the cache above.
          Clearing them costs one slower launch.
        </p>

        <ul className="ca-rows">
          {chrome.parts.map((part) => (
            <li className="ca-row ca-row--plain" key={part.id}>
              <div className="ca-row-main">
                <span className="ca-row-name">{part.name}</span>
              </div>
              <span className="ca-row-count">
                <span className="ca-size">{formatBytes(part.bytes)}</span>
              </span>
              <span className="ca-clear-spacer" />
            </li>
          ))}
        </ul>

        <footer className="ca-group-foot">
          <span className="ca-actions">
            {chrome.bytes > 0 && (
              <Danger
                id="window"
                armed={armed}
                arm={setArmed}
                busy={busy}
                label="Clear"
                confirm={`Clear ${formatBytes(chrome.bytes)}?`}
                onConfirm={() => void clearWindow()}
              />
            )}
          </span>
        </footer>
      </section>

      {freed && <p className="ca-freed">{freed}</p>}
    </div>
  )
}

/**
 * A clear that takes two clicks.
 *
 * Nothing on this page destroys work and the per-kind buttons say so by going
 * straight through. These two do not, for a plainer reason: they are the ones
 * labelled with a total rather than a thing, and the cost of hitting one by
 * mistake is rebuilding every index on the machine. One confirm, in place, no
 * dialog — the second click is the warning.
 */
function Danger({
  id,
  armed,
  arm,
  busy,
  label,
  confirm,
  onConfirm,
}: {
  id: string
  armed: string | null
  arm: (id: string | null) => void
  busy: boolean
  label: string
  confirm: string
  onConfirm: () => void
}) {
  if (armed === id) {
    return (
      <>
        <button className="ca-clear ca-clear--armed" onClick={onConfirm} disabled={busy}>
          {confirm}
        </button>
        <button className="ca-link" onClick={() => arm(null)}>
          Keep it
        </button>
      </>
    )
  }
  return (
    <button className="ca-clear" onClick={() => arm(id)} disabled={busy}>
      {label}
    </button>
  )
}

/**
 * How long ago, in the roughest terms that are still useful.
 *
 * `newest` is the last time anything was *read* out of the cache rather than
 * written into it, which is the number that says whether this cache is in use
 * — a directory nobody has touched in a month is one to clear without
 * thinking about it.
 */
function ago(stamp: number): string {
  const seconds = Math.max(0, (Date.now() - stamp) / 1000)
  if (seconds < 90) return 'moments ago'
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.round(minutes)} minutes ago`
  const hours = minutes / 60
  if (hours < 36) return `${Math.round(hours)} hours ago`
  const days = hours / 24
  if (days < 45) return `${Math.round(days)} days ago`
  return `${Math.round(days / 30)} months ago`
}
