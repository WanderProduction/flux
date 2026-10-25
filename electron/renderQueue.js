/**
 * The export queue: many cuts, a few at a time, with a log that proves it.
 *
 * Lives in the main process rather than the renderer, and that is the important
 * decision here. An export of a shoot folder is tens of minutes of work; one of
 * a drive is hours. Owned by a React component it would be at the mercy of a
 * re-render, a panel being closed, or a workspace being switched — and "I closed
 * the panel and my nine-hour render stopped" is not a thing an archiver may do.
 * The renderer subscribes to a queue it does not own.
 *
 * No `electron` import, so scripts/verify-queue.mjs can run the whole thing
 * headless. Progress leaves through a listener the caller supplies; main.js is
 * what turns that into IPC.
 *
 * ## What the log is for
 *
 * Every finished job appends a row to a CSV in the output folder: source, its
 * size, the output, its size, the ratio, and whether duration and frame count
 * matched. Two reasons, and neither is bookkeeping for its own sake.
 *
 * The first is that it is the only way the saving is *provable*. "2.3TB became
 * 195GB" is a claim; a file with one row per clip and a ratio on each is the
 * evidence, and it is what makes it safe to delete an original.
 *
 * The second is that it is how the one clip that went wrong gets found. A batch
 * of four hundred encodes will have a failure in it somewhere, and finding it by
 * watching a progress bar is not possible.
 *
 * ## Two kinds of job, one queue
 *
 * A row is either one cut of one clip or a whole sequence composited into one
 * file, and `runOne` dispatches on `job.kind`. They are the same thing to a
 * queue — a resolved snapshot with an output path and a length, which it runs,
 * verifies and logs — and the only place the difference shows is which module
 * is asked to encode it: electron/render.js or electron/renderSequence.js.
 *
 * Concurrency is per row, which means it does nothing for a sequence render:
 * one sequence is one job however many clips it composites. That is right
 * rather than a limitation — `At once` exists because four parallel reads of
 * large files on one spindle is slower than two, and a composite is already
 * reading several of them at once through one ffmpeg process.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { alreadyDone, checkEncoder, encodeCut, findTools } from './render.js'
import { encodeSequence, sequenceAlreadyDone } from './renderSequence.js'

/**
 * Encodes running at once, by default.
 *
 * NVENC on current drivers allows up to eight concurrent sessions, and encode
 * speed measured about six times realtime on this material — so the GPU is not
 * the thing that saturates first. Disk is: these are 60-100 Mbps sources read
 * off spinning drives, and four parallel reads of different large files on one
 * spindle is slower in total than two. Two is the measured compromise, and it
 * is configurable because someone running this off an SSD should raise it.
 */
export const DEFAULT_CONCURRENCY = 2

export const LOG_NAME = 'flux-export-log.csv'

const LOG_HEADER = [
  'finished_at',
  'status',
  'source',
  'source_bytes',
  'output',
  'output_bytes',
  'ratio',
  'cut_from_s',
  'cut_duration_s',
  'output_duration_s',
  'source_fps',
  'output_fps',
  'output_frames',
  'expected_frames',
  'kept_original',
  'detail',
].join(',')

