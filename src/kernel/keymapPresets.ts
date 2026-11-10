import { defaultKeymap, type Keymap } from './keymap'

/**
 * Keyboard presets for the editors arriving from somewhere else.
 *
 * An editor who cannot press the keys their hands already know does not
 * evaluate a new tool — they bounce off it in the first ten minutes, and no
 * amount of playback smoothness buys that back. These are the two rooms FLUX
 * is actually meant to take work from.
 *
 * ## What a preset is allowed to claim
 *
 * Not "FLUX behaves like Premiere". It cannot: Premiere has a ripple edit
 * tool, a slip tool, four-point edits and track targeting that FLUX has not
 * built, and a preset that silently bound those letters to the nearest FLUX
 * command would teach a wrong reflex — which is worse than an unbound key,
 * because a wrong reflex is discovered during someone's actual work.
 *
 * So each preset follows one rule, and it is the rule to argue with if these
 * ever feel wrong:
 *
 *   **Rebind every chord the source application defines and FLUX can honour.
 *   Unbind a chord only where FLUX's own binding would fire a tool switch or a
 *   destructive edit from a key that application uses for something else.
 *   Leave everything else on the FLUX default.**
 *
 * The third clause is what keeps them usable. A preset that cleared every
 * chord it could not map would hand a Premiere editor a keyboard that mostly
 * does nothing, and the FLUX defaults underneath are reasonable keys for
 * commands neither application has.
 *
 * ## They are whole maps, like every other preset
 *
 * `changes` is written as a diff because that is the readable way to state and
 * review it, but `keymapOf` resolves it against the current defaults and what
 * gets applied and stored is the entire map — the rule `kernel/keybindings.ts`
 * is built on. One consequence worth knowing: a preset follows a change to the
 * FLUX default for every chord it does not mention, which is what should
 * happen when a command moves.
 *
 * ## Where the bindings come from
 *
 * The transport — space, J/K/L, I/O, the arrows, Home/End — is shared by both
 * applications and by Avid before them, and it is the part most worth getting
 * right because it is the part used thousands of times a day. The
 * application-specific letters below are each noted with what they do in the
 * source application, so a wrong one can be found and argued with rather than
 * guessed at.
 */

export interface BuiltInPreset {
  id: string
  name: string
  /** One line, shown under the name on the Hotkeys page. */
  blurb: string
  /** What this changes from the FLUX default. `null` unbinds the chord. */
  changes: Record<string, string | null>
}

/**
 * The transport both applications share, and Avid before them.
 *
 * J shuttles back, K stops, L shuttles forward; I and O mark; the arrows step
 * a frame and Shift-arrows step further; Up and Down walk the cuts. This is
 * the muscle memory that actually matters — everything below it is preference,
 * this is reflex.
 */
const SHARED_TRANSPORT: Record<string, string | null> = {
  j: 'playback.shuttleBack',
  k: 'playback.pause',
  l: 'playback.shuttleForward',
  i: 'timeline.markIn',
  o: 'timeline.markOut',
  arrowup: 'timeline.toPreviousEdge',
  arrowdown: 'timeline.toNextEdge',

  // The shuttle moved to J and L, so the FLUX pair on either side of S goes,
  // and so does the cut navigation that took Shift to stay clear of it.
  a: null,
  d: null,
  'shift+a': null,
  'shift+d': null,
}

