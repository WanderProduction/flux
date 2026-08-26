import { PanelFrame } from './PanelFrame'

/**
 * Node Map — the full graph of the current scope.
 *
 * Shows the superset the Timeline can't: `clipA` and `music.wav` own time and
 * appear in both lenses, while the LFO owns none and lives only here. The violet
 * wire is a *driver* — the shape that makes audio-reactive grading possible.
 */

const NODES = [
  { id: 'clipA', label: 'clipA', kind: 'element', x: 40, y: 40 },
  { id: 'music', label: 'music.wav', kind: 'element', x: 40, y: 130 },
  { id: 'lfo', label: 'LFO', kind: 'driver', x: 40, y: 220 },
  { id: 'curves', label: 'color curves', kind: 'operator', x: 220, y: 40 },
  { id: 'out', label: 'output', kind: 'output', x: 400, y: 95 },
]

const NODE_W = 118
const NODE_H = 34

type Wire = { from: string; to: string; kind: 'signal' | 'driver' }
const WIRES: Wire[] = [
  { from: 'clipA', to: 'curves', kind: 'signal' },
  { from: 'curves', to: 'out', kind: 'signal' },
  { from: 'music', to: 'out', kind: 'signal' },
  { from: 'lfo', to: 'curves', kind: 'driver' },
]

function nodeById(id: string) {
  return NODES.find((n) => n.id === id)!
}

function wirePath(wire: Wire) {
  const a = nodeById(wire.from)
  const b = nodeById(wire.to)
  const x1 = a.x + NODE_W
  const y1 = a.y + NODE_H / 2
  const x2 = b.x
  const y2 = b.y + NODE_H / 2
  const dx = Math.max(36, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export function NodeMapPanel() {
  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Scope</span>
          <span className="tool-value">Sequence 1</span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--dim">5 nodes</span>
        </>
      }
    >
      <div className="nodemap">
        <svg className="nodemap-canvas" viewBox="0 0 560 290" preserveAspectRatio="xMidYMid meet">
          <defs>
            <pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" className="grid-dot" />
            </pattern>
          </defs>
          <rect width="560" height="290" fill="url(#grid)" />

          {WIRES.map((wire) => (
            <path
              key={`${wire.from}-${wire.to}`}
              d={wirePath(wire)}
              className={`wire wire--${wire.kind}`}
            />
          ))}

          {NODES.map((node) => (
            <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx="5"
                className={`node node--${node.kind}`}
              />
              <rect width="3" height={NODE_H} rx="1.5" className={`node-flag node-flag--${node.kind}`} />
              <text x="14" y={NODE_H / 2 + 4} className="node-label">
                {node.label}
              </text>
            </g>
          ))}
        </svg>

        <div className="nodemap-legend">
          <span><i className="dot dot--element" /> element</span>
          <span><i className="dot dot--operator" /> operator</span>
          <span><i className="dot dot--driver" /> driver (no time)</span>
        </div>
      </div>
    </PanelFrame>
  )
}
