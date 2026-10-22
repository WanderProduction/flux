/**
 * The render queue: jobs you line up, then start.
 *
 * Modelled on Adobe Media Encoder rather than on a Premiere export dialog, and
 * that is a deliberate difference from how Batch exports today. There, pressing
 * Export turns the whole sequence into jobs and starts immediately. Here you
 * add a selection, keep editing, add more from another sequence, and press
 * Start when the list is what you want.
 *
 * ## A queued job is a snapshot, not a reference
 *
 * This is the one decision everything else follows from.
 *
 * A job could have been "clip `c17` of sequence `s3`", resolved to a source and
 * a range at render time. It is not, and must not be: the whole point of a
 * queue you add to over time is that you carry on editing afterwards. By the
 * time Start is pressed, `c17` may have been razored into three, trimmed,
 * moved, or deleted outright — and a queue that silently renders whatever that
 * id means *now* would produce files that match nothing anyone reviewed.
 *
 * So adding resolves everything immediately: source path, in point, duration,
 * speed, output name. The clip id is kept, but only so the Timeline can show
 * which clips are queued. Nothing reads back through it.
 *
 * The honest cost: edit a clip after queueing it and the queue still holds the
 * old range. That is why a row names its source and its in/out, and why
 * re-adding a clip replaces its earlier job rather than making a second one.
 *
 * ## Why the list is here and the running is not
 *
 * The list is project state — it belongs to the project, is saved beside the
 * document, and has to survive a restart. The *running* lives in the main
 * process (electron/renderQueue.js), because an hours-long encode must not be
 * at the mercy of a panel closing. This module is the list, plus the part that
 * hands waiting jobs to main and folds the events back in.
 */

import { getAsset } from './assets'
import { getSequence, type Clip, type SequenceState } from './sequence'
import { getSelection } from './selection'
import { getRenderSettings, resolveOutput } from './renderSettings'
import { planExport, type ExportJob, type SkippedClip } from './batchExport'
import { isSequenceJob, planSequence, type SequenceJob } from './sequenceExport'
import { onRenderEvent, startRender, cancelRender, type QueueEvent } from './renderBridge'

export type JobStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled'

/**
 * What the list adds to whichever kind of job a row holds.
 *
 * The queue takes either — one cut of one clip, or a whole sequence composited
 * into one file — because they are the same thing to a list you add to and then
 * start: a resolved snapshot with an output path and a length. What differs is
 * only what the encoder is handed, and that difference lives in the main
 * process, where electron/renderQueue.js dispatches on `kind`.
 */
interface QueueRow {
  status: JobStatus
  /** Which sequence it came from, for the row to say so. */
  sequenceName: string
  addedAt: number
  /** Set when the job finishes: bytes written, and how much smaller. */
  bytes?: number
  ratio?: number
  error?: string
  /** 0..1 while running. */
  progress?: number
}

export type QueuedJob = (ExportJob | SequenceJob) & QueueRow

/**
 * What an Add button adds.
 *
 * `selection` and `sequence` both make one file per clip; `one-file` makes the
 * whole active sequence into a single composited file. Which of them the panel
 * offers follows the mode in kernel/renderSettings.ts.
 */
export type AddScope = 'selection' | 'sequence' | 'one-file'

export interface QueueSummary {
  total: number
  waiting: number
  running: number
  done: number
  failed: number
  /** Seconds of footage across every job that has not finished. */
  remainingSeconds: number
}

let jobs: QueuedJob[] = []
let running = false
let persist: ((jobs: QueuedJob[]) => void) | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
  persist?.(jobs)
}

export function subscribeRenderQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getQueue(): readonly QueuedJob[] {
  return jobs
}

export function isRendering(): boolean {
  return running
}

/**
 * Lets kernel/project.ts own the file without this module importing it.
 *
 * Same shape as the render settings hook, and for the same reason: the project
 * knows where its folder is, and this does not need to.
 */
export function onQueueChanged(handler: (jobs: QueuedJob[]) => void): void {
  persist = handler
}

/** Restores a queue read from disk. Never notifies the persister back. */
export function setQueue(stored: QueuedJob[] | undefined): void {
  /*
   * Anything that was mid-flight when the app closed comes back as waiting.
   * A row that says "running" with nothing running is a lie the UI would have
   * to explain, and the work genuinely was not finished — the partial file is
   * already gone, because an encode writes to a temporary and renames.
   */
  jobs = (stored ?? []).map((job) =>
    job.status === 'running' ? { ...job, status: 'waiting', progress: undefined } : job,
  )
  listeners.forEach((listener) => listener())
}

