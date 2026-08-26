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
| **Projects** | Create or open a project on launch. `Ctrl S` saves it to a `.flux` document. |
| **Dockable panels** | Drag, split, tab, float, resize — Premiere/FL-style, via `dockview`. |
| **Workspaces** | Saved panel layouts. `1` Edit. |
| **Layout persistence** | `Ctrl Alt S` saves the current workspace's layout, `Ctrl Shift R` resets it. |
| **File association** | `npm run register` gives `.flux` the FLUX icon in Explorer and opens it on double-click. |
| **Command palette** | `Ctrl K` — fuzzy search over every registered command. |
| **Panel focus** | `Ctrl 1`–`Ctrl 3`, opening the panel if the workspace doesn't have it. |
| **Content Browser** | Browse the disks; `imports` is the project's bin. Thumbnails on cards. |
| **Timeline** | Drop media on a track from anywhere — the browser, or Explorer. Drag clips to move and reorder them. |
| **Timeline wheel** | Scroll travels time · `Ctrl` travels tracks · `Alt` zooms, anchored on the pointer. |
| **Playback** | `Space` plays the sequence. Playhead in the timeline, picture in the viewer. |

Three built-in panels: **Viewer**, **Timeline**, **Content Browser** — and all three do real work.
The Node Map, Inspector and Mixer were removed: they were empty rooms named after systems that do
not exist yet, and a tour of empty rooms says less about where this is going than three that are
furnished. They come back when there is something to put in them.

### Projects

FLUX opens on a launcher: name a project, choose a folder, and it creates a folder named after the
project inside it:

```
<your folder>/
  <Project Name>/
    project_files/
      <Project Name>.flux   the project document — this IS the project
    imports/                media copied into the project
    exports/                renders — nothing writes here yet
```

The named folder matters: without it, choosing Downloads once would scatter those three folders
straight into Downloads, and a second project could never live beside the first. The launcher shows
the exact path before you commit, and the name is sanitised for the filesystem while the document
keeps what you typed.

`project_files` is the part FLUX owns — the document, and whatever bookkeeping comes later.
`imports` and `exports` are yours.

**Project state lives in the project folder, not in app data.** Opening a different project shows a
different timeline, and a project folder copied to another machine brings its contents with it.
Workspace layouts, the keymap and the recents list stay app-scoped, because those describe the
person using FLUX rather than the work.

### The `.flux` document

One file is the project. `project_files/<Project Name>.flux` holds everything the project knows:

- **name** and when it was created
- **assets** — every import, with its path, probed dimensions and duration
- **sequence** — tracks, and every clip with its track, start and length
- **settings** — per-project preferences, currently the copy-or-link import mode
- **view** — the workspace you were in, the timeline's zoom, the folder the browser was showing

That last one is the difference between a file that stores your edit and a project that reopens
where you left it, which is what a `.prproj` actually does. It is saved but it is deliberately *not*
unsaved work: zooming the timeline never lights the dirty dot, because a dot that appears when you
scroll is a dot people learn to ignore.

It is plain JSON on purpose. VISION.md promises open, inspectable project files, and a media app
that can lose an edit to an opaque blob has failed at the only job that matters. It also means a
project diffs in git.

**`Ctrl S` saves, and nothing else does.** (Layout save moved to `Ctrl Alt S` — a media app that
eats `Ctrl S` for a window layout is fighting muscle memory.) The chip in the top bar carries a dot
while there is unsaved work, and the status bar reads *saved* / *unsaved changes* / *saving…*.

Saves are **atomic**: a temp file plus a rename, so a crash mid-write cannot truncate the real
document.

There is **no autosave yet**. Because of that, closing the window over unsaved work
**asks first** — Save / Don't Save / Cancel — since that prompt is the only thing between a stray
Alt+F4 and a lost edit.

The document carries a format number. One written by a newer FLUX is **refused rather than
misread**: presenting a damaged edit as the real one, and then saving over it, is the failure a
project file must never have. Older projects are read and upgraded — both the folder-only layout
from before the format existed, and format 2, which kept the document loose in the project root. A
relocated document is moved on the next save, and the copy left behind is removed only once the new
one is safely written and only if it is the same document (matched by creation time, not by being a
`.flux` in the right place).

