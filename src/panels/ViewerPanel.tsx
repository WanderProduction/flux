import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import { assetUrl } from '../kernel/fsBridge'
import { VideoSource } from '../kernel/media/videoSource'
import { audioInfoFor, type AudioInfo } from '../kernel/media/peaks'
import {
  formatTimecode,
  getSeekToken,
  getTime,
  goToEnd,
  goToStart,
  isPlaying,
  pause,
  play,
  seek,
  setClockSource,
  stepFrames,
  subscribePlayback,
  toggle,
} from '../kernel/playback'
import {
  getSequence,
  isTrackVisible,
  sequenceDuration,
  subscribeSequence,
  type Clip,
  type SequenceState,
} from '../kernel/sequence'
import { getView, recordView, subscribeView } from '../kernel/view'
import {
  aspectLabel,
  framePixels,
  resolveZoom,
  stepZoom,
  zoomToward,
  DEFAULT_PAUSED_RESOLUTION,
  DEFAULT_PLAYBACK_RESOLUTION,
  RESOLUTIONS,
  ZOOM_LEVELS,
  type Point,
  type Zoom,
} from '../kernel/viewer'
import {
  cropRect,
  resolveTransform,
  transformOf,
  type Transform,
} from '../kernel/clipEffects'
import { PanelFrame } from './PanelFrame'

/**
 * Viewer — what the sequence looks like at the playhead.
 *
 * ## Two ways to put a picture on screen
 *
 * **The pipeline.** Every mp4 whose index we can read is demuxed, decoded
 * through WebCodecs and drawn to a canvas: see kernel/media/videoSource.ts. We
 * hold the frames, so we know exactly which one is on screen, and the canvas is
 * the surface they are composited into. Sound comes from the mixer — see
 * kernel/media/mixer.ts.
 *
 * ## Layers
 *
 * Every visible video track with a clip at the playhead is drawn, bottom track
 * first, into the sequence's own frame. That the output has a size of its own
 * is the thing that makes this a composite rather than a picture: two clips of
 * different shapes have to be drawn *into* something, and taking the size from
 * whichever happens to be on top would make the output change shape as the
 * playhead crossed a cut.
 *
 * Each frame is scaled to fit that output, centred, keeping its aspect — so a
 * portrait clip over a landscape one shows the layer beneath it down each side.
 * Each clip then carries its own transform — position, anchor, scale, rotation,
 * opacity, crop and skew, applied after the file's own rotation has put the
 * picture upright. See kernel/clipEffects.ts. What is still missing is
 * blending: a layer covers what is under it wherever it has pixels.
 *
 * **The element.** Anything else — webm, a container the demuxer will not
 * guess at, a build without WebCodecs — falls back to a plain `<video>`, which
 * is what this panel used to do for everything. A fallback rather than a
 * refusal: a viewer that shows nothing because it could not read a sample table
 * is worse than one that shows the file the old way.
 *
 * ## Who holds the clock
 *
 * Whatever is playing the audio, in both paths. kernel/playback.ts explains why
 * at length; the short version is that `requestAnimationFrame` is throttled the
 * moment the window is not being painted, while the thing feeding the sound
 * card is not. Frames are presented against that clock, which is what every NLE
 * does and what Premiere is explicit about.
 *
 * The media element is moved in exactly one circumstance: a deliberate seek,
 * which the transport announces with a token. Moving it because the time
 * changed would mean moving it because it moved.
 */

/**
 * How far out the element has to be before a seek bothers to move it.
 *
 * A quarter of a frame at 24fps: under the threshold of noticing, and enough
 * that scrubbing to where the picture already is costs nothing.
 */
const SYNC_TOLERANCE = 0.01 + 1 / 96

/**
 * How far `Shift` and an arrow go.
 *
 * Frames rather than a fraction of a second, so the long step stays a whole
 * number of frames at any rate — a jump that lands between two frames would
 * make the next single step half a frame long.
 */
const JUMP_FRAMES = 5

/**
 * Every clip to be drawn at `time`, bottom layer first.
 *
 * Tracks are stored in the order they stack, V2 above V1, so this walks them
 * backwards — the last one drawn is the one in front. Hidden tracks are left
 * out, and audio tracks never had a picture to contribute.
 */
export function layersAt(sequence: SequenceState, time: number): Clip[] {
  const layers: Clip[] = []
  for (const track of [...sequence.tracks].reverse()) {
    if (track.kind !== 'video' || !isTrackVisible(track)) continue
    const found = sequence.clips.find(
      (clip) =>
        clip.trackId === track.id && time >= clip.start && time < clip.start + clip.duration,
    )
    if (found) layers.push(found)
  }
  return layers
}

