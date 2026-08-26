import { PanelFrame, Scaffold } from './PanelFrame'

/** Files — the media browser / project bin. */

const ITEMS = [
  { name: 'clipA.mp4', meta: '3840×2160 · 24p', kind: 'video' },
  { name: 'clipB.mp4', meta: '3840×2160 · 24p', kind: 'video' },
  { name: 'music.wav', meta: '48 kHz · stereo', kind: 'audio' },
  { name: 'logo.png', meta: '1024×1024', kind: 'image' },
]

export function FilesPanel() {
  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-label">Project</span>
          <span className="tool-value">untitled</span>
        </>
      }
    >
      <ul className="file-list">
        {ITEMS.map((item) => (
          <li className="file-row" key={item.name}>
            <i className={`file-swatch file-swatch--${item.kind}`} />
            <div className="file-text">
              <span className="file-name">{item.name}</span>
              <span className="file-meta">{item.meta}</span>
            </div>
          </li>
        ))}
      </ul>
      <Scaffold note="Static sample bin — import is not wired yet." />
    </PanelFrame>
  )
}