/** A field that may hold a comma, a quote or a newline — which paths do. */
function csv(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * One run of the queue.
 *
 * Created, run once, and finished. A second export makes a second queue rather
 * than reusing this one, so there is no state to reset and no way for the tail
 * of one run to land in the log of the next.
 */
export class RenderQueue {
  /**
   * @param {object} config
   * @param {Array<object>} config.jobs
   * @param {string} config.outDir
   * @param {number} [config.concurrency]
   * @param {{ cq?: number, gop?: number }} [config.options]
   * @param {boolean} [config.resume] skip outputs that already verify
   * @param {(event: object) => void} [config.onEvent]
   */
  constructor({ jobs, outDir, concurrency, options = {}, resume = true, onEvent }) {
    this.jobs = jobs
    this.outDir = outDir
    this.concurrency = Math.max(1, concurrency ?? DEFAULT_CONCURRENCY)
    this.options = options
    this.resume = resume
    this.onEvent = onEvent ?? (() => {})

    this.controller = new AbortController()
    /** Per job id: 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled'. */
    this.status = new Map(jobs.map((job) => [job.id, 'waiting']))
    this.results = new Map()
    /** Seconds encoded so far, per running job, for a progress total. */
    this.progress = new Map()
    this.startedAt = 0
    this.finished = false
  }

  get totalDuration() {
    return this.jobs.reduce((total, job) => total + job.duration, 0)
  }

  /** A snapshot the UI can render without reaching into anything. */
  state() {
    const counts = { waiting: 0, running: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 }
    for (const status of this.status.values()) counts[status] = (counts[status] ?? 0) + 1

    let encodedSeconds = 0
    for (const job of this.jobs) {
      const status = this.status.get(job.id)
      if (status === 'done' || status === 'skipped') encodedSeconds += job.duration
      else if (status === 'running') encodedSeconds += this.progress.get(job.id) ?? 0
    }

    let sourceBytes = 0
    let outputBytes = 0
    for (const result of this.results.values()) {
      if (!result.ok) continue
      sourceBytes += result.sourceBytes ?? 0
      outputBytes += result.bytes ?? 0
    }

    const elapsed = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0
    const total = this.totalDuration
    /*
     * Remaining time is estimated from footage encoded per second of wall
     * clock, not from jobs finished. Clips here range from two seconds to two
     * minutes, so "19 of 400 done" says almost nothing about how far through
     * the work is, while seconds of footage is the thing actually being
     * consumed. Null until there is enough to divide by, because a wild
     * estimate in the first second is worse than none.
     */
    const rate = elapsed > 2 && encodedSeconds > 0 ? encodedSeconds / elapsed : null
    return {
      counts,
      jobs: this.jobs.length,
      encodedSeconds,
      totalSeconds: total,
      elapsed,
      rate,
      remaining: rate ? Math.max(0, (total - encodedSeconds) / rate) : null,
      sourceBytes,
      outputBytes,
      ratio: outputBytes > 0 ? sourceBytes / outputBytes : null,
      finished: this.finished,
      cancelled: this.controller.signal.aborted,
    }
  }

  cancel() {
    this.controller.abort()
    for (const [id, status] of this.status) {
      if (status === 'waiting') this.status.set(id, 'cancelled')
    }
    this.emit({ type: 'state' })
  }

  emit(event) {
    this.onEvent({ ...event, state: this.state() })
  }

  async appendLog(row) {
    if (!this.outDir) return
    const file = path.join(this.outDir, LOG_NAME)
    try {
      let head = ''
      try {
        await fs.access(file)
      } catch {
        head = `${LOG_HEADER}\n`
      }
      await fs.appendFile(file, head + row.map(csv).join(',') + '\n', 'utf8')
    } catch (err) {
      /*
       * A log that cannot be written must not stop an export that can. It is
       * said out loud, once, rather than swallowed — but the encoding is the
       * work, and losing nine hours of it because a CSV was locked by Excel
       * would be absurd.
       */
      this.emit({ type: 'warning', message: `could not write the log: ${err.message}` })
    }
  }

  /**
   * Runs everything, resolving when the queue is empty or cancelled.
   *
   * @returns {Promise<object>} the final state, plus every failure
   */
  async run() {
    const tools = await findTools()
    if (!tools.ok) {
      this.finished = true
      this.emit({ type: 'error', message: tools.error })
      return { ...this.state(), error: tools.error, failures: [] }
    }
    const encoder = await checkEncoder()
    if (!encoder.ok) {
      this.finished = true
      this.emit({ type: 'error', message: encoder.error })
      return { ...this.state(), error: encoder.error, failures: [] }
    }

    this.startedAt = Date.now()
    await fs.mkdir(this.outDir, { recursive: true })
    this.emit({ type: 'started' })

    let next = 0
    const workers = Array.from(
      { length: Math.min(this.concurrency, this.jobs.length) },
      async () => {
        for (;;) {
          if (this.controller.signal.aborted) return
          const index = next++
          if (index >= this.jobs.length) return
          const job = this.jobs[index]
          /*
           * A job that throws takes only itself down.
           *
           * Without this the rejection travels out of the worker, out of the
           * Promise.all below and out of run() — whose caller has already
           * handed a queue to the UI. Every row then keeps the status it held
           * at that instant, so the ones that were encoding read "running" for
           * ever, nothing reaches the log, and a batch looks busy while no
           * process exists. A stuck queue is worse than a failed one: a
           * failure names the clip and the reason.
           */
          try {
            await this.runOne(job)
          } catch (err) {
            await this.failJob(job, { ok: false, stage: 'crashed', error: err.message })
          }
        }
      },
    )
    await Promise.all(workers)

    this.finished = true
    this.emit({ type: 'finished' })

    const failures = [...this.results.entries()]
      .filter(([, result]) => !result.ok && !result.cancelled)
      .map(([id, result]) => ({
        id,
        name: this.jobs.find((job) => job.id === id)?.name ?? id,
        stage: result.stage,
        error: result.error,
      }))

    return { ...this.state(), failures }
  }

  async runOne(job) {
    if (job.kind === 'sequence') return this.runSequence(job)

    if (this.resume && (await alreadyDone(job))) {
      this.status.set(job.id, 'skipped')
      this.emit({ type: 'job', id: job.id, status: 'skipped' })
      await this.appendLog([
        new Date().toISOString(), 'skipped', job.source, job.sourceBytes,
        job.output, '', '', job.offset.toFixed(3), job.duration.toFixed(3),
        '', '', '', '', '', '', 'already encoded and verified',
      ])
      return
    }

    this.status.set(job.id, 'running')
    this.progress.set(job.id, 0)
    this.emit({ type: 'job', id: job.id, status: 'running' })

    const result = await encodeCut({
      job,
      signal: this.controller.signal,
      options: this.options,
      onProgress: ({ seconds }) => {
        const reached = Math.min(seconds, job.duration)
        this.progress.set(job.id, reached)
        /*
         * The fraction travels with the event so a row can draw its own bar.
         * The totals in `state` cover the batch; this is the one clip, and
         * "which of the two running clips is nearly done" is a question the
         * batch totals cannot answer.
         */
        this.emit({
          type: 'progress',
          id: job.id,
          progress: job.duration > 0 ? reached / job.duration : 0,
        })
      },
    })

    this.results.set(job.id, result)
    this.progress.delete(job.id)

    if (result.ok) {
      this.status.set(job.id, 'done')
      this.emit({ type: 'job', id: job.id, status: 'done', result })
      await this.appendLog([
        new Date().toISOString(),
        result.keptOriginal ? 'kept-original' : 'encoded',
        job.source, job.sourceBytes,
        result.output, result.bytes,
        result.ratio ? result.ratio.toFixed(2) : '',
        job.offset.toFixed(3), job.duration.toFixed(3),
        result.facts?.duration?.toFixed(3) ?? '',
        result.source?.frameRate?.toFixed(3) ?? '',
        result.facts?.frameRate?.toFixed(3) ?? '',
        result.facts?.frames ?? '',
        result.source ? Math.round(job.duration * result.source.frameRate) : '',
        result.keptOriginal ? 'yes' : 'no',
        /*
         * Both facts, because both are things someone reading this file later
         * will want explained without re-opening the clip. "Why is this one
         * bigger than its source" and "why does this one have no sound" are
         * the two questions a row cannot otherwise answer.
         */
        [
          result.grew ? 'encode was larger than the source' : '',
          job.silent ? 'no sound — its audio track was not being heard' : '',
        ]
          .filter(Boolean)
          .join('; '),
      ])
      return
    }

    if (result.cancelled) {
      this.status.set(job.id, 'cancelled')
      this.emit({ type: 'job', id: job.id, status: 'cancelled' })
      return
    }

    await this.failJob(job, result)
  }

  /**
   * Marks one job failed, tells the UI, and writes its row to the log.
   *
   * Shared by the ordinary failure path and the crash guard in run(), so a job
   * that threw is recorded exactly like one that returned a failure. The log is
   * the thing that makes a failure findable later, and a crash is the kind of
   * failure most worth finding.
   */
  async failJob(job, result) {
    this.progress.delete(job.id)
    this.results.set(job.id, result)
    this.status.set(job.id, 'failed')
    this.emit({ type: 'job', id: job.id, status: 'failed', result })
    await this.appendLog([
      new Date().toISOString(), `failed-${result.stage}`,
      job.source, job.sourceBytes,
      result.kept ?? job.output, result.facts?.bytes ?? '',
      '', job.offset?.toFixed(3) ?? '', job.duration?.toFixed(3) ?? '',
      result.facts?.duration?.toFixed(3) ?? '',
      '', result.facts?.frameRate?.toFixed(3) ?? '',
      result.facts?.frames ?? '', '', 'no',
      result.error ?? '',
    ])
  }

  /**
   * One sequence, composited into one file.
   *
   * The same shape as `runOne` above and deliberately so: resume by
   * verification, the status transitions, the progress ticks and a log row at
   * the end. What is different is only what it calls to do the encode.
   *
   * The `source` column holds the sequence's name and what went into it rather
   * than a path, because there is no one file this came from — that is what a
   * composite means. The full list of clips is not written there: it would be a
   * CSV cell with four hundred paths in it, and the sequence document is where
   * that question is answered properly.
   */
  async runSequence(job) {
    const layers = `${job.video.length} video, ${job.audio.length} audio`

    if (this.resume && (await sequenceAlreadyDone(job))) {
      this.status.set(job.id, 'skipped')
      this.emit({ type: 'job', id: job.id, status: 'skipped' })
      await this.appendLog([
        new Date().toISOString(), 'skipped', `${job.name} (${layers})`, job.sourceBytes,
        job.output, '', '', '0.000', job.duration.toFixed(3),
        '', job.frameRate.toFixed(3), '', '', '', '', 'already rendered and verified',
      ])
      return
    }

    this.status.set(job.id, 'running')
    this.progress.set(job.id, 0)
    this.emit({ type: 'job', id: job.id, status: 'running' })

    const result = await encodeSequence({
      job,
      signal: this.controller.signal,
      options: this.options,
      onWarning: (message) => this.emit({ type: 'warning', message }),
      onProgress: ({ seconds }) => {
        const reached = Math.min(seconds, job.duration)
        this.progress.set(job.id, reached)
        /*
         * The fraction travels with the event so a row can draw its own bar.
         * The totals in `state` cover the batch; this is the one clip, and
         * "which of the two running clips is nearly done" is a question the
         * batch totals cannot answer.
         */
        this.emit({
          type: 'progress',
          id: job.id,
          progress: job.duration > 0 ? reached / job.duration : 0,
        })
      },
    })

    this.results.set(job.id, result)
    this.progress.delete(job.id)

    if (result.ok) {
      this.status.set(job.id, 'done')
      this.emit({ type: 'job', id: job.id, status: 'done', result })
      await this.appendLog([
        new Date().toISOString(), 'composited',
        `${job.name} (${layers})`, job.sourceBytes,
        result.output, result.bytes,
        result.ratio ? result.ratio.toFixed(2) : '',
        '0.000', job.duration.toFixed(3),
        result.facts?.duration?.toFixed(3) ?? '',
        job.frameRate.toFixed(3),
        result.facts?.frameRate?.toFixed(3) ?? '',
        result.facts?.frames ?? '',
        Math.round(job.duration * job.frameRate),
        'no',
        (result.warnings ?? []).join('; '),
      ])
      return
    }

    if (result.cancelled) {
      this.status.set(job.id, 'cancelled')
      this.emit({ type: 'job', id: job.id, status: 'cancelled' })
      return
    }

    this.status.set(job.id, 'failed')
    this.emit({ type: 'job', id: job.id, status: 'failed', result })
    await this.appendLog([
      new Date().toISOString(), `failed-${result.stage}`,
      `${job.name} (${layers})`, job.sourceBytes,
      result.kept ?? job.output, result.facts?.bytes ?? '',
      '', '0.000', job.duration.toFixed(3),
      result.facts?.duration?.toFixed(3) ?? '',
      job.frameRate.toFixed(3), result.facts?.frameRate?.toFixed(3) ?? '',
      result.facts?.frames ?? '', Math.round(job.duration * job.frameRate), 'no',
      result.error ?? '',
    ])
  }
}
