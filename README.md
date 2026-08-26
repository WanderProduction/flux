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
| **Content Browser** | Browse the machine, import image and video by reference, thumbnails on cards. |

Six built-in panels: Viewer, Timeline, Node Map, **Content Browser**, Inspector, Mixer. Only the
Content Browser does real work; the other five are still scaffolding.

### The Content Browser

Browse any folder, import media into the project, see it as cards.

**Importing never copies or moves anything.** An asset is a reference — an absolute path plus what
we know about the file — so importing is instant and touches nothing on disk. The cost of that
choice is that files can move or vanish behind the project's back, so paths are re-checked on load
and a card whose original is gone is marked `offline` rather than rendering broken.

Supported formats are limited to what Chromium can decode, because a card we cannot draw is a
promise we cannot keep. `.mkv`, `.avi` and `.tif` are excluded on purpose — widening the list is an
engine question, not a UI one. The single definition lives in
[`shared/mediaTypes.js`](shared/mediaTypes.js) and is imported by *both* the Electron main process
and the renderer; two copies would drift silently.

Thumbnails are decoded in the renderer and cached as small JPEG data URLs, at most three at a time
and each under a deadline — a hundred simultaneous video decodes, or one malformed file waiting on
an event that never fires, is exactly the stall FLUX exists to avoid.

Local files reach the renderer over a `flux-asset://` protocol rather than `file://` (which CSP
blocks), which also gets range requests so video can seek without loading whole. The handler serves
**only** paths matching the shared media allowlist.

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
  kernel/       commands · panels · keymap · workspaces · store
                fsBridge · assets · thumbnails                    (the seams)
  panels/       the six built-in panels, registered via the SDK
  shell/        command palette
  styles/       theme tokens + app styles
shared/         media type definitions — imported by BOTH main and renderer
electron/       main process · preload bridge · filesystem reads
scripts/        verification harnesses
```

---

## Verifying

```bash
npm run verify:fs
```

Exercises `electron/filesystem.js` against a real temp directory — listing, filtering, natural
sort, truncation of huge folders, and the protocol allowlist.

The rest only exists inside Electron (IPC, the `flux-asset` protocol, real decoding), so it is
checked by attaching to the running app over the DevTools protocol. In three terminals:

```bash
npm run dev:renderer
```

```bash
npm run dev:debug
```

```bash
npm run verify:app
```

`verify:app` expects fixture media in `~/flux-media-test`. Generate it with ffmpeg — two H.264
mp4s, a VP9 webm, a png, a jpg, a nested folder, a `notes.txt` that must never be listed, and a
deliberately corrupt `.mp4` that must resolve to "no preview" rather than hang. It clears the
project's asset list so runs are repeatable.

---

## Stack

Electron + Vite + React + TypeScript, panels by [`dockview`](https://dockview.dev).

Chosen for the widest contributor pool (this is meant to be community-built) and because the
browser platform genuinely carries the engine we want: **WebGPU** for compute and render,
**WebCodecs** for hardware video decode, **Web Audio / AudioWorklet** for the DAW. Heavy compute can
move behind the kernel seam to native later without touching the UI.

## Not built yet

Everything below the shell: the signal graph, the compute scheduler (GPU/CPU/RAM split), caching and
proxies, playback, the audio graph, rendering, export, plugins, skinning UI. Audio files are not
importable yet — the Content Browser is image and video only.

## License

MIT.
