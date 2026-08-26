import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { ensureProbed, getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import {
  isAssetDrag,
  isDroppableDrag,
  isFileDrag,
  isNativeFileDrag,
  readAssetDragPayload,
  readFileDragPayload,
  readNativeFileDrag,
  type DraggedFile,
} from '../kernel/dragAssets'
import { importFiles } from '../kernel/importPipeline'
import {
  formatTimecode,
  getTime,
  isPlaying,
  seek,
  subscribePlayback,
} from '../kernel/playback'
import {
  addClip,
  addTrack,
  findFreeStart,
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
const HEADER_WIDTH = 68
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
  const lanesRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  /** Set by a zoom, read once the new scale has rendered. See zoomBy. */
  const zoomAnchor = useRef<{ time: number; clientX: number } | null>(null)

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
  useEffect(() => recordView({ timeline: { zoom } }), [zoom])

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
      if (!isDroppableDrag(event)) return
      event.preventDefault()
      setPreview(null)

      const dropTime = timeAt(event.clientX)
      const ids = await idsFromDrop(event)
      if (ids.length === 0) return

      // Sequential so several assets dropped together land end to end rather
      // than all resolving against the same free slot.
      let cursor = dropTime
      for (const assetId of ids) {
        const asset = await ensureProbed(assetId)
        if (!asset || asset.missing || asset.unreadable || !asset.duration) continue

        const clip = addClip({
          assetId,
          trackId: track.id,
          start: cursor,
          duration: asset.duration,
        })
        if (clip) cursor = clip.start + clip.duration
      }
    },
    [timeAt, idsFromDrop],
  )

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
        id: 'timeline.deleteSelected',
        title: 'Delete Selected Clips',
        category: 'Timeline',
        detail: 'Removes clips from the sequence; assets and files are untouched',
        enabled: () => selected.size > 0,
        run: deleteSelected,
      },
    ])
    return () => handle.dispose()
  }, [deleteSelected, selected.size, zoomBy])

  // ── rendering ─────────────────────────────────────────────────

  const step = tickInterval(zoom)
  const tickCount = Math.ceil(contentWidth / (step * zoom)) + 1

  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">{sequence.name}</span>
          <span className="tool-value tool-value--dim">{sequence.frameRate} fps</span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--dim">
            {sequence.clips.length} clip{sequence.clips.length === 1 ? '' : 's'}
          </span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            {formatTimecode(time, sequence.frameRate)}
          </span>
          <span className="cb-toolbar-end">
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
      <div className="tl" ref={rootRef}>
        <div className="tl-headers" style={{ width: HEADER_WIDTH }}>
          <div className="tl-header-spacer" />
          <div className="tl-header-list" ref={headersRef}>
            {sequence.tracks.map((track) => (
              <div className="tl-header" key={track.id} style={{ height: TRACK_HEIGHT }}>
                <span className="track-name">{track.name}</span>
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
                className="tl-lane"
                key={track.id}
                style={{ height: TRACK_HEIGHT }}
                onDragOver={(e) => onDragOver(e, track)}
                onDragLeave={() => setPreview(null)}
                onDrop={(e) => void onDrop(e, track)}
              >
                {sequence.clips
                  .filter((clip) => clip.trackId === track.id)
                  .map((clip) => (
                    <ClipBlock
                      key={clip.id}
                      clip={clip}
                      asset={assetById.get(clip.assetId)}
                      zoom={zoom}
                      selected={selected.has(clip.id)}
                      onSelect={(additive) =>
                        setSelected((current) => {
                          const next = additive ? new Set(current) : new Set<string>()
                          if (additive && current.has(clip.id)) next.delete(clip.id)
                          else next.add(clip.id)
                          return next
                        })
                      }
                    />
                  ))}

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
            />
          </div>
        </div>

        {sequence.clips.length === 0 && (
          <div className="tl-hint">Drag media onto a track — from the browser, or from Explorer</div>
        )}
      </div>
    </PanelFrame>
  )
}

function ClipBlock({
  clip,
  asset,
  zoom,
  selected,
  onSelect,
}: {
  clip: Clip
  asset: Asset | undefined
  zoom: number
  selected: boolean
  onSelect: (additive: boolean) => void
}) {
  const width = Math.max(2, clip.duration * zoom)

  // The asset can be gone while the clip remains: removing something from the
  // bin must not silently delete the editing work that used it.
  const orphaned = !asset
  // Requests its own decode rather than reading the cache. Reading the cache
  // made a clip's picture depend on whether the Content Browser had rendered
  // that card first, so a block was blank for any asset never scrolled past.
  const thumbnail = useThumbnail(asset?.path, asset?.kind, Boolean(asset) && !asset?.missing)

  const label = orphaned ? 'missing asset' : asset.name
  const state = orphaned || asset.missing ? ' clip--orphan' : ''

  return (
    <div
      className={`clip clip--video${state}${selected ? ' clip--selected' : ''}`}
      style={{ left: clip.start * zoom, width }}
      title={`${label} · ${clip.duration.toFixed(2)}s`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(e.ctrlKey || e.metaKey || e.shiftKey)
      }}
    >
      {thumbnail && width > 34 && <img className="clip-thumb" src={thumbnail} alt="" />}
      <span className="clip-label">{label}</span>
    </div>
  )
}