/**
 * The clip in front at `time`, or null.
 *
 * What the toolbar names, and what the fallback element plays when the pipeline
 * cannot read one of the layers. Audio tracks are skipped, and not merely
 * because a waveform is not a picture: the audio half of a linked pair is the
 * same file at the same moment, so showing it would mean decoding a video track
 * nothing asked for.
 */
export function clipAt(sequence: SequenceState, time: number): Clip | null {
  return layersAt(sequence, time).at(-1) ?? null
}

/**
 * Draws one clip into the sequence's frame, upright, cropped, transformed.
 *
 * Two rotations meet here and they are not the same thing. The **file's** is
 * intrinsic: a decoder hands back the picture exactly as it was coded, which
 * for two in five files in a camera library means lying on its side, and the
 * container's display matrix is what says so. The **clip's** is a decision
 * someone made in the panel. The file's is applied first, to put the picture
 * up the right way, and everything a person set then applies to that upright
 * picture — otherwise typing 90 into Rotation would mean something different
 * for a phone clip than for a camera one.
 *
 * The file's rotation is negated because the conventions point opposite ways:
 * `av_display_rotation_get` returns a counter-clockwise angle and canvas
 * `rotate()` takes a clockwise one. A wrong quarter turn inside a frame box
 * sized for the right one does not look sideways, it looks upside down, which
 * reads as a camera problem rather than a FLUX one. Measured: ffmpeg's correct
 * output for DSCF1908.MOV is pixel-identical to the coded frame through
 * `transpose=2` at PSNR inf, where clockwise scores 15dB.
 *
 * ## What 100% scale means
 *
 * The size FLUX already drew the clip at: scaled to fit the frame, centred.
 * **Not** the source's own pixel size, which is what Premiere's 100% means.
 *
 * Deliberate, and the reason is that untouched clips must composite exactly as
 * they did before any of this existed — a sequence of them has to render
 * identically to one from before there were parameters at all. Taking 100% to
 * mean native pixels would make every 4K clip in a 1080 sequence overflow the
 * moment this shipped. For the common case here the two agree anyway, since a
 * sequence takes its size from the first clip dropped on it.
 *
 * ## Crop is a clip path, not a source rectangle
 *
 * Cropping in the *displayed* orientation means its edges are the edges
 * someone sees, whatever way the file was coded. Taking a source rectangle
 * instead would need the crop mapped back through the file's rotation, and a
 * left crop on a sideways clip would come off the top. Clipping the
 * destination before the rotation is applied avoids the mapping entirely.
 */
function drawClip(
  context: CanvasRenderingContext2D,
  frame: VideoFrame,
  width: number,
  height: number,
  rotation: number,
  effects: Partial<Transform> | undefined,
) {
  const t = resolveTransform(effects, { width, height })
  const alpha = t.opacity / 100
  if (alpha <= 0) return

  // The picture's shape once the file's own rotation has been honoured.
  const quarter = rotation === 90 || rotation === 270
  const shown = quarter
    ? { width: frame.displayHeight, height: frame.displayWidth }
    : { width: frame.displayWidth, height: frame.displayHeight }
  if (!(shown.width > 0) || !(shown.height > 0)) return

  const rect = cropRect(t.crop, shown)
  if (rect.width <= 0 || rect.height <= 0) return

  // Frame pixels per displayed pixel at 100%: the fit this panel always used.
  const fit = Math.min(width / shown.width, height / shown.height)
  const fullWidth = shown.width * fit
  const fullHeight = shown.height * fit

  context.save()
  context.globalAlpha = alpha

  /*
   * Position, scale, rotation and skew, composed once in kernel/clipEffects so
   * every surface agrees what they mean together. After it, the origin is
   * wherever `position` points and the axes carry the scale and the turn.
   */
  const m = transformOf(t)
  context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])

  /*
   * Then back by the anchor, which moves the origin to the picture's centre.
   *
   * The anchor is given in sequence pixels and defaults to the centre of the
   * frame, which is where an untouched picture's own centre sits — so the
   * offset below is zero until someone moves it, and the picture is drawn
   * about its middle exactly as before.
   */
  context.translate(-(t.anchor.x - width / 2), -(t.anchor.y - height / 2))

  // The crop, in the picture's displayed orientation, before the file's own
  // rotation turns the axes.
  if (rect.width < shown.width || rect.height < shown.height) {
    context.beginPath()
    context.rect(
      -fullWidth / 2 + rect.x * fit,
      -fullHeight / 2 + rect.y * fit,
      rect.width * fit,
      rect.height * fit,
    )
    context.clip()
  }

  if (rotation !== 0) context.rotate((-rotation * Math.PI) / 180)
  // Inside the rotated space the box's axes have swapped, so a quarter turn
  // draws at the other dimension. Getting this the wrong way round is a
  // picture that is upright and squashed, which reads as a bad aspect ratio.
  const drawWidth = quarter ? fullHeight : fullWidth
  const drawHeight = quarter ? fullWidth : fullHeight
  context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  context.restore()
}