export function summary(): QueueSummary {
  const count = (status: JobStatus) => jobs.filter((job) => job.status === status).length
  return {
    total: jobs.length,
    waiting: count('waiting'),
    running: count('running'),
    done: count('done') + count('skipped'),
    failed: count('failed'),
    remainingSeconds: jobs
      .filter((job) => job.status === 'waiting' || job.status === 'running')
      .reduce((total, job) => total + job.duration, 0),
  }
}

/**
 * What adding the current selection would queue, without queueing it.
 *
 * Separate from `add` so the panel can say "12 clips, 4m 20s" on the button and
 * name what it would refuse, which is the same courtesy the import plan gives.
 */
export function previewAdd(scope: AddScope): {
  jobs: (ExportJob | SequenceJob)[]
  skipped: SkippedClip[]
  /** Why there is nothing to add, when a sequence render cannot be planned. */
  reason?: string
} {
  const settings = getRenderSettings()
  const sequence = getSequence()
  /*
   * Resolved once, here, and handed to whichever planner runs. Both need the
   * same answer to "what did the fields that nobody touched turn out to be",
   * and working it out twice is how two modes end up disagreeing about it.
   */
  const output = resolveOutput(settings, {
    width: sequence.settings.width,
    height: sequence.settings.height,
    frameRate: sequence.settings.frameRate,
    sampleRate: sequence.settings.audio.sampleRate,
    channels: sequence.settings.audio.channels,
  })

  if (scope === 'one-file') {
    const plan = planSequence(settings.outDir ?? '', sequence, {
      video: settings.video,
      audio: settings.audio,
      output,
    })
    return {
      jobs: plan.job ? [plan.job] : [],
      skipped: plan.skipped,
      ...(plan.reason ? { reason: plan.reason } : {}),
    }
  }

  const plan = planExport(settings.outDir ?? '', sequence, {
    frameRate: settings.frameRate,
    video: settings.video,
    audio: settings.audio,
    output,
  })
  if (scope === 'sequence') return { jobs: plan.jobs, skipped: plan.skipped }

  const held = getSelection()
  return {
    jobs: plan.jobs.filter((job) => held.has(job.id)),
    skipped: plan.skipped.filter((one) => held.has(one.id)),
  }
}

/**
 * Adds clips to the queue and returns how many landed.
 *
 * Re-adding a clip replaces its existing row rather than making a second one.
 * Pressing Add twice is something people do when they are not sure it worked,
 * and the result should be the same queue, not the same clip rendered twice to
 * the same filename.
 */
export function add(scope: AddScope): { added: number; replaced: number; skipped: SkippedClip[] } {
  const { jobs: wanted, skipped } = previewAdd(scope)
  if (wanted.length === 0) return { added: 0, replaced: 0, skipped }

  const sequenceName = getSequence().name
  const byId = new Map(jobs.map((job) => [job.id, job]))
  let replaced = 0

  for (const job of wanted) {
    const existing = byId.get(job.id)
    // A row that is already done stays done; re-adding it is a request to do it
    // again, so it goes back to waiting with its old result cleared.
    if (existing) replaced += 1
    byId.set(job.id, {
      ...job,
      status: 'waiting',
      sequenceName,
      addedAt: existing?.addedAt ?? Date.now(),
      bytes: undefined,
      ratio: undefined,
      error: undefined,
      progress: undefined,
    })
  }

  jobs = [...byId.values()].sort((a, b) => a.addedAt - b.addedAt)
  emit()
  return { added: wanted.length - replaced, replaced, skipped }
}

export function remove(ids: Iterable<string>): number {
  const doomed = new Set(ids)
  if (doomed.size === 0) return 0
  const before = jobs.length
  // A job in flight is not removed from under the encoder that is writing it.
  jobs = jobs.filter((job) => !doomed.has(job.id) || job.status === 'running')
  if (jobs.length === before) return 0
  emit()
  return before - jobs.length
}

/** Clears everything that is not currently being encoded. */
export function clear(): number {
  const before = jobs.length
  jobs = jobs.filter((job) => job.status === 'running')
  if (jobs.length === before) return 0
  emit()
  return before - jobs.length
}

