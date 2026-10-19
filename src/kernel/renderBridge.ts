/**
 * Typed access to the export queue, which lives in the main process.
 *
 * Thin on purpose: the queue is in electron/renderQueue.js because an export
 * runs for minutes or hours and must survive a panel closing, so there is no
 * state to mirror here — only a subscription and four calls. Anything that
 * cached queue state on this side would be a second copy of the truth, and the
 * one that goes stale the moment a render finishes while nobody is looking.
 *
 * Outside Electron `hasRenderer` is false and the panel says so rather than
 * offering a button that cannot work.
 */

import type { ExportJob } from './batchExport'

export interface QueueCounts {
  waiting: number
  running: number
  done: number
  skipped: number
  failed: number
  cancelled: number
}

export interface QueueState {
  counts: QueueCounts
  jobs: number
  /** Seconds of footage encoded so far, including the job in flight. */
  encodedSeconds: number
  totalSeconds: number
  elapsed: number
  /** Seconds of footage encoded per second of wall clock, or null while unknown. */
  rate: number | null
  /** Seconds left, or null while there is not enough to estimate from. */
  remaining: number | null
  sourceBytes: number
  outputBytes: number
  /** How much smaller the output is so far, or null before anything finished. */
  ratio: number | null
  finished: boolean
  cancelled: boolean
}

export interface QueueFailure {
  id: string
  name: string
  stage: string
  error: string
}

export type QueueEvent = {
  type: 'started' | 'finished' | 'job' | 'progress' | 'state' | 'warning' | 'error'
  id?: string
  status?: string
  message?: string
  state: QueueState
}

export interface RenderSummary extends QueueState {
  failures: QueueFailure[]
  error?: string
}

export interface RenderConfig {
  outDir: string
  concurrency?: number
  options?: { cq?: number; gop?: number }
  /** Skip outputs that already exist and verify. Defaults to true. */
  resume?: boolean
}

interface RenderBridge {
  tools: () => Promise<{ ok: boolean; error?: string; version?: string }>
  start: (jobs: ExportJob[], config: RenderConfig) => Promise<{ ok: boolean; error?: string; summary?: RenderSummary }>
  cancel: () => Promise<boolean>
  state: () => Promise<QueueState | null>
  reveal: (dirPath: string) => Promise<string>
  onEvent: (handler: (event: QueueEvent) => void) => () => void
}

interface Bridge {
  render?: RenderBridge
  fs?: { pickOutputDirectory?: () => Promise<string | null> }
}

const bridge: Bridge | undefined = (globalThis as { flux?: Bridge }).flux

export const hasRenderer = Boolean(bridge?.render)

function requireRender(): RenderBridge {
  if (!bridge?.render) throw new Error('the renderer bridge is unavailable outside Electron')
  return bridge.render
}

/** Whether ffmpeg and a usable NVENC encoder are present, and which build. */
export const checkTools = () => requireRender().tools()
export const startRender = (jobs: ExportJob[], config: RenderConfig) =>
  requireRender().start(jobs, config)
export const cancelRender = () => requireRender().cancel()
export const renderState = () => requireRender().state()
export const revealFolder = (dirPath: string) => requireRender().reveal(dirPath)
export const onRenderEvent = (handler: (event: QueueEvent) => void) =>
  requireRender().onEvent(handler)

export const pickOutputDirectory = (): Promise<string | null> =>
  bridge?.fs?.pickOutputDirectory?.() ?? Promise.resolve(null)

/** `3725` -> `1h 2m`. For a time remaining, where seconds are noise. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${total % 60}s`
  return `${total}s`
}
