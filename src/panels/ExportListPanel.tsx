import { useCallback, useEffect, useState } from 'react'

import { PanelFrame } from './PanelFrame'
import { JobProgress, RenderProgress } from './RenderProgress'
import { AssetThumb } from './AssetThumb'
import {
  clear,
  getQueue,
  isRendering,
  remove,
  retry,
  start,
  stop,
  subscribeRenderQueue,
  summary,
  type QueuedJob,
} from '../kernel/renderQueue'
import { isSequenceJob } from '../kernel/sequenceExport'
import { getRenderSettings, subscribeRenderSettings } from '../kernel/renderSettings'
import { formatDuration, hasRenderer, revealFolder } from '../kernel/renderBridge'
import { formatBytes, hasFilesystem } from '../kernel/fsBridge'

/**
 * What is about to be rendered, with the pictures.
 *
 * The Render panel already lists the queue, and this lists the same queue —
 * which is deliberate rather than an oversight. They answer two different
 * questions. A row of text beside the settings answers *how many and how
 * long*, which is what you want while you are deciding a bitrate. This answers
 * **"is that the right footage?"**, and the only honest way to answer it is to
 * show the footage: a filename tells you a clip is called DSCF3957, and a
 * frame of it tells you it is the shot you meant.
 *
 * That question only gets asked at one moment — after pressing `Ctrl M` and
 * before pressing Start — which is why this is the panel the Export workspace
 * is built around, and why it is not in the Edit workspace at all.
 *
 * ## It shows the queue, not the selection
 *
 * `Ctrl M` adds the selection and then comes here, so by the time this is on
 * screen the two are the same thing. Showing the live selection instead would
 * be worse in the way that matters: the queue is a set of snapshots, and a
 * panel that redrew itself every time something was clicked on the timeline
 * would be showing you what *would* be rendered rather than what *will* be.
 */
export function ExportListPanel() {
  const [jobs, setJobs] = useState<readonly QueuedJob[]>(getQueue)
  const [rendering, setRendering] = useState(isRendering)
  const [settings, setSettings] = useState(getRenderSettings)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      subscribeRenderQueue(() => {
        setJobs([...getQueue()])
        setRendering(isRendering())
      }),
    [],
  )
  useEffect(() => subscribeRenderSettings(() => setSettings(getRenderSettings())), [])

  const doStart = useCallback(async () => {
    setError(null)
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
  const done = jobs.filter((job) => job.status === 'done')
  const writtenBytes = done.reduce((total, job) => total + (job.bytes ?? 0), 0)
  const readBytes = done.reduce((total, job) => total + job.sourceBytes, 0)

  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-value tool-value--dim">
            {counts.total} to render{counts.failed > 0 ? ` · ${counts.failed} failed` : ''}
          </span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            {rendering ? 'rendering' : formatDuration(counts.remainingSeconds)}
          </span>
        </>
      }
    >
      <div className="export-list">
        {jobs.length === 0 ? (
          <p className="batch-note">
            Nothing to render yet. Select clips on the timeline and press <kbd>Ctrl M</kbd> — they
            land here, with their pictures, so you can see what you are about to write.
          </p>
        ) : (
          <>
            <div className="export-cards" role="list">
              {jobs.map((job) => (
                <ExportCard key={job.id} job={job} rendering={rendering} />
              ))}
            </div>

            {error && <p className="batch-error">{error}</p>}

            <div className="render-actions">
              {rendering ? (
                <button className="batch-button batch-button--quiet" onClick={() => void stop()}>
                  Stop after the clips in flight
                </button>
              ) : (
                <button
                  className="batch-button batch-button--go"
                  onClick={() => void doStart()}
                  disabled={counts.waiting === 0 || !settings.outDir}
                >
                  Render ({counts.waiting})
                </button>
              )}
              {counts.failed > 0 && !rendering && (
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
              {settings.outDir && !rendering && (
                <button
                  className="batch-button"
                  onClick={() => void revealFolder(settings.outDir as string)}
                  disabled={!hasRenderer}
                >
                  Show the folder
                </button>
              )}
            </div>

            {settings.outDir ? (
              <p className="batch-path" title={settings.outDir}>
                into {settings.outDir}
              </p>
            ) : (
              <p className="batch-error">No output folder has been chosen yet.</p>
            )}

            <RenderProgress rendering={rendering} />

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
              {writtenBytes > 0 && (
                <div>
                  <dt>Written</dt>
                  <dd>{formatBytes(writtenBytes)}</dd>
                </div>
              )}
              {writtenBytes > 0 && readBytes > 0 && (
                <div>
                  <dt>{readBytes >= writtenBytes ? 'Smaller by' : 'Larger by'}</dt>
                  <dd className={readBytes >= writtenBytes ? undefined : 'batch-bad'}>
                    {(readBytes >= writtenBytes
                      ? readBytes / writtenBytes
                      : writtenBytes / readBytes
                    ).toFixed(1)}
                    ×
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
      </div>
    </PanelFrame>
  )
}

/**
 * One job, as a card.
 *
 * The picture comes from the *source*, not from the output — the output does
 * not exist yet, which is the entire reason anyone is looking at this. For a
 * sequence render that means the first clip in it, which is the frame someone
 * recognises the edit by.
 */
function ExportCard({ job, rendering }: { job: QueuedJob; rendering: boolean }) {
  const sequenceJob = isSequenceJob(job)
  const source = sequenceJob ? (job.video[0]?.source ?? job.audio[0]?.source) : job.source
  const name = job.output.split(/[\\/]/).pop() ?? job.name

  const detail = sequenceJob
    ? `${job.video.length} video, ${job.audio.length} audio · ${job.width}×${job.height}`
    : [
        Math.abs(job.speed - 1) > 1e-9 ? `${job.speed.toFixed(2)}×` : null,
        job.silent ? 'no sound' : null,
        job.video === false ? 'sound only' : null,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <div className={`export-card export-card--${job.status}`} role="listitem">
      {/*
        No thumbnail for a sound-only render, and that is information rather
        than a gap: a card with no picture is a file with no picture.
      */}
      {source && job.video !== false ? (
        <AssetThumb path={source} kind="video" />
      ) : (
        <div className="thumb thumb--failed">
          <span>{job.video === false ? 'sound only' : 'no preview'}</span>
        </div>
      )}

      <div className="export-card-body">
        <span className="export-card-name" title={source ?? name}>
          {name}
        </span>
        <span className="export-card-meta">
          {formatDuration(job.duration)}
          {detail && ` · ${detail}`}
        </span>
        <JobProgress progress={job.progress} />
        <span className="export-card-status">
          {job.status === 'done' && job.ratio
            ? job.ratio >= 1
              ? `${job.ratio.toFixed(1)}× smaller`
              : `${(1 / job.ratio).toFixed(1)}× larger`
            : job.status === 'failed'
              ? (job.error ?? 'failed')
              : job.status}
        </span>
      </div>

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
  )
}
