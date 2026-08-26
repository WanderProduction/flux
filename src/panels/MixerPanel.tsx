import { PanelFrame, Scaffold } from './PanelFrame'

/**
 * Mixer — the DAW surface.
 *
 * The channel here that matters is "SFX bus": VISION.md's sharpest audio
 * complaint is that Premiere can't group unique clips from *different tracks*
 * into one mixer channel. So a bus in FLUX is a first-class node fed by any set
 * of clips regardless of track or time — not a per-track strip.
 */

const CHANNELS = [
  { name: 'clipA', level: 62, kind: 'clip' },
  { name: 'music', level: 74, kind: 'clip' },
  { name: 'SFX bus', level: 55, kind: 'bus' },
  { name: 'Master', level: 80, kind: 'master' },
]

export function MixerPanel() {
  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-label">Buses</span>
          <span className="tool-value">4</span>
        </>
      }
    >
      <div className="mixer">
        {CHANNELS.map((ch) => (
          <div className={`strip strip--${ch.kind}`} key={ch.name}>
            <div className="strip-meter">
              <div className="strip-meter-fill" style={{ height: `${ch.level}%` }} />
            </div>
            <div className="strip-fader">
              <div className="strip-fader-cap" style={{ bottom: `calc(${ch.level}% - 4px)` }} />
            </div>
            <span className="strip-name">{ch.name}</span>
          </div>
        ))}
      </div>
      <Scaffold note="Static strips — no audio graph yet." />
    </PanelFrame>
  )
}
