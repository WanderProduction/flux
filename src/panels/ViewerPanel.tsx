import { PanelFrame } from './PanelFrame'

/**
 * Viewer — the rendered output of the current scope at the playhead.
 * Will host the WebGPU surface the engine renders into.
 */
export function ViewerPanel() {
  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Scope</span>
          <span className="tool-value">Sequence 1</span>
          <span className="tool-sep" />
          <span className="tool-label">Quality</span>
          <span className="tool-value">Auto</span>
        </>
      }
    >
      <div className="viewer-stage">
        <div className="viewer-frame">
          <div className="viewer-frame-inner">
            <span className="viewer-placeholder">no output — engine not wired</span>
          </div>
        </div>
      </div>
      <div className="viewer-transport">
        <span className="tc">00:00:00:00</span>
        <div className="transport-bar">
          <div className="transport-playhead" style={{ left: '0%' }} />
        </div>
        <span className="tc tc--dim">00:00:10:00</span>
      </div>
    </PanelFrame>
  )
}
