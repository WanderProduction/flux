import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands } from '../kernel/commands'
import { getAssets, subscribeAssets, type Asset } from '../kernel/assets'
import { assetUrl } from '../kernel/fsBridge'
import {
  formatTimecode,
  getTime,
  goToEnd,
  goToStart,
  isPlaying,
  pause,
  play,
  seek,
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
 * lookup below moves into the graph. What must not change is who owns the time.
 * kernel/playback.ts owns it, this reads it, and the <video> is dragged along
 * behind — never the other way round. A viewer that used the video element as
 * its clock would run on the source's timeline instead of the sequence's, and
 * would have nothing to say at all about a gap between two clips.
 */

/**
 * How far the element may drift before it is pulled back, in seconds.
 *
 * Not zero. Assigning `currentTime` every frame re-seeks the decoder every
 * frame, which stutters far worse than the drift it is correcting. A quarter of
 * a frame at 24fps is under the threshold of noticing and leaves normal
 * playback alone entirely.
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
      }),
    [],
  )

  const duration = sequenceDuration()
  const clip = useMemo(() => clipAt(sequence, time), [sequence, time])
  const asset = clip ? assets.find((a) => a.id === clip.assetId) : undefined
  const playable = asset && !asset.missing && !asset.unreadable ? asset : undefined

  // ── keeping the element in step with the playhead ─────────────

  const syncVideo = useCallback(() => {
    const video = videoRef.current
    if (!video || !clip) return
    // readyState 0 means nothing is loaded yet and the assignment would be
    // dropped; onLoadedMetadata calls back here once it can land.
    if (video.readyState === 0) return
    const target = time - clip.start
    if (Math.abs(video.currentTime - target) > SYNC_TOLERANCE) video.currentTime = target
  }, [clip, time])

  useEffect(syncVideo, [syncVideo])

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