/** Puts finished and failed rows back to waiting, so Start does them again. */
export function retry(ids?: Iterable<string>): number {
  const wanted = ids ? new Set(ids) : null
  let touched = 0
  jobs = jobs.map((job) => {
    if (job.status === 'running' || job.status === 'waiting') return job
    if (wanted && !wanted.has(job.id)) return job
    touched += 1
    return { ...job, status: 'waiting', bytes: undefined, ratio: undefined, error: undefined }
  })
  if (touched > 0) emit()
  return touched
}

/**
 * Hands every waiting job to the main process and follows it.
 *
 * Only waiting rows go. Everything already done is left alone, which is what
 * makes pressing Start after a failure do the obvious thing — and it is a
 * different mechanism from the encoder's own resume, which re-verifies files on
 * disk. Both exist: this one is about what the list says, that one is about
 * what is actually in the output folder.
 */
export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: 'a render is already running' }
  const settings = getRenderSettings()
  if (!settings.outDir) return { ok: false, error: 'no output folder has been chosen' }

  const waiting = jobs.filter((job) => job.status === 'waiting')
  if (waiting.length === 0) return { ok: false, error: 'nothing in the queue is waiting' }

  running = true
  emit()

  const stop = onRenderEvent((event: QueueEvent) => applyEvent(event))
  try {
    const result = await startRender(waiting, {
      outDir: settings.outDir,
      concurrency: settings.concurrency,
      /*
       * Resolved at Start rather than carried on each row, and that is the one
       * place this breaks the snapshot rule on purpose. The audio format is a
       * property of *this run* — one output folder, one set of files someone
       * is about to go and use — where a clip's range is a property of the
       * edit it came from. Freezing 192k onto a row added last week would
       * mean changing the bitrate silently failed to apply to half the queue.
       */
      options: {
        cq: settings.cq,
        gop: settings.gop,
        audio: resolveOutput(settings, {
          width: getSequence().settings.width,
          height: getSequence().settings.height,
          frameRate: getSequence().settings.frameRate,
          sampleRate: getSequence().settings.audio.sampleRate,
          channels: getSequence().settings.audio.channels,
        }).audio,
      },
      resume: settings.resume,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true }
  } finally {
    stop()
    running = false
    emit()
  }
}

export async function stop(): Promise<boolean> {
  if (!running) return false
  return cancelRender()
}

/** Folds one event from the main process into the rows. */
function applyEvent(event: QueueEvent): void {
  if (!event.id) {
    // A state-only event. The rows have not changed, but the totals have.
    listeners.forEach((listener) => listener())
    return
  }
  const index = jobs.findIndex((job) => job.id === event.id)
  if (index < 0) return

  const job = jobs[index]
  const next: QueuedJob = { ...job }

  if (event.type === 'job' && event.status) {
    next.status = event.status as JobStatus
    next.progress = undefined
    const result = (event as unknown as { result?: Record<string, unknown> }).result
    if (result) {
      if (typeof result.bytes === 'number') next.bytes = result.bytes
      if (typeof result.ratio === 'number') next.ratio = result.ratio
      if (typeof result.error === 'string') next.error = result.error
    }
  }

  jobs = [...jobs.slice(0, index), next, ...jobs.slice(index + 1)]
  emit()
}

/**
 * Clips on the active sequence that already have a row. For the timeline.
 *
 * A sequence render covers every clip it composited, so all of them count as
 * queued — the marks on the timeline answer "is this going to be rendered",
 * and for a one-file job the answer is yes for the whole thing.
 */
export function queuedClipIds(sequence: SequenceState = getSequence()): Set<string> {
  const ids = new Set<string>()
  for (const job of jobs) {
    if (isSequenceJob(job)) {
      for (const cut of job.video) ids.add(cut.id)
      for (const cut of job.audio) ids.add(cut.id)
    } else {
      ids.add(job.id)
    }
  }
  return new Set(sequence.clips.filter((clip: Clip) => ids.has(clip.id)).map((clip) => clip.id))
}

/** A row's source file name, for display when the asset is long gone. */
export function sourceNameOf(job: QueuedJob): string {
  if (isSequenceJob(job)) return job.name
  return getAsset(job.id)?.name ?? job.name
}