export const builtInPresets: BuiltInPreset[] = [
  {
    id: 'builtin.premiere',
    name: 'Premiere Pro',
    blurb: 'The transport, the marks and the tool letters Premiere puts them on.',
    changes: {
      ...SHARED_TRANSPORT,

      // Tools. V, C, R and P are the same letters in both applications, so
      // they are already right in the FLUX default and are restated here only
      // so the preset reads as a complete statement of its own tools.
      v: 'tool.select', // Selection
      c: 'tool.razor', // Razor
      r: 'tool.stretch', // Rate Stretch
      p: 'tool.pen', // Pen

      /*
       * Premiere's B, Y, U and H are Ripple Edit, Slip, Slide and Hand, and
       * FLUX has none of them. The FLUX defaults on those letters are a brush,
       * a puppet tool, a ruler and nothing — so a Premiere editor reaching for
       * a ripple edit would get a paint brush. Unbound is the honest answer;
       * the tools are still on the tool strip and in the palette.
       */
      b: null,
      y: null,
      u: null,
      g: null,

      // Editing. Ctrl K is Add Edit; Q and W are the two ripple trims to the
      // playhead; S is snapping, which is why FLUX's N goes.
      'ctrl+k': 'timeline.cutAtPlayhead',
      q: 'timeline.trimHeadToPlayhead',
      w: 'timeline.trimTailToPlayhead',
      s: 'timeline.toggleSnapping',
      n: null,
      // E is Extend Selected Edit to Playhead, which FLUX has not built, and
      // the trim it held in the FLUX default is on W now.
      e: null,
      'shift+delete': 'timeline.rippleDelete',
      'shift+w': null,

      // Zoom. Premiere puts the timeline zoom on the bare bracket keys and
      // "zoom to sequence" on the backslash.
      '=': 'timeline.zoomIn',
      '-': 'timeline.zoomOut',
      '\\': 'timeline.zoomToFit',
      /*
       * Premiere's backtick maximises the panel under the cursor, which FLUX
       * has no command for. Left bound to Zoom to Fit would be a second,
       * undocumented key for something the backslash already does, and the
       * first time it is pressed by reflex the timeline jumps instead of the
       * panel growing.
       */
      '`': null,
      'shift+`': null,
    },
  },

  {
    id: 'builtin.resolve',
    name: 'DaVinci Resolve',
    blurb: 'Resolve’s Edit page: A and B for the modes, Ctrl B to split.',
    changes: {
      ...SHARED_TRANSPORT,

      /*
       * Resolve's edit modes rather than Premiere's tool letters: A is
       * Selection, B is Blade. Both are restored as tools here because that is
       * what FLUX has — a mode and a tool are not the same idea, but the key
       * and the result line up closely enough to be worth the reflex.
       */
      a: 'tool.select',
      b: 'tool.razor',
      // Resolve's trim mode (T) and dynamic trim (W) have no FLUX equivalent,
      // and C is not a tool there — so FLUX's razor on C would be a second,
      // unexpected blade.
      c: null,
      t: null,

      // Ctrl B splits the clip at the playhead.
      'ctrl+b': 'timeline.cutAtPlayhead',
      // FLUX's W cuts at the playhead; in Resolve that is Ctrl B, and W is
      // dynamic trim, which does not exist here.
      w: null,

      // N is already snapping in the FLUX default, which is also Resolve's
      // key, so it needs no change. Shift Z is Zoom to Fit; Ctrl = and Ctrl -
      // are the timeline zoom.
      'shift+z': 'timeline.zoomToFit',
      'ctrl+=': 'timeline.zoomIn',
      'ctrl+-': 'timeline.zoomOut',
      '`': null,
      'shift+`': null,

      'shift+delete': 'timeline.rippleDelete',
      'shift+w': null,

      // D enables and disables a clip in Resolve, which FLUX has not built.
      d: null,
      // Resolve's markers are M, and the marker walk is Shift Up / Shift Down.
      m: 'marker.add',
      'shift+arrowup': 'marker.previous',
      'shift+arrowdown': 'marker.next',
    },
  },
]

/**
 * The whole map a built-in preset means, resolved against the current defaults.
 *
 * A chord the preset sets to `null` is removed rather than stored as a null,
 * because a stored map is the whole truth and a key holding null is not the
 * same thing as a key that is not there.
 */
export function keymapOf(preset: BuiltInPreset): Keymap {
  const map: Keymap = { ...defaultKeymap }
  for (const [chord, command] of Object.entries(preset.changes)) {
    if (command === null) delete map[chord]
    else map[chord] = command
  }
  return map
}

export function builtInPreset(id: string): BuiltInPreset | undefined {
  return builtInPresets.find((one) => one.id === id)
}

export const isBuiltInPreset = (id: string): boolean => id.startsWith('builtin.')
