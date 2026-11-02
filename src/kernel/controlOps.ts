/**
 * What the control surface can be asked to do.
 *
 * The operations an MCP server — and so a language model — calls to put a
 * sequence together and start a render. See electron/control.js for the
 * transport and why there is one at all.
 *
 * ## They are coarse on purpose
 *
 * There is no `cutClip`, no `moveClip`, no `setInPoint`. The obvious API is a
 * verb per gesture, and it is the wrong one here for the same reason the cut
 * list is not XML: a two-hundred-cut reel becomes two hundred round trips,
 * each one a request, a reply and a model turn, and the model has to hold the
 * whole timeline in its head between them to stay consistent.
 *
 * So the unit is a *document*. `importCutList` takes the whole edit at once
 * and places it atomically, which is one call, one undo step, and one thing to
 * get right. The fine-grained verbs would be convenient for a human driving by
 * hand, and a human has the timeline in front of them already.
 *
 * ## Everything returns something small
 *
 * A caller paying by the token cannot afford `inspect` to return every clip of
 * a four-hundred-clip sequence. Each of these returns counts, names and ranges
 * — enough to decide what to do next, and never the whole model. Anything that
 * genuinely needs detail asks for one thing by id.
 */

import { getAssets, type Asset } from './assets'
import { importEditDocument } from './importEdit'
import { getSequence, listSequences, activateSequence, getMarkers } from './sequence'
import { getSelection } from './selection'
import * as renderQueue from './renderQueue'
import { getRenderSettings, updateRenderSettings } from './renderSettings'
import { getProject } from './project'
import { scanFootage } from './fsBridge'
import { readCutList } from '../../shared/editDocument.js'
import { readXmeml } from '../../shared/xmeml.js'

/** A sequence, small enough to put several in one reply. */
function describe(one: ReturnType<typeof getSequence>) {
  const video = one.tracks.filter((t) => t.kind === 'video').length
  const audio = one.tracks.filter((t) => t.kind === 'audio').length
  const end = one.clips.reduce((at, clip) => Math.max(at, clip.start + clip.duration), 0)
  return {
    id: one.id,
    name: one.name,
    width: one.settings.width,
    height: one.settings.height,
    frameRate: one.settings.frameRate,
    clips: one.clips.length,
    tracks: { video, audio },
    markers: one.markers.length,
    seconds: Math.round(end * 1000) / 1000,
  }
}

function assetName(assets: Asset[], id: string): string {
  return assets.find((one) => one.id === id)?.name ?? id
}

export type ControlOperations = Record<string, (params: Record<string, unknown>) => Promise<unknown>>

