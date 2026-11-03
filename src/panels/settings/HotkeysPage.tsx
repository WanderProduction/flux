import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { commands, type CommandInfo } from '../../kernel/commands'
import { CHORD_KEYS, chordOf, formatChord } from '../../kernel/keymap'
import {
  bindChord,
  changedCount,
  chordsFor,
  conflictFor,
  deletePreset,
  exportKeybindings,
  getActivePreset,
  getKeybindings,
  getPresets,
  importKeybindings,
  isDefaultKeymap,
  applyPreset,
  resetAllKeybindings,
  resetCommand,
  savePreset,
  subscribeKeybindings,
  unbindChord,
} from '../../kernel/keybindings'

/**
 * Hotkeys & Presets — the first settings page that changes anything.
 *
 * It is first for the reason docs/SETTINGS.md gives: the data model was
 * already right. Bindings have been a plain chord-to-command map since the
 * first week, so this page is a view over that map rather than a rewrite of
 * anything, and the whole of "make hotkeys editable" turned out to be a store
 * to keep them in and a way to capture a chord.
 *
 * ## Capturing a chord is the only hard part
 *
 * And it is hard for one reason: the app is listening for the same keys. Press
 * `Ctrl M` to rebind something and FLUX would send the sequence to render
 * while you were still choosing. So capture installs its own listener in the
 * **capture phase** on `window`, which runs before the keymap's own
 * bubble-phase listener, and calls `preventDefault`. The controller checks
 * `defaultPrevented` and steps aside — the same mechanism the folder tree uses
 * to keep its arrows away from the playhead.
 *
 * It also has to produce chords the keymap can actually hold, which includes
 * the held-key ones: `S` is both a command and a modifier, so eight of the
 * shipped bindings look like `s+arrowup`. So capture keeps its own held set
 * and asks `chordOf` — the same function the controller asks — rather than
 * assembling a chord string itself. A page that could display a binding it
 * could not reproduce would be a page that quietly refuses to edit eight rows.
 *
 * ## A rebind is a swap, and it says so first
 *
 * One chord runs one command, so taking a chord takes it from whoever had it.
 * That is the right behaviour and the wrong thing to do silently, so a
 * conflict stops and names the command about to lose its key. See
 * `conflictFor` in kernel/keybindings.ts.
 */
