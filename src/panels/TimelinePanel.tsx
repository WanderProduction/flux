import { PanelFrame } from './PanelFrame'

/**
 * Timeline — the time-occupying subset of the current scope's graph.
 *
 * Per docs/INTERACTION-MODEL.md this is a *lens*, not a separate document: the
 * clips drawn here are the same nodes the Node Map shows. Ambient nodes (an LFO,
 * a driver) own no time and so never appear here — that asymmetry is the whole
 * point and is why this panel can't just render "the graph".
 */

const TRACKS = [
  { id: 'V2', kind: 'video', clips: [{ label: 'title', start: 22, width: 18 }] },
  {
    id: 'V1',
    kind: 'video',
    clips: [
      { label: 'clipA', start: 2, width: 34 },
      { label: 'clipB', start: 38, width: 26 },
    ],
  },
  { id: 'A1', kind: 'audio', clips: [{ label: 'music.wav', start: 2, width: 62 }] },
]

export function TimelinePanel() {
  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Sequence 1</span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--dim">24 fps</span>
        </>
      }
    >
      <div className="timeline">
        <div className="timeline-ruler">
          <div className="timeline-gutter" />
          <div className="timeline-ticks">
            {Array.from({ length: 11 }, (_, i) => (
              <div className="tick" key={i}>
                <span>{`${i}s`}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="timeline-tracks">
          {TRACKS.map((track) => (
            <div className="track" key={track.id}>
              <div className="track-head">
                <span className="track-name">{track.id}</span>
              </div>
              <div className="track-lane">
                {track.clips.map((clip) => (
                  <div
                    key={clip.label}
                    className={`clip clip--${track.kind}`}
                    style={{ left: `${clip.start}%`, width: `${clip.width}%` }}
                  >
                    <span>{clip.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="timeline-playhead" style={{ left: 'calc(76px + 2%)' }} />
      </div>
    </PanelFrame>
  )
}
