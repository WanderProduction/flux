import { useEffect, useState } from 'react'

import { PanelFrame } from './PanelFrame'
import {
  activeTool,
  getTool,
  refusedTool,
  setTool,
  subscribeTool,
  tools,
  type ToolId,
} from '../kernel/tools'
import { formatChord } from '../kernel/keymap'

/**
 * The tool strip: what the pointer is holding.
 *
 * A ruler of tools rather than a menu, because picking one is something you do
 * a hundred times an hour and reading a list is not. The mode itself lives in
 * kernel/tools.ts — this panel shows it and changes it, and closing the panel
 * leaves every tool reachable by key and through the palette.
 *
 * ## Half of these are not built
 *
 * And they say so. The strip is the shape of the thing FLUX is going to be, in
 * the order the work is coming, and a row that only showed the three finished
 * tools would say less. What it must never do is *pretend*: an unbuilt tool is
 * drawn as unavailable, refuses to become the mode when it is picked, and
 * answers with what it will do when it exists. A button that silently does
 * nothing is a bug report waiting to be written.
 */
export function ToolsPanel() {
  const [active, setActive] = useState<ToolId>(activeTool)
  const [refused, setRefused] = useState<ToolId | null>(refusedTool)

  useEffect(
    () =>
      subscribeTool(() => {
        setActive(activeTool())
        setRefused(refusedTool())
      }),
    [],
  )

  const current = getTool(active)
  const denied = refused ? getTool(refused) : null

  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-value tool-value--dim">{current?.name ?? 'Select'}</span>
          <span className="tool-sep" />
          <span className="tool-value tool-value--mono">
            {current ? formatChord(current.key) : ''}
          </span>
        </>
      }
    >
      <div className="tools">
        <div className="tools-strip" role="toolbar" aria-label="Tools">
          {tools.map((tool) => (
            <button
              key={tool.id}
              className={`tool-button${tool.id === active ? ' tool-button--on' : ''}${
                tool.ready ? '' : ' tool-button--later'
              }`}
              data-tool={tool.id}
              title={`${tool.name} (${formatChord(tool.key)}) — ${
                tool.ready ? tool.detail : (tool.coming ?? 'not built yet')
              }`}
              onClick={() => setTool(tool.id)}
            >
              <span className="tool-glyph">{tool.glyph}</span>
              <span className="tool-name">{tool.name}</span>
              <span className="tool-key">{formatChord(tool.key)}</span>
            </button>
          ))}
        </div>

        {/*
          One line, and it is either what the tool in hand does or why the last
          one asked for could not be handed over. Never both, because the second
          is always about something that just happened.
        */}
        <div className={`tools-say${denied ? ' tools-say--refused' : ''}`}>
          {denied
            ? `${denied.name} is not built yet. ${denied.coming ?? ''}`
            : (current?.detail ?? '')}
        </div>
      </div>
    </PanelFrame>
  )
}
