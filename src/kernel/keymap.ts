/**
 * Key bindings: chord string -> command id.
 *
 * Deliberately a plain data map rather than listeners scattered across
 * components. Remapping is then just editing data, which is what "smart,
 * remappable hotkeys" in VISION.md has to mean, and it lets the palette show
 * the current binding for any command without asking the component that owns it.
 */

import { commands } from './commands'

export type Keymap = Record<string, string> // chord -> command id

export const defaultKeymap: Keymap = {
  'ctrl+k': 'palette.open',
  'ctrl+shift+p': 'palette.open',
  '1': 'workspace.switch.edit',
  'ctrl+1': 'panel.focus.viewer',
  'ctrl+2': 'panel.focus.timeline',
  'ctrl+3': 'panel.focus.content',
  'ctrl+s': 'project.save',
  'ctrl+alt+s': 'workspace.save',
  'ctrl+shift+r': 'workspace.reset',
  delete: 'timeline.deleteSelected',
  // Ctrl and the transport key: the picture and its sound are one thing to the
  // hand until this says otherwise.
  'ctrl+space': 'timeline.toggleLink',
  'ctrl+c': 'timeline.copy',
  'ctrl+v': 'timeline.paste',
  // Snapping is a mode, not a held key: `Alt` is spoken for by duplicate-drag,
  // and every NLE settled on the same answer.
  s: 'timeline.toggleSnapping',
  // The transport. Space is the one key in a media app that is spoken for
  // before anything else is designed.
  space: 'playback.toggle',
  home: 'playback.goToStart',
  end: 'playback.goToEnd',
}

/** Normalise a KeyboardEvent into a stable chord string like `ctrl+shift+p`. */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl') // treat cmd as ctrl for now
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  let key = e.key.toLowerCase()
  if (key === ' ') key = 'space'
  if (key === 'escape') key = 'esc'

  // Modifier-only presses are not chords.
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return ''

  parts.push(key)
  return parts.join('+')
}

/** Pretty-print a chord for display: `ctrl+k` -> `Ctrl K`. */
export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join(' ')
}

/**
 * Typing must never trigger commands. Without this, pressing "1" while naming a
 * workspace would silently switch workspaces instead of typing a 1.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export interface KeymapController {
  attach: () => () => void
  lookup: (commandId: string) => string | undefined
  setKeymap: (next: Keymap) => void
}

export function createKeymapController(initial: Keymap = defaultKeymap): KeymapController {
  let keymap: Keymap = { ...initial }

  const onKeyDown = (e: KeyboardEvent) => {
    const chord = chordOf(e)
    if (!chord) return

    // Bare keys (no modifier) are suppressed inside text entry; chords with a
    // modifier still work, so Ctrl+K reaches the palette from a search field.
    const hasModifier = e.ctrlKey || e.metaKey || e.altKey
    if (!hasModifier && isTextEntryTarget(e.target)) return

    const commandId = keymap[chord]
    if (!commandId) return

    const command = commands.get(commandId)
    if (!command || !commands.isEnabled(command)) return

    e.preventDefault()
    void commands.run(commandId)
  }

  return {
    attach() {
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    },
    lookup(commandId) {
      return Object.keys(keymap).find((chord) => keymap[chord] === commandId)
    },
    setKeymap(next) {
      keymap = { ...next }
    },
  }
}
