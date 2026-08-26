# FLUX

**A keyboard-driven media engine where the timeline and the node graph are the same project —
and every kind of media can drive every other kind, in real time.**

> **Status: pre-alpha shell.** What runs today is the application frame — panels, workspaces,
> the command palette and the keyboard spine. **There is no media engine yet.** Nothing decodes,
> renders, plays or exports. Panels show static scaffolding so the shell can be evaluated as a
> shell. Do not mistake any panel for a working feature.

- [`VISION.md`](VISION.md) — what this is and why it exists.
- [`docs/INTERACTION-MODEL.md`](docs/INTERACTION-MODEL.md) — panels, workspaces, the nested node
  graph, and how the timeline and node map stay one thing.

---

## Run it

```bash
npm install
```

```bash
npm run dev
```

That starts Vite on `127.0.0.1:5273` and opens the Electron window against it.

To work on the UI alone, without Electron:

```bash
npm run dev:renderer
```

The renderer runs fine in a plain browser — layouts fall back to `localStorage` instead of the
Electron store, so the whole shell stays testable without booting the desktop app.

---

## What works today

| | |
|---|---|
| **Dockable panels** | Drag, split, tab, float, resize — Premiere/FL-style, via `dockview`. |
| **Workspaces** | Saved panel layouts. `1` Edit · `2` Sound Design · `3` Nodes / Motion. |
| **Layout persistence** | `Ctrl S` saves the current workspace's layout, `Ctrl Shift R` resets it. Restored on launch. |
| **Command palette** | `Ctrl K` — fuzzy search over every registered command. |
| **Panel focus** | `Ctrl 1`–`Ctrl 6`, opening the panel if the workspace doesn't have it. |

Six built-in panels: Viewer, Timeline, Node Map, Files, Inspector, Mixer.

---

## Architecture

Three ideas carry the whole shell. They're small on purpose — the point is that they're the seams
everything else grows from.

### 1. Every action is a command

`src/kernel/commands.ts`

A feature is never "a button that also has a shortcut" — it is a **command** that a button, a key
binding and the palette all invoke. Anything wired straight to an `onClick` is unreachable by
keyboard, unsearchable in the palette, and unscriptable by the automation layer later. That rule is
what makes "every function reachable by keyboard alone" hold as the app grows.

### 2. Panels register through the SDK we ship

`src/kernel/panels.ts` · `src/panels/index.ts`

There is no switch statement in the shell that knows about the six built-in panels. They go through
`panels.register()` — the same call a community panel will make. Deleting an entry in
`src/panels/index.ts` removes that panel cleanly.

This is deliberate. Premiere's and After Effects' extension APIs rotted into reverse-engineering
exercises because the vendor never built anything with them. Every extension point here is one we
build on ourselves, so it can't quietly become an afterthought.

### 3. Skins are token overrides, nothing more

`src/styles/theme.css`

Every colour, radius and font resolves through a CSS variable, including dockview's own chrome. A
skin is a file that redefines those tokens. A component that hardcodes a colour has punched a hole
in the skinning system.

```
src/
  kernel/       commands · panels · keymap · workspaces · store   (the seams)
  panels/       the six built-in panels, registered via the SDK
  shell/        command palette
  styles/       theme tokens + app styles
electron/       main process + preload bridge
```

---

## Stack

Electron + Vite + React + TypeScript, panels by [`dockview`](https://dockview.dev).

Chosen for the widest contributor pool (this is meant to be community-built) and because the
browser platform genuinely carries the engine we want: **WebGPU** for compute and render,
**WebCodecs** for hardware video decode, **Web Audio / AudioWorklet** for the DAW. Heavy compute can
move behind the kernel seam to native later without touching the UI.

## Not built yet

Everything below the shell: the signal graph, the compute scheduler (GPU/CPU/RAM split), caching and
proxies, decode, playback, the audio graph, rendering, export, plugins, skinning UI.

## License

MIT.
