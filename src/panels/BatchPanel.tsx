import { useCallback, useEffect, useRef, useState } from 'react'

import { PanelFrame } from './PanelFrame'
import {
  MAX_BATCH_CLIPS,
  planBatch,
  runBatch,
  type BatchPlan,
  type BatchProgress,
  type BatchResult,
} from '../kernel/batchImport'
import { planExport, type ExportPlan } from '../kernel/batchExport'
import {
  cancelRender,
  checkTools,
  formatDuration,
  hasRenderer,
  onRenderEvent,
  pickOutputDirectory,
  revealFolder,
  startRender,
  type QueueState,
  type RenderSummary,
} from '../kernel/renderBridge'
import { formatBytes, hasFilesystem } from '../kernel/fsBridge'
import { getSequence, subscribeSequence } from '../kernel/sequence'
import { CQ, GOP_FRAMES } from '../../shared/renderFormat.js'

/**
 * Batch: a folder in, a folder out, and the review in between.
 *
 * The panel exists because both ends of a batch need something a timeline
 * cannot say. Importing needs a *plan shown before it is run* — how many files,
 * how much footage, and what the scan decided to walk past, because an import
 * that silently brought in a folder of proxies beside the originals would
 * double every shot and look like a success. Exporting needs the same thing
 * from the other side, plus somewhere to watch hours of encoding happen.
 *
 * What is deliberately *not* here is any notion of a list, a queue of clips, or
 * a selection model. The middle of this workflow is the timeline, edited with
 * the editor FLUX already is: razor out what is not wanted, trim the heads and
 * tails, drag to reorder, Delete what should not survive. This panel reads the
 * result. See kernel/batchImport.ts for why the timeline is the manifest.
 *
 * ## Two things it refuses to be vague about
 *
 * **Where the files are going.** Named in full, every time, next to the button
 * that starts the work. An export is the one operation here that writes
 * hundreds of gigabytes somewhere, and "somewhere" has to be a path on screen.
 *
 * **What it will not export.** Clips with a missing source, no length, or a
 * speed change are listed by name rather than quietly dropped. A count that
 * does not match the timeline is the one way an archive silently acquires a
 * hole.
 */