The launcher always appears on launch rather than silently reopening the last project. In an app
where a stray edit lands in whatever happened to be open, "which project am I in?" should not be a
question you answer by looking at the timeline.

*Not yet: autosave, Save As, and project folders for organising assets inside the bin.*

### Opening a project from Explorer

```bash
npm run register
```

writes per-user registry keys (`HKCU\Software\Classes`, never `HKLM` — no elevation, nothing that
touches other accounts) so `.flux` files carry the FLUX icon and open on double-click. `npm run
unregister` removes them.

FLUX takes a **single-instance lock**: a double-clicked project opens in the window already running
rather than starting a second copy. Two processes editing one document is a race with someone's
edit as the stake.

Registration points at the dev build, so `npm run dev` has to be running for a double-click to land
— if it is not, FLUX says so instead of opening a blank window. Pass `--exe <path>` to point it at
an installed build instead. A packaged FLUX registers the association itself at install time, via
`fileAssociations` in `package.json`.

### The Content Browser

The rail is ordered by how often it is reached for:

- **Project** — the project's own folders (`imports`, `exports`, `project_files`) as they really are
  on disk, opened for you. **`imports` is the project's bin**, and the folder the browser opens in.

  There used to be a separate synthetic *Assets* node beside these folders, which meant two lists of
  the same footage that agreed only some of the time. One consequence of removing it had to be
  handled rather than ignored: a *linked* asset is not inside `imports` at all, so it would have had
  nowhere left to appear. The imports view therefore shows the folder's real contents **plus** any
  asset that lives elsewhere, marked `linked`. Everything imported is visible in one place, which is
  the property the bin was there for.
- **Pinned** — folders you marked to keep. Open any folder and hit **Pin**; pins are app-scoped, so
  a footage drive stays pinned across projects.
- **This PC** — every mounted drive as its own root, expanding lazily.
- **Quick** — the OS's named folders, as a fallback.

All of them drive the same grid.

The **path bar sits above the grid**, aligned with the files it describes rather than starting over
at the rail: an up arrow, the full directory path as clickable crumbs, the pin toggle and the import
control. Arrow keys work throughout: Left/Right collapse and expand, Up/Down
move, Enter selects. Descending into a folder from the grid reveals and selects that path in the
tree, so the two panes never disagree about where you are. The rail is resizable and remembers its
width — deep trees need it.

Expanding a node uses a subfolder-only read rather than a full listing: opening a branch needs no
file metadata, and statting every media file in a folder you are only passing through is work that
shows up as a stutter on each chevron click. Windows system folders (`$Recycle.Bin`,
`System Volume Information`) are hidden, as Explorer hides them — they sit in every drive root and
only ever produce a permission error.

Browse any folder, import media into the project, see it as cards. Every card is draggable onto the
Timeline — see below.

**Importing asks how.** An asset is always a reference — an absolute path plus what we know about
the file — but you choose where that path points:

- **Copy into the project** — the file is copied into `imports` first. The project folder becomes
  self-contained, which is what makes it safe to archive or move, and reads come off one disk.
- **Leave the files where they are** — the asset points at the original. Instant and costs no space,
  but the project depends on that path surviving.

Neither is right for everyone, so FLUX asks, with a **Remember for this project** option — an
archive-everything job and a scratch edit off a fast drive want opposite things, so the answer is
stored per project, and *Ask Again How To Import* in the palette puts the question back. The import
button's caret offers **Import Copy** and **Import Origin** directly for when you already know. Either way the original is never moved or altered,
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

Drag a card onto a track and it becomes a clip, as long as its source and starting where you
dropped it. Click to select, `Delete` to remove, `+`/`−` to zoom, and drag the ruler to scrub.
Video and stills only — blocks are solid, with no waveform, because there is no audio pipeline to
draw one from.

**Anything droppable is droppable.** A card already in the project drops as a placement. A file
that is *not* in the project — from any folder in the browser, or dragged straight out of Explorer —
imports on the way, question and all, and then places. That means the copy-or-link decision can no
longer live inside the Content Browser: the Timeline has to raise the same question and has no
dialog of its own. It lives in [`src/kernel/importPipeline.ts`](src/kernel/importPipeline.ts) and
asks through a request the app shell answers, so there is one decision rather than two that drift.

