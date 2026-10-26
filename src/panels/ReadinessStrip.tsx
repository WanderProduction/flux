import { useEffect, useState } from 'react'

import { readySpans, subscribeReadiness, sweepReadiness, type ReadySpan } from '../kernel/readiness'

/**
 * The strip's height, in pixels.
 *
 * Exported because the timeline lays itself out from it — the marquee measures
 * down from the top of the content, and a strip the panel did not know the
 * height of would offset every sweep by four pixels.
 *
 * Thin on purpose. This is a status line, not a track: it has to be readable at
 * a glance and must never look like something that can be edited.
 */
export const READINESS_HEIGHT = 4

/**
 * How ready each stretch of the timeline is, as a coloured line over the ticks.
 *
 * Answers the question an editor has after dropping a hundred clips in and
 * before pressing play: which of this will run now, which is still being worked
 * on, and which is broken. See kernel/readiness for what the five states mean
 * and why `baked` and `ready` are not the same.
 *
 * Draws only what is on screen. The window comes from the panel rather than
 * being worked out here, so the strip and the clips under it are always
 * virtualised to the same stretch of time — two different answers to "what is
 * visible" is how a strip ends up a few clips out of step with the timeline it
 * is describing.
 */
export function ReadinessStrip({
  zoom,
  onScreen,
}: {
  zoom: number
  onScreen: { from: number; to: number } | null
}) {
  const [spans, setSpans] = useState<ReadySpan[]>(readySpans)

  useEffect(() => {
    const stop = subscribeReadiness(() => setSpans(readySpans()))
    // The timeline may already have been filled before this mounted — a panel
    // opened later, or a project reopened — in which case no event is coming
    // and the strip would sit empty until something moved.
    setSpans(readySpans())
    void sweepReadiness()
    return stop
  }, [])

  if (spans.length === 0) return <div className="tl-ready" aria-hidden />

  const drawn = onScreen
    ? spans.filter((span) => span.start < onScreen.to && span.start + span.duration > onScreen.from)
    : spans

  return (
    <div
      className="tl-ready"
      /* A strip of five colours means nothing without being told what they
         are, and a legend would cost more room than the strip. */
      title="Footage readiness: blue saved to disk, green ready now, amber being worked on, red unreadable"
    >
      {drawn.map((span) => (
        <div
          key={span.clipId}
          className={`tl-ready-span tl-ready-${span.state}`}
          style={{ left: span.start * zoom, width: Math.max(1, span.duration * zoom) }}
          title={span.note}
        />
      ))}
    </div>
  )
}