export function HotkeysPage() {
  /*
   * One counter for "something changed underneath this page".
   *
   * Bindings and the command registry are both module state read during
   * render, so React has no reason to re-run anything when either moves. The
   * memo below depends on this counter for that reason — without it, filtering
   * by key would keep showing the chords a rebind had already replaced.
   */
  const [tick, bump] = useState(0)
  useEffect(() => subscribeKeybindings(() => bump((n) => n + 1)), [])
  // Commands come and go with panels, so the list has to follow the registry.
  useEffect(() => {
    const handle = commands.subscribe(() => bump((n) => n + 1))
    return () => handle.dispose()
  }, [])

  const [query, setQuery] = useState('')
  /** The command whose chord is being captured, and what has been pressed. */
  const [capturing, setCapturing] = useState<string | null>(null)
  const [pending, setPending] = useState<{ chord: string; holder: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const rows = useMemo(() => {
    /*
     * The catalogue, not `list()`.
     *
     * Most commands belong to panels and are registered when the panel
     * mounts, so `list()` is whatever is open right now — and this page lives
     * in a workspace with no Timeline, Viewer, Content Browser or Render in
     * it. Measured before this: 47 of the 78 commands the shipped keymap binds
     * were listed, so half the app could not be rebound from the page built
     * for rebinding it. See `catalogue` in kernel/commands.ts.
     */
    const all = commands.catalogue()
    const needle = query.trim().toLowerCase()

    const matching = needle
      ? all.filter((command) => {
          const chords = chordsFor(command.id).join(' ')
          return `${command.title} ${command.category} ${command.id} ${chords}`
            .toLowerCase()
            .includes(needle)
        })
      : all

    // Grouped by the same category the palette groups by, so the two read as
    // one list of what the app can do rather than two different inventories.
    const byCategory = new Map<string, CommandInfo[]>()
    for (const command of matching) {
      byCategory.set(command.category, [...(byCategory.get(command.category) ?? []), command])
    }
    return [...byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, list]) => ({
        category,
        list: [...list].sort((a, b) => a.title.localeCompare(b.title)),
      }))
  }, [query, tick])

  // ── capture ──────────────────────────────────────────────────
  const held = useRef(new Set<string>())

  const commit = useCallback((chord: string, commandId: string) => {
    const holder = conflictFor(chord, commandId)
    if (holder) {
      // Stop and ask. The chord is not taken until the next click.
      setPending({ chord, holder })
      return
    }
    bindChord(chord, commandId)
    setCapturing(null)
    setNote(`${formatChord(chord)} now runs ${commands.get(commandId)?.title ?? commandId}`)
  }, [])

  useEffect(() => {
    if (!capturing) {
      held.current.clear()
      return
    }
    const target = capturing

    const onDown = (event: KeyboardEvent) => {
      /*
       * Everything, before anything else sees it. This is the whole reason
       * capture works at all: the keymap's own listener is on `window` in the
       * bubble phase and checks `defaultPrevented`, so stopping the event here
       * means choosing `Ctrl M` does not also start a render.
       */
      event.preventDefault()
      event.stopPropagation()

      const key = event.key.toLowerCase()
      if (key === 'escape') {
        setCapturing(null)
        setPending(null)
        return
      }
      // A modifier on its own is not a chord; keep waiting.
      if (['control', 'meta', 'alt', 'shift'].includes(key)) return

      /*
       * A chord key pressed bare might be the start of `s+arrowup` rather than
       * a chord of its own, exactly as the controller treats it. Held, and the
       * next key decides. With a modifier it cannot be the start of anything,
       * so it commits.
       */
      if (CHORD_KEYS.has(key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        held.current.add(key)
        bump((n) => n + 1)
        return
      }

      const chord = chordOf(event, held.current)
      if (chord) commit(chord, target)
    }

    const onUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      /*
       * A chord key let go without anything pressed after it was a plain
       * press, so it binds on its own — which is what makes `S` bindable at
       * all. The controller reaches the same conclusion the same way.
       */
      if (held.current.delete(key)) {
        event.preventDefault()
        commit(key, target)
      }
    }

    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [capturing, commit])

  const takeIt = useCallback(() => {
    if (!pending || !capturing) return
    const displaced = bindChord(pending.chord, capturing)
    const lost = displaced ? commands.get(displaced)?.title ?? displaced : null
    setNote(
      lost
        ? `${formatChord(pending.chord)} taken from ${lost}, which now has no key`
        : `${formatChord(pending.chord)} bound`,
    )
    setPending(null)
    setCapturing(null)
  }, [pending, capturing])

  const changed = changedCount()
  const presets = getPresets()
  const active = getActivePreset()
  const total = Object.keys(getKeybindings()).length

  return (
    <div className="hk">
      <Presets
        presets={presets}
        active={active}
        onNote={setNote}
      />

      <div className="hk-bar">
        <input
          className="hk-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a command, or a key"
          spellCheck={false}
        />
        <span className="hk-count">
          {total} bindings
          {changed > 0 ? ` · ${changed} changed from the defaults` : ' · all as shipped'}
        </span>
        <button
          className="hk-btn"
          disabled={isDefaultKeymap()}
          onClick={() => {
            resetAllKeybindings()
            setNote('Every binding is back to the shipped set')
          }}
        >
          Reset all
        </button>
      </div>

      {note && (
        <div className="hk-note" role="status">
          {note}
        </div>
      )}

      {capturing && !pending && (
        <div className="hk-capture">
          Press the keys for <strong>{commands.get(capturing)?.title ?? capturing}</strong>
          {held.current.size > 0 && (
            <span className="hk-capture-held">
              holding {[...held.current].map(formatChord).join(' + ')}…
            </span>
          )}
          <span className="hk-capture-hint">Esc to cancel</span>
        </div>
      )}

      {pending && capturing && (
        <div className="hk-conflict">
          <strong>{formatChord(pending.chord)}</strong> already runs{' '}
          <strong>{commands.get(pending.holder)?.title ?? pending.holder}</strong>. Taking it
          leaves that command with no key.
          <button className="hk-btn hk-btn--warn" onClick={takeIt}>
            Take it
          </button>
          <button
            className="hk-btn"
            onClick={() => {
              setPending(null)
              setCapturing(null)
            }}
          >
            Leave it
          </button>
        </div>
      )}

      {rows.length === 0 && <div className="hk-empty">No command matches “{query}”.</div>}

      {rows.map((group) => (
        <section className="hk-group" key={group.category}>
          <h3 className="hk-group-head">{group.category}</h3>
          {group.list.map((command) => {
            const chords = chordsFor(command.id)
            return (
              <div className="hk-row" key={command.id}>
                <div className="hk-row-name">
                  <span className="hk-row-title">
                    {command.title}
                    {/*
                      Said, not hidden. A command whose panel is closed can
                      still be rebound — the keymap is data and the binding
                      works the moment the panel opens — but pressing the key
                      now would do nothing, and a row that looked identical to
                      a live one would make that read as a broken rebind.
                    */}
                    {!commands.get(command.id) && (
                      <span className="hk-row-dormant" title="Its panel is not open, so the key does nothing until it is">
                        panel closed
                      </span>
                    )}
                  </span>
                  <span className="hk-row-id">{command.id}</span>
                </div>
                <div className="hk-row-keys">
                  {chords.map((chord) => (
                    <span className="hk-chord" key={chord}>
                      <kbd>{formatChord(chord)}</kbd>
                      <button
                        className="hk-chord-x"
                        title={`Remove ${formatChord(chord)}`}
                        aria-label={`Remove ${formatChord(chord)} from ${command.title}`}
                        onClick={() => {
                          unbindChord(chord)
                          setNote(`${formatChord(chord)} removed`)
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {chords.length === 0 && <span className="hk-unbound">no key</span>}
                  <button
                    className="hk-btn hk-btn--small"
                    onClick={() => {
                      setNote(null)
                      setPending(null)
                      setCapturing(capturing === command.id ? null : command.id)
                    }}
                  >
                    {capturing === command.id ? 'Listening…' : chords.length ? 'Add' : 'Set'}
                  </button>
                  <button
                    className="hk-btn hk-btn--small"
                    title="Back to the keys this command ships with"
                    onClick={() => {
                      if (resetCommand(command.id)) setNote(`${command.title} back to default`)
                    }}
                  >
                    Default
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/**
 * Named sets, and the clipboard round trip that stands in for a file.
 *
 * Export and import go through the clipboard rather than a file dialog, and
 * that is a deliberate smaller first step: the main process has pickers for
 * *opening* files and nothing for choosing where to save one, so a file export
 * would need a new IPC channel before it could do anything at all. The text is
 * identical either way, so the file version is a second route into
 * `exportKeybindings` rather than a different feature.
 */
function Presets({
  presets,
  active,
  onNote,
}: {
  presets: ReturnType<typeof getPresets>
  active: string | null
  onNote: (note: string) => void
}) {
  const [name, setName] = useState('')

  return (
    <section className="hk-presets">
      <h3 className="hk-group-head">Sets</h3>
      <p className="hk-presets-why">
        A set is the whole map, not a difference from the defaults — so it still means the same
        thing after a release changes one.
      </p>

      <div className="hk-presets-row">
        {presets.length === 0 && <span className="hk-unbound">none saved yet</span>}
        {presets.map((preset) => (
          <span
            className={`hk-preset${preset.id === active ? ' hk-preset--active' : ''}`}
            key={preset.id}
          >
            <button
              className="hk-preset-name"
              title={`Use "${preset.name}"`}
              onClick={() => {
                applyPreset(preset.id)
                onNote(`Using "${preset.name}"`)
              }}
            >
              {preset.name}
            </button>
            <button
              className="hk-chord-x"
              title={`Delete "${preset.name}"`}
              aria-label={`Delete the set "${preset.name}"`}
              onClick={() => {
                deletePreset(preset.id)
                onNote(`Deleted "${preset.name}"`)
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="hk-presets-row">
        <input
          className="hk-search hk-search--narrow"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this set"
          spellCheck={false}
        />
        <button
          className="hk-btn"
          disabled={!name.trim()}
          onClick={() => {
            const saved = savePreset(name)
            if (saved) {
              onNote(`Saved "${saved.name}"`)
              setName('')
            }
          }}
        >
          Save current as
        </button>
        <span className="tool-sep" />
        <button
          className="hk-btn"
          title="Copy the bindings in force, as text you can keep or send"
          onClick={() => {
            void navigator.clipboard
              .writeText(exportKeybindings())
              .then(() => onNote('Bindings copied to the clipboard'))
              .catch(() => onNote('The clipboard refused — nothing was copied'))
          }}
        >
          Copy
        </button>
        <button
          className="hk-btn"
          title="Replace the bindings in force with what is on the clipboard"
          onClick={() => {
            void navigator.clipboard
              .readText()
              .then((text) => {
                const result = importKeybindings(text)
                onNote(
                  result.ok
                    ? `Loaded ${result.bound} bindings from the clipboard`
                    : `Nothing loaded — ${result.reason}`,
                )
              })
              .catch(() => onNote('Could not read the clipboard'))
          }}
        >
          Paste
        </button>
      </div>
    </section>
  )
}
