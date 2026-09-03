import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { ensureProbed, getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import {
  hasSequenceFile,
  isAssetDrag,
  isDroppableDrag,
  isFileDrag,
  isNativeFileDrag,
  readAssetDragPayload,
  readFileDragPayload,
  readNativeFileDrag,
  sequenceFilesIn,
  type DraggedFile,
} from '../kernel/dragAssets'
import { importFiles } from '../kernel/importPipeline'
import { importSequenceFile } from '../kernel/project'
import {
  formatTimecode,
  getTime,
  isPlaying,
  seek,
  subscribePlayback,
} from '../kernel/playback'
import { audioStateFor, cachedPeaks, peaksFor } from '../kernel/media/peaks'
import { videoInfoFor } from '../kernel/media/indexCache'
import { peakRange } from '../../shared/peaks.js'
import {
  FRAME_RATES,
  PIXEL_FORMATS,
  PREVIEW_CODECS,
  SAMPLE_RATES,
} from '../../shared/sequenceFormat.js'
import {
  addClip,
  addLinkedClips,
  activateSequence,
  clampGain,
  updateSequenceSettings,
  createSequence,
  isTrackAudible,
  listSequences,
  removeSequence,
  renameSequence,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  setTrackHidden,
  setTrackGain,
  setTrackMuted,
  setTrackSolo,
  withLinked,
  addTrack,
  allowedTrim,
  trimClips,
  toggleLink,
  copyClips,
  pasteClips,
  duplicateClips,
  clipboardCount,
  type TrimEdge,
  findFreeStart,
  moveClips,
  snapDelta,
  getSequence,
  removeClips,
  sequenceDuration,
  snapToFrame,
  subscribeSequence,
  type Clip,
  type SequenceState,
  type Track,
} from '../kernel/sequence'
import { getView, recordView, subscribeView } from '../kernel/view'
import { getAssets as allAssets } from '../kernel/assets'
import { PanelFrame } from './PanelFrame'
import { useThumbnail } from './useThumbnail'

/**
 * Timeline — the time-occupying nodes of the current scope.
 *
 * Per docs/INTERACTION-MODEL.md this is a lens, not a document: a clip drawn
 * here is a reference to a project asset placed in time, and ambient nodes
 * (a driver, an LFO) will never appear because they own no time.
 *
 * Video only for now, and blocks are solid — no waveform, because there is no
 * audio pipeline to draw one from.
 */

const TRACK_HEIGHT = 46
const HEADER_WIDTH = 118

/**
 * How long a drop's explanation stays on screen.
 *
 * Long enough to read a sentence twice, short enough that it is gone before the
 * next drop — a message that outlived what it was about would be worse than
 * none, because it would be describing a clip you had already stopped thinking
 * about. Clicking it dismisses it sooner.
 */
const NOTICE_MS = 7000

/** Frame rates are counted, so they land on things like 29.970029. */
const round = (fps: number) => Math.round(fps * 1000) / 1000
const MIN_ZOOM = 8
const MAX_ZOOM = 400
const DEFAULT_ZOOM = 60 // pixels per second

/**
 * How hard a wheel notch zooms.
 *
 * Exponential rather than a fixed step, so a mouse wheel (one big delta) and a
 * trackpad (a stream of small ones) end up at the same place for the same
 * gesture instead of one of them being unusable.
 */
const ZOOM_PER_WHEEL_PIXEL = 1.0015

/**
 * Wheel deltas in CSS pixels, whatever the device reported.
 *
 * deltaMode is 0 for most mice and trackpads, but Firefox and some drivers
 * report lines or pages, and a raw `deltaY` of 3 would then move the timeline
 * three pixels instead of a notch. deltaX matters for trackpads, where a
 * two-finger sideways swipe is the natural way to travel a timeline.
 */
function wheelPixels(event: WheelEvent): number {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  return raw * scale
}

/**
 * Keeps a zoom usable. Also guards the value read back from a document: a
 * hand-edited .flux with zoom 0 would give every clip zero width and an empty
 * timeline that looks like lost work.
 */
function clampZoom(pixelsPerSecond: number): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return DEFAULT_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pixelsPerSecond))
}

/** Tick spacing that keeps labels readable at any zoom. */
function tickInterval(pixelsPerSecond: number): number {
  const candidates = [1 / 4, 1 / 2, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return candidates.find((step) => step * pixelsPerSecond >= 64) ?? 900
}

/**
 * A ruler label, at the precision the tick spacing actually needs.
 *
 * Zoomed in far enough, ticks fall every half second — and a label that only
 * counts whole seconds then prints `0:01` twice in a row, which reads as a
 * rendering bug and makes the ruler useless for placing anything.
 */
function formatTime(seconds: number, step = 1): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (step >= 1) return `${m}:${String(Math.round(s)).padStart(2, '0')}`
  const decimals = step >= 0.1 ? 2 : 3
  return `${m}:${s.toFixed(decimals).padStart(decimals + 3, '0')}`
}

interface DropPreview {
  trackId: string
  start: number
  duration: number
}

/**
 * How far the pointer travels before a press on a clip becomes a drag.
 *
 * Without it, selecting a clip is a coin toss: a click always carries a pixel
 * or two of movement, and every one of them would nudge the edit.
 */
const DRAG_THRESHOLD_PX = 3

/** How close, in pixels, an edge has to be before a drag snaps to it. */
const SNAP_PX = 8

/** Floating-point slack, for deciding whether a clip is trimmed at all. */
const EPS_UI = 1e-6

/** What the panel needs to *draw* a drag in progress. The rest lives in the
    handler's own closure — see beginClipDrag. */
interface ClipDrag {
  ids: string[]
  /** False until the pointer has travelled past the threshold. */
  moved: boolean
  deltaTime: number
  deltaTracks: number
  /** `Alt` is down: this drag leaves the original behind and places a copy. */
  copying: boolean
}

/**
 * A trim in progress, held for the same reason a move is: the clip in the
 * sequence is not touched until the pointer comes up, so an abandoned trim
 * needs no undoing. `delta` is already clamped to what the edge can take, so
 * what is drawn is what will be committed.
 */
interface ClipTrim {
  ids: string[]
  edge: TrimEdge
  delta: number
}

