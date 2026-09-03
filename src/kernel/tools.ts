/**
 * The tool the pointer is holding.
 *
 * One at a time, app-wide, exactly as it is in every editor with a tool strip:
 * the cursor means one thing everywhere, and which thing is a mode you can see.
 * It lives in the kernel rather than in the Tools panel because the Timeline is
 * what *uses* it — a panel that owned the mode would be a panel every other
 * panel had to reach into, and closing it would leave the pointer holding
 * nothing.
 *
 * ## Tools that do not exist yet
 *
 * Most of this list is `later`. That is deliberate and it is not the same as
 * scaffolding: the shape of the strip is the point — it says what FLUX is going
 * to be, in the order the work is coming — and a button that says plainly that
 * it is not built is honest, where a button that silently does nothing is a
 * bug. Nothing here is drawn to look ready when it is not, and picking one says
 * so and hands the pointer back.
 */

import { commands } from './commands'

export type ToolId =
  | 'select'
  | 'razor'
  | 'stretch'
  | 'pen'
  | 'geometry'
  | 'brush'
  | 'eyedropper'
  | 'ruler'
  | 'puppet'
  | 'generate'

export interface Tool {
  id: ToolId
  name: string
  /** The single key that picks it, as it appears in the keymap. */
  key: string
  /** What it does, in the words the strip and the palette both use. */
  detail: string
  /** Drawn on the button. A glyph, because the strip is one icon wide. */
  glyph: string
  /** False while it is a promise rather than a tool. */
  ready: boolean
  /** For the ones that are not ready: what it will do, said plainly. */
  coming?: string
}

export const tools: Tool[] = [
  {
    id: 'select',
    name: 'Select',
    key: 'v',
    detail: 'Select, move and trim clips',
    glyph: '⌖',
    ready: true,
  },
  {
    id: 'razor',
    name: 'Razor',
    key: 'c',
    detail: 'Cut a clip in two where you click',
    glyph: '⧗',
    ready: true,
  },
  {
    id: 'stretch',
    name: 'Stretch',
    key: 'r',
    detail: 'Drag an edge to change how fast a clip plays',
    glyph: '⇹',
    ready: true,
  },
  {
    id: 'pen',
    name: 'Pen',
    key: 'p',
    detail: 'Draw vector masks and paths',
    glyph: '✎',
    ready: false,
    coming: 'Vector masks and paths, once there is a compositor to mask into.',
  },
  {
    id: 'geometry',
    name: 'Geometry',
    key: 'g',
    detail: 'Create shape layers',
    glyph: '◇',
    ready: false,
    coming: 'Shape layers — rectangles, ellipses, polygons — as clips of their own.',
  },
  {
    id: 'brush',
    name: 'Brush',
    key: 'b',
    detail: 'Paint strokes onto the footage',
    glyph: '✒',
    ready: false,
    coming: 'Strokes painted onto a frame, and held as an effect rather than baked in.',
  },
  {
    id: 'eyedropper',
    name: 'Eyedropper',
    key: 'i',
    detail: 'Pick a colour out of the picture',
    glyph: '⌾',
    ready: false,
    coming: 'Picking a colour from the Viewer, for whatever is asking for one.',
  },
  {
    id: 'ruler',
    name: 'Ruler',
    key: 'u',
    detail: 'Measure distances and check alignment',
    glyph: '⊹',
    ready: false,
    coming: 'Measuring in pixels, with guides and grid alignment.',
  },
  {
    id: 'puppet',
    name: 'Puppet',
    key: 'y',
    detail: 'Pin and deform',
    glyph: '⚯',
    ready: false,
    coming: 'Pins on a picture, and warping between them.',
  },
  {
    id: 'generate',
    name: 'Generate',
    key: 'j',
    detail: 'Make something that was not filmed',
    glyph: '✧',
    ready: false,
    coming: 'Generative fills and shots. The interesting one, and the furthest off.',
  },
]

export function getTool(id: ToolId): Tool | undefined {
  return tools.find((tool) => tool.id === id)
}

let active: ToolId = 'select'
/**
 * The last tool asked for that could not be handed over.
 *
 * Kept so the strip can say *why* rather than appearing to ignore the click.
 * Cleared the moment anything else happens, because a refusal is about the last
 * thing you did and not a state to sit in.
 */
let refused: ToolId | null = null
const listeners = new Set<() => void>()

export function activeTool(): ToolId {
  return active
}

export function subscribeTool(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Picks a tool, if it is one.
 *
 * A tool that is not built refuses rather than becoming the mode — the pointer
 * keeps doing what it was doing, which is the only behaviour that cannot lose
 * an edit. The caller says why.
 *
 * @returns true when the tool changed hands.
 */
export function setTool(id: ToolId): boolean {
  const tool = getTool(id)
  if (!tool) return false
  if (!tool.ready) {
    refused = id
    listeners.forEach((listener) => listener())
    return false
  }
  if (id === active) return false
  active = id
  refused = null
  listeners.forEach((listener) => listener())
  return true
}

/** The tool that was asked for and is not built, or null. */
export function refusedTool(): ToolId | null {
  return refused
}

/** Back to the pointer. Used when a gesture is done with a one-shot tool. */
export function resetTool(): void {
  setTool('select')
}

/**
 * Puts every tool in the command registry, and so in the palette.
 *
 * App-wide rather than inside the Tools panel: the keys have to work whether or
 * not the strip is on screen, and a tool that could only be picked from a panel
 * would be a tool you can lose by closing a window.
 */
export function registerToolCommands(): () => void {
  const handle = commands.registerAll(
    tools.map((tool) => ({
      id: `tool.${tool.id}`,
      title: tool.ready ? `Tool: ${tool.name}` : `Tool: ${tool.name} (not built yet)`,
      category: 'Tools',
      detail: tool.ready ? tool.detail : tool.coming,
      run: () => {
        setTool(tool.id)
      },
    })),
  )
  return () => handle.dispose()
}