A drag carries one of two payloads, both private MIME types — `x-flux-assets` (ids, a placement) or
`x-flux-files` (paths, an import). A drop target can then refuse a foreign drag by simply not
finding either, rather than guessing at the payload; dockview drives panel docking through drag
events, so an unlabelled drag risks being read as a request to move a panel.

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

#### Driving it

| | |
|---|---|
| scroll | travel time |
| `Ctrl` + scroll | travel tracks |
| `Alt` + scroll | zoom, anchored on the pointer |
| drag the ruler, or the playhead | scrub |
| drag a clip | move it in time, and between tracks |
| `Alt` while dragging a clip | ignore snapping |
| `Shift` / `Ctrl` click | add to the selection |
| `Space` | play / pause |

The bare gesture is **horizontal** because a timeline is overwhelmingly a horizontal surface — the
axis you move along all day should not need a modifier held down to reach. That inverts the usual
`Ctrl`-to-zoom convention on purpose.

Two things about this are less obvious than they look:

- The wheel listener is attached **natively, not through React's `onWheel`**, because React
  registers wheel listeners as *passive*, where `preventDefault` silently does nothing. That matters
  twice over: the page would scroll as well as the timeline, and `Ctrl` + wheel is Chromium's own
  page-zoom gesture, which would zoom the entire application instead of the ruler.
- **Zoom is anchored on the pointer.** Without that the timeline slides out from under the cursor on
  every notch and zooming in on a cut becomes zoom-then-hunt. The `+`/`−` buttons and the commands
  anchor on the middle of the view for the same reason — a control that jumps differently depending
  on how you invoked it is worse than one that always jumps.

Scrolling down through tracks keeps the **ruler** in place and drags the **track headers** along
with the lanes. A timeline you cannot read the time off is not a timeline, and a name column that
has drifted out of step with its tracks is worse than no name column at all.

*Add Video Track* in the palette adds one above the rest — above, because tracks are drawn in order
and the first covers the others, so a track added underneath would be invisible the moment anything
is on V1.

#### Moving clips

Press a clip and drag: sideways moves it in time, up and down moves it between tracks. A selection
of several travels together and keeps its shape, because the gaps between clips are part of the edit
and a move that silently closed them would be a different edit than the one the hand asked for.

A press only becomes a drag after **three pixels**. Without a threshold, selecting a clip is a coin
toss — a click always carries a pixel or two, and every one of them would nudge the edit.

**Overlap resolves by where you dragged, not by a fixed rule.** Short of the neighbour's midpoint
butts up against it; past the midpoint goes after it. That is the behaviour of every reorderable
list, and it is what makes both gestures work: a nudge closes a gap instead of catapulting the clip
to the far side of the track, and a decisive drag reorders instead of refusing.

This is deliberately *not* the same rule as a drop. A drop has no history — the clip is new, nothing
about it says "before" or "after", and sliding right to the first free slot is as good an answer as
any. A move has a history, and how far you dragged it across its neighbour is the whole of what you
meant. Neither rule overwrites, and neither shifts anything downstream.

Dragging also **snaps** — to the start of the sequence, the playhead, and the edges of clips that
are not moving, within eight pixels. Hold `Alt` to turn it off. The overlap rule already butts a
clip against its neighbour when you overshoot; snapping is for the other half, where you stop three
frames short and leave a gap you cannot see and cannot close by hand.

Nothing is committed until the pointer comes up: the block follows the cursor as a transform while
the clip is still where it was, so an abandoned drag needs no undoing.

#### Moving the playhead

Drag the ruler, or the playhead itself — it carries a narrow handle down the length of the line. The
line is otherwise inert, because it lies over every lane and one that swallowed clicks would make
the clip underneath it unselectable at exactly the time you are looking at.

Not yet: trimming clips, audio tracks, and any UI for removing a track (the kernel refuses to remove
the last one, since a sequence with none has nowhere to drop).

### Playback