export function BatchPanel() {
  // ── import ───────────────────────────────────────────────────────
  const [plan, setPlan] = useState<BatchPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [importing, setImporting] = useState<BatchProgress | null>(null)
  const [imported, setImported] = useState<BatchResult | null>(null)
  const cancelImport = useRef(false)

  // ── export ───────────────────────────────────────────────────────
  const [outDir, setOutDir] = useState<string | null>(null)
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [summary, setSummary] = useState<RenderSummary | null>(null)
  const [tools, setTools] = useState<{ ok: boolean; error?: string; version?: string } | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  /*
   * The export plan is rebuilt whenever the sequence changes, so the numbers
   * next to the button are the numbers of the edit currently on screen. A plan
   * computed once and left there would be the thing someone presses Export on
   * after twenty minutes of cutting.
   */
  useEffect(() => {
    const refresh = () => setExportPlan(outDir ? planExport(outDir) : null)
    refresh()
    return subscribeSequence(refresh)
  }, [outDir])

  useEffect(() => {
    if (!hasRenderer) return
    void checkTools().then(setTools)
  }, [])

  useEffect(() => {
    if (!hasRenderer) return
    return onRenderEvent((event) => {
      setQueue(event.state)
      if (event.type === 'warning' && event.message) setWarning(event.message)
      if (event.type === 'error' && event.message) setWarning(event.message)
    })
  }, [])

  const choose = useCallback(async () => {
    setPlanError(null)
    setImported(null)
    const dir = await pickOutputDirectory()
    if (!dir) return
    setPlanning(true)
    setPlan(null)
    const result = await planBatch(dir)
    setPlanning(false)
    if (!result.ok) {
      setPlanError(
        result.error === 'empty'
          ? `There is no footage FLUX can read in ${dir}`
          : result.error === 'denied'
            ? `${dir} could not be read — permission denied`
            : `${dir} could not be read`,
      )
      return
    }
    setPlan(result.plan)
  }, [])

  const doImport = useCallback(async () => {
    if (!plan) return
    cancelImport.current = false
    setImported(null)
    setImporting({ label: 'Starting…', done: 0, total: plan.files.length })
    const result = await runBatch(plan, {
      onProgress: setImporting,
      cancelled: () => cancelImport.current,
    })
    setImporting(null)
    setImported(result)
    setPlan(null)
  }, [plan])

  const chooseOut = useCallback(async () => {
    const dir = await pickOutputDirectory()
    if (dir) {
      setOutDir(dir)
      setSummary(null)
      setQueue(null)
    }
  }, [])

  const doExport = useCallback(async () => {
    if (!exportPlan || exportPlan.jobs.length === 0 || !outDir) return
    setSummary(null)
    setWarning(null)
    const result = await startRender(exportPlan.jobs, { outDir })
    if (!result.ok) {
      setWarning(result.error ?? 'the export could not be started')
      return
    }
    if (result.summary) setSummary(result.summary)
  }, [exportPlan, outDir])

  if (!hasFilesystem) {
    return (
      <PanelFrame>
        <div className="batch">
          <p className="batch-note">
            Batch import and export read and write real folders, so they only work in the desktop
            app.
          </p>
        </div>
      </PanelFrame>
    )
  }

  const sequence = getSequence()
  const running = Boolean(queue && !queue.finished)
  const tooMany = plan ? plan.files.length > MAX_BATCH_CLIPS : false

  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-value tool-value--dim">
            {sequence.name} · {sequence.clips.length} clips
          </span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            HEVC CQ {CQ} · GOP {GOP_FRAMES}
          </span>
        </>
      }
    >
      <div className="batch">
        {/* ── 1. bring a folder in ─────────────────────────────── */}
        <section className="batch-step">
          <h3 className="batch-head">
            <span className="batch-num">1</span> Import a folder
          </h3>

          <button className="batch-button" onClick={choose} disabled={planning || Boolean(importing)}>
            {planning ? 'Scanning…' : 'Choose a folder…'}
          </button>

          {planError && <p className="batch-error">{planError}</p>}

          {plan && (
            <div className="batch-plan">
              <p className="batch-path" title={plan.root}>
                {plan.root}
              </p>
              <dl className="batch-facts">
                <div>
                  <dt>Files</dt>
                  <dd>{plan.files.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(plan.bytes)}</dd>
                </div>
                {plan.skipped.length > 0 && (
                  <div>
                    <dt>Folders skipped</dt>
                    <dd>{plan.skipped.length}</dd>
                  </div>
                )}
                {plan.stills > 0 && (
                  <div>
                    <dt>Stills left out</dt>
                    <dd>{plan.stills}</dd>
                  </div>
                )}
              </dl>

              {/*
                Named, not just counted. A filter that silently ate a shoot
                folder would look exactly like a smaller import, and the only
                defence is being able to read what it decided.
              */}
              {plan.skipped.length > 0 && (
                <details className="batch-details">
                  <summary>
                    {plan.skipped.length} proxy or cache folder
                    {plan.skipped.length === 1 ? '' : 's'} walked past
                  </summary>
                  <ul className="batch-list">
                    {plan.skipped.slice(0, 40).map((one) => (
                      <li key={one.path}>{one.path}</li>
                    ))}
                    {plan.skipped.length > 40 && <li>…and {plan.skipped.length - 40} more</li>}
                  </ul>
                </details>
              )}

              {plan.unreadable.length > 0 && (
                <p className="batch-warn">
                  {plan.unreadable.length} folder{plan.unreadable.length === 1 ? '' : 's'} could not
                  be read and were left out.
                </p>
              )}

              {plan.truncated && (
                <p className="batch-warn">
                  The scan stopped at its file limit — this tree is bigger than one scan returns.
                </p>
              )}

              {tooMany ? (
                <>
                  <p className="batch-warn">
                    {plan.files.length.toLocaleString()} clips is more than one sequence can
                    usefully be reviewed in. Import a shoot folder instead — these hold the most:
                  </p>
                  <ul className="batch-list">
                    {plan.busiest.map((one) => (
                      <li key={one.path}>
                        <span className="batch-count">{one.files}</span> {one.path}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <button className="batch-button batch-button--go" onClick={doImport}>
                  Lay {plan.files.length.toLocaleString()} clips on a new sequence
                </button>
              )}
            </div>
          )}

          {importing && (
            <div className="batch-progress">
              <div className="batch-bar">
                <div
                  className="batch-bar-fill"
                  style={{
                    width: `${importing.total ? (importing.done / importing.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <p className="batch-note">{importing.label}</p>
              <button
                className="batch-button batch-button--quiet"
                onClick={() => {
                  cancelImport.current = true
                }}
              >
                Stop
              </button>
            </div>
          )}

          {imported && (
            <p className="batch-done">
              {imported.cancelled
                ? `Stopped. Nothing was placed.`
                : `${imported.placed.toLocaleString()} clips on “${imported.sequenceName}” — ${formatDuration(imported.duration)} of footage.`}
              {imported.unreadable.length > 0 && (
                <>
                  {' '}
                  <span className="batch-warn-inline">
                    {imported.unreadable.length} file
                    {imported.unreadable.length === 1 ? '' : 's'} could not be read and
                    {imported.unreadable.length === 1 ? ' is' : ' are'} not on the timeline.
                  </span>
                </>
              )}
            </p>
          )}
        </section>

        {/* ── 2. the bit this panel does not do ────────────────── */}
        <section className="batch-step batch-step--quiet">
          <h3 className="batch-head">
            <span className="batch-num">2</span> Review it on the timeline
          </h3>
          <p className="batch-note">
            Razor out what you do not want, trim the heads and tails, drag to reorder, and Delete
            what should not survive. Every clip left on a video track becomes one file.
          </p>
        </section>

        {/* ── 3. write it out ──────────────────────────────────── */}
        <section className="batch-step">
          <h3 className="batch-head">
            <span className="batch-num">3</span> Export
          </h3>

          {tools && !tools.ok && (
            <p className="batch-error">{tools.error}</p>
          )}

          <button className="batch-button" onClick={chooseOut} disabled={running}>
            {outDir ? 'Change the output folder…' : 'Choose where to export…'}
          </button>

          {outDir && (
            <p className="batch-path" title={outDir}>
              {outDir}
              {/*
                The brief's eighth trap, and the one most likely to be hit by
                accident: C: has the least room on this machine by a wide
                margin, and an export is hundreds of gigabytes.
              */}
              {/^[cC]:/.test(outDir) && (
                <span className="batch-warn-inline"> — C: usually has the least room free.</span>
              )}
            </p>
          )}

          {exportPlan && (
            <>
              <dl className="batch-facts">
                <div>
                  <dt>Clips</dt>
                  <dd>{exportPlan.jobs.length.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Footage</dt>
                  <dd>{formatDuration(exportPlan.duration)}</dd>
                </div>
                <div>
                  <dt>Reads</dt>
                  <dd>{formatBytes(exportPlan.sourceBytes)}</dd>
                </div>
                <div>
                  {/*
                    12x is the conservative planning figure from the encode
                    tests, which measured 10.6x to 23.9x across varied content.
                    Labelled as an estimate because it is one.
                  */}
                  <dt>Writes, about</dt>
                  <dd>{formatBytes(exportPlan.sourceBytes / 12)}</dd>
                </div>
              </dl>

              {exportPlan.skipped.length > 0 && (
                <details className="batch-details" open>
                  <summary>
                    {exportPlan.skipped.length} clip
                    {exportPlan.skipped.length === 1 ? '' : 's'} will not be exported
                  </summary>
                  <ul className="batch-list">
                    {exportPlan.skipped.map((one) => (
                      <li key={one.id}>
                        <strong>{one.name}</strong> — {one.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {!running && (
                <button
                  className="batch-button batch-button--go"
                  onClick={doExport}
                  disabled={exportPlan.jobs.length === 0 || Boolean(tools && !tools.ok)}
                >
                  Export {exportPlan.jobs.length.toLocaleString()} clip
                  {exportPlan.jobs.length === 1 ? '' : 's'}
                </button>
              )}
            </>
          )}

          {queue && (
            <div className="batch-progress">
              <div className="batch-bar">
                <div
                  className="batch-bar-fill"
                  style={{
                    width: `${
                      queue.totalSeconds
                        ? Math.min(100, (queue.encodedSeconds / queue.totalSeconds) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <dl className="batch-facts">
                <div>
                  <dt>Done</dt>
                  <dd>
                    {queue.counts.done + queue.counts.skipped} / {queue.jobs}
                  </dd>
                </div>
                {queue.counts.skipped > 0 && (
                  <div>
                    <dt>Already done</dt>
                    <dd>{queue.counts.skipped}</dd>
                  </div>
                )}
                {queue.counts.failed > 0 && (
                  <div>
                    <dt>Failed</dt>
                    <dd className="batch-bad">{queue.counts.failed}</dd>
                  </div>
                )}
                <div>
                  <dt>Elapsed</dt>
                  <dd>{formatDuration(queue.elapsed)}</dd>
                </div>
                {queue.remaining !== null && !queue.finished && (
                  <div>
                    <dt>Left, about</dt>
                    <dd>{formatDuration(queue.remaining)}</dd>
                  </div>
                )}
                {queue.rate !== null && (
                  <div>
                    <dt>Speed</dt>
                    <dd>{queue.rate.toFixed(1)}x realtime</dd>
                  </div>
                )}
                {queue.ratio !== null && (
                  <div>
                    {/*
                      Not always smaller. Some of this archive is already a
                      delivery export, and re-encoding a short cut of one can
                      cost more than it saves — so the label changes rather
                      than reporting "0.8x smaller", which is not a sentence.
                    */}
                    <dt>{queue.ratio >= 1 ? 'Smaller by' : 'Larger by'}</dt>
                    <dd className={queue.ratio >= 1 ? undefined : 'batch-bad'}>
                      {(queue.ratio >= 1 ? queue.ratio : 1 / queue.ratio).toFixed(1)}x
                    </dd>
                  </div>
                )}
              </dl>

              {running && (
                <button className="batch-button batch-button--quiet" onClick={() => void cancelRender()}>
                  Stop after the clips in flight
                </button>
              )}
            </div>
          )}

          {warning && <p className="batch-error">{warning}</p>}

          {summary && (
            <div className="batch-plan">
              <p className="batch-done">
                {summary.cancelled ? 'Stopped. ' : 'Finished. '}
                {summary.counts.done.toLocaleString()} encoded
                {summary.counts.skipped > 0 && `, ${summary.counts.skipped} already done`}
                {summary.counts.failed > 0 && `, ${summary.counts.failed} failed`}
                {summary.ratio !== null &&
                  (summary.ratio >= 1
                    ? ` — ${formatBytes(summary.sourceBytes)} became ${formatBytes(summary.outputBytes)}, ${summary.ratio.toFixed(1)}x smaller.`
                    : ` — ${formatBytes(summary.sourceBytes)} became ${formatBytes(summary.outputBytes)}, which is ${(1 / summary.ratio).toFixed(1)}x larger. This material was already compressed.`)}
              </p>

              {summary.failures.length > 0 && (
                <details className="batch-details" open>
                  <summary>{summary.failures.length} failed</summary>
                  <ul className="batch-list">
                    {summary.failures.map((one) => (
                      <li key={one.id}>
                        <strong>{one.name}</strong> — {one.stage}: {one.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <p className="batch-note">
                Every clip, its size and whether its frame count matched is in{' '}
                <code>flux-export-log.csv</code> in the output folder. Nothing was moved or deleted.
              </p>
              {outDir && (
                <button className="batch-button" onClick={() => void revealFolder(outDir)}>
                  Show the folder
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </PanelFrame>
  )
}
