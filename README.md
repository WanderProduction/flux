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
| **Projects** | Create or open a project on launch. State lives in the project folder. |
| **Dockable panels** | Drag, split, tab, float, resize — Premiere/FL-style, via `dockview`. |
| **Workspaces** | Saved panel layouts. `1` Edit · `2` Sound Design · `3` Nodes / Motion. |
| **Layout persistence** | `Ctrl S` saves the current workspace's layout, `Ctrl Shift R` resets it. Restored on launch. |
| **Command palette** | `Ctrl K` — fuzzy search over every registered command. |
| **Panel focus** | `Ctrl 1`–`Ctrl 6`, opening the panel if the workspace doesn't have it. |
| **Content Browser** | Two rail trees — the local disks and the project. Browse, import by reference, thumbnails on cards. |
| **Timeline** | Drag assets from the Content Browser onto a track. Select, delete, zoom. |

Six built-in panels: Viewer, Timeline, Node Map, **Content Browser**, Inspector, Mixer. The Content
Browser and Timeline do real work; the other four are still scaffolding.

### Projects

FLUX opens on a launcher: name a project, choose a folder, and it creates

```
<your folder>/
  project_files/    the manifest, and the project's own state
  imports/          media copied into the project
  exports/          renders — nothing writes here yet
```

`project_files` is the part FLUX owns — the manifest (name, app version, format
number) and the project's assets and sequence. `imports` and `exports` are yours.

**Project state lives in the project folder, not in app data.** Opening a different project shows a
different timeline, and a project folder copied to another machine brings its contents with it.
Workspace layouts, the keymap and the recents list stay app-scoped, because those describe the
person using FLUX rather than the work.

There is no explicit save: assets and the sequence are written as they change. The manifest carries
a format number, and a project written by a newer FLUX is refused rather than misread — a project
file is the one thing in a media app that must never be quietly corrupted.

The launcher always appears on launch rather than silently reopening the last project. In an app
where a stray edit lands in whatever happened to be open, "which project am I in?" should not be a
question you answer by looking at the timeline.

*Not yet: autosave snapshots, and project folders for organising assets inside the bin.*

### The Content Browser

The rail holds **two separate trees**:

- **Project** — the imported assets. Leaves drag to the timeline exactly like cards do.
- **This PC** — every mounted drive as its own root, expanding lazily as you open branches.

They are separate on purpose. A project asset is a *reference* to a file, not the file's location,
so folding them into one tree would imply the project mirrors the disk — and it does not. Project
folders, when they arrive, will be the project's own structure with no relationship to where the
files actually live.

Both trees drive the same grid. Arrow keys work throughout: Left/Right collapse and expand, Up/Down
move, Enter selects. Descending into a folder from the grid reveals and selects that path in the
tree, so the two panes never disagree about where you are. The rail is resizable and remembers its
width — deep trees need it.

Expanding a node uses a subfolder-only read rather than a full listing: opening a branch needs no
file metadata, and statting every media file in a folder you are only passing through is work that
shows up as a stutter on each chevron click. Windows system folders (`$Recycle.Bin`,
`System Volume Information`) are hidden, as Explorer hides them — they sit in every drive root and
only ever produce a permission error.

Browse any folder, import media into the project, see it as cards.

**Importing asks how.** An asset is always a reference — an absolute path plus what we know about
the file — but you choose where that path points:

- **Copy into the project** — the file is copied into `imports` first. The project folder becomes
  self-contained, which is what makes it safe to archive or move, and reads come off one disk.
- **Leave the files where they are** — the asset points at the original. Instant and costs no space,
  but the project depends on that path surviving.

Neither is right for everyone, so FLUX asks, with a *Always do this* option; *Ask Again How To
Import* in the palette puts the question back. Either way the original is never moved or altered,
and a copy never overwrites: a name collision suffixes instead, because two cards both starting at
`C0001.MP4` is routine and overwriting would destroy the first import.

Either way files can still move or vanish behind the project's back, so paths are re-checked on load
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

### The Timeline

Drag a card from the Content Browser onto a track and it becomes a clip, as long as its source and
starting where you dropped it. Click to select, `Delete` to remove, `+`/`−` to zoom. Video and
stills only — blocks are solid, with no waveform, because there is no audio pipeline to draw one
from.

A clip is the first thing in FLUX that **owns time**, which in
[`docs/INTERACTION-MODEL.md`](docs/INTERACTION-MODEL.md) is exactly what separates a
Timeline-visible node from an ambient one. So a clip *references* an asset rather than containing
it, and carries only its placement — when the signal graph lands, a clip becomes an element node
and this stays its time placement, not a second competing source of truth.

Two behaviours worth knowing:

- **Dropping onto an occupied span slides right** to the first free slot. Overlap has to resolve
  somehow, and the alternatives are real editing decisions: overwrite destroys work, insert shifts
  everything downstream. Neither should happen by accident on a drag.
- **Removing an asset from the bin does not delete its clips.** They stay, hazard-striped and
  marked unplayable. Silently deleting editing work because someone tidied the bin is not a
  trade this project makes.

Not yet: moving or trimming clips once placed, and audio tracks.

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
                project · fsBridge · assets · sequence
                thumbnails · mediaProbe · importMode              (the seams)
  launcher/     the project chooser, shown until a project is open
  panels/       the six built-in panels, registered via the SDK
  shell/        command palette
  styles/       theme tokens + app styles
shared/         media type definitions — imported by BOTH main and renderer
electron/       main process · preload bridge · filesystem reads · project layout
scripts/        verification harnesses
```

---

## Verifying

```bash
npm run verify:fs
```

```bash
npm run verify:project-fs
```

These need no running app. `verify:fs` exercises `electron/filesystem.js` against a real temp
directory — listing, filtering, natural sort, truncation of huge folders, and the protocol
allowlist. `verify:project-fs` does the same for project creation: the folder layout, refusing to
create over an existing project, refusing a newer format, and copying into `imports` without ever
overwriting.

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

```bash
npm run verify:project
```

```bash
npm run verify:tree
```

```bash
npm run verify:timeline
```

`verify:app`, `verify:tree` and `verify:timeline` expect fixture media in `~/flux-media-test`. Generate it with
ffmpeg — two H.264 mp4s, a VP9 webm, a png, a jpg, a nested folder, a `notes.txt` that must never be
listed, and a deliberately corrupt `.mp4` that must resolve to "no preview" rather than hang. Both
clear the project's asset list and sequence so runs are repeatable.

`verify:timeline` synthesises drag and drop with a real `DataTransfer` and real `DragEvent`s
dispatched at the actual DOM nodes, so the app's own handlers run as they do under a mouse.
`verify:tree` clicks real chevrons and dispatches real arrow keys.

> **Three rules the UI harnesses learned the hard way.** Wait for a *condition*, never a duration —
> a cold directory read is slower than any sleep you would guess. Identify a tree row by *path*,
> never by label — `Users` and `Program Files` exist on most drives, so a label match silently
> picks a row on the wrong one. And let every check build the state it needs from scratch, so none
> of them depends on what another happened to leave behind.

> **Harnesses must reach kernel state through `window.__fluxDev`** (defined in `src/main.tsx`,
> stripped from production builds), never by dynamic import. Importing `/src/kernel/x.ts` from
> outside does *not* get the instance the app is running once Vite has appended an HMR
> cache-busting query — it silently creates a second module with its own empty state, and checks
> then pass or fail for reasons unrelated to the app. `attach()` refuses to run without the handle.

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
