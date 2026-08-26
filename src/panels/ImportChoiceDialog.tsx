import { useEffect, useRef, useState } from 'react'

import type { ImportMode } from '../kernel/importMode'

export interface ImportChoice {
  mode: 'copy' | 'link'
  remember: boolean
}

/**
 * Asks whether an import should be copied into the project or linked in place.
 *
 * Both options are legitimate, so neither is styled as the dangerous one — the
 * text says what each costs and lets the user decide. "Remember" writes the
 * answer to the app preference so this stops appearing once someone knows which
 * way they work.
 */
export function ImportChoiceDialog({
  count,
  onChoose,
  onCancel,
}: {
  count: number
  onChoose: (choice: ImportChoice) => void
  onCancel: () => void
}) {
  const [remember, setRemember] = useState(false)
  const copyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus after paint, so the keystroke that triggered the import cannot land
    // on the button and choose for the user.
    const id = requestAnimationFrame(() => copyRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const choose = (mode: ImportMode & ('copy' | 'link')) => onChoose({ mode, remember })

  return (
    <div
      className="palette-scrim"
      onMouseDown={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">
          Import {count} file{count === 1 ? '' : 's'}
        </h2>

        <div className="dialog-choices">
          <button ref={copyRef} className="choice" onClick={() => choose('copy')}>
            <span className="choice-name">Copy into the project</span>
            <span className="choice-detail">
              Puts a copy in <code>imports</code>. The project folder becomes self-contained and
              safe to move or archive. Uses disk space.
            </span>
          </button>

          <button className="choice" onClick={() => choose('link')}>
            <span className="choice-name">Leave the files where they are</span>
            <span className="choice-detail">
              Points at the originals. Instant and uses no space, but the project breaks if those
              files move.
            </span>
          </button>
        </div>

        <label className="dialog-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Always do this (change it later from the command palette)</span>
        </label>
      </div>
    </div>
  )
}
