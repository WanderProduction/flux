/**
 * The command registry — the spine of "keyboard-first".
 *
 * The rule from VISION.md is that every function in the app is reachable by
 * keyboard alone. That only stays true if there is exactly one place actions
 * can live, so: a feature is not "a button that also has a shortcut", it is a
 * command that a button, a key and the palette all invoke. Anything wired
 * straight to an onClick is unreachable by keyboard, unsearchable in the
 * palette and unscriptable by automation later.
 */

export interface Command {
  /** Stable, namespaced id — `workspace.switch.edit`. Keymaps bind to this. */
  id: string
  /** Human label, shown in the palette. */
  title: string
  /** Palette grouping — "Workspace", "Panel", "View". */
  category: string
  /** Optional longer explanation for the palette's second line. */
  detail?: string
  /**
   * Does the thing. `target` is for the commands that act *on* something.
   *
   * Almost every command here takes nothing: the palette calls `run()` and the
   * command reads whatever it needs off the kernel. A few are different —
   * "place this folder on the timeline" has an argument that cannot come from
   * the selection or the playhead, and a command that could only ever ask a
   * file picker for it would be a command nothing but a human could run.
   *
   * Optional on both sides, so a command that ignores it and a caller that
   * does not pass one both stay exactly as they were.
   */
  run: (target?: unknown) => void | Promise<void>
  /** When false the command is listed but not runnable. */
  enabled?: () => boolean
}

export interface Disposable {
  dispose: () => void
}

type Listener = () => void

class CommandRegistry {
  private commands = new Map<string, Command>()
  private listeners = new Set<Listener>()

  register(command: Command): Disposable {
    if (this.commands.has(command.id)) {
      // Loud, because a silent overwrite means one of two extensions has
      // quietly lost its command and nobody will know until a key does the
      // wrong thing.
      console.warn(`[flux] command "${command.id}" was already registered — overwriting`)
    }
    this.commands.set(command.id, command)
    this.emit()
    return {
      dispose: () => {
        this.commands.delete(command.id)
        this.emit()
      },
    }
  }

  registerAll(commands: Command[]): Disposable {
    const handles = commands.map((c) => this.register(c))
    return { dispose: () => handles.forEach((h) => h.dispose()) }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  list(): Command[] {
    return [...this.commands.values()]
  }

  isEnabled(command: Command): boolean {
    return command.enabled ? command.enabled() : true
  }

  async run(id: string, target?: unknown): Promise<boolean> {
    const command = this.commands.get(id)
    if (!command) {
      console.warn(`[flux] no such command: ${id}`)
      return false
    }
    if (!this.isEnabled(command)) return false
    await command.run(target)
    return true
  }

  /** Subscribe to registry changes so UI (the palette) re-renders. */
  subscribe(listener: Listener): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }
}

export const commands = new CommandRegistry()