`Space` plays. The playhead runs down the Timeline, the Viewer shows the clip under it, and the
ruler scrubs.

**There is exactly one clock**, in [`src/kernel/playback.ts`](src/kernel/playback.ts). Panels read
it and render; only commands move it. The moment two panels each keep their own time they disagree,
and "the picture is a few frames off the timeline" is the kind of bug that makes an editor stop
trusting the tool.

The clock is driven by `requestAnimationFrame`, **not** by the `<video>` element, and the element is
dragged along behind it. A video is only the *source* under the playhead: it starts, it ends, it is
replaced by the next clip, while the sequence's time runs continuously across gaps where no video
exists at all. A viewer that used the element as its clock would be running on the source's
timeline instead of the sequence's, and would have nothing to say about a gap between two clips.

The element is re-seeked only when it drifts past about a quarter of a frame. Assigning
`currentTime` every frame re-seeks the decoder every frame, which stutters far worse than the drift
it corrects.

Small behaviours that are deliberate: playback **stops on the last frame** rather than running past
it into empty space, so the picture stays up; pressing play at the end **starts over**, because
nothing happening is not what a finger expects from a player; and deleting the clip under the
playhead **pulls the playhead back** rather than leaving it floating past the end of everything,
where play would then refuse to move it.

**FLUX keeps rendering when it is not in front.** Chromium stops producing frames for a window that
is backgrounded *or* merely covered by another window, which for an ordinary app is a battery win
and for this one is wrong: the playhead is driven by `requestAnimationFrame`, so alt-tabbing away
would silently freeze playback mid-take. `backgroundThrottling: false` plus
`--disable-backgrounding-occluded-windows` turn both off. It also has a second effect that is easy
to be caught out by — a frozen window fires no `scroll` events at all, so anything following a
scroll position quietly stops following it.

This is a *player*, not a renderer — it shows the source directly, because there is no compositor
yet to composite anything. When the engine lands, the Viewer becomes the surface it draws into and
the clip lookup moves into the graph. What must not change is who owns the time.

Not yet: audio scrubbing, loop, frame stepping, and playing across a gap without a black frame at
the seam.

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
                project · view · playback · fsBridge · assets · sequence
                importPipeline · thumbnails · mediaProbe          (the seams)
  launcher/     the project chooser, shown until a project is open
  panels/       the three built-in panels, registered via the SDK
  shell/        command palette · the import-choice host
  styles/       theme tokens + app styles
shared/         media types, project naming and the .flux format
                — imported by BOTH main and renderer
build/          icons, generated by npm run icons (the script is the source)
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

`verify:launch` is the odd one out: it stops any running FLUX and starts its own, because "what
happens when FLUX is **not** already running" is half of what it checks. It reads the launch command
straight out of the registry rather than reconstructing it, so it checks the association
`npm run register` actually wrote — a cold start opening the double-clicked project, closing it
landing on the launcher instead of reopening it, and a second document being handed to the running
app rather than starting a second copy.

```bash
npm run verify:launch
```

```bash
npm run verify:playback
```

`verify:playback` is the one suite where "it looks right" proves nothing: a viewer showing a stale
frame while the clock has moved on, and a clock running while the video is paused, both photograph
perfectly. So it checks that the sequence's time and the element's time stay in agreement, in
seconds, against a real decode of a real file.

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

---

## Icons

`npm run icons` draws them from code — `scripts/make-icons.mjs` rasterises the marks at 4x, filters
them down and writes real PNG and ICO files with a small hand-rolled encoder. No image tooling to
install, and the mark is adjusted by editing numbers rather than opening a design app.

The outputs in `build/` are committed so a fresh clone runs without a generation step, but the
script is the source of truth: change the drawing, re-run it, commit what it produced.

The `.flux` document gets its own icon: the app's dark plate with a folded corner, deliberately not
a white page with a badge on it. At 16px in Explorer a white page reads as "generic file, nothing
handles this", which is the one impression a project document must not give.

Registering it with Windows is `npm run register` — see **Opening a project from Explorer** above.
A packaged build does it at install time through `fileAssociations` in `package.json`; packaging
with electron-builder is not wired up yet.
