import { useCallback, useRef, useState } from 'react'

import { PanelFrame } from './PanelFrame'
import { commands } from '../kernel/commands'
import {
  MAX_BATCH_CLIPS,
  planBatch,
  runBatch,
  type BatchPlan,
  type BatchProgress,
  type BatchResult,
} from '../kernel/batchImport'
import { formatDuration, pickOutputDirectory } from '../kernel/renderBridge'
import { formatBytes, hasFilesystem } from '../kernel/fsBridge'
import { getSequence } from '../kernel/sequence'

/**
 * Batch: a folder of footage onto a timeline.
 *
 * Importing needs a *plan shown before it is run* — how many files, how much
 * footage, and what the scan decided to walk past — because an import that
 * silently brought in a folder of proxies beside the originals would double
 * every shot and look like a success. That is what this panel is for, and it is
 * all it is for.
 *
 * What is deliberately *not* here is any notion of a list, a grid, or a
 * selection model for what to render. A clip already carries which file it
 * plays, where it starts, how long it runs and at what rate, so a folder laid
 * out as clips end to end *is* the render list — and the razor, trimming,
 * ripple delete and Delete are already the tools for editing it. Nothing is
 * ever "marked for export"; the edit is the instruction.
 *
 * Rendering itself moved out to the Render panel once the queue grew up. It
 * needed settings, rows, and a list that survives switching sequences, and
 * bolting that onto the bottom of an import panel would have made one panel
 * that does two jobs badly. See kernel/renderQueue.ts.
 */
export function BatchPanel() {
  const [plan, setPlan] = useState<BatchPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [importing, setImporting] = useState<BatchProgress | null>(null)
  const [imported, setImported] = useState<BatchResult | null>(null)
  const cancelImport = useRef(false)

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

  if (!hasFilesystem) {
    return (
      <PanelFrame>
        <div className="batch">
          <p className="batch-note">
            Batch import reads real folders, so it only works in the desktop app.
          </p>
        </div>
      </PanelFrame>
    )
  }

  const sequence = getSequence()
  const tooMany = plan ? plan.files.length > MAX_BATCH_CLIPS : false

  return (
    <PanelFrame
      toolbar={
        <span className="tool-value tool-value--dim">
          {sequence.name} · {sequence.clips.length} clips
        </span>
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

        {/* ── 3. hand it to Render ─────────────────────────────── */}
        <section className="batch-step">
          <h3 className="batch-head">
            <span className="batch-num">3</span> Render what survived
          </h3>
          <p className="batch-note">
            Select the clips you want and add them to the queue in the{' '}
            <strong>Render</strong> panel (<code>Ctrl 5</code>), or add the whole sequence. Every
            clip becomes one file. Settings, the queue and the progress all live there — this
            panel's job ends once the footage is on the timeline.
          </p>
          <button className="batch-button" onClick={() => void commands.run('panel.focus.render')}>
            Open Render
          </button>
        </section>
      </div>
    </PanelFrame>
  )
}
