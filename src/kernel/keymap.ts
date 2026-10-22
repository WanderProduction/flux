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
  'ctrl+4': 'panel.focus.batch',
  'ctrl+5': 'panel.focus.render',
  '2': 'workspace.switch.export',
  /*
   * Send to render. The key every NLE uses for it — Premiere's Export, Media
   * Encoder's queue — so the muscle memory arrives with the user.
   */
  'ctrl+m': 'render.send',
  /*
   * A new sequence, on the key every app uses for "a new one of the thing this
   * app makes". FLUX makes sequences; a project is made once, from the
   * launcher, and never with a keystroke in the middle of an edit.
   */
  'ctrl+n': 'sequence.new',
  'ctrl+s': 'project.save',
  'ctrl+alt+s': 'workspace.save',
  'ctrl+shift+r': 'workspace.reset',
  /*
   * The marked span. '/' marks exactly what is selected, which is the span
   * someone almost always means — the clips you just picked are the clips you
   * want to render.
   *
   * Mark In and Mark Out are deliberately *not* on I and O, which is where
   * every NLE puts them: I is already the eyedropper, and single letters are
   * the tool strip's. The commands exist and are in the palette, and the ends
   * are draggable on the ruler, so nothing here is unreachable — but if the
   * I/O muscle memory is worth more than a tool that is still a stub, moving
   * the eyedropper is the change to make, and it should be made on purpose.
   */
  '/': 'timeline.markSelection',
  'ctrl+shift+x': 'timeline.clearMarks',
  delete: 'timeline.deleteSelected',
  // Backspace deletes the way Delete does: the clip goes, the hole stays.
  // Ripple is Shift W, and it should stay a decision rather than a near-miss.
  backspace: 'timeline.deleteSelected',
  'ctrl+z': 'timeline.undo',
  'ctrl+shift+z': 'timeline.redo',
  /*
   * The shuttle, on the keys either side of S — the same pair as the cut
   * navigation above them, which is why those took Shift.
   */
  a: 'playback.shuttleBack',
  d: 'playback.shuttleForward',
  // Ctrl and the transport key: the picture and its sound are one thing to the
  // hand until this says otherwise.
  // Ctrl and the key that means "the other one of these": the picture and its
  // sound are one thing to the hand until this says otherwise.
  'ctrl+tab': 'timeline.toggleLink',
  /*
   * Auto-select-on-pause, on the key it was asked for — and on `Alt A` as well.
   *
   * `Alt F4` is Windows' own "close this window", handled by the window manager
   * before a page ever sees it, and preventDefault cannot take it back. It is
   * bound here because it was asked for and it may reach us; the second binding
   * is so the feature is reachable when it does not, and the command is in the
   * palette either way.
   */
  'alt+f4': 'timeline.toggleAutoSelect',
  'alt+a': 'timeline.toggleAutoSelect',
  'ctrl+c': 'timeline.copy',
  'ctrl+v': 'timeline.paste',
  /*
   * Snapping is a mode, not a held key: `Alt` is spoken for by duplicate-drag,
   * and every NLE settled on the same answer.
   *
   * On `n` rather than `s`, which is where Resolve keeps it — `s` is worth more
   * as "take the clip I am parked on", the keyboard's version of clicking one.
   */
  n: 'timeline.toggleSnapping',
  /*
   * The tool strip, on the letters every editor uses for them. Single keys,
   * because picking a tool is something done a hundred times an hour — and the
   * ones that are not built yet are bound too, so they can say so rather than
   * appearing to be nothing at all.
   */
  v: 'tool.select',
  c: 'tool.razor',
  r: 'tool.stretch',
  p: 'tool.pen',
  g: 'tool.geometry',
  b: 'tool.brush',
  i: 'tool.eyedropper',
  u: 'tool.ruler',
  y: 'tool.puppet',
  j: 'tool.generate',
  s: 'timeline.selectAtPlayhead',
  /*
   * Cutting and un-cutting, on neighbouring keys: W splits the playhead's
   * moment, Shift W takes something out and closes the hole behind it.
   */
  w: 'timeline.cutAtPlayhead',
  'shift+w': 'timeline.rippleDelete',
  /** Jumping between cuts, on the keys either side of S. */
  'shift+a': 'timeline.toPreviousEdge',
  'shift+d': 'timeline.toNextEdge',
  /*
   * Trimming to the playhead: Q takes the head up to it, E takes the tail back
   * to it. Premiere's pair, on Premiere's keys — except that its second one is
   * W, which is spoken for here by the cut.
   */
  q: 'timeline.trimHeadToPlayhead',
  e: 'timeline.trimTailToPlayhead',
  /*
   * `S` held, and an arrow: walk the selection to the next clip along. With
   * `Shift` as well, take that one too rather than instead.
   */
  's+arrowup': 'timeline.selectAbove',
  's+arrowdown': 'timeline.selectBelow',
  's+arrowleft': 'timeline.selectPrevious',
  's+arrowright': 'timeline.selectNext',
  'shift+s+arrowup': 'timeline.addAbove',
  'shift+s+arrowdown': 'timeline.addBelow',
  'shift+s+arrowleft': 'timeline.addPrevious',
  'shift+s+arrowright': 'timeline.addNext',
  /*
   * The bare arrows belong to the playhead, which is what they do in every NLE.
   * One frame at a time, and five with `Shift` — far enough to cover ground,
   * near enough that you can still see what you went past.
   */
  arrowleft: 'playback.stepBack',
  arrowright: 'playback.stepForward',
  'shift+arrowleft': 'playback.jumpBack',
  'shift+arrowright': 'playback.jumpForward',
  /*
   * Which track the keyboard is aimed at. `Tab` walks down the stack and
   * `Shift Tab` back up it, which is what those two keys mean everywhere else
   * — the pair rather than the single key that was asked for, because a cycle
   * you can only go forwards round is one you have to go the whole way round to
   * correct a slip. `Ctrl Tab` is the link toggle and stays where it is.
   */
  tab: 'timeline.targetNext',
  'shift+tab': 'timeline.targetPrevious',
  /*
   * What the targeted track does. `Alt M` mutes, `Alt O` solos — `Alt S` would
   * be the obvious partner and already means "which half of the pair am I
   * holding", so solo takes the other letter in its own name — and `Alt V`
   * takes a video track out of the picture.
   */
  'alt+m': 'timeline.toggleTrackMute',
  'alt+o': 'timeline.toggleTrackSolo',
  'alt+v': 'timeline.toggleTrackVisible',
  /*
   * Moving a clip with the keyboard: along its track to the next cut, or up and
   * down the stack. `Alt` because the bare arrows belong to the playhead, which
   * is what they do in every NLE and what they will do here.
   */
  'alt+arrowleft': 'timeline.nudgeLeft',
  'alt+arrowright': 'timeline.nudgeRight',
  'alt+arrowup': 'timeline.nudgeUp',
  'alt+arrowdown': 'timeline.nudgeDown',
  /** Which half of a linked pair the keyboard is holding. */
  'alt+s': 'timeline.toggleHalf',
  // The transport. Space is the one key in a media app that is spoken for
  // before anything else is designed.
  space: 'playback.toggle',
  home: 'playback.goToStart',
  end: 'playback.goToEnd',
}

