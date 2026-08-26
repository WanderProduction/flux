import { PanelFrame, Scaffold } from './PanelFrame'

/**
 * Inspector — parameters of the current selection.
 *
 * The three parameter states from docs/INTERACTION-MODEL.md are shown here on
 * purpose: `static`, `keyframed`, and `driven`. A driven parameter is the one
 * that has a wire into it, and its driver wins over any keyframes via a combine
 * mode. Making that visible in the Inspector is what stops the Node Map from
 * feeling like a separate application.
 */

const PARAMS = [
  { name: 'Opacity', value: '100%', state: 'static' },
  { name: 'Scale', value: '100%', state: 'static' },
  { name: 'Position', value: '0, 0', state: 'keyframed' },
  { name: 'Lift', value: '← LFO', state: 'driven' },
]

export function InspectorPanel() {
  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-label">Selection</span>
          <span className="tool-value">clipA</span>
        </>
      }
    >
      <div className="param-list">
        {PARAMS.map((param) => (
          <div className="param-row" key={param.name}>
            <span className="param-name">{param.name}</span>
            <span className={`param-value param-value--${param.state}`}>{param.value}</span>
            <span className={`param-state param-state--${param.state}`}>{param.state}</span>
          </div>
        ))}
      </div>
      <Scaffold note="Static sample parameters — nothing is bound to an engine yet." />
    </PanelFrame>
  )
}