export function ViewerPanel() {
  const [sequence, setSequence] = useState<SequenceState>(getSequence)
  const [assets, setAssets] = useState<Asset[]>(getAssets)
  const [time, setTime] = useState(getTime)
  const [playing, setPlaying] = useState(isPlaying)
  const [seekToken, setSeekToken] = useState(getSeekToken)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaRef = useRef<HTMLMediaElement>(null)

  useEffect(() => {
    setSequence({ ...getSequence() })
    return subscribeSequence(() => setSequence({ ...getSequence() }))
  }, [])
  useEffect(() => subscribeAssets(() => setAssets([...getAssets()])), [])
  useEffect(
    () =>
      subscribePlayback(() => {
        setTime(getTime())
        setPlaying(isPlaying())
        setSeekToken(getSeekToken())
      }),
    [],
  )

  // ── the stage: what shape the frame is, and where you are looking ──

  const [view, setViewState] = useState(getView)
  useEffect(() => subscribeView(() => setViewState({ ...getView() })), [])

  const stageRef = useRef<HTMLDivElement>(null)
  /**
   * The stage's size in CSS pixels, measured rather than assumed.
   *
   * Fit is a question about the panel, and the panel is resized by dragging a
   * dock splitter — which fires no window resize and no React render. Without
   * an observer the frame would stay the size it was when the panel mounted.
   */
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setStageSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const [zoom, setZoom] = useState<Zoom>('fit')
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })

  /** The sequence's own frame — the shape everything is composited into. */
  const frame = useMemo(
    () => ({ width: sequence.settings.width, height: sequence.settings.height }),
    [sequence.settings.width, sequence.settings.height],
  )
  const scale = resolveZoom(zoom, frame, stageSize)

  const fit = useCallback(() => {
    panRef.current = { x: 0, y: 0 }
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }, [])

  /*
   * Back to Fit whenever the frame changes shape.
   *
   * A sequence switched from landscape to portrait at 400% would otherwise
   * keep the old scale and the old offset, and the picture would be somewhere
   * off the side of the panel — looking exactly like the viewer had gone
   * blank. Keyed on the size rather than the sequence id so that changing a
   * sequence's resolution in its settings does the same.
   */
  useEffect(() => {
    fit()
  }, [frame.width, frame.height, fit])

  /** Kept in refs so the commands below do not re-register on every wheel tick. */
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const panRef = useRef(pan)
  panRef.current = pan

  /**
   * Moves the zoom by one level and *writes the refs back itself*.
   *
   * The refs are refreshed during render, so without this a second call made
   * before React had re-rendered would read the scale from before the first
   * and compute the same step again — two zoom-ins in quick succession landed
   * on one level, which is exactly what holding a zoom key does. Updating them
   * here makes each call see the one before it; the next render then assigns
   * the same values over the top.
   */
  const applyZoom = useCallback((next: number, pointer: Point) => {
    const from = scaleRef.current
    if (!(from > 0) || next === from) return
    const panned = zoomToward(pointer, panRef.current, from, next)
    scaleRef.current = next
    panRef.current = panned
    setZoom(next)
    setPan(panned)
  }, [])

  const zoomBy = useCallback(
    // Around the centre, because a command has no cursor to zoom towards.
    (direction: 1 | -1) => applyZoom(stepZoom(scaleRef.current, direction), { x: 0, y: 0 }),
    [applyZoom],
  )

  /**
   * Wheel to zoom, towards the cursor.
   *
   * A native listener with `passive: false` rather than React's `onWheel`:
   * React attaches wheel at the root as a *passive* listener, so
   * `preventDefault` from a synthetic handler does nothing and the panel
   * scrolls underneath the zoom.
   */
  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0) return
      event.preventDefault()
      const from = scaleRef.current
      if (!(from > 0)) return
      // Exponential so each notch is the same proportional step, and a
      // trackpad's many small deltas add up to the same place as one notch.
      const factor = Math.exp(-event.deltaY * 0.0015)
      const to = Math.min(
        ZOOM_LEVELS[ZOOM_LEVELS.length - 1],
        Math.max(ZOOM_LEVELS[0], from * factor),
      )
      if (to === from) return
      applyZoom(to, {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  /**
   * The middle button drags the picture around.
   *
   * Middle rather than left, so dragging never competes with whatever a click
   * in the viewer comes to mean later. `preventDefault` on the way down is
   * what stops Chromium opening its autoscroll ring, which otherwise appears
   * and eats the drag.
   */
  const beginPan = useCallback((event: React.PointerEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY }
    const from = panRef.current
    const onMove = (move: PointerEvent) => {
      const next = { x: from.x + (move.clientX - origin.x), y: from.y + (move.clientY - origin.y) }
      panRef.current = next
      setPan(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // ── how many pixels are worth compositing ─────────────────────

  const prefs = view.viewer ?? {
    playbackResolution: DEFAULT_PLAYBACK_RESOLUTION,
    pausedResolution: DEFAULT_PAUSED_RESOLUTION,
  }
  /**
   * The lever Premiere calls Playback Resolution, split in two as Premiere
   * splits it: running and stopped are different jobs. Dropping frames while
   * playing is a cost you choose; a soft picture on the frame you have stopped
   * on to judge focus is not.
   */
  const resolution = playing ? prefs.playbackResolution : prefs.pausedResolution
  const pixels = useMemo(() => framePixels(frame, resolution), [frame, resolution])

  const duration = sequenceDuration()
  const layers = useMemo(() => layersAt(sequence, time), [sequence, time])
  /** Identity of the stack, so effects fire when it changes and not every tick. */
  const stack = layers.map((layer) => layer.id).join('|')
  /**
   * Where each layer sits, which is a different question from which layers
   * there are.
   *
   * The drawing depends on both — a clip's start and its in point are what turn
   * the playhead into a moment in a file — while the decoders depend only on
   * the identities. Keeping them apart means an edit to a clip already on
   * screen redraws it without tearing down and restarting its decoder.
   *
   * This was one identity until trimming arrived, and the drawing was reading
   * placement out of a closure the stack alone decided when to renew: trim the
   * head of the clip under the playhead and the picture went on showing the
   * frames from before the trim, because the ids had not changed.
   */
  const placement = layers
    .map(
      (layer) =>
        // The effects belong in here for the same reason the trim does: they
        // change what is drawn without changing which clips are drawn, and
        // this string is what decides whether the drawing is renewed. Left
        // out, moving Scale changed the document and nothing on screen — the
        // panel worked, the picture did not, and the two disagreed silently.
        `${layer.id}@${layer.start}+${layer.offset}x${layer.speed}` +
        `:${JSON.stringify(layer.effects?.transform ?? null)}`,
    )
    .join('|')
  const clip = layers.at(-1) ?? null
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  const asset = clip ? assetById.get(clip.assetId) : undefined
  const playable = asset && !asset.missing && !asset.unreadable ? asset : undefined

  // ── the pipeline, when the file allows it ─────────────────────

  /**
   * One source per layer, kept across changes to the stack.
   *
   * Reopening every layer when any one of them changes would tear down and
   * restart decoders that had not moved — and restarting a decoder means
   * finding a keyframe and running up to the playhead again, which is the one
   * genuinely expensive thing in the pipeline. So the map is reconciled: open
   * what is new, close what has gone, leave the rest alone.
   */
  const sourcesRef = useRef(new Map<string, VideoSource>())
  const [ready, setReady] = useState(0)
  const [why, setWhy] = useState<string | null>(null)

  /** True when every layer can be drawn by the pipeline. */
  const decoding = layers.length > 0 && layers.every((layer) => sourcesRef.current.has(layer.id))

  /*
   * What sound this clip's file has, if any.
   *
   * A file with no audio track lands on the timeline as a picture and nothing
   * else — correctly, since there is no sound to put on an audio track. But the
   * absence of something is a poor way to say so: dropping a silent file looks
   * exactly like dropping one whose audio failed to arrive, and the only
   * difference is a thing that is not there.
   *
   * So the Viewer says it. This is the panel already reporting what it knows
   * about the clip under the playhead, and "none" is the answer that was
   * missing.
   */
  const [sound, setSound] = useState<AudioInfo | null | undefined>(undefined)
  useEffect(() => {
    setSound(undefined)
    if (!playable || playable.kind !== 'video') return
    let live = true
    void audioInfoFor(playable.path).then((info) => {
      if (live) setSound(info)
    })
    return () => {
      live = false
    }
  }, [playable?.id, playable?.path])

  useEffect(() => {
    let live = true
    const held = sourcesRef.current
    const wanted = new Set(layers.map((layer) => layer.id))

    for (const [id, source] of held) {
      if (!wanted.has(id)) {
        source.close()
        held.delete(id)
      }
    }

    void Promise.all(
      layers.map(async (layer) => {
        if (held.has(layer.id)) return
        const file = assetById.get(layer.assetId)
        if (!file || file.missing || file.unreadable || file.kind !== 'video') return
        const result = await VideoSource.open(file.path)
        if (!live || !result.ok) {
          if (result.ok) result.source.close()
          // Not an error to put in front of the user — the element path will
          // show the file. Kept for the toolbar, which says which path is in
          // use and why.
          if (!result.ok) setWhy(result.reason)
          return
        }
        held.set(layer.id, result.source)
      }),
    ).then(() => {
      if (live) setReady((n) => n + 1)
    })

    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack, assetById])

  // Everything goes when the panel does; the reconcile above only closes what
  // has left the stack.
  useEffect(() => {
    const held = sourcesRef.current
    return () => {
      for (const source of held.values()) source.close()
      held.clear()
    }
  }, [])

  /**
   * Draws the stack, bottom layer first.
   *
   * Reads the clock itself rather than taking `time` as a dependency, and skips
   * a draw while one is in flight. A decode that has not finished must not
   * queue another behind it — at sixty notifications a second that is how a
   * scrub turns into a backlog of stale frames arriving in the wrong order.
   *
   * Every layer is asked for its frame before anything is drawn. Drawing each
   * one as it arrives would show the composite half-built, and a layer that
   * decoded slowly would flicker in and out from one notification to the next.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || layers.length === 0) return

    let stopped = false
    let drawing = false
    /*
     * The *preview* size, not the sequence's.
     *
     * Every coordinate below is in this space, which is the whole trick: at a
     * quarter resolution each layer is scaled into a canvas a sixteenth of the
     * area, so the per-frame cost of compositing and of handing the result to
     * the compositor falls with it. The element is still laid out at the
     * frame's full size, so the browser scales it back up on the way to the
     * screen and the picture only looks softer.
     */
    const { width, height } = pixels

    const draw = async () => {
      if (stopped || drawing) return
      drawing = true
      try {
        const now = getTime()
        const frames = await Promise.all(
          layers.map((layer) => {
            const source = sourcesRef.current.get(layer.id)
            // Sequence time to source time: how far into the clip the
            // playhead is, at the rate the clip runs, from where it was cut.
            return source
              ? source.frameFor(layer.offset + (now - layer.start) * layer.speed)
              : Promise.resolve(null)
          }),
        )
        if (stopped) return

        /*
         * A source that has given up is let go of.
         *
         * VideoSource rebuilds its own decoder when one dies, so reaching here
         * means it has failed and spent every attempt. Keeping it would mean
         * the pipeline drawing black for the rest of the session while the
         * element sitting behind it — the fallback that exists for precisely
         * this — is never used, because `decoding` only asks whether a source
         * exists. Dropping it answers that question honestly.
         *
         * Not reopened. A fresh source would have a fresh budget and fail the
         * same three times, which is a loop rather than a recovery.
         */
        const lost = layers.filter((layer) => sourcesRef.current.get(layer.id)?.broken)
        if (lost.length > 0) {
          for (const layer of lost) {
            sourcesRef.current.get(layer.id)?.close()
            sourcesRef.current.delete(layer.id)
          }
          setWhy('decode-failed')
          // Re-renders, which is what makes `decoding` false and puts the
          // element on screen.
          setReady((n) => n + 1)
          return
        }

        const context = canvas.getContext('2d')
        if (!context) return
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        // Cleared, not painted over: a layer that has gone must leave, and the
        // frame behind the bottom one is the sequence's own black.
        context.clearRect(0, 0, width, height)
        context.fillStyle = '#000'
        context.fillRect(0, 0, width, height)

        let drawn = 0
        let front: VideoFrame | null = null
        for (const [index, frame] of frames.entries()) {
          if (!frame) continue
          // Per layer, because a stack can mix a vertical phone clip with a
          // landscape camera one and each has to be put up on its own terms.
          const rotation = sourcesRef.current.get(layers[index].id)?.info.rotation ?? 0
          drawClip(context, frame, width, height, rotation, layers[index].effects?.transform)
          drawn += 1
          front = frame
        }

        // What is *actually* on screen, for anything that needs to check. The
        // front layer's moment, since that is the one being looked at.
        if (front) canvas.dataset.frameTime = ((front.timestamp ?? 0) / 1e6).toFixed(3)
        canvas.dataset.layers = String(drawn)
      } finally {
        drawing = false
      }
    }

    void draw()
    const unsubscribe = subscribePlayback(() => void draw())
    return () => {
      stopped = true
      unsubscribe()
    }
    // `ready` is here so the first draw happens once the sources are open,
    // `placement` so an edit to a clip already on screen is drawn, and
    // `pixels` so switching resolution — including the switch that happens on
    // every play and pause — resizes the canvas and redraws into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack, placement, ready, pixels])

  // ── the media element: sound, and the clock ───────────────────

  /**
   * Puts the element where the playhead is.
   *
   * Reads the clock rather than the rendered `time`, so it is correct whenever
   * it is called — on a seek, and once more just before play hands it the
   * clock.
   */
  const syncMedia = useCallback(() => {
    const media = mediaRef.current
    if (!media || !clip) return
    if (media.readyState === 0) return
    const target = clip.offset + (getTime() - clip.start) * clip.speed
    if (Math.abs(media.currentTime - target) > SYNC_TOLERANCE) media.currentTime = target
    // seekToken is the dependency that matters: this must fire on a seek, not
    // on the clock advancing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, playable?.id, seekToken])

  useEffect(syncMedia, [syncMedia])

  /*
   * The element is a clock only when it is the thing playing.
   *
   * On the pipeline path there is no element at all any more — the sound comes
   * from the mixer, and so does the time. This registers for the fallback case
   * only, where a file the demuxer will not read is being played by the
   * browser, sound and all. See kernel/playback.ts for who wins when both can
   * answer.
   */
  useEffect(() => {
    if (!clip || !playable || playable.kind !== 'video' || decoding) {
      setClockSource('element', null)
      return
    }
    setClockSource('element', () => {
      const media = mediaRef.current
      if (!media || media.paused || media.readyState < 2) return null
      return clip.start + (media.currentTime - clip.offset) / clip.speed
    })
    return () => setClockSource('element', null)
  }, [clip, playable, decoding])

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    if (playing) {
      /*
       * Put it where the playhead is *before* starting it.
       *
       * The moment it is playing it becomes the clock, and a clock that starts
       * somewhere else drags the sequence there with it. Measured without this:
       * pressing play ran the wall clock forward for the several hundred
       * milliseconds the element took to start, and then the playhead snapped
       * backwards to wherever the element had begun.
       */
      syncMedia()
      // A play() that loses a race with a source change rejects; there is
      // nothing to recover, and the next transport change will call again.
      void media.play().catch(() => {})
    } else {
      media.pause()
    }
  }, [playing, playable?.id, decoding, syncMedia])

  // ── commands ──────────────────────────────────────────────────

  useEffect(() => {
    const handle = commands.registerAll([
      {
        id: 'playback.toggle',
        title: 'Play / Pause',
        category: 'Playback',
        detail: 'Runs the sequence from the playhead',
        enabled: () => sequenceDuration() > 0,
        run: toggle,
      },
      { id: 'playback.play', title: 'Play', category: 'Playback', run: play },
      { id: 'playback.pause', title: 'Pause', category: 'Playback', run: pause },
      { id: 'playback.goToStart', title: 'Go to Start', category: 'Playback', run: goToStart },
      { id: 'playback.goToEnd', title: 'Go to End', category: 'Playback', run: goToEnd },
      /*
       * The arrows, and the arrows with `Shift`.
       *
       * Registered here rather than in the Timeline because they move the
       * transport and nothing else — the Viewer is where the transport's
       * commands live, and a frame step is the smallest one there is.
       *
       * Five for the long step: enough to cross a syllable or a footfall,
       * short enough that what you skipped is still on screen either side.
       */
      {
        id: 'playback.stepForward',
        title: 'Next Frame',
        category: 'Playback',
        detail: 'One frame later',
        run: () => stepFrames(1),
      },
      {
        id: 'playback.stepBack',
        title: 'Previous Frame',
        category: 'Playback',
        detail: 'One frame earlier',
        run: () => stepFrames(-1),
      },
      {
        id: 'playback.jumpForward',
        title: 'Forward Five Frames',
        category: 'Playback',
        detail: 'Shift and an arrow',
        run: () => stepFrames(JUMP_FRAMES),
      },
      {
        id: 'playback.jumpBack',
        title: 'Back Five Frames',
        category: 'Playback',
        detail: 'Shift and an arrow',
        run: () => stepFrames(-JUMP_FRAMES),
      },
      /*
       * The viewer's own navigation, as commands as well as controls.
       *
       * No key bindings offered here: the obvious ones are taken by the tool
       * palette, and silently stealing a letter someone already uses to reach
       * the Razor is a worse trade than one more trip through the palette.
       */
      {
        id: 'viewer.fit',
        title: 'Fit in Viewer',
        category: 'Viewer',
        detail: 'Back to the zoom and position that fits the panel',
        run: fit,
      },
      {
        id: 'viewer.zoomIn',
        title: 'Zoom In',
        category: 'Viewer',
        detail: 'The next level up, around the centre',
        run: () => zoomBy(1),
      },
      {
        id: 'viewer.zoomOut',
        title: 'Zoom Out',
        category: 'Viewer',
        detail: 'The next level down, around the centre',
        run: () => zoomBy(-1),
      },
    ])
    return () => handle.dispose()
  }, [fit, zoomBy])

  // ── scrubbing ─────────────────────────────────────────────────

  const barRef = useRef<HTMLDivElement>(null)
  const scrubTo = useCallback(
    (clientX: number) => {
      const bar = barRef.current
      if (!bar || duration <= 0) return
      const rect = bar.getBoundingClientRect()
      seek(((clientX - rect.left) / rect.width) * duration)
    },
    [duration],
  )

  const beginScrub = useCallback(
    (event: React.PointerEvent) => {
      if (duration <= 0) return
      event.preventDefault()
      // The same as the timeline ruler: a scrub takes the playhead, so the
      // clock has to let go of it.
      pause()
      scrubTo(event.clientX)
      const onMove = (move: PointerEvent) => scrubTo(move.clientX)
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [duration, scrubTo],
  )

  const progress = duration > 0 ? Math.min(1, time / duration) : 0
  const url = playable ? assetUrl(playable.path) : undefined

  /**
   * Whether there is a frame to put on screen at all.
   *
   * Content, not merely an open sequence: a sequence exists from the moment a
   * project is created, and showing its empty frame means the viewer's resting
   * state is a black rectangle that never does anything. The frame appears when
   * the sequence has something in it and keeps its shape from then on, gaps
   * included.
   */
  const hasFrame = duration > 0 && frame.width > 0 && frame.height > 0

  /**
   * The menu's levels, plus wherever the wheel has actually landed.
   *
   * A wheel zoom lands between levels far more often than on one, and a select
   * whose value matches no option renders blank — so the panel would show an
   * empty box exactly when someone had just zoomed. The odd value joins the
   * list for as long as it is in force.
   */
  const zoomOptions = useMemo(() => {
    const levels: number[] = [...ZOOM_LEVELS]
    if (zoom !== 'fit' && !levels.some((level) => Math.abs(level - zoom) < 1e-9)) {
      levels.push(zoom)
      levels.sort((a, b) => a - b)
    }
    return levels
  }, [zoom])

  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Scope</span>
          <span className="tool-value">{sequence.name}</span>
          <span className="tool-sep" />
          {/* The shape being worked in, named. A sequence's resolution is the
              one setting that changes what the whole panel looks like, and it
              was readable nowhere. */}
          <span className="tool-label">Frame</span>
          <span className="tool-value tool-value--dim" title={`${frame.width}×${frame.height}`}>
            {aspectLabel(frame.width, frame.height)}
          </span>
          <span className="tool-sep" />
          <span className="tool-label">Source</span>
          <span className="tool-value tool-value--dim">
            {playable ? playable.name : clip ? 'offline' : 'none'}
          </span>
          {playable?.kind === 'video' && (
            <>
              <span className="tool-sep" />
              <span className="tool-label">Sound</span>
              <span
                className="tool-value tool-value--dim"
                title={
                  sound === undefined
                    ? 'Reading the file'
                    : sound
                      ? 'Played by the mixer, from its own audio clip on the timeline'
                      : 'This file has no audio track, so it lands on the timeline as picture only'
                }
              >
                {sound === undefined
                  ? '…'
                  : sound
                    ? `${sound.channels}ch ${Math.round(sound.sampleRate / 100) / 10}k`
                    : 'none'}
              </span>
              <span className="tool-sep" />
              <span className="tool-label">Decode</span>
              <span
                className="tool-value tool-value--dim"
                title={
                  decoding
                    ? 'Demuxed here and decoded through WebCodecs'
                    : `Played by the browser: ${why ?? 'opening'}`
                }
              >
                {decoding ? 'pipeline' : 'element'}
              </span>
            </>
          )}
        </>
      }
    >
      {/*
        The stage is always here — it is what the wheel and the middle button
        are listened to on, and what gets measured for Fit. The *frame* is not:
        an empty sequence has no shape to show, and a black 16:9 box standing
        in for one is a lie about what you are working on, which was the whole
        complaint. Nothing to show, nothing drawn.
      */}
      <div
        className="viewer-stage"
        ref={stageRef}
        onPointerDown={beginPan}
        onAuxClick={(event) => event.preventDefault()}
      >
        {hasFrame && (
        <div
          className="viewer-frame"
          style={{
            width: `${Math.round(frame.width * scale)}px`,
            height: `${Math.round(frame.height * scale)}px`,
            transform: `translate(calc(-50% + ${Math.round(pan.x)}px), calc(-50% + ${Math.round(pan.y)}px))`,
          }}
          data-aspect={aspectLabel(frame.width, frame.height)}
        >
          <div className="viewer-frame-inner">
            {playable && clip ? (
              playable.kind === 'image' ? (
                <img className="viewer-media" src={url} alt={playable.name} />
              ) : (
                <>
                  {/* The stack is composited here.

                      Deliberately not keyed on the clip in front. The canvas
                      is the *sequence's* frame now, not one clip's picture, so
                      remounting it whenever the front layer changed would
                      throw away the surface every layer draws into — and hand
                      whatever was holding it a detached node still showing the
                      last composite. */}
                  <canvas
                    ref={canvasRef}
                    className="viewer-media"
                    style={{ display: decoding ? 'block' : 'none' }}
                  />
                  {/* Nothing but the canvas on the pipeline path: the sound
                      is the mixer's, and a second copy of it here would play
                      the same audio twice, a beat apart. */}
                  {decoding ? null : (
                    <video
                      key={`video-${playable.id}`}
                      ref={mediaRef as React.RefObject<HTMLVideoElement>}
                      className="viewer-media"
                      src={url}
                      preload="auto"
                      playsInline
                      onLoadedMetadata={syncMedia}
                    />
                  )}
                </>
              )
            ) : (
              /* Only an actual problem gets words. A gap between clips is
                 black, the way a gap is black everywhere else — saying "no
                 clip at the playhead" over it is narrating the obvious. */
              clip && <span className="viewer-placeholder">media offline</span>
            )}
          </div>
        </div>
        )}
      </div>

      <div className="viewer-transport">
        <button
          className="transport-button"
          onClick={toggle}
          disabled={duration <= 0}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="tc">{formatTimecode(time, sequence.settings.frameRate)}</span>
        <div
          className="transport-bar"
          ref={barRef}
          onPointerDown={beginScrub}
          role="slider"
          aria-label="Playhead"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000)}
          aria-valuenow={Math.round(time * 1000)}
          tabIndex={0}
        >
          <div className="transport-progress" style={{ width: `${progress * 100}%` }} />
          <div className="transport-playhead" style={{ left: `${progress * 100}%` }} />
        </div>
        <span className="tc tc--dim">{formatTimecode(duration, sequence.settings.frameRate)}</span>
      </div>

      <div className="viewer-controls">
        <button
          className="viewer-chip"
          onClick={fit}
          disabled={!hasFrame}
          title="Fit the frame to the panel, and put it back in the middle"
        >
          Fit
        </button>
        <select
          className="viewer-select"
          value={zoom === 'fit' ? 'fit' : String(zoom)}
          disabled={!hasFrame}
          title="Zoom"
          aria-label="Zoom level"
          onChange={(event) => {
            const value = event.target.value
            if (value === 'fit') return fit()
            applyZoom(Number(value), { x: 0, y: 0 })
          }}
        >
          <option value="fit">Fit</option>
          {zoomOptions.map((level) => (
            <option key={level} value={String(level)}>
              {Math.round(level * 100)}%
            </option>
          ))}
        </select>

        <span className="viewer-controls-gap" />

        {/* Two menus rather than one, because stopped and running are
            different jobs — see `resolution` above. */}
        <span className="tool-label">Playback</span>
        <select
          className="viewer-select"
          value={String(prefs.playbackResolution)}
          title="How much of the sequence's resolution to composite while playing"
          aria-label="Playback resolution"
          onChange={(event) =>
            recordView({ viewer: { ...prefs, playbackResolution: Number(event.target.value) } })
          }
        >
          {RESOLUTIONS.map((option) => (
            <option key={option.label} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>

        <span className="tool-label">Paused</span>
        <select
          className="viewer-select"
          value={String(prefs.pausedResolution)}
          title="How much of the sequence's resolution to composite when stopped on a frame"
          aria-label="Paused resolution"
          onChange={(event) =>
            recordView({ viewer: { ...prefs, pausedResolution: Number(event.target.value) } })
          }
        >
          {RESOLUTIONS.map((option) => (
            <option key={option.label} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </PanelFrame>
  )
}
