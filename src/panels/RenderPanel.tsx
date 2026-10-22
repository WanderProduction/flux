import { useCallback, useEffect, useState } from 'react'

import { PanelFrame } from './PanelFrame'
import {
  add,
  clear,
  getQueue,
  isRendering,
  previewAdd,
  remove,
  retry,
  start,
  stop,
  subscribeRenderQueue,
  summary,
  type AddScope,
  type QueuedJob,
} from '../kernel/renderQueue'
import { isSequenceJob } from '../kernel/sequenceExport'
import {
  getRenderSettings,
  subscribeRenderSettings,
  updateRenderSettings,
  type RenderSettings,
} from '../kernel/renderSettings'
import {
  checkTools,
  formatDuration,
  hasRenderer,
  pickOutputDirectory,
  revealFolder,
} from '../kernel/renderBridge'
import { formatBytes, hasFilesystem } from '../kernel/fsBridge'
import { getSelection, subscribeSelection } from '../kernel/selection'
import { getSequence, subscribeSequence } from '../kernel/sequence'
import { CQ, GOP_FRAMES } from '../../shared/renderFormat.js'

/**
 * Render: what the encode will be, and what is lined up to be encoded.
 *
 * Two windows in one panel, which is the shape the request asked for and also
 * the shape the work has. Settings are a decision you make once for a project;
 * the queue is a list you build over an afternoon. Putting them in one panel
 * and not two keeps the thing you are about to press next to the thing it will
 * do.
 *
 * ## Add, then start
 *
 * Modelled on Adobe Media Encoder rather than a Premiere export dialog. Select
 * clips, press Add, keep editing, add more — from another sequence if you like
 * — and press Start when the list is right. The queue is saved beside the
 * project document, so a list built today is still there tomorrow.
 *
 * What makes that safe is that a queued job is a *snapshot*: source, in point,
 * duration and speed are all resolved the moment it is added, so editing or
 * deleting the clip afterwards cannot change or break what was queued. See
 * kernel/renderQueue.ts, which is where that decision is argued.
 *
 * ## What one job is, chosen before anything is added
 *
 * `Each clip as its own file` is the archive: every clip on the timeline
 * becomes a file of its own, which is how 2.3TB of reviewed footage becomes a
 * folder you can delete the originals of. `The whole sequence as one file` is
 * the deliverable: layers composited, gaps black, audio mixed down, one mp4.
 *
 * It is one choice at the top rather than a third Add button, because it is a
 * decision about the work and not a thing you do once — an archive pass and a
 * deliverable pass are different afternoons, and a project reopens rendering
 * the way it last rendered.
 *
 * Switching it does not touch the queue, so a list genuinely can hold both
 * kinds at once. That is allowed rather than prevented: throwing away a list
 * someone built because they looked at the other mode would be worse than a
 * mixed list, and every row says which it is — a cut names its source and its
 * speed, a composite names how many layers went into it and the frame it was
 * drawn in.
 *
 * ## The settings are honest about what is a choice
 *
 * Most of the encode is not one. The codec, the rate control, the pixel format
 * and the `hvc1` tag were arrived at by encoding this library's own footage and
 * scoring it, and presenting them as sliders would imply otherwise — so they
 * are shown as what the render *is*, not as fields. What is genuinely a choice
 * is the quality/size trade, how hard to drive the disk, and the frame rate
 * policy, and those are the only things here you can move.
 */
/**
 * One collapsible section of the settings, with the switch that decides
 * whether its contents mean anything.
 *
 * The switch sits in the *header* rather than among the fields, because it is
 * not one of them — it decides whether the rest of the section applies at all.
 * A section that is off is collapsed and dimmed rather than hidden, so the page
 * still says what a render *could* carry, not only what this one will.
 *
 * `pending` marks the three that are scaffolding. They are shown, off, and say
 * what they are waiting for — which is a different and more honest thing than
 * leaving them out, because the question "can FLUX burn in captions yet" has an
 * answer and this is where someone will look for it.
 */