/**
 * Letter keys that can be *held* as if they were modifiers.
 *
 * `S` takes the clip under the playhead; holding it and pressing an arrow walks
 * that selection to the next clip along. Editors have done this for decades and
 * a keyboard cannot express it any other way — `Ctrl`, `Alt` and `Shift` are
 * three, and they are all spoken for.
 *
 * Deliberately a short list. Every key added here stops being available as a
 * plain shortcut in combination with anything else, and a keymap where any
 * letter might be a modifier is a keymap nobody can predict.
 */
export const CHORD_KEYS = new Set(['s'])

/**
 * Normalise a KeyboardEvent into a stable chord string like `ctrl+shift+p`.
 *
 * Held chord keys come after the real modifiers and before the key itself:
 * `shift+s+arrowup`. Sorted, so two keys held in either order name one chord.
 */
export function chordOf(e: KeyboardEvent, held: ReadonlySet<string> = new Set()): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl') // treat cmd as ctrl for now
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')

  let key = e.key.toLowerCase()
  if (key === ' ') key = 'space'
  if (key === 'escape') key = 'esc'

  // Modifier-only presses are not chords.
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return ''

  // The key being pressed is not also one of the keys being held: `s` is `s`,
  // not `s+s`.
  for (const chord of [...held].filter((one) => one !== key).sort()) parts.push(chord)

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
  /** Chord keys currently down. See CHORD_KEYS. */
  const held = new Set<string>()
  /**
   * Chord keys that something was pressed *with* while they were down.
   *
   * A key that can be held as a modifier cannot run its own command when it
   * goes down: `S` selects the clip under the playhead, and holding it to press
   * an arrow would toggle that selection away before the arrow ever arrived.
   * So its own command waits for the release, and only fires if the key was
   * never used as a modifier — which is how a key that is both a shortcut and a
   * modifier behaves everywhere it exists.
   */
  const usedAsModifier = new Set<string>()

  const run = (chord: string): boolean => {
    const commandId = keymap[chord]
    if (!commandId) return false
    const command = commands.get(commandId)
    if (!command || !commands.isEnabled(command)) return false
    void commands.run(commandId)
    return true
  }

  const onKeyDown = (e: KeyboardEvent) => {
    /*
     * Auto-repeat is not a second press.
     *
     * Holding a key so it can be a modifier means the OS sends its keydown over
     * and over, and every one of those would run the command the key is bound
     * to — `S` held down would toggle a selection on and off thirty times a
     * second. A command is something you ask for once.
     */
    if (e.repeat) return
    /*
     * A key something else has already answered is not ours.
     *
     * The folder tree walks its rows with the arrows and calls preventDefault
     * on them; so does the palette. Those handlers run first — React dispatches
     * inside the page, this listens on the window — so a handled key arrives
     * here already marked, and without this the same arrow would move a row in
     * the bin *and* step the playhead a frame.
     */
    if (e.defaultPrevented) return

    const key = e.key.toLowerCase()
    // Anything pressed while a chord key is down is what that key was held
    // *for*, whether or not the combination turns out to be bound.
    if (!CHORD_KEYS.has(key)) for (const one of held) usedAsModifier.add(one)

    const chord = chordOf(e, held)
    if (CHORD_KEYS.has(key)) {
      held.add(key)
      // Unmodified, it might be the start of a chord; its own command waits for
      // the release. With a modifier it cannot be, so it runs now — and its
      // release must then stay quiet, or `Alt S` would be followed by a bare S
      // undoing whatever it just did.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return
      usedAsModifier.add(key)
    }
    if (!chord) return

    // Bare keys (no modifier) are suppressed inside text entry; chords with a
    // modifier still work, so Ctrl+K reaches the palette from a search field.
    const hasModifier = e.ctrlKey || e.metaKey || e.altKey
    if (!hasModifier && isTextEntryTarget(e.target)) return

    if (run(chord)) e.preventDefault()
  }

  const onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if (!held.delete(key)) return
    // Let go without having been used as a modifier: it was a plain press after
    // all, so it does what it says on the key.
    if (!usedAsModifier.delete(key) && !isTextEntryTarget(e.target)) run(key)
  }

  /*
   * A key held when the window loses focus is a key that never comes up.
   *
   * Alt-tabbing mid-chord would otherwise leave `S` held for ever, and every
   * arrow press afterwards would be a chord nobody meant to type.
   */
  const onBlur = () => {
    held.clear()
    usedAsModifier.clear()
  }

  return {
    attach() {
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('blur', onBlur)
      }
    },
    lookup(commandId) {
      return Object.keys(keymap).find((chord) => keymap[chord] === commandId)
    },
    setKeymap(next) {
      keymap = { ...next }
    },
  }
}
