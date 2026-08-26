import { useEffect, useMemo, useRef, useState } from 'react'
import { commands, type Command } from '../kernel/commands'
import { formatChord } from '../kernel/keymap'

/**
 * The command palette — the single search surface for every action.
 *
 * VISION.md's complaint is concrete: hunting the effects bin by hand costs
 * hours. The answer is that everything registered as a command is findable by
 * typing three letters, so discovery never depends on knowing which menu an
 * action was filed under.
 */

/** Subsequence match: "wsn" finds "Workspace: Nodes". Cheap, and enough. */
function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()

  let hi = 0
  let score = 0
  let streak = 0
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni], hi)
    if (found === -1) return null
    // Reward consecutive hits and hits at word starts — keeps "time" ranking
    // "Timeline" above an incidental match buried mid-word.
    streak = found === hi ? streak + 1 : 0
    const atWordStart = found === 0 || h[found - 1] === ' ' || h[found - 1] === ':'
    score += 10 - Math.min(found - hi, 8) + streak * 2 + (atWordStart ? 5 : 0)
    hi = found + 1
  }
  return score
}

export function CommandPalette({
  open,
  onClose,
  lookupChord,
}: {
  open: boolean
  onClose: () => void
  lookupChord: (commandId: string) => string | undefined
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Re-read the registry each time it opens so late-registered commands (a
  // plugin loaded after boot) are always present.
  const all = useMemo(() => (open ? commands.list() : []), [open])

  const results = useMemo(() => {
    const scored = all
      .map((command) => {
        const label = `${command.category}: ${command.title}`
        return { command, score: fuzzyScore(label, query) }
      })
      .filter((r): r is { command: Command; score: number } => r.score !== null)

    scored.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    return scored.map((r) => r.command)
  }, [all, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      // Focus after paint, otherwise the keystroke that opened the palette can
      // land in the input as a stray character.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  const run = (command: Command | undefined) => {
    if (!command || !commands.isEnabled(command)) return
    onClose()
    void commands.run(command.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[index])
    }
  }

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Run a command…"
          spellCheck={false}
        />
        <ul className="palette-list" ref={listRef}>
          {results.length === 0 && <li className="palette-empty">No matching command</li>}
          {results.map((command, i) => {
            const chord = lookupChord(command.id)
            return (
              <li
                key={command.id}
                data-selected={i === index}
                className="palette-row"
                onMouseMove={() => setIndex(i)}
                onClick={() => run(command)}
              >
                <span className="palette-cat">{command.category}</span>
                <span className="palette-title">{command.title}</span>
                {command.detail && <span className="palette-detail">{command.detail}</span>}
                {chord && <kbd className="palette-kbd">{formatChord(chord)}</kbd>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
