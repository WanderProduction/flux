import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import { assetUrl } from '../kernel/fsBridge'
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
 * This is a *player*, not a renderer: it shows the source under the playhead
 * directly. There is no compositor yet, so there is nothing to composite; when
 * the engine lands this element becomes the surface it draws into and the clip
 * lookup below moves into the graph.
 *
 * While the element is playing it *is* the clock — it hands kernel/playback.ts
 * its own position and the sequence follows, for the reasons set out at the top
 * of that file. The element is therefore moved in exactly one circumstance: a
 * deliberate seek, which the transport announces with a token. Moving it
 * because the time changed would mean moving it because it moved, which is a
 * decoder flush on every animation frame.
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
 * Topmost track wins: tracks are stored in the order they are drawn, V2 above
 * V1, so the first match down the list is the one covering the others.
 */
export function clipAt(sequence: SequenceState, time: number): Clip | null {
  for (const track of sequence.tracks) {
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
  const videoRef = useRef<HTMLVideoElement>(null)

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

  // ── the element, the clock, and the one thing that moves it ───

  /**
   * Puts the element where the playhead is.
   *
   * Called on a deliberate seek and when the source changes, and at no other
   * time — see the note at the top of this file.
   */
  const syncVideo = useCallback(() => {
    const video = videoRef.current
    if (!video || !clip) return
    // readyState 0 means nothing is loaded yet and the assignment would be
    // dropped; onLoadedMetadata calls back here once it can land.
    if (video.readyState === 0) return
    const target = time - clip.start
    if (Math.abs(video.currentTime - target) > SYNC_TOLERANCE) video.currentTime = target
    // `time` is read but deliberately not a dependency: this must fire on a
    // seek, not on the clock advancing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, playable?.id, seekToken])

  useEffect(syncVideo, [syncVideo])

  /**
   * Hands the clock to the element while it is playing this clip.
   *
   * `clip.start + currentTime` converts the source's own timeline into the
   * sequence's. Null while paused, stalled or unloaded, which lets the wall
   * clock cover the gap rather than freezing the playhead on a buffering
   * stream — and means a stall stops the sequence exactly where the picture
   * stopped, instead of the time running on without it.
   */
  useEffect(() => {
    if (!clip || !playable || playable.kind !== 'video') {
      setClockSource(null)
      return
    }
    setClockSource(() => {
      const video = videoRef.current
      if (!video || video.paused || video.readyState < 2) return null
      return clip.start + video.currentTime
    })
    return () => setClockSource(null)
  }, [clip, playable])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      // A play() that loses a race with a source change rejects; there is
      // nothing to recover, and the next transport change will call again.
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [playing, playable?.id])

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
      {
        id: 'playback.goToStart',
        title: 'Go to Start',
        category: 'Playback',
        run: goToStart,
      },
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
        </>
      }
    >
      <div className="viewer-stage">
        <div className="viewer-frame">
          <div className="viewer-frame-inner">
            {playable && clip ? (
              playable.kind === 'video' ? (
                <video
                  // Keyed by asset: a different source needs a fresh element,
                  // and reusing one mid-play leaves the old frame on screen
                  // while the new file loads.
                  key={playable.id}
                  ref={videoRef}
                  className="viewer-media"
                  src={assetUrl(playable.path)}
                  preload="auto"
                  playsInline
                  onLoadedMetadata={syncVideo}
                  onSeeked={() => {
                    /* nothing to do — the frame is already on screen */
                  }}
                />
              ) : (
                <img className="viewer-media" src={assetUrl(playable.path)} alt={playable.name} />
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
