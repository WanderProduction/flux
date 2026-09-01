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
 * There is no per-clip transform yet: no position, no scale, no opacity, and no
 * blending. A layer covers what is under it wherever it has pixels.
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

/** A frame scaled to fit `width` by `height`, centred, keeping its shape. */
function fitted(frame: { displayWidth: number; displayHeight: number }, width: number, height: number) {
  const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight)
  const w = frame.displayWidth * scale
  const h = frame.displayHeight * scale
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
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

  const duration = sequenceDuration()
  const layers = useMemo(() => layersAt(sequence, time), [sequence, time])
  /** Identity of the stack, so effects fire when it changes and not every tick. */
  const stack = layers.map((layer) => layer.id).join('|')
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
    const { width, height } = sequence

    const draw = async () => {
      if (stopped || drawing) return
      drawing = true
      try {
        const now = getTime()
        const frames = await Promise.all(
          layers.map((layer) => {
            const source = sourcesRef.current.get(layer.id)
            return source ? source.frameFor(now - layer.start) : Promise.resolve(null)
          }),
        )
        if (stopped) return

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
        for (const frame of frames) {
          if (!frame) continue
          const box = fitted(frame, width, height)
          context.drawImage(frame, box.x, box.y, box.w, box.h)
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
    // `ready` is here so the first draw happens once the sources are open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack, ready, sequence.width, sequence.height])

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
    const target = getTime() - clip.start
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
      return clip.start + media.currentTime
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
    ])
    return () => handle.dispose()
  }, [])

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

  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Scope</span>
          <span className="tool-value">{sequence.name}</span>
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
      <div className="viewer-stage">
        <div className="viewer-frame">
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
              <span className="viewer-placeholder">
                {clip ? 'media offline' : duration > 0 ? 'no clip at the playhead' : 'empty sequence'}
              </span>
            )}
          </div>
        </div>
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
        <span className="tc">{formatTimecode(time, sequence.frameRate)}</span>
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
        <span className="tc tc--dim">{formatTimecode(duration, sequence.frameRate)}</span>
      </div>
    </PanelFrame>
  )
}