function Section({
  title,
  on,
  onToggle,
  pending,
  hint,
  children,
}: {
  title: string
  on: boolean
  onToggle?: (next: boolean) => void
  pending?: string
  hint?: string
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(!pending && on)

  return (
    <section className={`xs${pending ? ' xs--pending' : ''}${on ? '' : ' xs--off'}`}>
      <div className="xs-head">
        <button
          className="xs-title"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          disabled={Boolean(pending)}
        >
          <span className="xs-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {title}
        </button>
        {pending ? (
          <span className="xs-pending">not yet</span>
        ) : (
          <label className="xs-switch" title={on ? `${title} on` : `${title} off`}>
            <input
              type="checkbox"
              checked={on}
              disabled={!onToggle}
              onChange={(e) => onToggle?.(e.target.checked)}
            />
            <span className="xs-track" aria-hidden="true" />
          </label>
        )}
      </div>
      {open && <div className="xs-body">{children}</div>}
      {!open && (hint || pending) && <p className="xs-hint">{pending ?? hint}</p>}
    </section>
  )
}

export function RenderPanel() {
  const [settings, setSettings] = useState<RenderSettings>(getRenderSettings)
  const [jobs, setJobs] = useState<readonly QueuedJob[]>(getQueue)
  const [rendering, setRendering] = useState(isRendering)
  const [tools, setTools] = useState<{ ok: boolean; error?: string; version?: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, bumpSelection] = useState(0)

  useEffect(() => subscribeRenderSettings(() => setSettings(getRenderSettings())), [])
  useEffect(
    () =>
      subscribeRenderQueue(() => {
        setJobs([...getQueue()])
        setRendering(isRendering())
      }),
    [],
  )
  // The Add buttons count what is selected, so they have to re-read on both.
  useEffect(() => subscribeSelection(() => bumpSelection((n) => n + 1)), [])
  useEffect(() => subscribeSequence(() => bumpSelection((n) => n + 1)), [])

  useEffect(() => {
    if (!hasRenderer) return
    void checkTools().then(setTools)
  }, [])

  const chooseOut = useCallback(async () => {
    const dir = await pickOutputDirectory()
    if (dir) updateRenderSettings({ outDir: dir })
  }, [])

  const doAdd = useCallback((scope: AddScope) => {
    setError(null)
    const result = add(scope)
    const parts: string[] = []
    if (result.added) parts.push(`${result.added} added`)
    if (result.replaced) parts.push(`${result.replaced} already queued, updated`)
    if (result.skipped.length) parts.push(`${result.skipped.length} refused`)
    setNote(parts.length ? parts.join(' · ') : 'Nothing to add')
  }, [])

  const doStart = useCallback(async () => {
    setError(null)
    setNote(null)
    const result = await start()
    if (!result.ok) setError(result.error ?? 'the render could not be started')
  }, [])

  if (!hasFilesystem) {
    return (
      <PanelFrame>
        <div className="batch">
          <p className="batch-note">Rendering writes real files, so it only works in the desktop app.</p>
        </div>
      </PanelFrame>
    )
  }

  const counts = summary()
  const held = getSelection()
  const sequence = getSequence()
  const oneFile = settings.mode === 'sequence'
  /*
   * Only the plan the mode will actually use is built. `planSequence` walks
   * every clip on every track, and doing it on every render of this panel to
   * fill in a button nobody can press would be work for nothing.
   */
  const canAdd = oneFile ? { jobs: [], skipped: [] } : previewAdd('selection')
  const whole = oneFile ? previewAdd('one-file') : previewAdd('sequence')
  const done = jobs.filter((job) => job.status === 'done')
  const savedFrom = done.reduce((total, job) => total + job.sourceBytes, 0)
  const savedTo = done.reduce((total, job) => total + (job.bytes ?? 0), 0)

  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-value tool-value--dim">
            {counts.total} queued{counts.failed > 0 ? ` · ${counts.failed} failed` : ''}
          </span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            {rendering ? 'rendering' : formatDuration(counts.remainingSeconds)}
          </span>
        </>
      }
    >
      <div className="batch">
        {tools && !tools.ok && <p className="batch-error">{tools.error}</p>}

        {/* ── settings ─────────────────────────────────────────── */}
        <section className="batch-step">
          <h3 className="batch-head">Settings</h3>

          {/*
            First, because it decides what everything below it applies to. The
            hint says what each mode is *for* rather than what it does: "one
            file per clip" is already on the label, and which one you want is a
            question about whether you are archiving or delivering.
          */}
          <label className="render-field render-mode">
            <span className="render-label">Render</span>
            <select
              value={settings.mode}
              disabled={rendering}
              onChange={(e) =>
                updateRenderSettings({ mode: e.target.value as RenderSettings['mode'] })
              }
            >
              <option value="clips">Each clip as its own file</option>
              <option value="sequence">The whole sequence as one file</option>
            </select>
            <span className="render-hint">
              {oneFile
                ? 'Layers composited into the sequence frame, audio mixed down, gaps black and silent. One mp4.'
                : 'Every clip on a video track becomes one file, named after its source. What an archive wants.'}
            </span>
          </label>

          <button className="batch-button" onClick={chooseOut} disabled={rendering}>
            {settings.outDir ? 'Change the output folder…' : 'Choose where to render…'}
          </button>
          {settings.outDir && (
            <p className="batch-path" title={settings.outDir}>
              {settings.outDir}
              {/^[cC]:/.test(settings.outDir) && (
                <span className="batch-warn-inline"> — C: usually has the least room free.</span>
              )}
            </p>
          )}

          {/*
            Sections, in the order a deliverable is described: what it looks
            like, what it sounds like, then the three that do not exist yet,
            then the things that are about the *run* rather than the file.
          */}
          <Section
            title="Video"
            on={settings.video}
            onToggle={rendering ? undefined : (next) => updateRenderSettings({ video: next })}
            hint="No picture — the output will be a sound file."
          >
          <div className="render-fields">
            <label className="render-field">
              <span className="render-label">Quality (CQ)</span>
              <input
                type="number"
                min={1}
                max={51}
                value={settings.cq}
                disabled={rendering}
                onChange={(e) => updateRenderSettings({ cq: Number(e.target.value) })}
              />
              <span className="render-hint">
                Lower is bigger and better. {CQ} measured a 1% low of 95.64 VMAF — visually
                transparent.
              </span>
            </label>

            <label className="render-field">
              <span className="render-label">Keyframes every</span>
              <input
                type="number"
                min={1}
                max={600}
                value={settings.gop}
                disabled={rendering}
                onChange={(e) => updateRenderSettings({ gop: Number(e.target.value) })}
              />
              <span className="render-hint">
                Frames. {GOP_FRAMES} is about a second, which is what lets the result be re-cut
                later with no re-encode. Costs 4.9% size.
              </span>
            </label>


            {/*
              Offered only for clips. A composite has one frame and one rate by
              definition — the sequence's — so there is nothing left to choose,
              and a disabled control implying otherwise would be worse than
              none. What it is is stated instead.
            */}
            {oneFile ? (
              <div className="render-field">
                <span className="render-label">Frame</span>
                <p className="render-value render-value--mono">
                  {sequence.settings.width}×{sequence.settings.height} · {sequence.settings.frameRate}fps
                </p>
                <span className="render-hint">
                  The sequence's own, which is what a composite is rendered into. Change it in
                  Sequence settings. Every layer is resampled to this rate.
                </span>
              </div>
            ) : (
              <label className="render-field">
                <span className="render-label">Frame rate</span>
                <select
                  value={settings.frameRate}
                  disabled={rendering}
                  onChange={(e) =>
                    updateRenderSettings({ frameRate: e.target.value as RenderSettings['frameRate'] })
                  }
                >
                  <option value="source">Keep each clip's own</option>
                  <option value="sequence">Conform to the sequence ({sequence.settings.frameRate})</option>
                </select>
                <span className="render-hint">
                  {settings.frameRate === 'source'
                    ? 'Mixed 25/29.97/50fps footage stays as shot, so slow motion survives.'
                    : 'Everything is resampled to the sequence rate. Slow motion shot at 50fps will lose frames.'}
                </span>
              </label>
            )}
          </div>

          {/*
            Shown rather than offered. These were measured, not chosen, and a
            field implies a decision nobody should be making casually.
          */}
          <details className="batch-details">
            <summary>What the encode is</summary>
            <p className="batch-note">
              HEVC through <code>hevc_nvenc</code>, constant quality, 10-bit <code>p010le</code>,
              tagged <code>hvc1</code> so it plays in QuickTime and Premiere on macOS. Never
              scaled, so 4K stays 4K. Measured against this library at 10.6× to 23.9× smaller.
            </p>
          </details>
          </Section>

          <Section
            title="Audio"
            on={settings.audio}
            onToggle={rendering ? undefined : (next) => updateRenderSettings({ audio: next })}
            hint="Silent — every output will be written with no audio stream."
          >
            <div className="render-fields">
              <div className="render-field">
                <span className="render-label">Format</span>
                <p className="render-value render-value--mono">AAC · 192 kbps</p>
                <span className="render-hint">
                  Not yet a choice. Format, bitrate, sample rate and channels become fields that
                  follow the sequence until you change one.
                </span>
              </div>
              <div className="render-field">
                <span className="render-label">From the sequence</span>
                <p className="render-value render-value--mono">
                  {sequence.settings.audio.sampleRate / 1000}kHz ·{' '}
                  {sequence.settings.audio.channels === 1 ? 'mono' : 'stereo'}
                </p>
                <span className="render-hint">
                  {oneFile
                    ? 'The mixdown follows the fader, mute and solo on every audio track.'
                    : 'A clip whose track is muted, or not soloed, is written with no sound at all.'}
                </span>
              </div>
            </div>
          </Section>

          <Section
            title="Captions"
            on={false}
            pending="No caption track is read or burned in yet."
          />
          <Section
            title="Effects"
            on={false}
            pending="There is nothing to render: no per-clip transform, blend or effect exists."
          />
          <Section
            title="Metadata"
            on={false}
            pending="Timecode and camera metadata are dropped, not carried across."
          />

          <Section title="General" on hint="How hard to drive the disk, and what to skip.">
            <div className="render-fields">
              <label className="render-field">
                <span className="render-label">At once</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.concurrency}
                  disabled={rendering}
                  onChange={(e) => updateRenderSettings({ concurrency: Number(e.target.value) })}
                />
                <span className="render-hint">
                  The disk saturates before the GPU does. Two is right for spinning drives; raise
                  it for an SSD.
                </span>
              </label>
            </div>
            <label className="render-check">
              <input
                type="checkbox"
                checked={settings.resume}
                disabled={rendering}
                onChange={(e) => updateRenderSettings({ resume: e.target.checked })}
              />
              <span>
                Skip files already rendered <em>and verified</em>
              </span>
            </label>
          </Section>
        </section>

        {/* ── queue ────────────────────────────────────────────── */}
        <section className="batch-step">
          <h3 className="batch-head">Queue</h3>

          <div className="render-actions">
            {oneFile ? (
              /*
                One button, because there is one thing to add. A selection
                cannot narrow a composite — leaving clips out of it is an edit
                on the timeline, which is the whole idea the Batch panel is
                built on: the timeline is the manifest.
              */
              <button
                className="batch-button"
                onClick={() => doAdd('one-file')}
                disabled={whole.jobs.length === 0}
                title={whole.reason ?? sequence.name}
              >
                Add “{sequence.name}” as one file
              </button>
            ) : (
              <>
                <button
                  className="batch-button"
                  onClick={() => doAdd('selection')}
                  disabled={canAdd.jobs.length === 0}
                  title={
                    held.size === 0 ? 'Select clips on the timeline first' : `${held.size} selected`
                  }
                >
                  Add selection ({canAdd.jobs.length})
                </button>
                <button
                  className="batch-button"
                  onClick={() => doAdd('sequence')}
                  disabled={whole.jobs.length === 0}
                >
                  Add whole sequence ({whole.jobs.length})
                </button>
              </>
            )}
            {counts.failed > 0 && (
              <button className="batch-button" onClick={() => retry()}>
                Retry failed ({counts.failed})
              </button>
            )}
            <button
              className="batch-button"
              onClick={() => clear()}
              disabled={jobs.length === 0 || rendering}
            >
              Clear
            </button>
          </div>

          {note && <p className="batch-note">{note}</p>}
          {error && <p className="batch-error">{error}</p>}

          {oneFile && whole.reason && jobs.length === 0 && (
            <p className="batch-note">Nothing to render: {whole.reason}.</p>
          )}

          {(oneFile ? whole : canAdd).skipped.length > 0 && (
            <details className="batch-details">
              <summary>
                {(oneFile ? whole : canAdd).skipped.length}{' '}
                {oneFile ? 'clip' : 'selected clip'}
                {(oneFile ? whole : canAdd).skipped.length === 1 ? '' : 's'}{' '}
                {oneFile ? 'will be left out' : 'cannot be rendered'}
              </summary>
              <ul className="batch-list">
                {(oneFile ? whole : canAdd).skipped.map((one) => (
                  <li key={one.id}>
                    <strong>{one.name}</strong> — {one.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {jobs.length === 0 ? (
            <p className="batch-note">
              {oneFile
                ? 'Nothing queued. Press Add to line up this sequence — the layers, the gaps and the mix as one file.'
                : 'Nothing queued. Select clips on the timeline and press Add — every clip becomes one file.'}
            </p>
          ) : (
            <>
              <div className="render-rows" role="list">
                {jobs.map((job) => (
                  <div className={`render-row render-row--${job.status}`} role="listitem" key={job.id}>
                    <span className="render-dot" aria-hidden="true" />
                    <span
                      className="render-name"
                      title={isSequenceJob(job) ? job.name : job.source}
                    >
                      {job.output.split(/[\\/]/).pop()}
                    </span>
                    {/*
                      A row names what it will read. For a cut that is its
                      source and its speed; for a composite it is how many
                      layers went into it, which is the one number that says
                      whether the right thing was queued.
                    */}
                    <span className="render-meta">
                      {formatDuration(job.duration)}
                      {isSequenceJob(job)
                        ? ` · ${job.video.length} video, ${job.audio.length} audio · ${job.width}×${job.height}`
                        : Math.abs(job.speed - 1) > 1e-9
                          ? ` · ${job.speed.toFixed(2)}×`
                          : ''}
                      {/*
                        Said before it happens, not discovered afterwards. A
                        row that will write a file with no sound is a row you
                        want to notice while the mute is still something you
                        remember pressing.
                      */}
                      {!isSequenceJob(job) && job.silent && ' · no sound'}
                      {job.sequenceName && ` · ${job.sequenceName}`}
                    </span>
                    <span className="render-status">
                      {job.status === 'done' && job.ratio
                        ? `${job.ratio >= 1 ? `${job.ratio.toFixed(1)}× smaller` : `${(1 / job.ratio).toFixed(1)}× larger`}`
                        : job.status === 'failed'
                          ? (job.error ?? 'failed')
                          : job.status}
                    </span>
                    {!rendering && (
                      <button
                        className="render-drop"
                        title="Take this out of the queue"
                        onClick={() => remove([job.id])}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="render-actions">
                {rendering ? (
                  <button className="batch-button batch-button--quiet" onClick={() => void stop()}>
                    Stop after the clips in flight
                  </button>
                ) : (
                  <button
                    className="batch-button batch-button--go"
                    onClick={() => void doStart()}
                    disabled={
                      counts.waiting === 0 || !settings.outDir || Boolean(tools && !tools.ok)
                    }
                  >
                    Start ({counts.waiting})
                  </button>
                )}
                {settings.outDir && !rendering && (
                  <button
                    className="batch-button"
                    onClick={() => void revealFolder(settings.outDir as string)}
                  >
                    Show the folder
                  </button>
                )}
              </div>

              <dl className="batch-facts">
                <div>
                  <dt>Done</dt>
                  <dd>
                    {counts.done} / {counts.total}
                  </dd>
                </div>
                {counts.failed > 0 && (
                  <div>
                    <dt>Failed</dt>
                    <dd className="batch-bad">{counts.failed}</dd>
                  </div>
                )}
                <div>
                  <dt>Left</dt>
                  <dd>{formatDuration(counts.remainingSeconds)}</dd>
                </div>
                {savedTo > 0 && (
                  <div>
                    <dt>{savedFrom >= savedTo ? 'Smaller by' : 'Larger by'}</dt>
                    <dd className={savedFrom >= savedTo ? undefined : 'batch-bad'}>
                      {(savedFrom >= savedTo ? savedFrom / savedTo : savedTo / savedFrom).toFixed(1)}×
                    </dd>
                  </div>
                )}
                {savedTo > 0 && (
                  <div>
                    <dt>Written</dt>
                    <dd>{formatBytes(savedTo)}</dd>
                  </div>
                )}
              </dl>
            </>
          )}
        </section>
      </div>
    </PanelFrame>
  )
}