export function TimelinePanel() {
  const [sequence, setSequence] = useState<SequenceState>(getSequence)
  const [assets, setAssets] = useState<Asset[]>(getAssets)
  // Restored from the project document, so reopening lands you at the zoom you
  // were working at rather than snapping back to the default.
  const [zoom, setZoom] = useState(() => clampZoom(getView().timeline.zoom || DEFAULT_ZOOM))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<DropPreview | null>(null)
  const [time, setTime] = useState(getTime)
  const [playing, setPlaying] = useState(isPlaying)
  const [drag, setDrag] = useState<ClipDrag | null>(null)
  const [trim, setTrim] = useState<ClipTrim | null>(null)
  /**
   * Why the last drop did less than it looked like it should.
   *
   * Held here rather than shouted through a dialog: a file with no soundtrack
   * is a thing to know, not a thing to acknowledge, and a modal in the middle
   * of laying out an edit would be worse than the silence it replaces.
   */
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * Whether edges snap. A mode rather than a held key, because `Alt` means
   * "duplicate" while dragging and one modifier cannot mean two things.
   * Recorded with the view, so a project opens the way it was left.
   */
  const [snapping, setSnapping] = useState(() => getView().timeline.snapping !== false)
  const lanesRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  /** Set by a zoom, read once the new scale has rendered. See zoomBy. */
  const zoomAnchor = useRef<{ time: number; clientX: number } | null>(null)
  /**
   * The selection as it is *now*, not as it was when this render's handlers
   * were made. Two presses in quick succession both run against the same render
   * — React has not re-rendered in between — so a handler reading the state
   * variable would build the second selection from the first one's starting
   * point and silently drop a shift-click.
   */
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(
    () =>
      subscribePlayback(() => {
        setTime(getTime())
        setPlaying(isPlaying())
      }),
    [],
  )

  useEffect(() => {
    setSequence({ ...getSequence() })
    return subscribeSequence(() => setSequence({ ...getSequence() }))
  }, [])

  useEffect(() => subscribeAssets(() => setAssets([...getAssets()])), [])

  // Recorded, never marked dirty: zooming is not an edit. It is written out
  // with the next save. See kernel/view.ts.
  useEffect(() => recordView({ timeline: { zoom, snapping } }), [zoom, snapping])

  /*
   * Follow the view when it names a zoom.
   *
   * Seeding from the view at mount is only correct while every view change is
   * followed by a remount, which is true today because the shell is keyed on
   * the project root. That is an invariant one refactor away from quietly
   * breaking, and when it breaks the failure is a saved zoom that does not
   * match the zoom on screen.
   *
   * Only that direction. Writing the panel's zoom back when the view has none
   * looks like tidiness and is not: resetView() fires while this panel is still
   * mounted, so the panel would immediately undo it. Zero means "never set",
   * which the seed above already handles.
   */
  useEffect(
    () =>
      subscribeView(() => {
        setSnapping(getView().timeline.snapping !== false)
        const stored = getView().timeline.zoom
        if (stored > 0 && Math.abs(stored - zoom) > 0.01) setZoom(clampZoom(stored))
      }),
    [zoom],
  )

  const assetById = useMemo(() => {
    const map = new Map<string, Asset>()
    assets.forEach((asset) => map.set(asset.id, asset))
    return map
  }, [assets])

  const duration = sequenceDuration()
  const contentWidth = Math.max((duration + 4) * zoom, 600)

  /** Pointer x -> seconds, accounting for the lane's scroll offset. */
  const timeAt = useCallback(
    (clientX: number): number => {
      const lanes = lanesRef.current
      if (!lanes) return 0
      const rect = lanes.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left + lanes.scrollLeft) / zoom)
    },
    [zoom],
  )

  // ── moving clips ──────────────────────────────────────────────

  /**
   * Times a drag should land exactly on: the start of the sequence, the
   * playhead, and every edge of every clip that is *not* moving.
   *
   * Overlap already butts a clip against its neighbour when you overshoot;
   * snapping is for the other half, where you stop three frames short and leave
   * a gap you cannot see and cannot close by hand.
   */
  const snapTargets = useCallback(
    (movingIds: Set<string>): number[] => {
      const targets = [0, time]
      for (const clip of sequence.clips) {
        if (movingIds.has(clip.id)) continue
        targets.push(clip.start, clip.start + clip.duration)
      }
      return targets
    },
    [sequence, time],
  )

  /**
   * Nudges a delta so a moving edge lands on a nearby target.
   *
   * Both edges of the group are offered, and the closest wins: butting the head
   * of a clip against the tail of another is the same gesture as butting its
   * tail against the next one's head, and the hand does not distinguish them.
   */
  const snapDeltaToEdges = useCallback(
    (rawDelta: number, movingIds: Set<string>): number => {
      const moving = sequence.clips.filter((clip) => movingIds.has(clip.id))
      if (moving.length === 0) return rawDelta

      const head = Math.min(...moving.map((clip) => clip.start)) + rawDelta
      const tail = Math.max(...moving.map((clip) => clip.start + clip.duration)) + rawDelta
      const tolerance = SNAP_PX / zoom

      let best = rawDelta
      let bestGap = tolerance
      for (const target of snapTargets(movingIds)) {
        for (const edge of [head, tail]) {
          const gap = Math.abs(target - edge)
          if (gap < bestGap) {
            bestGap = gap
            best = rawDelta + (target - edge)
          }
        }
      }
      return best
    },
    [sequence, zoom, snapTargets],
  )

  /**
   * Nudges a trim so the edge being dragged lands on a nearby target.
   *
   * One edge, not two: a trim moves the head or the tail, and offering the
   * other one would snap the edge to a target it is not travelling towards.
   */
  const snapTrimToEdges = useCallback(
    (rawDelta: number, edge: TrimEdge, movingIds: Set<string>): number => {
      const moving = sequence.clips.filter((clip) => movingIds.has(clip.id))
      if (moving.length === 0) return rawDelta

      const at =
        edge === 'start'
          ? Math.min(...moving.map((clip) => clip.start)) + rawDelta
          : Math.max(...moving.map((clip) => clip.start + clip.duration)) + rawDelta
      const tolerance = SNAP_PX / zoom

      let best = rawDelta
      let bestGap = tolerance
      for (const target of snapTargets(movingIds)) {
        const gap = Math.abs(target - at)
        if (gap < bestGap) {
          bestGap = gap
          best = rawDelta + (target - at)
        }
      }
      return best
    },
    [sequence, zoom, snapTargets],
  )

  /**
   * Press an edge, drag, release — a trim.
   *
   * Deliberately not the move gesture with a flag. A move asks where a clip
   * should *land*, and resolves overlap by sliding and reordering; a trim asks
   * how much of a clip should *play*, and stops dead at its neighbour, at the
   * ends of the file, and at one frame. Sharing a path would mean one of the
   * two behaving like the other somewhere.
   *
   * The clip pressed, plus whatever is linked to it — not the selection. An
   * edge belongs to one clip, and trimming everything selected because an edge
   * happened to be dragged is not a gesture anybody asked for.
   */
  const beginClipTrim = useCallback(
    (event: React.PointerEvent, clip: Clip, edge: TrimEdge) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const ids = withLinked([clip.id])
      // Selected as well as trimmed, so what is about to change is visible
      // before it changes.
      const chosen = new Set(ids)
      setSelected(chosen)
      selectedRef.current = chosen

      const startX = event.clientX
      let delta = 0
      setTrim({ ids, edge, delta })

      const onMove = (move: PointerEvent) => {
        const raw = (move.clientX - startX) / zoom
        const wanted = snapping ? snapTrimToEdges(raw, edge, chosen) : raw
        // Clamped here rather than only on commit: an edge that keeps following
        // the pointer past the end of its own file and then springs back on
        // release is a lie about what the edit will be.
        delta = allowedTrim(ids, edge, wanted)
        setTrim({ ids, edge, delta })
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (delta !== 0) trimClips(ids, edge, delta)
        setTrim(null)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [zoom, snapping, snapTrimToEdges],
  )

  /**
   * Press, move, release — on the window, not on the clip.
   *
   * setPointerCapture would be the tidier way to keep receiving moves once the
   * pointer leaves the block, and it is not used here for two reasons. It
   * throws outright if the pointer is already gone by the time React dispatches
   * the press, which turns a fast click into an uncaught error. And it cannot
   * be driven at all by a synthesised pointer, so the harness would have to
   * exercise a different code path from the one people actually get — a check
   * passing for the wrong reason is worse than no check. Window listeners are
   * the same mechanism the ruler's scrub already uses.
   */
  const beginClipDrag = useCallback(
    (event: React.PointerEvent, clip: Clip) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      // Selection settles on press, not on release: the drag has to move what
      // the user can see is selected, and pressing an unselected clip means
      // "this one".
      const current = selectedRef.current
      const additive = event.shiftKey || event.ctrlKey || event.metaKey
      // A picture and the sound that came with it are one thing to the hand, so
      // pressing either shows both selected. moveClips would move the pair
      // regardless; this is so what happens is what was visibly about to.
      const together = withLinked([clip.id])
      let chosen: Set<string>
      if (additive) {
        chosen = new Set(current)
        if (chosen.has(clip.id)) together.forEach((id) => chosen.delete(id))
        else together.forEach((id) => chosen.add(id))
      } else {
        chosen = current.has(clip.id) ? new Set(current) : new Set(together)
      }
      setSelected(chosen)
      // Immediately, not on the next render: a second press can arrive in the
      // same tick, and it has to build on this selection rather than the one
      // this render was made with.
      selectedRef.current = chosen
      if (chosen.size === 0) return

      const ids = [...chosen]
      const startX = event.clientX
      const startY = event.clientY
      let moved = false
      let deltaTime = 0
      let deltaTracks = 0
      let copying = event.altKey
      setDrag({ ids, moved, deltaTime, deltaTracks, copying })

      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX
        const dy = move.clientY - startY
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
        moved = true

        const raw = dx / zoom
        deltaTime = snapDelta(snapping ? snapDeltaToEdges(raw, chosen) : raw)
        deltaTracks = Math.round(dy / TRACK_HEIGHT)
        // Read as the pointer moves rather than at the press, so the decision
        // can be made — and unmade — while the clip is in the air.
        copying = move.altKey
        setDrag({ ids, moved, deltaTime, deltaTracks, copying })
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        // Committed here and nowhere else: until the pointer comes up the clip
        // is still where it was, so an abandoned drag needs no undoing.
        if (moved && copying) {
          /*
           * `Alt` leaves the original where it is and puts a copy where the
           * drag ended — which is the gesture in every NLE, and the reason
           * snapping had to become a mode rather than a held key.
           *
           * The copies become the selection: what is under the pointer when
           * you let go is what you were placing, and leaving the originals
           * selected would mean the next drag moved the wrong clips.
           */
          const copies = duplicateClips(ids, deltaTime, deltaTracks)
          if (copies.length > 0) {
            const made = new Set(copies.map((clip) => clip.id))
            setSelected(made)
            selectedRef.current = made
            setNotice(`Duplicated ${copies.length} clip${copies.length === 1 ? '' : 's'}`)
          }
        } else if (moved) moveClips(ids, deltaTime, deltaTracks)
        else if (!additive && chosen.size > together.length) {
          /*
           * Pressed a clip that was already part of a group, and let go without
           * dragging: that means "this one", not "all of them".
           *
           * The press has to keep the group, or a group could never be dragged
           * at all — the first press would throw the rest of it away. The
           * release is where the two intents separate, which is how every
           * multi-select surface behaves and why nobody notices the rule.
           *
           * It matters most straight after unlinking a pair. Both halves are
           * still selected, and without this the only way to move one of them
           * alone would be to click somewhere empty first — which reads as the
           * unlink not having worked.
           */
          const one = new Set(together)
          setSelected(one)
          selectedRef.current = one
        }
        setDrag(null)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [zoom, snapping, snapDeltaToEdges],
  )

  // ── zoom ──────────────────────────────────────────────────────

  /**
   * Zooms, keeping one point on screen fixed.
   *
   * Without an anchor the timeline slides out from under the pointer on every
   * notch, and zooming in on a specific cut turns into zoom-then-hunt. The
   * anchor defaults to the middle of the view so the buttons and the keyboard
   * behave the same way as the wheel — a control that jumps differently
   * depending on how you invoked it is worse than one that always jumps.
   */
  const zoomBy = useCallback(
    (factor: number, clientX?: number) => {
      const lanes = lanesRef.current
      if (lanes) {
        const rect = lanes.getBoundingClientRect()
        const x = clientX ?? rect.left + rect.width / 2
        zoomAnchor.current = {
          time: (x - rect.left + lanes.scrollLeft) / zoom,
          clientX: x,
        }
      }
      setZoom((current) => clampZoom(current * factor))
    },
    [zoom],
  )

  // Applied after the new scale has been laid out, not during the event: the
  // content is only its new width once React has rendered it.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const lanes = lanesRef.current
    if (!anchor || !lanes) return
    zoomAnchor.current = null
    const rect = lanes.getBoundingClientRect()
    lanes.scrollLeft = Math.max(0, anchor.time * zoom - (anchor.clientX - rect.left))
  }, [zoom])

  // ── the wheel ─────────────────────────────────────────────────

  /**
   * Scroll travels time. Ctrl travels tracks. Alt zooms.
   *
   * The bare gesture is horizontal because a timeline is overwhelmingly a
   * horizontal surface — the axis you move along all day should not need a
   * modifier held down to reach.
   *
   * Attached natively rather than through onWheel because React registers wheel
   * listeners as *passive*, where preventDefault silently does nothing. That
   * matters twice over: the page would scroll as well as the timeline, and
   * Ctrl+wheel is Chromium's own page-zoom gesture, which would zoom the entire
   * application instead of the ruler.
   */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onWheel = (event: WheelEvent) => {
      const lanes = lanesRef.current
      if (!lanes) return
      const delta = wheelPixels(event)
      if (delta === 0) return
      event.preventDefault()

      if (event.altKey) {
        zoomBy(Math.pow(ZOOM_PER_WHEEL_PIXEL, -delta), event.clientX)
      } else if (event.ctrlKey || event.metaKey) {
        lanes.scrollTop += delta
      } else {
        lanes.scrollLeft += delta
      }
    }

    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  /**
   * The track headers ride along with the lanes.
   *
   * They are a separate column so they stay put while time scrolls sideways,
   * which means nothing moves them vertically unless it is done by hand — and a
   * name column that has drifted out of step with its tracks is worse than no
   * name column at all.
   */
  useEffect(() => {
    const lanes = lanesRef.current
    const headers = headersRef.current
    if (!lanes || !headers) return
    const sync = () => {
      headers.style.transform = `translateY(${-lanes.scrollTop}px)`
    }
    sync()
    lanes.addEventListener('scroll', sync, { passive: true })
    return () => lanes.removeEventListener('scroll', sync)
  }, [])

  // ── drop from the Content Browser ─────────────────────────────

  const onDragOver = useCallback(
    (event: React.DragEvent, track: Track) => {
      if (!isDroppableDrag(event)) return
      // Without preventDefault the browser refuses the drop entirely.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'

      // The payload is unreadable during dragover (browsers only expose types),
      // so the preview shows a nominal block; the real length lands on drop.
      const start = snapToFrame(timeAt(event.clientX))
      setPreview({ trackId: track.id, start, duration: 2 })
    },
    [timeAt],
  )

  /**
   * Turns whatever was dropped into asset ids, importing first if it has to.
   *
   * A file dragged from a folder, or straight out of Explorer, is not in the
   * project yet — so this is where the import happens, question and all. Must
   * read the DataTransfer synchronously: it goes inert the moment the drop
   * handler yields, and the copy-or-link dialog is a very long yield.
   */
  /**
   * Imports any `.fluxseq` in a drop, and says whether that was the whole drop.
   *
   * Copied into the project's sequences folder rather than opened where it
   * lies: the folder is the list, and a sequence the project cannot find again
   * tomorrow is not in the project.
   */
  const importDroppedSequences = useCallback(async (event: React.DragEvent) => {
    const files = sequenceFilesIn(event)
    if (files.length === 0) return false
    for (const file of files) await importSequenceFile(file)
    return true
  }, [])

  const idsFromDrop = useCallback(async (event: React.DragEvent): Promise<string[]> => {
    if (isAssetDrag(event)) return readAssetDragPayload(event)

    let files: DraggedFile[] = []
    if (isFileDrag(event)) files = readFileDragPayload(event)
    else if (isNativeFileDrag(event)) files = readNativeFileDrag(event)
    if (files.length === 0) return []

    const added = await importFiles(files)
    const ids = added.map((asset) => asset.id)

    // Dropping a file that is already in the project still has to place a clip
    // — importing is a no-op there, so `added` will not contain it.
    const existing = allAssets()
    for (const file of files) {
      const hit = existing.find((asset) => asset.path === file.path)
      if (hit && !ids.includes(hit.id)) ids.push(hit.id)
    }
    return ids
  }, [])

  const onDrop = useCallback(
    async (event: React.DragEvent, track: Track) => {
      if (!isDroppableDrag(event) && !hasSequenceFile(event)) return
      event.preventDefault()
      setPreview(null)

      // A sequence dropped in from outside is a sequence, not footage: it goes
      // into the project's sequences folder and opens, rather than being
      // laid on a track.
      if (await importDroppedSequences(event)) return

      const dropTime = timeAt(event.clientX)
      const ids = await idsFromDrop(event)
      if (ids.length === 0) return

      // What the drop could not do, in the words of whoever is watching it.
      // A clip that arrives without its sound looks identical to a broken
      // timeline unless the timeline says which it was.
      const notices: string[] = []

      // Sequential so several assets dropped together land end to end rather
      // than all resolving against the same free slot.
      let cursor = dropTime
      for (const assetId of ids) {
        const asset = await ensureProbed(assetId)
        if (!asset || asset.missing || asset.unreadable || !asset.duration) continue

        // Cheap: the audio track's index, not its waveform. See media/peaks.ts.
        const sound = await audioStateFor(asset.path)
        const hasAudio = sound.kind === 'sound'
        const silence =
          sound.kind === 'silent'
            ? `${asset.name} has no soundtrack`
            : sound.kind === 'unreadable'
              ? `${asset.name}: FLUX cannot read this file's audio yet (${sound.detail})`
              : null

        /*
         * The first clip into an empty sequence decides what the sequence is.
         *
         * Premiere asks; FLUX takes the answer from the footage, because the
         * question can only be answered by looking at the footage and the user
         * has not been shown any sequence settings to answer it with. Once
         * there is an edit the settings stay put — changing them under someone
         * halfway through would reframe and re-time every shot at once.
         *
         * The rate is counted from the sample table rather than read off the
         * container, for the reason media/indexCache.ts gives.
         */
        if (getSequence().clips.length === 0) {
          const video = await videoInfoFor(asset.path)
          updateSequenceSettings({
            ...(video
              ? { width: video.width, height: video.height, frameRate: round(video.frameRate) }
              : asset.width && asset.height
                ? { width: asset.width, height: asset.height }
                : {}),
            ...(sound.kind === 'sound'
              ? { audio: { sampleRate: sound.sampleRate, channels: sound.channels } }
              : {}),
          })
        }

        /*
         * Dropped on an audio track, a file arrives as its sound alone — which
         * is what an audio track is for, and what Premiere does. A file with no
         * sound is refused rather than laid down as a silent block: an audio
         * clip that can never make a noise is not a thing the timeline should
         * be able to contain.
         */
        if (track.kind === 'audio') {
          if (!hasAudio) {
            notices.push(`${silence}, so there is nothing to put on an audio track`)
            continue
          }
          const clip = addClip({
            assetId,
            trackId: track.id,
            start: cursor,
            duration: asset.duration,
          })
          if (clip) cursor = clip.start + clip.duration
          continue
        }

        const { video } = addLinkedClips(
          { assetId, trackId: track.id, start: cursor, duration: asset.duration },
          hasAudio,
        )
        if (video) cursor = video.start + video.duration
        if (video && silence) notices.push(`${silence} — it dropped as picture alone`)
      }

      // Cleared as well as set: every drop answers for itself, and a complaint
      // left over from the last one would be describing a clip you have already
      // stopped thinking about.
      setNotice(notices.length > 0 ? notices.join(' · ') : null)
    },
    [timeAt, idsFromDrop],
  )

  /*
   * The notice clears itself, and the timer restarts on each new one.
   *
   * Keyed on the message: a second drop that says the same thing about the same
   * file should still be visible for its full span, and a timer that survived
   * from the first would cut it short for no reason anybody could see.
   */
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // ── scrubbing ─────────────────────────────────────────────────

  /** Click or drag anywhere on the ruler to move the playhead. */
  const beginScrub = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      seek(snapToFrame(timeAt(event.clientX)))
      const onMove = (move: PointerEvent) => seek(snapToFrame(timeAt(move.clientX)))
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [timeAt],
  )

  // ── commands ──────────────────────────────────────────────────

  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return
    removeClips([...selected])
    setSelected(new Set())
  }, [selected])

  /**
   * Ties the selection together, or cuts it apart.
   *
   * Reports what happened, because the result is invisible until something is
   * dragged: two clips that no longer move together look exactly like two clips
   * that do, right up to the moment one of them is somewhere the other is not.
   */
  const toggleLinkSelected = useCallback(() => {
    const ids = [...selectedRef.current]
    if (ids.length === 0) {
      setNotice('Select the clips that should move together, then press Ctrl Space')
      return
    }

    // Counted before the change: unlinking takes the partners with it, so after
    // the fact there is no group left to count.
    const count = withLinked(ids).length
    const result = toggleLink(ids)
    if (result === 'linked') setNotice(`Linked ${count} clips — they move together now`)
    else if (result === 'unlinked') setNotice(`Unlinked ${count} clips — each moves on its own`)
    else setNotice('A clip on its own has nothing to link to — select both halves, or two clips')
  }, [])

  const copySelected = useCallback(() => {
    const count = copyClips([...selectedRef.current])
    setNotice(
      count > 0
        ? `Copied ${count} clip${count === 1 ? '' : 's'}`
        : 'Nothing selected to copy',
    )
  }, [])

  /**
   * Puts the clipboard down at the playhead.
   *
   * The playhead rather than the pointer, because paste is a keyboard gesture
   * and the pointer may be anywhere — including outside the panel. It is also
   * where every NLE pastes, for the same reason.
   */
  const pasteAtPlayhead = useCallback(() => {
    const landed = pasteClips(getTime())
    if (landed.length === 0) {
      setNotice(clipboardCount() === 0 ? 'Nothing copied yet' : 'No room to paste that here')
      return
    }
    const made = new Set(landed.map((clip) => clip.id))
    setSelected(made)
    selectedRef.current = made
    const at = Math.min(...landed.map((clip) => clip.start))
    const slid = at > getTime() + 1e-6
    setNotice(
      `Pasted ${landed.length} clip${landed.length === 1 ? '' : 's'}` +
        (slid ? ` — slid to ${at.toFixed(2)}s, past what was already there` : ''),
    )
  }, [])

  useEffect(() => {
    const handle = commands.registerAll([
      {
        id: 'timeline.zoomIn',
        title: 'Zoom In',
        category: 'Timeline',
        run: () => zoomBy(1.5),
      },
      {
        id: 'timeline.zoomOut',
        title: 'Zoom Out',
        category: 'Timeline',
        run: () => zoomBy(1 / 1.5),
      },
      {
        id: 'timeline.addTrack',
        title: 'Add Video Track',
        category: 'Timeline',
        detail: 'Adds a track above the others',
        run: () => {
          addTrack('video')
        },
      },
      {
        id: 'timeline.copy',
        title: 'Copy Clips',
        category: 'Timeline',
        detail: 'Copies the selection, linked halves included',
        enabled: () => selected.size > 0,
        run: copySelected,
      },
      {
        id: 'timeline.paste',
        title: 'Paste Clips',
        category: 'Timeline',
        detail: 'Puts the copied clips down at the playhead',
        enabled: () => clipboardCount() > 0,
        run: pasteAtPlayhead,
      },
      {
        id: 'timeline.toggleSnapping',
        title: 'Toggle Snapping',
        category: 'Timeline',
        detail: 'Whether edges snap to clips, the playhead and the start',
        run: () => setSnapping((on) => !on),
      },
      {
        id: 'timeline.toggleLink',
        title: 'Link or Unlink Selected Clips',
        category: 'Timeline',
        detail: 'Linked clips move, select and delete as one',
        enabled: () => selected.size > 0,
        run: toggleLinkSelected,
      },
      {
        id: 'timeline.deleteSelected',
        title: 'Delete Selected Clips',
        category: 'Timeline',
        detail: 'Removes clips from the sequence; assets and files are untouched',
        enabled: () => selected.size > 0,
        run: deleteSelected,
      },
    ])
    return () => handle.dispose()
  }, [copySelected, pasteAtPlayhead, deleteSelected, toggleLinkSelected, selected.size, zoomBy])

  // ── rendering ─────────────────────────────────────────────────

  const step = tickInterval(zoom)
  const tickCount = Math.ceil(contentWidth / (step * zoom)) + 1
  const allSequences = listSequences()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-value tool-value--dim">
            {sequence.settings.width}×{sequence.settings.height}
          </span>
          <span className="tool-value tool-value--dim">{sequence.settings.frameRate} fps</span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--dim">
            {sequence.clips.length} clip{sequence.clips.length === 1 ? '' : 's'}
          </span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            {formatTimecode(time, sequence.settings.frameRate)}
          </span>
          <span className="cb-toolbar-end">
            <button
              className={`cb-btn${snapping ? ' cb-btn--on' : ''}`}
              onClick={() => setSnapping((on) => !on)}
              title="Snap edges to clips, the playhead and the start (S)"
            >
              Snap
            </button>
            <button
              className="cb-btn"
              onClick={() => setSettingsOpen(true)}
              title="Sequence settings"
            >
              Settings
            </button>
            {selected.size > 0 && (
              <button className="cb-btn" onClick={deleteSelected}>
                Delete {selected.size}
              </button>
            )}
            <button
              className="cb-btn"
              onClick={() => zoomBy(1 / 1.5)}
              title="Zoom out (Alt + scroll)"
            >
              −
            </button>
            <button
              className="cb-btn"
              onClick={() => zoomBy(1.5)}
              title="Zoom in (Alt + scroll)"
            >
              +
            </button>
          </span>
        </>
      }
    >
      <div className="tl-shell">
      <SequenceTabs
        sequences={allSequences}
        activeId={sequence.id}
        onRename={(id, name) => renameSequence(id, name)}
      />
      {settingsOpen && (
        <SequenceSettingsDialog sequence={sequence} onClose={() => setSettingsOpen(false)} />
      )}
      <div className="tl" ref={rootRef}>
        <div className="tl-headers" style={{ width: HEADER_WIDTH }}>
          <div className="tl-header-spacer" />
          <div className="tl-header-list" ref={headersRef}>
            {sequence.tracks.map((track) => (
              <div
                className={`tl-header tl-header--${track.kind}`}
                key={track.id}
                style={{ height: TRACK_HEIGHT }}
              >
                <span className="track-name">{track.name}</span>
                {track.kind === 'audio' ? (
                  <TrackControls track={track} silent={!isTrackAudible(track, sequence.tracks)} />
                ) : (
                  <VideoTrackControls track={track} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="tl-scroll" ref={lanesRef}>
          <div className="tl-content" style={{ width: contentWidth }}>
            <div className="tl-ruler" onPointerDown={beginScrub}>
              {Array.from({ length: tickCount }, (_, i) => {
                const seconds = i * step
                return (
                  <div className="tl-tick" key={i} style={{ left: seconds * zoom }}>
                    <span>{formatTime(seconds, step)}</span>
                  </div>
                )
              })}
              {/* The grip lives in the ruler, not on the playhead line: the
                  ruler stays put while the tracks scroll under it, and a grip
                  that slid away from its own ruler would read as broken. */}
              <span className="tl-playhead-grip" style={{ left: time * zoom }} />
            </div>

            {sequence.tracks.map((track) => (
              <div
                className={`tl-lane tl-lane--${track.kind}`}
                key={track.id}
                style={{ height: TRACK_HEIGHT }}
                onDragOver={(e) => onDragOver(e, track)}
                onDragLeave={() => setPreview(null)}
                onDrop={(e) => void onDrop(e, track)}
              >
                {sequence.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => {
                    const dragging = drag?.moved === true && drag.ids.includes(clip.id)
                    const copying = dragging && drag?.copying === true
                    const trimming = trim?.ids.includes(clip.id) ? trim : null
                    return (
                      <ClipBlock
                        key={clip.id}
                        clip={clip}
                        asset={assetById.get(clip.assetId)}
                        zoom={zoom}
                        selected={selected.has(clip.id)}
                        dragging={dragging}
                        copying={copying}
                        // The head takes the clip's front with it and gives back
                        // the same amount of length; the tail only changes the
                        // length. Same arithmetic as the kernel's trim, so what
                        // is drawn is what will be committed.
                        trimStart={trimming?.edge === 'start' ? trimming.delta : 0}
                        trimDuration={
                          trimming ? (trimming.edge === 'start' ? -trimming.delta : trimming.delta) : 0
                        }
                        onTrim={(event, edge) => beginClipTrim(event, clip, edge)}
                        // Offset rather than re-placed: the move is not
                        // committed until the pointer comes up, so the clip in
                        // the sequence is still where it was.
                        offsetX={dragging ? drag.deltaTime * zoom : 0}
                        offsetY={dragging ? drag.deltaTracks * TRACK_HEIGHT : 0}
                        onPointerDown={(event) => beginClipDrag(event, clip)}
                      />
                    )
                  })}

                {preview?.trackId === track.id && (
                  <div
                    className="tl-drop-preview"
                    style={{
                      left: findFreeStart(track.id, preview.start, preview.duration) * zoom,
                      width: Math.max(2, preview.duration * zoom),
                    }}
                  />
                )}
              </div>
            ))}

            {/* One playhead over every lane, drawn last so nothing covers it. */}
            <div
              className={`tl-playhead${playing ? ' tl-playhead--live' : ''}`}
              style={{ left: time * zoom }}
            >
              {/* The line itself stays inert so it never swallows a click meant
                  for the clip underneath it; only this narrow handle grabs. */}
              <span className="tl-playhead-handle" onPointerDown={beginScrub} />
            </div>
          </div>
        </div>

        {sequence.clips.length === 0 && !notice && (
          <div className="tl-hint">Drag media onto a track — from the browser, or from Explorer</div>
        )}

        {notice && (
          <button
            className="tl-notice"
            title="Dismiss"
            onClick={() => setNotice(null)}
          >
            {notice}
          </button>
        )}
      </div>
      </div>
    </PanelFrame>
  )
}

/**
 * Whether a video track is drawn.
 *
 * One button, where an audio track has three. Video has no level to ride and
 * nothing to solo against — a layer is either in the picture or it is not, and
 * the eye says which.
 */
function VideoTrackControls({ track }: { track: Track }) {
  return (
    <span className={`track-controls${track.hidden ? ' track-controls--silent' : ''}`}>
      <button
        className={`track-toggle track-toggle--eye${track.hidden ? ' track-toggle--off' : ''}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setTrackHidden(track.id, !track.hidden)}
        title={`${track.hidden ? 'Show' : 'Hide'} ${track.name}`}
        aria-pressed={!track.hidden}
      >
        {track.hidden ? '⦸' : '◉'}
      </button>
    </span>
  )
}

/**
 * A track's level, and whether it is heard.
 *
 * The level is dragged rather than typed, the way every parameter in a
 * compositor is: a fader is a gesture, and stopping to select a number and
 * commit it is not how anyone rides a level. Double-click puts it back to
 * unity, which is the only value worth a shortcut.
 *
 * `silent` is not the same as `muted` — a track is also silent when something
 * else is soloed — so the row dims for either, and the M button still shows
 * only what it itself is doing.
 */
function TrackControls({ track, silent }: { track: Track; silent: boolean }) {
  const dragging = useRef(false)

  const beginGainDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const startGain = track.gain
      dragging.current = false

      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX
        if (!dragging.current && Math.abs(dx) < DRAG_THRESHOLD_PX) return
        dragging.current = true
        // A quarter of a decibel per pixel: the whole range in a drag the width
        // of the panel, and fine enough to place a level by ear.
        setTrackGain(track.id, clampGain(startGain + dx * 0.25))
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [track.id, track.gain],
  )

  return (
    <span className={`track-controls${silent ? ' track-controls--silent' : ''}`}>
      <button
        className={`track-toggle${track.muted ? ' track-toggle--on' : ''}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setTrackMuted(track.id, !track.muted)}
        title={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
        aria-pressed={track.muted}
      >
        M
      </button>
      <button
        className={`track-toggle track-toggle--solo${track.solo ? ' track-toggle--on' : ''}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setTrackSolo(track.id, !track.solo)}
        title={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
        aria-pressed={track.solo}
      >
        S
      </button>
      <span
        className="track-gain"
        onPointerDown={beginGainDrag}
        onDoubleClick={() => setTrackGain(track.id, 0)}
        title={`${track.name} level — drag to change, double-click for unity`}
        role="slider"
        aria-label={`${track.name} level`}
        aria-valuemin={MIN_GAIN_DB}
        aria-valuemax={MAX_GAIN_DB}
        aria-valuenow={track.gain}
      >
        {track.gain <= MIN_GAIN_DB ? '-∞' : `${track.gain > 0 ? '+' : ''}${track.gain.toFixed(1)}`}
      </span>
    </span>
  )
}

/**
 * One tab per sequence, and a `+`.
 *
 * The tab strip is the only place a sequence can be switched, which is what
 * makes it safe for every editing function to work on "the active one" without
 * asking which — see kernel/sequence.ts.
 */
function SequenceTabs({
  sequences,
  activeId,
  onRename,
}: {
  sequences: SequenceState[]
  activeId: string
  onRename: (id: string, name: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <div className="seq-tabs">
      {sequences.map((one) => (
        <div
          key={one.id}
          className={`seq-tab${one.id === activeId ? ' seq-tab--active' : ''}`}
          onClick={() => activateSequence(one.id)}
          onDoubleClick={() => setRenaming(one.id)}
          title={`${one.name} — ${one.settings.width}×${one.settings.height} at ${one.settings.frameRate}fps`}
        >
          {renaming === one.id ? (
            <input
              className="seq-tab-name"
              defaultValue={one.name}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => {
                onRename(one.id, event.currentTarget.value)
                setRenaming(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setRenaming(null)
                event.stopPropagation()
              }}
            />
          ) : (
            <span className="seq-tab-label">{one.name}</span>
          )}
          {sequences.length > 1 && (
            <button
              className="seq-tab-close"
              title={`Close ${one.name}`}
              onClick={(event) => {
                event.stopPropagation()
                removeSequence(one.id)
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        className="seq-tab-add"
        title="New sequence"
        onClick={() => createSequence()}
      >
        +
      </button>
    </div>
  )
}

/**
 * What the sequence *is*: the frame, the rate, and the settings recorded for
 * later.
 *
 * The dialog says which is which. A setting that appears to do something and
 * does not is worse than one that is honestly labelled, and FLUX has no
 * exporter and no preview render files yet — so the audio and preview groups
 * are written to the file and acted on by nothing.
 */
function SequenceSettingsDialog({
  sequence,
  onClose,
}: {
  sequence: SequenceState
  onClose: () => void
}) {
  const s = sequence.settings
  const number = (value: string, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  return (
    <div className="seq-settings-scrim" onClick={onClose}>
      <div
        className="seq-settings"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Sequence settings"
      >
        <div className="seq-settings-head">
          <span className="seq-settings-title">{sequence.name}</span>
          <button className="cb-btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="seq-settings-group">
          <span className="seq-settings-legend">In force</span>
          <label className="seq-field">
            <span>Width</span>
            <input
              type="number"
              value={s.width}
              min={2}
              onChange={(e) => updateSequenceSettings({ width: number(e.target.value, s.width) })}
            />
          </label>
          <label className="seq-field">
            <span>Height</span>
            <input
              type="number"
              value={s.height}
              min={2}
              onChange={(e) => updateSequenceSettings({ height: number(e.target.value, s.height) })}
            />
          </label>
          <label className="seq-field">
            <span>Frame rate</span>
            <select
              value={String(s.frameRate)}
              onChange={(e) => updateSequenceSettings({ frameRate: Number(e.target.value) })}
            >
              {[...new Set([...FRAME_RATES, s.frameRate])]
                .sort((a, b) => a - b)
                .map((rate) => (
                  <option key={rate} value={String(rate)}>
                    {rate} fps
                  </option>
                ))}
            </select>
          </label>
        </div>

        <div className="seq-settings-group">
          <span className="seq-settings-legend">
            Recorded — saved with the sequence, not yet acted on
          </span>
          <label className="seq-field">
            <span>Sample rate</span>
            <select
              value={String(s.audio.sampleRate)}
              onChange={(e) =>
                updateSequenceSettings({
                  audio: { ...s.audio, sampleRate: Number(e.target.value) },
                })
              }
            >
              {SAMPLE_RATES.map((rate) => (
                <option key={rate} value={String(rate)}>
                  {rate} Hz
                </option>
              ))}
            </select>
          </label>
          <label className="seq-field">
            <span>Channels</span>
            <select
              value={String(s.audio.channels)}
              onChange={(e) =>
                updateSequenceSettings({ audio: { ...s.audio, channels: Number(e.target.value) } })
              }
            >
              <option value="1">Mono</option>
              <option value="2">Stereo</option>
            </select>
          </label>
          <label className="seq-field">
            <span>Preview codec</span>
            <select
              value={s.preview.codec}
              onChange={(e) =>
                updateSequenceSettings({ preview: { ...s.preview, codec: e.target.value } })
              }
            >
              {PREVIEW_CODECS.map((codec) => (
                <option key={codec} value={codec}>
                  {codec}
                </option>
              ))}
            </select>
          </label>
          <label className="seq-field">
            <span>Pixel format</span>
            <select
              value={s.preview.pixelFormat}
              onChange={(e) =>
                updateSequenceSettings({ preview: { ...s.preview, pixelFormat: e.target.value } })
              }
            >
              {PIXEL_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
          <label className="seq-field seq-field--check">
            <input
              type="checkbox"
              checked={s.preview.cacheFrames}
              onChange={(e) =>
                updateSequenceSettings({
                  preview: { ...s.preview, cacheFrames: e.target.checked },
                })
              }
            />
            <span>Cache preview frames</span>
          </label>
        </div>
      </div>
    </div>
  )
}

/**
 * How narrow a clip can get before its trim handles are in the way.
 *
 * Below this the whole block is barely a grab target, and two handles either
 * side of it would leave nothing in the middle to press for a move.
 */
const HANDLE_MIN_WIDTH = 22

function ClipBlock({
  clip,
  asset,
  zoom,
  selected,
  dragging,
  copying,
  trimStart,
  trimDuration,
  offsetX,
  offsetY,
  onPointerDown,
  onTrim,
}: {
  clip: Clip
  asset: Asset | undefined
  zoom: number
  selected: boolean
  dragging: boolean
  copying: boolean
  trimStart: number
  trimDuration: number
  offsetX: number
  offsetY: number
  onPointerDown: (event: React.PointerEvent) => void
  onTrim: (event: React.PointerEvent, edge: TrimEdge) => void
}) {
  // What the clip is *while the pointer is down*. The sequence still holds the
  // untrimmed clip until the trim is committed, so this is drawn from the
  // in-flight delta rather than from the sequence.
  const start = clip.start + trimStart
  const duration = clip.duration + trimDuration
  const offset = clip.offset + trimStart
  const width = Math.max(2, duration * zoom)

  // The asset can be gone while the clip remains: removing something from the
  // bin must not silently delete the editing work that used it.
  const orphaned = !asset
  // Requests its own decode rather than reading the cache. Reading the cache
  // made a clip's picture depend on whether the Content Browser had rendered
  // that card first, so a block was blank for any asset never scrolled past.
  const thumbnail = useThumbnail(asset?.path, asset?.kind, Boolean(asset) && !asset?.missing)

  const label = orphaned ? 'missing asset' : asset.name
  const state = orphaned || asset.missing ? ' clip--orphan' : ''
  // Says so only when it is: a clip playing its whole file has nothing to
  // report, and a badge on every clip would say nothing at all.
  const trimmed = offset > EPS_UI || offset + duration < clip.sourceDuration - EPS_UI

  return (
    <div
      className={`clip clip--${clip.kind}${state}${selected ? ' clip--selected' : ''}${
        dragging ? ' clip--dragging' : ''
      }${copying ? ' clip--copying' : ''}`}
      style={{
        left: start * zoom,
        width,
        transform: dragging ? `translate(${offsetX}px, ${offsetY}px)` : undefined,
      }}
      title={`${label} · ${duration.toFixed(2)}s${
        trimmed ? ` · from ${offset.toFixed(2)}s of ${clip.sourceDuration.toFixed(2)}s` : ''
      }`}
      onPointerDown={onPointerDown}
    >
      {clip.kind === 'audio' ? (
        <Waveform path={asset?.path} width={width} start={offset} duration={duration} />
      ) : (
        thumbnail && width > 34 && <img className="clip-thumb" src={thumbnail} alt="" />
      )}
      {/* Says which clips travel together, which is otherwise invisible until
          one of them is dragged. A chain rather than a word: it sits inside a
          block that may be twenty pixels wide. */}
      {clip.linkId && width > 46 && (
        <span className="clip-link" title="Linked — moves with its other half (Ctrl Space)">
          ⛓
        </span>
      )}
      <span className="clip-label">{label}</span>

      {/* Handles last, so they sit above the label and the waveform. Their
          own pointerdown stops the block's, which would otherwise start a
          move: an edge is not a place to grab a clip from. */}
      {!orphaned && width >= HANDLE_MIN_WIDTH && (
        <>
          <span
            className="clip-handle clip-handle--start"
            title="Drag to trim the head"
            onPointerDown={(event) => onTrim(event, 'start')}
          />
          <span
            className="clip-handle clip-handle--end"
            title="Drag to trim the tail"
            onPointerDown={(event) => onTrim(event, 'end')}
          />
        </>
      )}
    </div>
  )
}

/**
 * The clip's sound, drawn.
 *
 * A canvas rather than an SVG path or a run of divs: at 400 pixels per second a
 * minute of audio is 24,000 columns, and a timeline that built 24,000 DOM nodes
 * per clip would stop being a timeline. Drawing is one pass over the peaks with
 * one line per pixel — see shared/peaks.js for why there is a bucket per pixel
 * to draw from.
 *
 * The peaks are asked for once and drawn whenever they arrive. Until then the
 * clip is a plain block, which is what every NLE shows while it is conforming;
 * blocking the clip on its own waveform would mean a timeline that will not
 * show an edit until it has read the audio.
 */
function Waveform({
  path,
  width,
  start,
  duration,
}: {
  path: string | undefined
  width: number
  start: number
  duration: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState(() => (path ? cachedPeaks(path) : null))

  useEffect(() => {
    if (!path) return
    let live = true
    const held = cachedPeaks(path)
    setPeaks(held)
    if (held) return
    void peaksFor(path).then((result) => {
      if (live) setPeaks(result.ok ? result.peaks : null)
    })
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return

    // Backing store in device pixels, size in CSS pixels: a waveform drawn at
    // one device pixel per column on a 150% display is the only version of this
    // that looks like a waveform rather than a smear.
    const ratio = window.devicePixelRatio || 1
    const columns = Math.max(1, Math.floor(width))
    const height = canvas.clientHeight || 1
    canvas.width = Math.round(columns * ratio)
    canvas.height = Math.round(height * ratio)

    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, columns, height)

    const middle = height / 2
    const reach = height / 2 - 1
    context.strokeStyle = getComputedStyle(canvas).color
    context.lineWidth = 1

    context.beginPath()
    for (let x = 0; x < columns; x++) {
      const from = start + (x / columns) * duration
      const to = start + ((x + 1) / columns) * duration
      const [low, high] = peakRange(peaks, from, to)
      // Half a pixel, so a one-pixel line lands on the pixel rather than across
      // the seam between two.
      const at = x + 0.5
      // A minimum of one pixel: silence should read as a line through the
      // middle, not as a gap where the waveform stopped.
      context.moveTo(at, middle - Math.max(high * reach, 0.5))
      context.lineTo(at, middle + Math.max(-low * reach, 0.5))
    }
    context.stroke()
  }, [peaks, width, start, duration])

  if (!peaks) return null
  return <canvas className="clip-wave" ref={canvasRef} />
}