export const operations: ControlOperations = {
  /**
   * The names this build understands.
   *
   * Asked for by the main process when the surface starts, so it can route
   * only what exists and refuse the rest — and served to callers, so a model
   * that guessed wrong can correct itself from the reply instead of from a
   * version number.
   */
  async listOperations() {
    return Object.keys(operations).sort()
  },

  /** What is open, and what this build can do. A caller's first call. */
  async describeProject() {
    const project = getProject()
    const settings = getRenderSettings()
    return {
      project: project ? { name: project.name, root: project.root } : null,
      openSequence: getSequence().name,
      sequences: listSequences().map(describe),
      render: {
        outDir: settings.outDir,
        cq: settings.cq,
        gop: settings.gop,
        concurrency: settings.concurrency,
        frameRate: settings.frameRate,
      },
      queue: renderQueue.summary(),
    }
  },

  /**
   * Everything on a sequence, by track.
   *
   * Capped, and it says when it capped. A model that asked for a
   * four-hundred-clip sequence and silently got the first hundred would plan
   * against a timeline that is not the one there.
   */
  async inspectSequence(params) {
    const wanted = typeof params.sequence === 'string' ? params.sequence : null
    if (wanted && !activateSequence(wanted)) {
      const names = listSequences().map((one) => one.name)
      throw new Error(`no sequence "${wanted}". Open ones: ${names.join(', ')}`)
    }
    const limit = typeof params.limit === 'number' ? Math.max(1, params.limit) : 200
    const one = getSequence()
    const assets = getAssets()

    const clips = one.clips
      .slice()
      .sort((a, b) => a.start - b.start)
      .slice(0, limit)
      .map((clip) => ({
        id: clip.id,
        track: clip.trackId,
        source: assetName(assets, clip.assetId),
        start: Math.round(clip.start * 1000) / 1000,
        duration: Math.round(clip.duration * 1000) / 1000,
        offset: Math.round(clip.offset * 1000) / 1000,
        ...(Math.abs(clip.speed - 1) > 1e-9 ? { speed: clip.speed } : {}),
      }))

    return {
      ...describe(one),
      clips,
      truncated: one.clips.length > clips.length ? one.clips.length - clips.length : 0,
      /*
       * Markers come back whole, and before the clips are capped. They are the
       * only part of a timeline that says what it is *about*, there are never
       * many, and they are the cheapest useful thing a model can read.
       */
      markers: getMarkers().map((marker) => ({
        start: Math.round(marker.start * 1000) / 1000,
        end: Math.round(marker.end * 1000) / 1000,
        name: marker.name,
        comment: marker.comment,
      })),
    }
  },

  /** Lay a cut list down as a new sequence. The main way an agent edits. */
  async importCutList(params) {
    const read = readCutList(params.cutList ?? params)
    if (!read.ok) {
      // Every problem at once — see shared/editDocument.js.
      throw new Error(`the cut list has problems:\n- ${read.problems.join('\n- ')}`)
    }
    const result = await importEditDocument(read.document, {
      remaps: Array.isArray(params.remaps) ? (params.remaps as never) : [],
      sequenceName: typeof params.name === 'string' ? params.name : undefined,
    })
    return { ...result, sequence: describe(getSequence()) }
  },

  /** Lay a Premiere or Resolve XML down as a new sequence. */
  async importSequenceXml(params) {
    if (typeof params.xml !== 'string') throw new Error('pass the XML as `xml`')
    const parsed = readXmeml(params.xml)
    if (!parsed.ok) throw new Error(parsed.error)
    const result = await importEditDocument(parsed.document, {
      remaps: Array.isArray(params.remaps) ? (params.remaps as never) : [],
      sequenceName: typeof params.name === 'string' ? params.name : undefined,
    })
    return { ...result, sequence: describe(getSequence()) }
  },

  /** Media under a folder, with proxy and cache folders walked past. */
  async scanFolder(params) {
    if (typeof params.folder !== 'string') throw new Error('pass a `folder`')
    const result = await scanFootage(params.folder)
    if (!result.ok) throw new Error(`${params.folder}: ${result.error}`)
    const limit = typeof params.limit === 'number' ? Math.max(1, params.limit) : 500
    return {
      root: result.scan.root,
      files: result.scan.files.slice(0, limit).map((file) => ({
        path: file.path,
        name: file.name,
        kind: file.kind,
        size: file.size,
      })),
      total: result.scan.files.length,
      truncated: Math.max(0, result.scan.files.length - limit),
      skipped: result.scan.skipped.length,
    }
  },

  /** Change what a render does. The format itself is not negotiable. */
  async setRenderSettings(params) {
    updateRenderSettings(params as never)
    return getRenderSettings()
  },

  /**
   * Put clips in the queue. `scope` is 'selection' or 'sequence'.
   *
   * Nothing starts. Queueing and starting are separate calls because they are
   * separate decisions — see kernel/renderQueue.ts on why the queue is
   * add-then-start.
   */
  async queueRender(params) {
    const scope = params.scope === 'selection' ? 'selection' : 'sequence'
    if (scope === 'selection' && getSelection().size === 0) {
      throw new Error('nothing is selected — pass scope "sequence", or select clips first')
    }
    const result = renderQueue.add(scope)
    return { ...result, queue: renderQueue.summary() }
  },

  /**
   * Start the queue, and do not wait for it.
   *
   * A batch runs for minutes or hours; holding the call open would trip the
   * renderer timeout and tell the caller the render failed while it was
   * happily encoding. So this returns as soon as it is running and the caller
   * polls `renderStatus`.
   */
  async startRender() {
    if (renderQueue.isRendering()) throw new Error('a render is already running')
    if (!getRenderSettings().outDir) throw new Error('no output folder is set')
    if (renderQueue.summary().waiting === 0) throw new Error('nothing in the queue is waiting')

    const running = renderQueue.start()
    // Surfaced rather than dropped: a rejection here would otherwise be an
    // unhandled promise with nothing watching it.
    void running.catch((err) => console.error('[flux] render:', err))
    return { started: true, queue: renderQueue.summary() }
  },

  async renderStatus() {
    return {
      rendering: renderQueue.isRendering(),
      ...renderQueue.summary(),
      jobs: renderQueue.getQueue().map((job) => ({
        name: job.output.split(/[\\/]/).pop(),
        status: job.status,
        ...(job.ratio ? { ratio: Math.round(job.ratio * 10) / 10 } : {}),
        ...(job.error ? { error: job.error } : {}),
      })),
    }
  },

  async stopRender() {
    return { stopped: await renderQueue.stop() }
  },
}
