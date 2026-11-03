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

/**
 * A command the registry has been told about, whether or not it is loaded.
 *
 * Everything except `run` — which is the point. This is what something needs
 * in order to *talk about* a command: list it, name it, group it, bind a key
 * to it. Running it needs the real thing, and the real thing may belong to a
 * panel that is closed.
 */
export type CommandInfo = Omit<Command, 'run' | 'enabled'>

type Listener = () => void

class CommandRegistry {
  private commands = new Map<string, Command>()
  /**
   * Everything registered since launch, kept when the command goes away.
   *
   * Most commands belong to panels and are registered when the panel mounts,
   * so `commands` holds whatever is open right now — which is the right
   * answer for running something and the wrong one for listing what this
   * build can do. Measured: with the Settings workspace open, 47 of the 78
   * commands the shipped keymap binds were registered, because that workspace
   * has no Timeline, Viewer, Content Browser or Render panel in it. A hotkeys
   * editor built on that list would hide half the app.
   *
   * Kept rather than rebuilt, because nothing can enumerate what a panel
   * *will* register without mounting it. So this fills in as panels are
   * opened, and the one gap left is a session that has never opened the panel
   * at all — which the Hotkeys page states rather than hides.
   *
   * Not a memory leak worth worrying about: it is one small object per
   * distinct command id, and a build has on the order of a hundred.
   */
  private known = new Map<string, CommandInfo>()
  private listeners = new Set<Listener>()

  register(command: Command): Disposable {
    if (this.commands.has(command.id)) {
      // Loud, because a silent overwrite means one of two extensions has
      // quietly lost its command and nobody will know until a key does the
      // wrong thing.
      console.warn(`[flux] command "${command.id}" was already registered — overwriting`)
    }
    this.commands.set(command.id, command)
    this.known.set(command.id, {
      id: command.id,
      title: command.title,
      category: command.category,
      ...(command.detail ? { detail: command.detail } : {}),
    })
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

  /** What can be run right now. */
  list(): Command[] {
    return [...this.commands.values()]
  }

  /**
   * Everything this build has registered since launch, loaded or not.
   *
   * For anything that talks *about* commands rather than running them — the
   * Hotkeys page is the first. Use `get` alongside it to tell whether a
   * particular one can be run at this moment.
   */
  catalogue(): CommandInfo[] {
    return [...this.known.values()]
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
