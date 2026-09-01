import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import { assetUrl } from '../kernel/fsBridge'
import { VideoSource } from '../kernel/media/videoSource'
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
 * **The pipeline.** An mp4 whose index we can read is demuxed, decoded through
 * WebCodecs and drawn to a canvas: see kernel/media/videoSource.ts. We hold the
 * frames, so we know exactly which one is on screen, and the canvas is the
 * surface a compositor will eventually draw into. Sound comes from an `<audio>`
 * element alongside, which is also the clock — see below.
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
 * The clip visible at `time`, or null.
 *
 * Topmost *video* track wins: tracks are stored in the order they are drawn, V2
 * above V1, so the first match down the list is the one covering the others.
 *
 * Audio tracks are skipped, and not merely because a waveform is not a picture.
 * The sound this panel plays comes from the same file as the clip it is
 * showing, so treating an audio clip as the thing to show would put the Viewer
 * on the audio half of a linked pair — the same file, the same moment, and a
 * decode of a video track that nothing asked for. What is missing is a mixer:
 * a sequence whose sound comes from several audio clips at once is a thing FLUX
 * cannot yet play, and pretending otherwise here would hide that.
 */
export function clipAt(sequence: SequenceState, time: number): Clip | null {
  for (const track of sequence.tracks) {
    if (track.kind !== 'video') continue
    const found = sequence.clips.find(
      (clip) =>
        clip.trackId === track.id && time >= clip.start && time < clip.start + clip.duration,
    )
    if (found) return found
  }
  return null
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
  const clip = useMemo(() => clipAt(sequence, time), [sequence, time])
  const asset = clip ? assets.find((a) => a.id === clip.assetId) : undefined
  const playable = asset && !asset.missing && !asset.unreadable ? asset : undefined

  // ── the pipeline, when the file allows it ─────────────────────

  const [source, setSource] = useState<VideoSource | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  /** True when the pipeline is drawing, which is also when the mixer has the sound. */
  const decoding = Boolean(source)

  useEffect(() => {
    setSource(null)
    setWhy(null)
    if (!playable || playable.kind !== 'video') return

    let live = true
    let opened: VideoSource | null = null
    void VideoSource.open(playable.path).then((result) => {
      if (!live) {
        if (result.ok) result.source.close()
        return
      }
      if (result.ok) {
        opened = result.source
        setSource(result.source)
      } else {
        // Not an error to report at the user — the element path will show the
        // file. Kept for the toolbar, which says which path is in use.
        setWhy(result.reason)
      }
    })

    return () => {
      live = false
      opened?.close()
    }
  }, [playable?.id, playable?.path])

  /**
   * Draws whichever frame belongs at the playhead.
   *
   * Reads the clock itself rather than taking `time` as a dependency, and skips
   * a draw while one is in flight. A decode that has not finished must not
   * queue another behind it — at sixty notifications a second that is how a
   * scrub turns into a backlog of stale frames arriving in the wrong order.
   */
  useEffect(() => {
    if (!source || !clip) return
    const canvas = canvasRef.current
    if (!canvas) return

    let stopped = false
    let drawing = false

    const draw = async () => {
      if (stopped || drawing) return
      drawing = true
      try {
        const at = getTime() - clip.start
        const frame = await source.frameFor(at)
        if (stopped || !frame) return
        const context = canvas.getContext('2d')
        if (!context) return
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        context.drawImage(frame, 0, 0, canvas.width, canvas.height)
        // What is *actually* on screen, for anything that needs to check.
        canvas.dataset.frameTime = ((frame.timestamp ?? 0) / 1e6).toFixed(3)
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
  }, [source, clip])

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
  }, [playing, playable?.id, source, syncMedia])

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
                  {/* The pipeline draws here; the element below is then only
                      sound and a clock, and is never seen. */}
                  <canvas
                    key={`canvas-${playable.id}`}
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
