# FLUX

**A keyboard-driven media engine where the timeline and the node graph are the same project —
and every kind of media can drive every other kind, in real time.**

> **Status: pre-alpha.** The application frame is real — panels, workspaces, the command palette
> and the keyboard spine — and so now is a working slice of the engine: mp4 is demuxed here and
> decoded through WebCodecs, sequences play with summed audio, the timeline edits, and
> [Batch](#batch-a-folder-in-a-folder-out) imports a folder of footage and renders what survives
> review through ffmpeg. **What is not here is everything the engine is eventually for**: the
> signal graph, the node map, the compute scheduler, a real exporter, plugins. Seven of the nine
> tools in the strip are unbuilt and say so. Nothing in the UI is painted on — if a panel offers
> something, it does it — but this is a long way from a finished editor.

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

### Or just `flux`

To run it like an installed program rather than through Vite:

```bash
npm run dist
```

That writes `release/FLUX Setup <version>.exe` — a per-user installer that puts FLUX in the Start
Menu and registers `.flux` properly. `npm run pack` is the faster half: no installer, just
`release/win-unpacked/FLUX.exe`, which runs exactly the same.

```bash
npm run cli
```

Now `flux` opens the launcher from any terminal, and `flux some-project.flux` opens that project —
the shim passes its arguments through, and `electron/main.js` already reads a project path out of
argv. `npm run uncli` removes it.

> **The one step here that can break something other than FLUX is PATH**, so by default it does not
> touch it. `setx` — the obvious tool — **truncates the value at 1024 characters**, and a
> developer's PATH is routinely longer than that, so using it would quietly delete the tail of
> someone's environment. Instead the shim goes in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is
> already on the user PATH on every Windows 10 and 11 install. Only if that folder is missing does
> it make its own and append — and then it writes the old value to a file first and goes through
> the registry rather than through `setx`.

A packaged build is a different program from the dev one in three ways that all fail *silently* —
the renderer comes off `file://` inside an asar rather than `http://`, a
`script-src 'self'` CSP is in force that Vite's dev server could never run under, and
`window.__fluxDev` is stripped. A build that white-screens looks identical from outside: process
up, window open, title right. So there is a check that asks the page what is in it:

```bash
npm run verify:packaged
```

### Shipping an update

An installed FLUX updates itself. The loop is three commands:

```bash
npm version patch --no-git-tag-version
npm run dist
npm run serve:updates
```

`npm run dist` writes the installer *and* a `latest.yml` naming it, with its size and SHA-512.
That pair is the whole feed format: `electron-updater`'s generic provider wants nothing more than
a static directory holding those two things. `serve:updates` is that directory served over HTTP —
a stand-in for a release server, and the only thing a real one has to do better.

A running FLUX checks the feed at startup, downloads a newer build quietly, and then **waits**. It
does not restart itself: fetching is invisible and recoverable, while installing restarts the app,
and restarting an editor out from under someone mid-edit is a way to lose work. The offer appears
in the status bar, and on the launcher — which is the better of the two places, since nothing is
open there and installing costs only the restart.

> **The feed URL is changeable without building a new app**, which is the whole shape of this.
> FLUX is served off a folder on one machine today and off a server later, and if the URL were only
> baked in then moving the feed would mean shipping a release whose only purpose was to say where
> the *next* release lives — and anyone still on the old build could never be told. So the baked-in
> URL is the last resort:
>
> | | |
> |---|---|
> | `FLUX_UPDATE_FEED` | an environment variable — what the harness uses |
> | `update-feed.json` in userData | `{"url": "…"}` — what a user sets |
> | `app-update.yml` | written at build time from `publish` in package.json |

Updating is the one feature whose failure mode is that *nothing happens*. A wrong URL, a missing
`latest.yml`, a stale checksum, an updater that quietly refuses because the build is unpackaged —
every one of those looks exactly like "there is no update yet", which is also the correct answer
almost all of the time. Nothing about using the app tells them apart, so:

```bash
npm run verify:update
```

That drives the packaged app against three feeds — one offering the version already running, one
offering a newer build, and one that is not there — and checks it says the right thing to each,
including that an unreachable feed leaves FLUX working and says nothing about it. A feed served
off a folder is only up when someone is shipping, so a failed check is the state of nearly every
launch — and a standing failure in the one line that reports real problems teaches you to stop
reading it. The error is kept in the state, not thrown away. And an editor that would not start
because a release server was down would be a far worse bug than one that never updated at all.

> **Pick a port that is actually free.** The default is 8911 rather than something tidier,
> because 8788 — the first choice — is what `wrangler pages dev` listens on, and on a machine that
> does any Cloudflare work the bind fails with `EADDRINUSE` while `netstat` shows *nothing* holding
> it. Windows services and WSL can take a port invisibly, so `serve:updates` says so plainly and
> suggests `--port` rather than dying in a stack trace.

**[Batch](#batch-a-folder-in-a-folder-out) needs ffmpeg**, and only Batch does. Everything else —
browsing, importing, editing, playback — runs without it.

```bash
winget install Gyan.FFmpeg
```

`ffmpeg` and `ffprobe` have to be reachable: `PATH` first, then the usual Windows install
locations. The encode uses `hevc_nvenc`, so it also wants an NVIDIA card. Both are checked once
when the panel opens and reported plainly, rather than discovered as four hundred failed encodes.

---

## What works today

| | |
|---|---|
| **Projects** | Create or open a project on launch. `Ctrl S` saves it to a `.flux` document. |
| **Dockable panels** | Drag, split, tab, float, resize — Premiere/FL-style, via `dockview`. |
| **Workspaces** | Saved panel layouts. `1` Edit, `2` Export. |
| **Layout persistence** | `Ctrl Alt S` saves the current workspace's layout, `Ctrl Shift R` resets it. |
| **File association** | `npm run register` gives `.flux` the FLUX icon in Explorer and opens it on double-click. |
| **Command palette** | `Ctrl K` — fuzzy search over every registered command. |
| **Panel focus** | `Ctrl 1`–`Ctrl 5`, opening the panel if the workspace doesn't have it. |
| **Content Browser** | Browse the disks; `imports` is the project's bin. Thumbnails on cards. |
| **Timeline** | Drop media — or a whole folder — on a track from anywhere: the browser, or Explorer. Drag clips to move and reorder them. |
| **Trimming** | Drag either edge of a clip to change what it plays. Linked pairs trim together. |
| **Link / unlink** | `Ctrl Tab` cuts a pair apart, or ties clips together. Apart, each half moves alone. |
| **Copy, paste, duplicate** | `Ctrl C` / `Ctrl V` at the playhead, or `Alt` drag to leave a copy behind. |
| **Selection** | Click, click-again, click-away, rubber band, `Shift` range by track and time, `Ctrl` one at a time. |
| **Keyboard edit** | `S` takes what the playhead is on; `Alt` and the arrows walk it, swap it, and lift it between tracks. |
| **Viewer** | The frame is the sequence's shape — 9:16, 1:1, 4:5, anything. Wheel zooms, middle-drag pans, `Fit` resets. |
| **Effect Controls** | Position, anchor, scale, rotation, opacity, crop, skew; level, mute and balance for the sound. |
| **Preview resolution** | `Playback` and `Paused`, Full to 1/16, so a heavy stack plays without the paused frame going soft. |
| **Tools** | A strip of them: select, razor and stretch work; the rest say what they will do. |
| **Ripple delete** | `Shift W` takes a clip — or a selected gap — out and closes the hole. |
| **Trim to playhead** | `Q` and `E` take an edge exactly to the playhead. |
| **Chord keys** | `S` held is a modifier: with the arrows it walks the selection clip by clip. |
| **Open GOP** | Files whose keyframes are not IDR frames — most phone footage — seek and play. |
| **Timeline wheel** | Scroll travels time · `Ctrl` travels tracks · `Alt` zooms, anchored on the pointer. |
| **Playback** | `Space` plays the sequence. Playhead in the timeline, picture in the viewer. |
| **Decode pipeline** | H.264 and HEVC mp4 are demuxed here and decoded through WebCodecs onto a canvas. |
| **Audio tracks** | A file with sound lands as a linked picture-and-sound pair, with its waveform drawn. |
| **No sound, said out loud** | A file with none says so on its card and on the drop, rather than landing as picture alone in silence. |
| **Mixer** | Every audio clip under the playhead, summed on one AudioContext — which is also the clock. |
| **Level, mute, solo** | Per track, in decibels, saved with the project. |
| **Layers** | Every visible video track is composited into the sequence's frame; each has an eye. |
| **Sequences** | Many per project, each its own `.fluxseq` file, each a tab on the timeline. |
| **HEVC** | 4:2:2 10-bit included — the profile the cameras in this archive shoot. |
| **Rotation** | Footage shot with the body turned lands and renders upright, not on its side. |
| **Batch import** | Point at a folder; every clip under it lands end to end on a new sequence. |
| **Batch export** | Every clip left on the timeline becomes one file, encoded and verified. |
| **Sequence render** | Or the whole sequence as *one* file: layers composited, audio mixed down, gaps black. |
| **Export page** | `Ctrl M` queues what is selected and opens a whole page showing it, with the pictures. |
| **In and out** | Mark a span — `/` fits it to the selection — and the render is about that span only. |
| **Drop a folder** | A shoot folder dropped on the timeline lands as its footage, in scan order — or from the palette. |

Six built-in panels: **Viewer**, **Timeline**, **Content Browser**, **Tools**, **Batch** and
**Render** — and all six do real work.
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

The project folder now has a `sequences/` directory beside `project_files/`, `imports/` and
`exports/` — see [Sequences](#sequences).

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
blocks). The handler serves **only** paths matching the shared media allowlist, and it speaks the
small part of HTTP that matters — see **Serving media** below, because getting that wrong is what a
broken viewer looks like.

### Tools

A strip down the left of what the pointer is holding. One tool at a time,
app-wide, because the cursor means one thing everywhere and which thing should
be a mode you can see.

| | | |
|---|---|---|
| **Select** | `V` | select, move and trim — everything above |
| **Razor** | `C` | cut a clip in two where you click |
| **Stretch** | `R` | drag an edge to change how fast a clip plays |
| Pen | `P` | *vector masks and paths* |
| Geometry | `G` | *shape layers* |
| Brush | `B` | *strokes painted onto a frame* |
| Eyedropper | `I` | *pick a colour out of the picture* |
| Ruler | `U` | *measure in pixels, guides, grid alignment* |
| Puppet | `Y` | *pins, and warping between them* |
| Generate | `J` | *generative fills and shots* |

**Seven of these are not built, and they say so.** The strip is the shape of the
thing FLUX is going to be, in the order the work is coming, and a row showing
only the three finished tools would say less. What it must never do is pretend:
an unbuilt tool is drawn as unavailable, *refuses* to take the pointer when it
is picked, and answers with what it will do when it exists. A button that
silently becomes a mode which does nothing is a bug report waiting to be
written; one that says "not yet, and here is what this will be" is a roadmap you
can click.

The mode lives in `kernel/tools.ts` rather than in the panel. The Timeline is
what *uses* it, and a panel that owned it would be a panel every other panel had
to reach into — closing the strip would leave the pointer holding nothing.
Every tool is a command, so the keys and the palette both reach them whether or
not the strip is on screen.

#### The razor, and cutting

Clicking a clip cuts it in two where the pointer is; **`Shift` and a click cuts
every track** at that moment. From the keyboard, **`W`** cuts everything the
playhead crosses — the pointer says *where*, the playhead already knows.

**Both halves of a pair, always**: a cut through the picture that left the sound
whole would produce a clip linked to something twice its length, and the first
drag would take them apart. Each side then gets a link of its own — two pairs,
not four clips sharing one id — and the right-hand piece starts further into its
source by exactly the distance the cut was from the clip's head.

The very edge of a clip is not a cut, and the razor says so rather than making a
piece with no frames in it. The tool stays in hand afterwards, because cutting
is something you do several times in a row.

**`Shift A` and `Shift D` walk the playhead between cuts** — every clip edge on
every track, and zero. Across all tracks because the playhead is not on a track,
and a cut on any of them is a moment worth landing on.

#### Ripple delete, and gaps

`Delete` takes a clip out and leaves the hole, which is usually right: most of
the time a shot is being replaced by another one. **`Shift W` is the other
intention** — take this out and let everything after it fall back.

**Only the tracks something was removed from move.** A pair deleted from V1 and
A1 ripples both, so a picture and its sound stay together; music on A2 that had
nothing removed from it stays exactly where it was put. The other reading —
everything on every track slides — is what Premiere does with sync lock on, and
it is the reading that can quietly ruin a soundtrack you were happy with. When
there is a sync lock to turn on, this is what it will switch.

Removed rightmost first, so each shift is measured against clips that have not
moved yet: two clips taken out of one track compose correctly instead of one
dragging the other's measurement out from under it.

**A gap is a thing you can hold.** Click the empty stretch between two clips, or
press `S` where there is no clip to take, and the hole itself is selected —
drawn hatched rather than filled, because it is an absence and a solid block
would read as a clip that will not play. `Shift W` closes it; so does `Delete`,
since there is nothing else Delete can mean on a gap.

A gap is bounded on the right by a clip, always. What comes after the last clip
is not a gap — it is where the sequence has not been used yet, and closing it
would mean nothing — so a press out there lets go of the selection instead. On
the left it is bounded by a clip *or* by the start of the sequence, because the
hole before the first shot is one of the things this is for.

Gaps are held apart from the clip selection rather than pretending to be one:
a gap has no id, it stops existing the moment its neighbours move, and two kinds
of selection on screen at once would make every command ask which was meant.

#### Stretching, and what a clip's rate is

The stretch tool drags an edge like a trim, and means something else: **the same
frames, over more or less time**. `Alt` and an edge does it with any tool in
hand, which is the shortcut the strip is a slower way of reaching.

A clip therefore carries a `speed` — how fast its source runs, as a multiple —
and it covers `duration × speed` seconds of that source. Every place that turns
a moment on the timeline into a moment in a file multiplies by it:

- the compositor asks its decoder for `offset + (now − start) × speed`
- the mixer seeks by the same arithmetic, maps each decoded frame back the other
  way, and hands the rate to `AudioBufferSourceNode.playbackRate` — Web Audio
  resamples, and the pitch moves with the speed, which is what a stretch means
  before anyone asks for pitch to be held
- the waveform draws `duration × speed` seconds of source into the block
- and a trim's arithmetic divides by it: a clip at 2× has half as much timeline
  left to give as it has file

The edge you are *not* holding stays where it is, so a stretch feels like
pulling the clip longer rather than moving it. The rate is recomputed from the
new length rather than accumulated, so stretching out and back lands on exactly
the rate it started at instead of near it. It stops at **ten times either way**:
past that the picture is a slideshow or a blur, and a limit you reach by
dragging is kinder than one you discover by wondering why nothing plays.

`speed` is stored rather than derived from the two durations, even though it
could be. A clip at 1.0000001 because of floating point would be a clip that is
*nearly* untouched, and "is this stretched?" has to have a yes or no answer for
anything downstream to say so. A clip saved before stretching existed played at
the rate it was shot, which is exactly what 1 means.

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
| drag either edge of a clip | trim what it plays |
| `Alt` while dragging a clip | leave the original and place a copy |
| `S` | take the clip under the playhead — or the gap, when there is no clip |
| `W` | cut every clip the playhead crosses |
| `Shift W` | ripple delete: take it out and close the hole |
| `Shift A` / `Shift D` | playhead to the previous / next cut |
| `Q` / `E` | trim the head up to the playhead / the tail back to it |
| `S` held + arrows | walk the selection to the clip above, below, before, after |
| `Shift` + `S` held + arrows | add that clip rather than replacing |
| razor click, `Shift` | cut every track at that moment |
| `Alt` `←` `→` | walk the selection to the next cut, or swap with what it touches |
| `Alt` `↑` `↓` | move the selection a track up or down |
| `Alt S` | step between the halves of a linked pair |
| `N` | snapping on or off |
| click a clip | select it — and again to let it go |
| click empty timeline | let go of everything |
| drag across empty timeline | rubber-band select |
| `Shift` click a clip | select the rectangle from the anchor to here |
| `Ctrl` click a clip | add it, or take it back out |
| `Alt F4` / `Alt A` | auto-select on pause, on or off |
| `Ctrl C` / `Ctrl V` | copy the selection, paste it at the playhead |
| `Ctrl Tab` | link or unlink the selected clips |
| `Space` | play / pause |
| `Delete` | remove the selected clips |

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
are not moving, within eight pixels. The overlap rule already butts a clip against its neighbour
when you overshoot; snapping is for the other half, where you stop three frames short and leave a
gap you cannot see and cannot close by hand.

Snapping is a **mode**, toggled with `N` or the button in the toolbar, and recorded with the view so
a project opens the way it was left. It was a held `Alt` until `Alt` was needed for duplicate-drag —
the one gesture that cannot be spelled another way — and every NLE had already made the same trade.
A mode you cannot see the state of is worse than a key you have to hold, so the button lights when
it is on.

Nothing is committed until the pointer comes up: the block follows the cursor as a transform while
the clip is still where it was, so an abandoned drag needs no undoing.

#### Trimming clips

Drag either edge of a clip. The head sets where in the file it starts, the tail sets where it ends,
and the clip's block on the timeline is what it will play.

A clip therefore carries **three numbers, not one**: where it sits on the timeline, how much of the
source it plays, and where in the source that begins. The third is the in point, and moving it is
the whole of what separates a trim from the two edits it resembles:

|  | `start` | `offset` | `duration` |
|---|---|---|---|
| **Move** | changes | — | — |
| **Trim the head** | changes | changes by the same amount | changes by the same amount |
| **Slip** *(not built)* | — | changes | — |

Trimming the head moves `start` and `offset` together, which is what keeps the frames still in the
clip exactly where they were on the timeline. Only the frames outside it stop being played. A trim
that moved `offset` alone would be a slip — the same block playing different footage — and one that
moved `start` alone would be a move that ate frames.

**Four things stop an edge**, and each is a different fact about the edit:

- **The source.** The head cannot go before the first frame of the file, and the tail cannot go past
  the last. This is why a clip records how long its source was when it was cut: without that, a
  trimmed edge could never be pulled back out. It is written on the clip rather than looked up from
  the bin for the same reason a link is — it has to be a fact about the sequence, not something the
  panel that happens to be in front knows.
- **The neighbour.** An edge stops where the next clip on that track begins. Trimming is not moving:
  nothing slides out of the way and nothing is overwritten.
- **One frame.** A clip is a thing that plays, so the floor is the smallest amount of time that can
  be played. A zero-length clip is an invisible object on the timeline that still catches drops and
  still has to be found to be deleted.
- **The start of the sequence.** Nothing lives before zero.

The edge is **clamped while you drag it**, not on release. An edge that keeps following the pointer
past the end of its own file and then springs back when you let go is a lie about what the edit will
be. Snapping works as it does for a move — the moving edge only, since offering the other one would
snap the edge to a target it is not travelling towards — and `Alt` turns it off.

**A linked pair trims by one amount.** The limits of every clip in the pair are intersected first,
so the picture and its sound lose the same frames and stay in sync. Clamped rather than refused,
which is the opposite of what a *move* does with a pair: an edge that stops when it reaches the
file's end is what a hand expects, where a pair that ignores the drag entirely reads as a broken
handle.

Nothing is committed until the pointer comes up, as with a move: the block is drawn from the
in-flight delta while the sequence still holds the untrimmed clip.

Everything downstream reads the in point rather than assuming a clip starts at the top of its file —
the compositor asks its decoder for `now - start + offset`, the mixer seeks its source to
`offset + into the clip` and maps each decoded frame back the other way, and the waveform is drawn
from `offset` for `duration`. That last one is the cheapest thing here to get wrong and the easiest
to see: a waveform drawn from the top of the file looks completely normal, and is showing sound the
clip does not play.

The mixer's two halves — where it seeks to, and where it puts each decoded frame back — are
**redundant in what you hear and not in what they cost**. Get only the placement right and the mixer
decodes its way from the top of the file, throws every frame away as having missed its moment, and
reaches the in point by brute force. It sounds the same. So the check that a trimmed clip plays from
its in point also asserts that *no frame arrived late*, which is the only thing that tells the two
apart — a canary that broke the seek and left the placement alone passed a level meter perfectly.

> **The picture kept showing the frames from before the trim**, and the sound did not. The
> compositor's drawing was reading its layers out of a closure renewed only when the *set* of layers
> changed — so trimming a clip already under the playhead changed three numbers that nothing
> redrew. Placement and identity are now separate dependencies: an edit to a clip on screen redraws
> it, without tearing down and restarting a decoder that had not moved.

A clip saved before trimming existed played its whole file from the top, so it reads back with an in
point of zero and a source length equal to its duration — which is not a default standing in for an
unknown, it is what that clip actually was.

Not yet: rolling and slip edits, ripple trimming, and trimming with the keyboard.

#### A folder, by drag or by palette

Drop a shoot folder on a track and it lands as every clip under it, end to end, in scan order — the
same copy-or-link question and the same placement as dropping the files themselves. Dropping a
folder and dropping its contents should not be two different features, so they are not: both go
through `footageUnder` (the Batch panel's own scan) and then `idsForFiles` and `placeAssets`.

**Place a Folder on the Timeline…** in the palette does exactly the same thing, and it exists for
two reasons. It is useful — "put this whole folder on the timeline" without going to Explorer — and
it is the only way any of this can be *checked*.

> **A native drag cannot be synthesised.** `webkitGetAsEntry()` has to report a real directory, and
> Electron's `pathForFile` only answers for a `File` that came off a real drag — so the three lines
> that *detect* a dropped folder are out of reach of any harness, and will stay that way. Putting
> the rest behind a command that takes a path moves the untested surface from "the whole feature"
> to "three lines", and `verify:timeline` drives it against the fixture folder: fourteen clips,
> abutting, with `notes.txt` correctly not among them.

Commands can take a target now — `run(id, target)` — for exactly this. Almost none do: the palette
calls `run()` and a command reads what it needs off the kernel. But "place *this* folder" has an
argument that cannot come from the selection or the playhead, and a command that could only ever
ask a file picker for it would be a command nothing but a human could run.

**Reading the folder has to happen before the first `await`.** `dataTransfer.items` is reclaimed
the moment the drop handler yields, so a folder read after an await is always empty — and the
symptom is "dropping folders does nothing", which looks like a missing feature rather than a timing
bug. The whole drop is captured up front for that reason.

#### In and out, and rendering only that

Mark a span on the ruler and the render is about that span and nothing else. The band is drawn over
the ticks with a handle at each end; drag either one and it **snaps to every clip edge and to the
playhead**, because an out point a frame short of a clip's end renders a file a frame short and
nothing on screen would show it.

`/` marks exactly the span the selected clips occupy, which is the one worth a key: the span you
want to render is almost always the span of the clips you just picked, and dragging two handles
onto the same frames is work the app can simply do. `Ctrl Shift X` clears both marks. Mark In and
Mark Out are in the palette but **not** on `I` and `O`, where every NLE puts them — `I` is already
the eyedropper and single letters belong to the tool strip. That is a trade worth making
deliberately rather than by rebinding a tool out from under someone.

The marks belong to the **sequence**, not to the render settings, and are written into the
`.fluxseq`. Marking a span is an edit: it is a statement about this cut, and losing it on reopen
would mean marking it again every session.

What the two render modes do with it differs, and both are what you would want:

| | |
|---|---|
| **Each clip as its own file** | Clips outside the span are dropped — and *named*, so a queue with two rows instead of four has an answer on screen. A clip straddling a mark is trimmed to it, which moves its **source in point** by the same amount: the frames before the mark are not wanted. |
| **The whole sequence as one file** | The composite is exactly as long as the span and starts at the in point, so every clip's placement moves back by it. The gap rule still holds inside: an in point landing in the middle of a gap gives you black, not a shorter file. |

A stretched clip multiplies the trim by its speed, because it covers `speed` seconds of file per
second of timeline. Measured: a span cutting a 7s clip in half produced a 3.5s job reading from
3.5s into the source.

#### Selecting

Every selection gesture on a timeline is a **rectangle**: tracks by time. A click is one with no
width, a range is the one between two clips, and a rubber band is one drawn by hand. All three ask
`clipsInRegion` the same question, and it lives in the kernel because "which clips are in this
region" is a fact about the sequence rather than about the panel drawing it.

| gesture | what it means |
|---|---|
| click | this clip, and its other half |
| click again | let it go |
| click empty timeline | let go of everything |
| drag empty timeline | everything the band touches, live as it is dragged |
| `Shift` click | the rectangle from the anchor to here |
| `Ctrl` click | this one as well, or no longer |

**A range is an area, not a run of items.** Anchor on a picture on V1 and shift-click a sound two
tracks below it: the selection is the picture, its own sound, and whatever else lies under that
stretch of time down to the track clicked. Shift-clicking the *last* audio track therefore takes
every audio clip under the picture, which is the thing a list-style range could never express. A
track above the anchor is not in it — reaching down does not reach up — and reaching the other way
takes what it passes.

The **anchor** is set by every plain or `Ctrl` press and left alone by a `Shift` press, so
shift-clicking twice re-aims the same range rather than dragging one end along behind the pointer.
That is what makes overshooting recoverable.

**Touching counts.** A clip half inside the rubber band is inside it, because that is what dragging
a box across a timeline visibly does; requiring containment would make a sweep across a long clip
select nothing at all. The band selects *live* while it is dragged — a sweep that only shows its
result on release is a sweep you cannot aim — and its rows come from measuring the lanes rather than
from dividing pixels by a track height. The arithmetic version is off by the ruler's bottom border,
which is invisible until the pointer is exactly on a boundary and then silently drops the last row.

Selections expand through links throughout: a picture whose sound was left out of a range would come
apart the moment the range was dragged.

**`Alt F4` toggles auto-select on pause** — play until it looks right, stop, and the clip you landed
on is already selected. Off by default, because a transport that quietly changes the selection every
time it stops is a surprise. It fires on the *edge* from playing to stopped, not on every tick and
not on a seek, and it takes the front-most clip — the one the Viewer is showing, which is the only
thing "the clip I paused on" can mean.

> `Alt F4` is Windows' own "close this window", handled by the window manager before a page ever
> sees it, and `preventDefault` cannot take it back. It is bound because it was asked for and it may
> arrive; **`Alt A` is bound to the same command** so the feature is reachable when it does not, and
> it is in the palette either way.

#### Editing from the keyboard

Everything the pointer does to a clip's *placement*, without the pointer.

| | |
|---|---|
| `S` | take the clip the playhead is on — again to put it down |
| `Alt` `←` `→` | to the next cut, or swap with what it is already touching |
| `Alt` `↑` `↓` | a track up or down, inside its own band |
| `Alt S` | step between the halves of a linked pair |
| `Alt` click | take one half of a pair, not both |

**Sideways lands on cuts, not on a step.** A fixed nudge is a number nobody
means: the interesting places on a timeline are the edges, and landing exactly
on one is the whole reason to do this with a key rather than by hand. So the
clip travels until it butts against the next edge in that direction. Leftward,
the start of the sequence is an edge like any other; rightward, with nothing
ahead, there is no cut to go to and nothing happens.

**With no gap at all, the clip trades places with what it is touching**, so a
shot can be walked through a sequence without picking anything up. The partner
is a *unit*, not a clip — swapping with half of a pair would take that pair
apart — and both halves of a moving pair have to be against the *same* unit, or
there is no single trade to make and the nudge refuses rather than guessing.

**The keyboard moves exactly what is selected.** That is the one place the
links rule bends, and it bends deliberately: `Alt S` narrows a pair to its
picture, then to its sound, so the two can be walked apart a track at a time —
and being handed the other half back would make the narrowing pointless. It is
*not* the same as cutting the link. The link is still there afterwards, dragging
either half still moves both, and a plain click takes the pair back.

`Alt` on a press means the same thing it means on a drag: **this half**, or a
copy of this half.

#### Trimming to the playhead

`Q` takes the head of a clip up to the playhead; `E` takes the tail back to it.
Premiere's pair on Premiere's keys, except that its second one is `W`, which the
cut already owns here.

The keyboard's version of dragging an edge, and the one that is **exact**: a
hand can land a frame either side of where it meant, and this cannot. Each clip
gets its own distance — the playhead is one moment and the clips crossing it
start at different ones — which is why this is not the same call a drag makes,
where the *hand* moved one distance and every clip in the group should follow it.

It takes the selection when there is one and everything under the playhead when
there is not, the same rule the razor's `Shift` follows. The hole is left behind:
trimming a head forward leaves a gap in front of the clip exactly as deleting it
would, and `Shift W` is the gesture that says "and close it".

#### Walking a selection with the keyboard

Hold `S` and press an arrow: the selection moves to the clip above, below,
before or after. Hold `Shift` as well and it *adds* that clip instead, so a
selection can be built up a clip at a time without the pointer.

Sideways is the next clip along the same track. Up and down are the nearest
track with something **at the same time** — a clip above that does not overlap
is not the clip above, it is a different part of the edit, and jumping to it
would lose your place.

That needed the keymap to learn a new kind of chord: **a letter key held down as
if it were a modifier**. `Ctrl`, `Alt` and `Shift` are three and they are all
spoken for. Two rules fall out of it, and both are the difference between a
feature and a bug:

- **A held chord key does not run its own command on the way down.** `S` selects
  the clip under the playhead, so holding it to press an arrow would toggle that
  selection away before the arrow arrived. Its own command waits for the
  release, and fires only if the key was never used as a modifier — which is how
  a key that is both a shortcut and a modifier behaves wherever it exists.
- **Auto-repeat is not a second press.** Holding a key so it can be a modifier
  makes the operating system send its keydown over and over, and every one of
  those would run the command again: `S` held would toggle a selection on and
  off thirty times a second.

A key held when the window loses focus is a key that never comes up, so blur
lets go of everything held. Alt-tabbing mid-chord would otherwise leave `S` down
for ever, and every arrow afterwards would be a chord nobody meant to type.

`CHORD_KEYS` is deliberately one key long. Every letter added to it stops being
available as a plain shortcut in combination with anything else, and a keymap
where any letter might be a modifier is one nobody can predict.

#### Copying clips

Three ways to get a second copy, and one machinery underneath: a snapshot of the clips, put down
somewhere with new ids and new links.

- **`Ctrl C` / `Ctrl V`** — copies the selection, pastes it at the playhead. The playhead rather
  than the pointer, because paste is a keyboard gesture and the pointer may be anywhere, including
  outside the panel.
- **`Alt` and drag** — leaves the original where it is and places a copy where the drag ends.

Copying a picture copies its sound, exactly as moving one moves its sound: the selection is expanded
through links before anything is snapshotted. **A copied pair is linked to itself**, not to the pair
it came from — two pairs sharing one link id would mean dragging the copy moved the original, which
is the kind of bug that surfaces an hour later in somebody's edit rather than here.

Pasted clips are **new clips**, so they follow the drop rule rather than the move rule: if something
is already where they would land, the whole group slides right until every member fits. As one
group, not clip by clip — a pair placed independently lands out of sync, and sliding right is the
only outcome that neither loses a frame nor moves what was already there. The timeline says when it
had to slide, because a copy that quietly landed somewhere else is a copy you will not find.

Two smaller decisions worth naming. The clipboard lives in `kernel/sequence.ts` rather than in the
system clipboard: a clip is a reference to an asset in *this* project plus a placement in time, and
pasting one into a text editor could only ever produce nonsense. It is emptied when a project
closes, because those asset ids mean nothing in the next one. And an `Alt`-drag deliberately does
**not** go through it — duplicating something must not throw away what you copied a minute ago,
which is a small thing that is infuriating exactly once.

What lands becomes the selection, in both cases: what is under the pointer when you let go is what
you were placing, and leaving the originals selected would mean the next drag moved the wrong clips.

#### Moving the playhead

Drag the ruler, or the playhead itself — it carries a narrow handle down the length of the line. The
line is otherwise inert, because it lies over every lane and one that swallowed clicks would make
the clip underneath it unselectable at exactly the time you are looking at.

#### Sound on the timeline

A file with audio lands as **two clips** — the picture on a video track, the sound on an audio
track — sharing a link. They move together, they are selected together, and deleting one deletes the
other, because losing a take's sound by dragging its picture is not an edit anyone means to make.
That rule lives in `sequence.ts` rather than in the panel: anything that moves a clip gets it,
including things not written yet.

**A linked pair is one thing to move.** Resolving each clip's placement on its own is what a group
of unrelated clips wants, and is exactly wrong for a pair: their tracks differ, so what blocks one
need not block the other — and the moment that happens the picture and its sound move by different
amounts and the take is out of sync. Found on real footage rather than imagined: two clips end to
end on V1, drag the first one right, and the audio track was clear, so the sound slid three seconds
while the picture, blocked by its neighbour, did not move at all. Nothing said so; the pair simply
arrived in two pieces.

So a link moves as a unit. The clip that was grabbed decides the distance — through the same
midpoint rule, so dragging a pair feels like dragging a clip — and the rest follow it exactly. If a
follower cannot sit there, the unit does not move: a pair that will not fit somewhere should refuse
to go there, which is a thing you can see and undo.

**`Ctrl Tab` cuts the link, and ties it back.** One gesture rather than two commands, because the
question a hand asks is never "is this linked?" — it is "should this move on its own now?", and the
answer to that is always the opposite of what is currently true. Apart, the halves select, move and
trim on their own, and can be left deliberately out of sync; a second press ties them back where
they now are. Linking does not move anything: two clips that drifted apart stay where they are and
travel together from here, because re-syncing them would silently undo the edit that separated them.

The whole group either way. Given one half of a pair, both halves come apart — leaving a partner
pointing at a link with nobody else in it would be a clip that looks tied to something and is not.
Given two clips to tie together, anything already linked to either of them joins the new group
rather than being left behind. A linked clip shows a small chain; it is dim, because being linked is
the normal state and a row of bright icons reads as a row of warnings.

One rule had to change to make an unlinked pair usable. **A press keeps the selection; a release
without a drag collapses it to the clip you pressed.** The press has to keep the group or a group
could never be dragged at all — the first press would throw the rest of it away — and the release is
where "I meant this one" and "I meant all of these" separate. Every multi-select surface works this
way, which is why nobody notices the rule until it is missing: without it, both halves stay selected
after unlinking and dragging one still moves both, which reads exactly like the unlink not having
worked.

Tracks stack the way every NLE stacks them, and it is not arbitrary — **video upward** because a
higher layer is in front, **audio downward** because nothing is in front of anything, it all just
sums. A clip may only travel within its own band; a picture landing on an audio track would be a
clip whose kind and track disagree, which every other rule in the sequence assumes cannot happen.

Dropped on an audio track, a file arrives as its sound alone. A file with no sound is refused there
rather than laid down as a silent block.

**Sound that has nowhere to go gets a track made for it.** If every audio track is busy at the
moment the picture lands, the sound cannot slide along to the next gap — that would put it out of
sync with its own picture — and dropping it would lose it. A new track is the only answer that keeps
the pair together, and it is what every NLE does.

**A file with no audio says so, rather than quietly landing as a picture.** This was reported as the
audio half of the app being broken, and the report was fair: the footage was shot without a
microphone, FLUX did exactly the right thing, and *the only evidence was a thing that was not
there*. An absence cannot be read. So it is said twice — on the card before the drag, and on the
timeline after the drop.

The card carries it because whether a file has sound is a fact about the file, knowable before you
drag it. It costs the audio sample table and nothing more: six ranged reads the first time, memory
afterwards, no decode (see [Indexing once](#indexing-once)). The drop carries it because that is the
moment the question is being asked.

And there are **two ways to have no sound**, which are not the same thing:

| | The card | The timeline |
|---|---|---|
| No soundtrack at all | `no audio` | *name* has no soundtrack — it dropped as picture alone |
| Audio FLUX cannot read | `audio ?` | *name*: FLUX cannot read this file's audio yet (`unsupported-codec:ac-3`) |

The first is a fact about the footage; the second is a fact about FLUX, and will change when the
demuxer grows. Saying the second as the first would send someone looking for a fault in their own
file, so `media/peaks.ts` returns three answers where it used to return two.

The notice clears itself after seven seconds, and every drop answers for itself — a complaint left
over from the previous drop would be describing a clip you had already stopped thinking about. The
Viewer's toolbar keeps reporting what sound the clip under the playhead has: `2ch 48k`, or `none`.

The waveform comes from [`shared/peaks.js`](shared/peaks.js): the audio decoded once, end to end,
and reduced to the loudest sample in each direction per bucket. This is what Premiere's `.pek` files
are and what its conforming progress bar is producing. Three numbers decide the shape of it:

- **400 buckets a second**, because that is the timeline's maximum zoom — one bucket per pixel
  there, and fewer than one per pixel everywhere else. Zooming past the peaks would draw a straight
  line between real samples.
- **One signed byte** per number. The limit is what the screen can show, not what the audio holds: a
  byte resolves 1/127 of full scale, which on a waveform twenty pixels tall is a sixth of a pixel.
- **Two bytes a bucket**, so an hour of audio is under 3MB — which is what makes keeping it beside
  the media reasonable at all.

Decoding sixty seconds of AAC takes about **230ms**, and reading the result back off disk takes
**3.4ms**. So it happens in the background, once, and the clip is a plain block until it arrives —
which is what every NLE shows while it is conforming. Blocking a clip on its own waveform would mean
a timeline that will not show an edit until it has read the audio.

It goes in the same media cache as the sample table, under the same staleness rules, filed under a
different name — see [Indexing once](#indexing-once). Getting that key wrong is instructive: with
one entry per file instead of one per file per thing, every value still comes back *correct*,
because an entry stamped with the wrong name is refused on read and simply rebuilt. The only symptom
is a cache that silently never hits.

`AudioData` is borrowed from a pool exactly as `VideoFrame` is, and holding one stops the decoder
rather than merely using memory. Here it is easy: nothing needs keeping, so each one is folded into
its buckets and closed in the same breath. What does need throttling is the *queue* — an hour of AAC
is 150,000 chunks, and submitting them all before the decoder caught up would hold the whole
compressed track in memory.

Not yet: any UI for removing a track (the kernel refuses to remove the last one, since a sequence
with none has nowhere to drop).

### Batch: a folder in, a folder out

`Ctrl 4`. Built for one job: an archive of 10,898 video files across 343 folders, 2.3TB of
camera footage that has to be reviewed, culled and compressed. It is three steps, and the
middle one is not in the panel.

#### The timeline is the manifest

This is the whole idea, and it is why there is no render list, job grid or selection model
anywhere in the batch code.

A clip already carries everything one encode needs: which file it plays, where in that file it
starts, how long it runs and at what rate. So a folder laid out as clips end to end **is** the
render list — and every tool that already exists is already a tool for editing it. The razor
splits a take into the two bits worth keeping. Trimming the edges drops the handles. `Shift W`
ripples a bad take out. `Delete` removes what should not survive. Drag reorders.

Then export writes one file per clip left on a video track. Nothing was ever "marked for
export"; the edit is the instruction.

That is also what makes the cuts **frame-accurate**. The export re-encodes from the original
rather than copying out of an archive, so there is no keyframe to snap to — a 4.000s cut from a
50fps source comes out at exactly 200 frames, verified on real footage.

#### 1 · Import a folder

Choose a folder and FLUX scans it, then says what importing it would mean *before* doing it —
how many files, how much footage, and which folders it walked past. The last one matters more
than it sounds: an editing suite writes a `Proxies` folder of low-resolution stand-ins next to
the originals, with the same filenames and a suffix. Measured in this archive: folders of 178
proxies beside the 178 originals. An import that took both would bring every shot in twice and
look like a success, so the scan skips them — and **names every folder it skipped**, because a
filter you cannot read is a filter you are trusting.

The list lives in [`shared/footageFilter.js`](shared/footageFilter.js): `Proxies`,
`Media Cache`, `Peak Files`, `Auto-Save`, `Project Backups`, `LOCAL CACHE`. Render folders —
`EX`, `AE`, `Pre-comp` — are deliberately **not** on it. They hold finished exports rather than
duplicates of camera footage, and some are the only copy of something delivered; skipping them
would be a decision about someone's work rather than about clutter.

Scanning 11,213 files across 1,080 folders takes about 400ms, so this is one IPC call rather
than the renderer walking the tree a listing at a time.

Everything is **linked, never copied**, and not as a preference — copying hundreds of gigabytes
into the project to review it is not a thing anyone wants. The copy-or-link question the
Content Browser asks is therefore not asked here.

**Stills are left out, and counted.** A batch import is for footage. A still has no duration of
its own, so it arrives as a five-second clip of a static picture — and a folder of camera
footage with a logo and three reference shots in it becomes a review with four frozen clips
padding it out. They are reported rather than silently dropped, because "14 files, 9 clips" is a
discrepancy someone would otherwise have to go and explain to themselves. The Content Browser
still imports images exactly as before.

Export refuses a still too, for the same reason plus one more: it *could* encode one —
`-loop 1 -framerate n` makes a video of a held frame — and that is precisely why leaving it out
is a decision rather than an oversight. The five seconds come from a UI default, so the length
of the file produced would be a number nobody chose.

Clips land end to end on a new sequence named after the folder, in scan order, which for camera
footage is also chronological. The sequence takes its shape from the first clip the same way a
hand drop does.

**Two thousand clips is the limit**, and it is a limit on what can be reviewed rather than on
what the timeline holds. Past a couple of thousand blocks a sequence stops being something you
scrub and becomes a list you scroll. Pointing at a whole drive therefore does not import it: it
answers with the folders holding the most footage, so the next move is obvious. The busiest
folder in this archive holds 406 files, so a per-shoot import always fits.

**An import is one undo step.** Placing 406 clips by calling `addClip` 406 times would push 406
history entries, overflow the 200-entry limit and throw away everything the session had done
before it — leaving an import that takes 406 presses to undo. `asOneStep` in
[`kernel/sequence.ts`](src/kernel/sequence.ts) suspends the notification and the snapshot and
publishes once, so `Ctrl Z` takes the whole import back out, which is the only sensible meaning
of undoing an import.

Clips are laid out in **whole frames**, which is subtler than it looks. `addClip` snaps every
start to the frame grid, so placing a clip at the exact second the previous one ended lands it
up to half a frame *before* that end — the two overlap, both are under the playhead for one
frame, and the compositor blends them. Across a hundred clips that is a hundred single-frame
cross-dissolves nobody asked for, each too brief to see and too consistent to be an accident
once noticed. Whole frames make one clip's end exactly the next one's start.

#### 2 · Review it on the timeline

The panel says so and then gets out of the way. This step is the editor.

#### 3 · Render what survived

Select the clips you want and add them to the queue in **Render**. That panel is where the
settings and the queue live; Batch's job ends once the footage is on the timeline.

### Render: add, then start

`Ctrl 5`. Two windows in one panel, which is both what was asked for and the shape the work
has: settings are a decision you make once for a project, and the queue is a list you build over
an afternoon.

Modelled on Adobe Media Encoder rather than a Premiere export dialog. Select clips, press
**Add selection**, keep editing, add more — from another sequence if you like — and press
**Start** when the list is right. The queue is saved beside the project document, so a list
built today is still there tomorrow.

The first setting decides what one job *is*: **each clip as its own file**, which is what an
archive wants, or **the whole sequence as one file**, which is what a deliverable wants. Both go
through the same queue, the same encode and the same verifier.

#### `Ctrl M`, and a page rather than a dialog

Select clips, press `Ctrl M`: they are queued and the **Export** workspace opens with them on
screen, each with a frame from the footage. With nothing selected it takes the whole sequence.

One keystroke doing two things, and that pairing is the point — "send this to render" is a single
thought, and splitting it into *add* and then *go and check* is how a queue ends up with something
in it nobody looked at.

The page is three panels: what is about to be rendered, what it will be rendered as, and the
Viewer. No Timeline and no Tools, because this is not where you edit — and an export page that
invited a trim would invite trimming something already queued, which the snapshot rule says will
not take effect.

**The pictures are the point of the left-hand panel.** The Render panel already lists the queue as
text, and this lists the same queue, which is deliberate rather than duplication: they answer two
different questions. A row of text beside the settings answers *how many and how long*, which is
what you want while deciding a bitrate. The cards answer **"is that the right footage?"** — and a
filename tells you a clip is called `DSCF3957`, while a frame of it tells you it is the shot you
meant.

#### Sections, and the two switches at the top of them

The settings are grouped the way a deliverable is described — **Video**, **Audio**, then
**Captions**, **Effects** and **Metadata**, then **General** for the things that are about the run
rather than the file. The last three are scaffolding and say so: shown, off, and carrying the
reason they are empty. Leaving them out would be tidier and would lose the answer to "can FLUX
burn in captions yet", which is a question someone will come here to ask.

Video and Audio each carry a switch, and those two are the coarsest thing on the page on purpose.
Before anyone asks what bitrate the sound should be, the question is whether there is any:

| | |
|---|---|
| **Video off** | A sound-only file. For a sequence render the picture half of the filter graph is not built at all — a composite nobody is going to keep still costs every decode and every overlay. |
| **Audio off** | Every output written with no audio stream. |
| **Both off** | Refused. Turning the second one off puts the first back, so the pair behaves as a choice of three states — a file with neither is not a smaller render, it is a mistake. |

They are a **ceiling, not an override**. Audio on does not put sound into a clip whose track was
muted; the timeline still decides that, and the switch only decides whether the question is asked.

A sound-only file keeps its `.mp4` extension rather than becoming `.m4a`. AAC in mp4 is an ordinary
sound file, and an export whose *names* changed when a switch was flicked would break every resume
— `alreadyDone` looks for the output path, and a path that moved is a path that is not there.

The verifier branches with it. There is no picture to measure, so what is left is that there must
be sound and there must be **no** picture — and the second half matters as much as the first,
because without it, flicking Video off and rendering again would be skipped by resume: the old file
with its picture passes every check that remains.

#### Inherit unless touched

Every field in Video and Audio is empty until someone moves it, and empty does not mean *unset* —
it means **follow whatever is being rendered**. The inherited value is the placeholder, so the box
is never blank: "what will this be?" is answered whether or not anyone has typed in it. Type a
number and the field says it is yours, and offers `follow` to hand it back.

That way back matters more than it looks. Without it the only route from `1920` to "follow the
sequence" is selecting the text and deleting it, which nobody discovers — so every field anyone
ever touched would stay touched forever.

| | following | typed |
|---|---|---|
| **Width / Height** | each source's own size — 4K stays 4K | fitted and padded to the box, never stretched |
| **Force a rate** | the frame-rate policy above | wins over it |
| **Bitrate** | 192 kbps | yours |
| **Sample rate / Channels** | each source, untouched | resamples or downmixes every clip |

**Inheriting is not the same as defaulting, and that is the whole of why this is one function
rather than a `??` in two planners.** `null` on sample rate in clips mode emits **no flag at all**,
so a 44.1kHz source stays 44.1 and a 48kHz one stays 48. Resolving it to "the sequence's 48kHz"
and emitting `-ar 48000` would quietly resample half an archive — every file still playing, every
file subtly altered. For a *composite* the opposite is true: the mixdown has already resampled to
the sequence's rate, so stating it is simply true. `resolveOutput` in
[`kernel/renderSettings.ts`](src/kernel/renderSettings.ts) is the one place that difference is
decided, and `verify:render-queue` checks it by rendering with nothing touched and asserting the
written file is byte-for-byte the shape its source was.

A typed size is checked against **itself**, not against the source. The verifier compares output
dimensions to the source's *displayed* size by default — the rotation rule — so a job told to
scale would fail every check unless it is also told what it asked for.

Two consequences worth naming:

- **A scaled cut is never "the whole file"** for the never-write-a-bigger-file rule. That rule
  falls back to keeping the original, and the original is the size someone just asked it not to be.
- **Dimensions round to even numbers.** `yuv420p` chroma is subsampled two-to-one on both axes, so
  an odd width is not a slightly wrong size, it is a frame the encoder refuses outright.

The audio *format* is a list with one entry. AAC in mp4 plays everywhere this archive has to be
readable, which is the whole requirement — and unlike the video settings above it, the bitrate was
chosen rather than measured, because the encode tests scored pictures and nobody ran a VMAF on a
soundtrack. The panel says so where the field is.

#### A queued job is a snapshot, not a reference

This is the one decision everything else follows from, and it is what makes add-then-start safe.

A job could have been "clip `c17` of sequence `s3`", resolved to a source and a range at render
time. It is not, and must not be: the whole point of a queue you add to over time is that you
carry on editing afterwards. By the time Start is pressed, `c17` may have been razored into
three, trimmed, moved, or deleted outright — and a queue that silently rendered whatever that id
means *now* would produce files matching nothing anyone reviewed.

So adding resolves everything immediately: source path, in point, duration, speed, output name.
The clip id is kept only so the timeline can say which clips are queued; nothing reads back
through it. `scripts/verify-render-queue.mjs` asserts exactly this — it deletes a queued clip and
razors another, and requires both jobs to come through unchanged and still renderable.

The honest cost: edit a clip after queueing it and the queue still holds the old range. That is
why re-adding a clip **replaces** its row rather than making a second one. Pressing Add twice is
something people do when they are not sure it worked, and the result should be the same queue,
not the same clip rendered twice to the same filename.

#### What is a choice, and what is a finding

Most of the encode is not a choice. The codec, the rate control, the pixel format and the `hvc1`
tag were arrived at by encoding this library's own footage and scoring it, and presenting them as
fields would imply otherwise — so they are shown under *What the encode is* rather than offered.

Four things are genuinely yours:

| | |
|---|---|
| **Quality (CQ)** | Lower is bigger and better. 26 measured a 1% low of 95.64 VMAF. |
| **Keyframes every** | 30 frames is about a second, which is what lets the result be re-cut later with no re-encode. Costs 4.9% size. |
| **At once** | The disk saturates before the GPU does — NVENC allows eight sessions, but four parallel reads of large files on one spindle is slower than two. |
| **Frame rate** | Keep each clip's own, or conform to the sequence. |

That last one has a trap in it, which is why it defaults to *keep*. This library mixes 25, 29.97
and 50fps, and the 50fps material is kept for slow motion. Conforming resamples all of it — and a
silent conform is the exact failure the verifier exists to catch, since an Adobe export in the
encode tests turned an 1850-frame 50fps source into 1108 frames at 29.97 and looked perfectly
healthy. Choosing it should be something you did on purpose.

#### The timeline decides what is in the file

Hiding a track and muting one are edits, not view state, and the render reads them — in **both**
modes, which it did not used to. A hidden video track was still exported clip by clip, while the
sequence render left it out, and two modes disagreeing about what the timeline means is worse than
either answer on its own.

| | |
|---|---|
| **Hidden video track** | Its clips are not exported, and each is named in the panel as refused rather than quietly absent. |
| **Muted audio track** | The clips it belongs to are written with **no audio stream at all** — `-an`, not a fader at zero. |
| **Solo somewhere else** | The same, through the same rule: `isTrackAudible` is the one place solo and mute become an answer. |
| **A clip with no linked audio** | Untouched. There is no track state to obey, and silencing it would be a decision nobody could see on screen. |

Hidden clips are dropped **before** the names are assigned, and that is visible in the output
folder. Naming first and filtering second would leave `DSCF3957.mp4` and `DSCF3957_03.mp4` with no
`_02` between them, which reads as a failed export rather than as a track you chose not to render.

**The fader is deliberately not in that table.** A level is how loud you needed something while
reviewing; baking it into an archived original would quietly alter the footage. The *sequence*
render does apply it, because a deliverable is supposed to sound like what was heard — so the two
modes differ here on purpose, where they used to differ by accident.

> **This is also a resume problem, and that is the part worth the verifier knowing about.** A file
> with sound passes every other check — size, rate, frame count, profile, pixel format. So without
> the verifier knowing what the sound was *supposed* to be, muting a track and rendering again
> would skip every clip, and the archive would keep whatever the first run produced, permanently,
> with nothing saying so. `verify` now asserts the output's audio against the job: silent means
> there must be none, and not-silent means there must be some *when the source had some*. That
> asymmetry is why `sourceFacts` reports whether a source has audio at all.

When this landed, it barely moved on this archive: the Fujifilm bodies record `pcm_s24le`, the
demuxer could not read it, and **127 of 128 clips** in a real shoot folder had no audio clip on the
timeline to mute. That is fixed — see *Uncompressed audio* below. The same check now reports
**128 linked clips silenced, 0 untouched**.

#### Speed changes render

A stretched clip used to be refused, which was wrong: adjusting time is an edit like any other
and the render is what it is for. A clip at speed `s` covers `duration × s` seconds of its source,
so the read limit goes on the input and `setpts=PTS/s` compresses it back down; audio follows
through `atempo`, chained because one instance only accepts 0.5 to 2.0, so 4× is `atempo=2,atempo=2`.

The rate is then **forced**, and that part is not optional. `setpts` retimes frames without
removing any, so a clip played at 2× keeps every frame in half the time: a 50fps source comes out
a perfectly valid 100fps file, which is not what anyone meant by "twice as fast". Forcing the rate
makes ffmpeg drop or duplicate to hit it, which is what every NLE does with a speed change — and
it is the same mechanism the conform policy uses, rather than each having its own.

Measured on real footage: 3s out at 1×, 2× and 0.5× gave 150, 152 and 149 frames, all at 50fps,
covering 3s, 6s and 1.5s of source respectively.

#### The whole sequence as one file

Pick it in **Render**, press **Add**, press **Start**, and one mp4 comes out: every visible video
track composited into the sequence's frame, every audible audio track mixed down, gaps black and
silent, and the file exactly as long as the sequence says it is.

The queue, the settings, the encoder, the log and the verifier are the same ones. What is new is a
planner ([`kernel/sequenceExport.ts`](src/kernel/sequenceExport.ts)), a filter graph
([`shared/sequenceGraph.js`](shared/sequenceGraph.js)) and a runner
([`electron/renderSequence.js`](electron/renderSequence.js)) — because compositing, mixing and
gaps genuinely did not exist anywhere.

**Two planners, not a flag.** `planExport` names its outputs so several cuts of `DSCF3957.MOV` do
not collide, decides whether a cut is a whole file so the never-write-a-bigger-file rule has
something to fall back on, and offers a frame-rate policy. A sequence render needs none of the
three: there is one output, a composite has no original to keep instead, and a sequence has a rate
of its own. A flag would have left four branches inside one function, each of them the whole
difference.

#### Composited by ffmpeg, not by the Viewer's canvas

The Viewer already composites — it decodes through WebCodecs and draws each layer into the
sequence's frame with `drawUpright` — and piping its canvas into ffmpeg would have reused that.

It would also have meant a decode, a rasterise, a read-back and a copy through IPC *per frame*,
with an hours-long render at the mercy of a panel being closed — the exact thing the queue lives in
the main process to avoid. ffmpeg can composite natively, on frames it is already decoding. The
price of going native is that gaps, differing source sizes, rotation and per-clip speed each have
to be handled on purpose rather than falling out of a canvas.

The graph is one opaque black base the length of the sequence, and one `overlay` per clip on top of
it, bottom track first:

```
color=black:s=WxH:r=R:d=D ──────────────────────────────────────[b]
clip ─ setpts to its place ─ fps ─ fit ─ pad transparent ───────[v0]
[b][v0]  overlay ──────────────────────────────────────────────►[x0]
[x0][v1] overlay ──────────────────────────────────────────────►[x1] …
```

| | |
|---|---|
| **Gaps** | The base is `d=D` and the output is `-t D`, so the length comes from the sequence and not from where the footage stops. Time with nothing over it shows the base, which is black. The mix has a full-length silent input under it for the same reason. |
| **Layers** | Overlays are applied bottom track upward, so the last one written is in front — the order `layersAt` walks, for the same reason. A hidden track is left out: hiding one is a statement about what the sequence looks like. |
| **Different shapes** | Every clip is scaled to *fit* the frame keeping its aspect, then padded out with **transparent**, not black. That is what makes it a composite — a portrait clip over a landscape one has to let the layer beneath show down each side. |
| **Rotation** | Nothing transposes. ffmpeg applies the display matrix on decode, so `scale` already sees the *displayed* size — which is the point, since two files in five here are coded 1920×1080 with `rotation: 90`. Scaling first and turning after fits a vertical clip to a landscape box and then rotates it. |
| **Ten bits** | The base, every layer and every overlay are 10-bit. Compositing at eight and encoding to `p010le` would throw away exactly the bits that flag exists to keep. |

**Placement is absolute, and that is what keeps it in step.** Each clip's frames are stamped with
where they belong — `setpts=…+start/TB` — and `overlay` pairs frames by timestamp. The obvious
alternative was one full-length stream per track, built by `concat`-ing clips and generated gaps;
it was rejected because `concat` renumbers timestamps from the start of the lane, so every
segment's rounding adds to the one before it and a lane of fifty clips can drift a second from the
base by its end. An upper layer appearing a frame early, deep into a long sequence, is not
something anyone finds by watching. Absolute placement cannot accumulate.

Clips need no padding to reach the sequence's length either: `eof_action=pass` passes the base
through once a clip's frames run out, and `overlay` already passes it through before a clip's first
frame arrives. Measured: a 2s clip placed at 110s of a 120s sequence produced exactly 3000 frames
at 25fps, black at 50s and 115s, content at 111s, and streamed at 7.8× realtime without buffering
the 110 seconds it waited through.

**The graph is written to a file**, not passed as an argument. Windows caps a command line at about
32,000 characters and one clip is roughly 200 of them, so a 150-clip sequence would refuse to start
— and refuse with an error about the command line rather than about the render.
`-filter_complex_script` has no such limit. It is kept beside a failed `.flux-part`, because a
composite that came out wrong is diagnosed by reading the graph that produced it.

#### The mixdown agrees with what was heard

Sound comes from audio tracks through `trackLevel` — the mixer's own function, the one place mute,
solo and the fader become a number. It is imported rather than reimplemented, because "the render
agrees with playback" is only true if both ask the same question. A track at zero is dropped from
the plan entirely rather than mixed in at silence, which saves decoding a file nobody will hear.

Each clip is `asetpts`, then the `atempo` chain if it is stretched, then `volume`, then `adelay` to
put it where it belongs — the audio form of the `setpts` offset above, applied after the speed
change for the same reason: a stretched clip is longer or shorter than its source, and where it
starts is not.

`amix` then sums them, with **`normalize=0`**, and that is mandatory rather than tidy: amix divides
by its input count by default, so adding a second audio track would halve the first. A mixdown that
gets quieter the more you put in it is not what any mixer does and not what was heard.
`dropout_transition=0` stops it ramping the remaining inputs when one ends, which would move a
level nobody touched.

Measured from the rendered file: unity came out at −15.4 dB mean, and the same sequence with the
fader at −6 came out 5.90 dB down.

#### "The source" is now the sequence

The verification rules do not change — same displayed size, same frame rate, the frame count asked
for, `Main 10`, `yuv420p10le`, duration within a second, frames *counted* rather than read. What
changes is what they are measured against, because there is no single source file to compare a
composite with. What a sequence render has to come out as is what the **sequence** says: its frame,
its rate, and its length including the gap at the end. So `verify` is handed the sequence in the
shape it expects a source file in, which is why it takes a facts object rather than opening a file
itself.

One assertion is added, because the picture checks cannot see it: the output must have an audio
stream, of the sequence's length. A mixdown that stopped where the last clip did is out by the
length of the trailing gap, and nothing about the video would say so.

The never-write-a-bigger-file rule is deliberately **not** applied. It answers "the encode cost
more than the footage it came from, so keep the original" — and a composite has no original. There
is no file on disk that is this sequence; that is the whole reason for rendering it.

*Not yet in a sequence render: **stills**. Every layer is a decoded video stream placed by
timestamp, and a held frame would need `-loop 1` and a rate of its own. A still on the timeline is
named in the panel as left out rather than silently dropped. The per-clip mode refuses stills too,
but for a different reason — there the length would be a number nobody chose, while here the
timeline chose it, so this one is a gap in the graph rather than a decision about archives.*

#### Where the queue lives, and why it is in two places

The **list** is project state. It belongs to the project, is saved beside the document, and has to
survive a restart. The **running** is in the main process, because an hours-long encode must not
be at the mercy of a panel closing — "I closed the panel and my nine-hour render stopped" is not a
thing an archiver may do.

The list is written to `project_files/render-queue.json` rather than into the `.flux` document,
and that placement is deliberate. Its rows change constantly while a render runs — waiting,
running, done, several a minute — and folding that into the document would light the unsaved dot
on every finished encode. A dot that appears for something you did not do is a dot people learn to
ignore. `project_files` is already described as the part FLUX owns, "the document, and whatever
bookkeeping comes later"; this is that bookkeeping.

A row that was mid-flight when the app closed comes back as **waiting**. A row saying "running"
with nothing running is a lie the UI would have to explain, and the work genuinely was not
finished — the partial file is already gone, because an encode writes to a temporary and renames.

#### Selection had to move first

None of this could read the selection, because there was no selection to read: it was
`useState<Set<string>>` inside the Timeline panel, and a panel cannot see another panel's state.

It now lives in [`kernel/selection.ts`](src/kernel/selection.ts), for the same reason
`kernel/tools.ts` owns the tool in hand — a mode a panel owned would be a mode every other panel
had to reach into, and closing that panel would leave the app holding nothing. The Timeline still
*drives* it and no longer owns it, so closing the Timeline no longer throws away what you had
selected.

It also prunes itself. A selection outlives the clips in it: undo takes them away, so does
deleting, and a selection still pointing at a clip that is gone makes `Delete` and every other
command quietly do nothing. The Timeline used to prune in its own handler, which only worked while
the Timeline was open — fine when it was the only owner, not fine now.

#### The encode, and why every flag is what it is

[`shared/renderFormat.js`](shared/renderFormat.js) holds it once — imported by the renderer to
show it, the main process to run it, and the harness to check it.

```
ffmpeg -ss <in> -i SOURCE -t <len> \
  -c:v hevc_nvenc -preset p6 -rc vbr -cq 26 -b:v 0 -g 30 \
  -pix_fmt p010le -tag:v hvc1 \
  -c:a aac -b:a 192k -dn -movflags +faststart \
  -f mp4 OUT.mp4
```

None of those numbers is taste. Each was measured against this archive's own footage with VMAF,
against x265 and against Adobe Media Encoder on identical clips.

| | |
|---|---|
| `-cq 26` | Constant quality. Worst 1% low measured anywhere: **95.64 VMAF** — the visual transparency threshold. Matched x265 CRF 20 on size and mean quality, 10–13× faster. |
| `-b:v 0` | **Mandatory**, not redundant with `-rc vbr`. Without it NVENC silently caps the bitrate and constant quality stops being constant. |
| `-g 30` | One-second keyframes, so the *archive* can be re-cut later with `-c copy` at no quality cost. Costs 4.9% size; VMAF measured flat across GOP 250/60/30/15, so the precision is bought with storage alone. |
| `-pix_fmt p010le` | 10-bit from 10-bit. This footage gets re-encoded again when it is reused, and ten bits survives that second generation far better than eight. |
| `-tag:v hvc1` | **Mandatory.** Without it HEVC-in-MP4 will not play in QuickTime, Finder preview or Premiere on macOS, which makes the archive unusable on half the machines that need to read it. |
| `-f mp4` | Stated rather than inferred: an encode writes to a `.flux-part` temporary and renames on success, and ffmpeg picks its muxer from the extension. Without this the whole command is refused with `Error opening output files: Invalid argument`. |
| no `-vf scale` | 4K stays 4K. Punch-in is the main value of 4K b-roll, and an archive that threw it away would have to be shot again. |
| no rate conform | 25, 29.97 and 50fps all stay as shot. The 50fps material is kept for slow motion. |

Two measured findings worth keeping, because both are counterintuitive:

**Adaptive quantisation lost.** `-spatial-aq`, `-temporal-aq` and `-rc-lookahead` were tested on
four clips including deliberately-chosen hard strobing footage, on the theory that they would
help exactly there. They used 9–16% *more* bitrate **and** scored worse on mean, 1% low and
minimum, on 4 of 4. They are absent on purpose rather than by omission. The honest caveat: VMAF
under-rewards AQ, because AQ targets banding and VMAF barely weights it. The decision stands on
consistency and on it also costing more — but if banding ever turns up in dark gradients,
re-test by eye rather than by VMAF.

**Strobing footage is easier to compress, not harder.** The hardest-looking clip in the archive
scored 99.91 VMAF at 5.8 Mbps. A strobe-lit room is mostly near-black between flashes and blown
flat during them, and neither holds detail. What costs bitrate is fine detail in motion —
daylight foliage, crowds, texture. Nobody should over-engineer for the strobes.

Measured compression: 10.6× to 23.9× across varied content. **12× is the planning figure**, and
it is what the panel's estimate uses.

#### Why an encode is not finished when ffmpeg exits 0

This is the part that justifies its own module. During the encode tests, an Adobe Media Encoder
export produced **1108 frames at 29.97fps from an 1850-frame 50fps source**. Exit code fine.
File plays. Thumbnail correct. Two thirds of the motion gone, and nothing anywhere said so — it
would have surfaced months later, when someone went looking for slow motion they thought they
had archived.

So every output is re-opened and asserted against its source before it counts as done: same
displayed size, same frame rate, the frame count the cut asked for, `Main 10`, `yuv420p10le`,
duration within a second. A file that fails is reported as a failure and **not counted**, which
is the only thing that makes the saving at the end mean anything.

**The frame count is counted, not read.** `nb_frames` is a container field an encoder can get
wrong, and a wrong one is exactly the failure being guarded against.

**The size comparison is against the source's *displayed* size**, and that is the trap that
nearly got through. ffmpeg applies the display matrix on decode and writes upright pixels, so a
source coded 1920×1080 with `rotation: 90` produces a correct output that is 1080×1920 with no
rotation flag at all. A verifier comparing `width` to `width` fails it — on **two files in
five** in this archive.

An encode writes to a `.flux-part` temporary and renames on success, for the same reason the
project document does: a crash or a cancel must not leave a half-written file where a finished
one should be, because a resumable run asks "does the output exist" and a truncated file that
answers yes is a hole nothing would find. A file that fails *verification* is kept, under its
temporary name — it is the evidence for diagnosing the one clip that went wrong, and no resume
will mistake it for finished work.

**Never write a bigger file.** Some of this material is already a 35 Mbps delivery export, and
some of it — finished logo animations, social exports — is already compressed hard enough that
re-encoding a few seconds of it costs more than it saves. Where the encode loses and the cut is
the whole file, the original is copied instead. Where it loses on a *trim* there is no original
of that range to keep, so the encode is kept and the row is flagged in the log. The panel says
"larger by 1.3×" rather than "0.8× smaller", which is not a sentence.

#### The log is the point

Every finished job appends a row to `flux-export-log.csv` in the output folder: source, its
size, output, its size, the ratio, the cut, the source and output frame rates, the frame count
and the frame count expected.

Two reasons, and neither is bookkeeping. The first is that it is the only way the saving is
*provable* — "2.3TB became 195GB" is a claim, and a file with one row per clip and a ratio on
each is the evidence. It is what makes it safe to delete an original. The second is that it is
how the one clip that went wrong gets found, which is not something a progress bar can do across
four hundred encodes.

A log that cannot be written says so once and does not stop the export. Losing nine hours of
encoding because a CSV was open in Excel would be absurd.

#### What it needs, and what it does not do yet

ffmpeg and ffprobe on `PATH` — `winget install Gyan.FFmpeg` — plus an NVIDIA card for
`hevc_nvenc`. Both are checked once, up front, and said plainly: the difference between "no
NVIDIA card" and "your first 400 encodes failed" is worth one probe.

*Not yet: the unattended whole-tree mode that compresses an archive with no review at all. The
pieces are all here — the scan, the format, the queue, the verifier and the log — and what is
missing is the job that walks a tree writing a parallel output tree rather than reading a
sequence.*

### Serving media

[`electron/assetServer.js`](electron/assetServer.js) exists for one reason: **byte ranges**.

Chromium's media stack decides whether a source is *seekable* from the response it gets. No
`Accept-Ranges`, no `Content-Length`, and a `Range` request answered with a plain `200` all say the
same thing — this is a stream you may read from the beginning and nothing else. `video.seekable`
then comes back empty, assigning `currentTime` silently does nothing, and the element plays the
couple of seconds it managed to buffer and stops.

Which is not what a server bug looks like from the outside. It looks like a viewer that can only
ever show the head of a clip. FLUX shipped exactly that until a 60-second file was pointed at it:
`seekable.end(0)` was `0`, a seek to 45s reported back `0`, and only the first three seconds ever
buffered.

So the handler answers properly: `Accept-Ranges` and a real `Content-Length` on every response,
`206` with a `Content-Range` for a range, `416` for one that cannot be satisfied, and a *stream* for
the body so a 4GB take costs 64KB of memory rather than 4GB.

One trap worth naming, because it bit the checks before it bit anyone else: **a small file seeks
fine with no range support at all**, because Chromium simply buffers the whole thing. A check that
watches a short fixture seek therefore passes on a completely broken server. The contract is checked
against the headers directly instead.

### What the demuxer reads, and what the pictures do about rotation

Two additions that only real camera footage would have forced, both in
[`shared/mp4.js`](shared/mp4.js).

**HEVC.** The demuxer read `avcC` and nothing else, so every HEVC file fell back to the `<video>`
element — which plays, so nothing looked broken; it just quietly stopped being
frame-addressable, which is the entire point of the pipeline. Sampled across this archive: 29% is
HEVC **4:2:2 10-bit** (`Rext`, what the Fujifilm bodies shoot) and 13% is HEVC Main. Measured
directly against this machine's Chromium, all of it configures *and decodes* — including the 4:2:2
profile, which is the one a reasonable person would assume a browser could not touch.

The codec string is the fiddly part. `avc1.PPCCLL` is a transcription of three bytes; HEVC's is a
derivation, and the field that catches people is the compatibility mask — the bitstream stores
`flag[j]` MSB-first and the codec string wants that same 32-bit word **with its bit order
reversed**. Main 10, whose only set flag is `flag[2]`, is `0x20000000` in the file and the single
digit `4` in the string. Chromium's `isConfigSupported` was measured not to validate that field at
all, so getting it wrong would not fail here — it would be worse: a string that is wrong and
accepted, carried into the index cache and printed in diagnostics, disagreeing with every other
tool that reads the same file.

**Rotation.** Cameras do not rotate pixels. A clip shot with the body turned is coded exactly as the
sensor read it — 1920×1080 — and the container carries a 3×3 matrix in `tkhd` saying how to put it
back up. In this archive that is not an edge case: **two files in five** are vertical, every one
coded landscape with `rotation: 90`.

Nothing in FLUX read that matrix, and the reason it went unnoticed is instructive. Chromium applies
it for `<video>` itself, so thumbnails and the probe had always drawn these upright — the same clip
looked right on its card and lay on its side on the canvas. Parsing is checked against `ffprobe` on
real files rather than against a fixture, and agreed on 29 of 29 including a 270° case.

`width` and `height` stay **coded**, because that is what a decoder must be configured with; a
separate `displaySize()` gives the shape on screen. Collapsing the two is how a vertical clip ends
up configured 1080×1920 and decoding nothing. The compositor fits on the *displayed* shape and then
rotates — fit first and rotate after and the picture overflows one axis and gaps the other.

The displayed shape is also what a sequence takes from its first clip, which was a real bug before
rotation was read: a folder of vertical footage produced a landscape sequence with the whole review
letterboxed inside it.

#### Uncompressed audio

38% of this archive is `pcm_s24le`, and for a long time the demuxer handled only AAC — so those
files landed as picture with no sound at all. The card said *"FLUX cannot read this file's audio
yet"* rather than *"no soundtrack"*, which is the distinction
[`media/peaks.ts`](src/kernel/media/peaks.ts) exists to keep: telling someone the second when it is
the first is a lie they could act on, by going to look for a fault in their footage.

PCM needs no decoder — the samples *are* the audio — so it was a demuxer gap rather than a platform
one, and three things had to be true before it closed.

**One box, three layouts.** A sound sample entry comes in versions, and they are not cosmetic
variations. v0 is the plain 28-byte preamble. v1 adds `bytesPerPacket`, which is the only honest
depth on an `in24` track — ffmpeg writes `samplesize` 16 on 24-bit audio, and believing it costs a
third of every sample. **v2 is a different structure entirely**, with the rate as a float64 and an
explicit flags word, and it is what QuickTime and these cameras write for `lpcm`. Reading a v2
entry at v0 offsets yields *3 channels at 1Hz* — which is what FLUX was doing, and why it reported
`unsupported-codec` rather than crashing.

The four-letter type sets the defaults — `twos` big-endian, `sowt` little, `in24`/`fl32`
big-endian — and a `wave`/`enda` box overrides the endianness, which is how ffmpeg writes
little-endian samples into a box whose name means the opposite.

**An index of packets, not of frames.** At 48kHz a PCM frame *is* a sample, so indexing one the way
a compressed track is indexed means 336,336 entries for a seven-second clip — 11MB of index for
seven seconds, and over a gigabyte for one shoot folder. That is the real reason this was not just
"accept `lpcm`". Frames are grouped into packets of 4096 instead, which is 85ms at 48kHz: 84
entries for that same clip. Packets never straddle a chunk, because frames are contiguous *within*
a chunk and chunks are not contiguous with each other — a packet that crossed one would read
whatever the muxer put in between, most often a lump of video, as audio. Every packet is a key
frame, because every PCM frame is, which is what makes seeking in it exact.

**Converting it is arithmetic, and all three ways to get it wrong sound like noise.** The divisor
is 2^(n-1), not 2^n and not 2^(n-1)-1 — the first halves the volume of the whole archive and the
second lets the most negative sample clip. The sign lives in the top byte, so a 24-bit value is
assembled and then sign-extended with `<< 8 >> 8`; without that every negative sample becomes a
large positive one. And the byte order is what `enda` is for. None of these throws, and none of
them looks wrong on a waveform — a bad divisor is quiet audio, a bad sign is loud audio.

So they are **measured**. `verify:demux` decodes one 440Hz tone from four fixtures — `sowt`,
`twos`, `in24` and `fl32` — and requires all four to come back as the same tone at the same level,
so whichever path is wrong is the one that disagrees. Measured: 0.125 peak at 440Hz, identical
across all four. The `lpcm` v2 layout has no fixture, because ffmpeg will not write one; it is
checked against real camera footage instead, and cross-checked against ffmpeg's own decode of the
same file — FLUX reads −8.45 dB peak where ffmpeg reports −8.1 dB across both channels.

The result on a real shoot folder: four clips imported, **four linked with sound** where it used to
be one, waveforms drawn from the same arithmetic the mixer plays, and the mixer scheduling 46
buffers with none late.

### Playback

`Space` plays. The playhead runs down the Timeline, the Viewer shows the clip under it, and the
ruler scrubs.

**There is exactly one clock**, in [`src/kernel/playback.ts`](src/kernel/playback.ts). Panels read
it and render; only commands move it. The moment two panels each keep their own time they disagree,
and "the picture is a few frames off the timeline" is the kind of bug that makes an editor stop
trusting the tool.

**Whatever is playing the media *is* that clock**, while something is. Otherwise the wall clock.

This took being wrong once to see. The first version accumulated `performance.now()` deltas on every
animation frame and treated the `<video>` as a follower to be dragged into line. Two things go
wrong with that, and both were measurable:

- **`requestAnimationFrame` is not a clock.** Chromium throttles it whenever it decides the window
  does not need painting. The media pipeline keeps running regardless, because it is driven by the
  audio device — so the picture stayed correct and the sequence's own idea of the time fell behind
  it, in visible one-second lurches.
- **Correcting the follower means assigning `currentTime`, which is a seek.** Doing that every frame
  flushes the decoder every frame. Measured: about one seek per second, `rAF` down from 75fps to 4,
  and the clock 770ms behind the picture. Handing the clock to the element instead: **zero** seeks
  during playback, 75fps, worst drift **15ms**.

So the element reports where it is and the sequence follows; animation frames only decide how often
the UI resamples. The element is moved in exactly one circumstance — a deliberate seek, which the
transport announces with a token. Moving it because the time changed would mean moving it because it
moved.

#### The pipeline

An mp4 whose index FLUX can read is **demuxed here and decoded through WebCodecs**, and the frames
are drawn to a canvas. Anything else — a webm, a container the demuxer will not guess at, a build
without WebCodecs — falls back to a plain `<video>`. The Viewer's toolbar says which path a clip is
on. A fallback rather than a refusal: a viewer that shows nothing because it could not parse a
sample table is worse than one that shows the file the old way.

Four pieces:

- [`shared/mp4.js`](shared/mp4.js) reads the sample table — where every frame is, how big it is,
  when it is shown, and whether it is a keyframe. `VideoDecoder` decodes; it does not demux, and it
  has no idea what an mp4 is. This is also what makes seeking possible: inter-frame codecs decode
  forward from a keyframe and nowhere else, so a seek is always "rewind to a keyframe, decode
  through". It reads bytes through a `ByteReader`, which is the same interface over ranged
  `flux-asset://` fetches in the app and over a file handle in the harness — so the part most likely
  to be subtly wrong is testable with no app running.
- [`src/kernel/media/videoSource.ts`](src/kernel/media/videoSource.ts) turns that index into frames:
  seek to the keyframe, decode forward, keep a small window, hand out the frame belonging to a given
  moment.
- [`src/kernel/media/indexCache.ts`](src/kernel/media/indexCache.ts) means a file is read once, not
  once per open — see below.
- The Viewer draws it, and an `<audio>` element alongside carries the sound *and the clock*.

Three things about it were only obvious after being wrong:

- **Holding frames stops the decoder.** A `VideoFrame` is a handle on a decoder buffer and the pool
  is small; hold too many and the decoder waits for buffers instead of producing. Measured with a
  32-frame buffer: a decode that takes 59ms became **twelve frames in five seconds**, and every seek
  past the first came back empty. Frames behind the playhead are now released as they fall behind,
  not when they are used.
- **Presentation order is not decode order.** With B-frames a clip's timestamps run forward and
  back through the sample table, so "scan until a timestamp is past the one I want" stops early and
  returns the wrong frame. Lookups go through an index sorted by presentation time.
- **A `flush()` demands a keyframe afterwards.** Calling it at the end of every batch makes the next
  batch — which starts on a delta frame — fail outright.

#### Sequences

A project holds many sequences and exactly one is being edited. Each is a **file of its own**:

```
<root>/
  project_files/<Project Name>.flux   the document
  sequences/<Sequence Name>.fluxseq   one file per sequence
  imports/                            media copied into the project
  exports/                            renders
```

**The folder is the list.** There is no second register of which sequences exist, so a `.fluxseq`
dropped into that folder is in the project and one removed is gone. Dropping a sequence file onto
the timeline copies it in and opens it — copied rather than opened where it lies, because a sequence
the project cannot find again tomorrow is not in the project.

A sequence carries **the media its clips refer to**: path, name, kind, and what was probed. That is
what makes it portable, because a clip references an asset by id and an id means nothing in another
project. Opening one elsewhere matches those files by *path* — one already in the bin is used,
anything new is linked where it lies — and then remaps the clips onto whatever id this project uses.
Not the other way round: adopting the sequence's ids would mean two projects eventually claiming one
id for two different files, and a clip pointing at the wrong footage is a worse failure than an extra
pass over the clip list.

**Settings in force, and settings recorded.** `width`, `height` and `frameRate` drive the app: they
are the frame the compositor draws into and the grid the timeline snaps to. The audio and preview
groups — sample rate, channels, preview codec, pixel format, frame caching — are written to the file
and **acted on by nothing**, because FLUX has no exporter and no preview render files yet. The
settings dialog says so under its own heading. A setting that appears to do something and does not is
worse than one that is honestly labelled.

**An empty sequence takes its shape from the first clip dropped into it** — size, rate, and the
audio the file has. Premiere asks; FLUX takes the answer from the footage, because the question can
only be answered by looking at the footage and nobody has been shown any sequence settings to answer
it with. The rate is *counted* from the sample table rather than read off a container field, which an
encoder can get wrong. Once there is an edit the settings stay: changing them halfway through would
reframe and re-time every shot at once.

Sequences live in `kernel/sequence.ts` beside the one being edited rather than in a module of their
own. Every editing function works on `sequence`, so there is no way to mutate one that is not on
screen, and switching tabs is the only thing that changes which that is. Switching is **not a
commit** — the outgoing sequence goes back with its unsaved edits, because an edit that vanished
because you looked at something else would be the worst kind of loss.

On save, every sequence is written and the document records only which was open. The sequences go
first: a document naming a sequence whose file had not been written would open to an empty timeline,
where the other order fails safely — a file the document does not name yet is still found, because
the folder is the list.

A project written before sequences were files carries one inside the document. It is brought across
on open and written out on the next save, which is why such a project opens with unsaved work.

#### Layers

Every visible video track with a clip at the playhead is drawn, bottom track first, into the
sequence's own frame. Two clips stacked on V1 and V2 both play, and their sound stacks the same way
onto A1 and A2 — where each has a level, a mute and a solo, and each video track has an eye.

**The sequence has a size of its own**, and that is the thing that makes this a composite rather
than a picture. Two clips of different shapes have to be drawn *into* something, and taking the size
from whichever happens to be on top would make the output change shape as the playhead crossed a
cut. The first clip dropped into an empty sequence decides it: Premiere asks, and FLUX takes the
answer from the footage, because the question can only be answered by looking at the footage and
nobody has been shown any sequence settings to answer it with. After that it stays — changing it
under someone halfway through would reframe every shot at once.

Each frame is scaled to fit that output, centred, keeping its aspect. So a portrait clip over a
landscape one shows the layer beneath it down each side, which is also how the checks can tell that
both layers were drawn: `layer_red.mp4` is flat red and landscape, `layer_blue.mp4` is flat blue and
portrait, and a correct composite is blue down the middle with red at the edges. There is no way to
produce that by drawing one layer.

Sources are kept across changes to the stack rather than reopened. Reopening a layer that had not
moved would restart its decoder, and restarting a decoder means finding a keyframe and running up to
the playhead again — the one genuinely expensive thing in the pipeline.

A clip now carries a transform of its own — position, anchor, scale, rotation, opacity, crop and
skew — which the compositor applies after turning the picture upright. See
[Effect Controls](#effect-controls) for what the parameters mean. The render draws all of them except skew.

Still absent, and each a real absence rather than an oversight: **no blend modes** and **no
effects**. A layer covers what is under it wherever it has pixels.

#### The frame, and looking at it

The Viewer's frame is **the sequence's shape**, and nothing else's. 9:16, 1:1, 4:5, 5:4, 16:9 or
anything custom — it comes from the sequence's own width and height, so a vertical cut is previewed
vertically and a landscape clip dropped into it is letterboxed rather than the frame changing to
suit it. The toolbar names the ratio it worked out: `FRAME 9:16`.

That sounds like it was always true, and it was not: the ratio was a constant in the stylesheet.
A vertical sequence was previewed in a landscape box, which reads as a scaling bug rather than a
frame one and sends you looking in entirely the wrong place.

**An empty sequence draws no frame at all.** Not a black rectangle with "empty sequence" written
across it — a box standing in for a shape nothing has chosen yet is a claim about the work that
is not true. The frame appears when there is something in the sequence and keeps its shape from
then on, gaps included. Gaps are black, and nothing is written over them, because a gap is black
everywhere else too.

**The wheel zooms towards the cursor**, the **middle button drags**, and **Fit** puts it back. Zoom
towards the centre instead and pointing at the corner of a shot and zooming in takes the thing you
were pointing at off the side of the panel. There are no key bindings for these: the obvious letters
already reach the Tools, and silently taking one would be a worse trade than a trip through the
palette (`viewer.fit`, `viewer.zoomIn`, `viewer.zoomOut`).

#### Preview resolution, and why there are two of them

`Playback` and `Paused`, each **Full**, **1/2**, **1/4**, **1/8** or **1/16**, exactly as Premiere
splits them.

What it buys is **fewer pixels to composite**, and that is all it buys. The canvas the stack is
drawn into shrinks; the element on screen does not, so the browser scales the result back up and the
only visible difference is a softer picture. At 1/4 the composite is a sixteenth of the area. It
does **not** make the decoders do less work — a decoded frame arrives at its coded size whatever
this says — so it pays off on stacks of layers and on big frames rather than on one small clip.

Two settings rather than one because stopped and running are different jobs. Dropping frames while
playing is a cost you choose; a soft picture on the frame you have stopped on *to judge focus* is
not one anyone would choose. So the default pair is 1/2 while playing and Full when stopped, and the
canvas swaps size on every play and pause.

They ride in the project's view state, which means they never mark the document dirty — the same
reason zooming the timeline does not. A preference about whether *this machine* keeps up has no
business being an edit to the work, and the render never reads them at all.

### Effect Controls

What the selected clip does to its own picture and its own sound: **Position**, **Anchor Point**,
**Scale** (uniform or not), **Rotation**, **Opacity**, **Crop** on each edge, **Skew**, and for the
sound **Level**, **Mute** and **Balance**. The names and the units are Premiere's, because someone
arriving from it will type 50 into Scale and expect half.

It follows the **selection**, not the playhead. The playhead is where you are looking and the
selection is what you are working on, and they are usually different — scrubbing to check a cut
elsewhere must not swap the parameters out from under a hand halfway through typing a number.

Selecting a clip selects everything linked to it, so picking up a shot hands the panel both halves:
Motion, Opacity and Crop belong to the picture, Level and Balance to the sound. Several clips at
once shows nothing rather than guessing what a field should say when two clips disagree.

#### Nothing is stored until it is touched

`effects` is absent on a clip until a parameter actually moves off its default, and the defaults are
*resolved against the frame* rather than written down.

Both halves of that matter. A clip carrying `rotation: 0` is claiming someone decided not to rotate
it, and a document should be a record of decisions. More concretely: the defaults for Position and
Anchor Point are **the centre of the frame**, so writing them down would pin them to the sequence
size they were written at — resize a 1080×1920 sequence to 1080×1080 afterwards and every clip would
still be anchored at y=960, half of them hanging off the bottom.

It also means an untouched clip has to composite byte-identically to one from before any of this
existed, which is checked rather than assumed.

#### What 100% means here

The size FLUX already drew the clip at — scaled to fit the frame, centred. **Not** the source's own
pixel size, which is what Premiere's 100% means.

Deliberate: taking 100% to mean native pixels would make every 4K clip in a 1080 sequence overflow
the frame the moment this shipped, which is a change to every existing project rather than a new
feature. For the common case the two agree anyway, since a sequence takes its size from the first
clip dropped on it.

#### Crop is a clip path, not a source rectangle

The crop happens in the picture's **displayed** orientation, so its edges are the edges you see
whatever way the file was coded. Taking a source rectangle instead would need the crop mapped back
through the file's rotation, and a left crop on a sideways clip would come off the top.

#### The render draws it too

The ffmpeg graph builds a clip's filters in the same order the canvas does: scale the whole
picture, take the crop out of what that produced, turn it, fade it, and overlay it where the
transform says. The sound carries its own level, mute and balance alongside the track's.

**An untouched clip takes the path it always took** — scale to fit, pad, overlay at the origin —
and carries no placement at all. That is not an optimisation: it is what makes a sequence nobody
has moved go on rendering exactly as it did before any of this existed.

The arithmetic lives in `renderPlacement`, in whole pixels, because ffmpeg has no matrix: its
filters each do one thing and have to be told exactly how big and exactly where. Keeping it in one
place beside the canvas version is the only way to be sure the two agree, and they must — the
preview is what someone approves and the render is what they get.

> **Rotation turns the same way in both, and that was measured rather than assumed.** The display
> matrix two files away uses the *opposite* convention, so reasoning from it would have been wrong:
>
> | | top-left | top-right | bottom-left | bottom-right |
> |---|---|---|---|---|
> | `rotate=+PI/2` | blue | red | white | green |
> | canvas `rotate(+90°)` | blue | red | white | green |
>
> A negated angle was tried first, and moved the top-right corner to the top left.

Checked by rendering each case through the real graph and looking at the result: the plain clip
fills the frame, 50% scale is half size and centred, 90° puts blue/red/white/green clockwise from
the top left, and a 50% top crop leaves the lower half where it was.

#### Skew is still refused

ffmpeg has no shear filter. The nearest thing, `perspective`, draws a different picture from the
one the canvas does, and approximating it would mean an export that *nearly* matches what was
approved — which is worse than one that says plainly it cannot:

> the render cannot draw skew, and one clip has it: DSCF1906.MOV. Set Skew back to 0 in Effect
> Controls to render this sequence.

#### When the decoder will not start

A file's sync samples are where the index says decoding may begin. For H.264 that is a **weaker
promise than "this is an IDR"**: an open GOP marks I-frames whose group refers back across the
boundary, and Chromium will not configure a decoder and then start it on one. It refuses with the
same words it uses for a delta frame — *a key frame is required after configure() or flush()*.

The symptom is specific and misleading. Playing *through* those frames is fine, because the decoder
is already running. Only starting there fails — so the picture goes black partway into a file and
stays black, and it looks like something that happened at a moment rather than at a place. It was
reported as a trimming bug, because trimming is what had moved the playhead past the point.

The file that prompted this has 451 frames and three sync samples, and only the first is an IDR:

| sample | `stss` | first NALs | starts? |
|---|---|---|---|
| 0 | sync | 6 (SEI), **5 (IDR)** | yes |
| 250 | sync | 6 (SEI), **1 (non-IDR)** | no |
| 298 | sync | 6 (SEI), **1 (non-IDR)** | no |

There is no way to know which is which without the bytes, and reading every keyframe in a file
before playing a frame of it is not a trade worth making. So it is **learned**: a start point the
decoder refuses is remembered, and the source steps back to the one before it — down to sample zero,
which is an IDR in anything that plays at all. The decoder that refused is thrown away with it, or
the second refusal in one pass is not recognised as one.

Two smaller repairs sit behind that, both about the same failure mode — a picture that never comes
back:

- **A decoder that dies is rebuilt at a keyframe.** WebCodecs answers an internal error by closing
  the decoder; the next batch built a new one and handed it whatever came next in the file, which is
  a delta frame in the middle of a GOP. `decode()` threw, the throw escaped a feed nobody awaits, and
  the source stayed alive producing nothing. The invariant is now held where it has to be true
  rather than trusted from four call sites away.
- **A source that gives up hands the picture back.** `VideoSource.broken` existed and *nothing read
  it*, so a source that had exhausted its repairs kept the pipeline drawing black over a perfectly
  good `<video>` — `decoding` only ever asked whether a source existed. Three failures with no frame
  in between is the line; the count resets on every frame that comes out, because a source that
  recovered is not a source that is failing.

#### Indexing once

Most of what an open costs is not the parsing. The `moov` is found by stepping through the file's
top-level boxes, and every step is a ranged request through `flux-asset://`, which is an IPC round
trip. Measured: six of them, **5.7ms of the 6ms a short clip takes and 12.6ms of the 22ms a
36,000-frame one does** — before a single frame is read. And the Viewer pays it again every time the
playhead crosses a cut, because it opens a source per clip.

So the index is kept. Three layers, each covering a different span of time:

| | covers | cost |
|---|---|---|
| **Memory** | scrubbing across a cut, over and over | **0.4ms** |
| **Disk** | opening the project tomorrow | **5ms** |
| **The file** | anything not cached, and always available | **13ms** |

Twenty-four crossings between three sources: **155ms rebuilt every time, 25ms cached.**

The disk half lives in [`electron/mediaCache.js`](electron/mediaCache.js), under the app's user data
rather than in the project folder — the same side of the line Premiere puts its media cache on, and
for the same reason. An index is *derived*: rebuildable from the media at any time, and a megabyte
of machine-generated bytes per clip has no business in the folder someone browses, the zip they send
a collaborator, or the git diff. Keeping it out also gets sharing for free — two projects cutting
the same footage index it once between them.

The format is [`shared/mp4Index.js`](shared/mp4Index.js): the six typed arrays written straight out
at 33 bytes a frame, so loading is one read with no parsing. As JSON the same thing would be
megabytes of decimal digits to write, parse and re-pack.

Four things this has to get right, none of which is speed:

- **A restored index is the same index.** Every field, every element. A cache that is subtly
  different gives a file that plays one way on first open and another way on second — and nothing
  would point back here. `verify:demux` compares element for element, and `verify:playback` opens a
  file both ways and checks the frames that come back are the *same frames*.
- **A stale index is worse than no index.** Entries carry the source's size and modification time
  and are checked against the file on every lookup. An index for bytes that have changed does not
  fail; it feeds the decoder offsets into a file that is no longer shaped that way.
- **The window between reading a file and storing its index.** A recording still running would
  otherwise be read at one length and stamped with the length it had reached by the time the entry
  was written — current-looking forever after. So the identity observed *before* the index is built
  travels back with the write, and main refuses it if the file has moved on.
- **A flipped byte is silent.** The length check catches a torn write; a checksum catches rot. Same
  hazard the demuxer has, except written to disk, where it survives restarts and is handed back with
  confidence every time.

Failures are remembered too — a webm costs the same six round trips to be refused as an mp4 does to
be read — but **only in memory**. A refusal written to disk outlives the reason for it, and a file a
later FLUX could play would go on being refused by an entry an older one wrote.

#### How Premiere does this, and where FLUX is on that road

Worth being explicit, because it is the difference between what exists now and what VISION.md is
actually asking for.

**Premiere never plays your source file.** It has its own decode layer, and around it:

1. **Conform and index on import** — a media cache holding an index of frame positions (so a seek
   into long-GOP H.264 can find the keyframe to decode from), conformed audio, and peak files for
   waveforms. This is what the progress bar on import is doing.
2. **A render pipeline** — for each output frame it walks the sequence, decodes the sources it
   needs, applies effects on the GPU where it can, and composites into a frame buffer.
3. **A playback engine with a ring buffer** — worker threads fill a queue of finished frames ahead
   of the playhead. **Audio is the master clock**; frames are presented against it, and when the
   pipeline cannot keep up it *drops frames* rather than slowing down, because a glitch in the
   sound is far more noticeable than a missing frame.
4. **Preview render files** — the red/yellow/green bar. Anything that cannot play in real time is
   rendered to disk in a preview codec, and playback reads that instead of re-rendering.
5. **Proxies** — low-resolution stand-ins swapped in for editing and swapped back out for export.
6. **Quality throttling** — 1/2 and 1/4 playback resolution, and a lower quality while scrubbing.

FLUX now has 1, 2 and 3: a sample-table index, built on first sight of a file and kept on disk
after that; frames decoded into a buffer we own and composited into the sequence's frame; and audio
as the master clock, with every audio clip under the playhead summed on one AudioContext. It has
**none of 4, 5 or 6** — no preview render files, no proxies, no quality throttling — and item 2 is
present as layering and a per-clip transform; there are still no effects.

One difference from Premiere worth naming: Premiere indexes on *import*, which is what its
conforming progress bar is doing. FLUX indexes on first sight of a file and keeps the result, which
gets the same thing for every open after the first without a background job to manage. The first
look at a clip still pays 13ms.

The honest next step is item 2 — a compositor drawing several decoded sources into one frame — at
which point preview render files and proxies (4 and 6) start to be worth having, because there is
finally something expensive to cache. That is the "GPU-first seed with prerender to cache" in
VISION.md.

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

#### The mixer, and the clock moving into it

Every audio clip under the playhead is decoded and played, summed on one `AudioContext`. See
[`src/kernel/media/mixer.ts`](src/kernel/media/mixer.ts).

A media element could not do this. It plays one file, starting when you ask and arriving when it
feels like it; two of them told to start together do not, and nothing can be done about that from
outside, because the scheduling happens where you cannot reach. `AudioContext.currentTime` is the
audio device's own clock, and a buffer scheduled against it starts at that time to the sample. That
is the only way several sources stay together.

**So the clock moved here.** FLUX has always said audio is the master clock; up to now that meant an
`<audio>` element in the Viewer, which worked because there was only ever one of them. With several
clips playing there is no "the" element to ask, and the context's clock is a better answer than any
of them — it is what the samples are actually being played against. The Viewer keeps the picture and
makes no sound at all on the pipeline path.

There are now two things that could be the clock, so
[`playback.ts`](src/kernel/playback.ts) names them instead of holding one slot: the mixer first, and
the Viewer's element only as the fallback for a file the pipeline cannot read, which the browser
plays sound and all. Both can be sounding at once, and they will drift, because they are two devices
with no way to agree — but something has to speak for the sequence, and the mixer does.

[`src/kernel/media/audioSource.ts`](src/kernel/media/audioSource.ts) is the audio twin of
`videoSource.ts`, and deliberately narrower: sound is only ever wanted in order and only ever wanted
once, so it is a cursor rather than a buffer. Frames come out whole — an AAC frame is 1024 samples,
and each is scheduled at its own timestamp rather than spliced to fit, which is sample-accurate
without anyone doing arithmetic on sample offsets. An off-by-one in the seam between two frames is a
click, forty-seven times a second.

Scheduling runs on a timer about a second ahead of the playhead. Too short and a slow decode arrives
after the moment it was meant for, which is a gap you can hear; too long and every seek throws away
more than it needed to.

**Checked by listening.** A tap on the master bus reports the level, and `verify:playback` reads it
rather than computing what it ought to be — a mixer that scheduled nothing, or scheduled the wrong
thing, cannot move a meter measuring what came out. `voice_over.mp4` is two seconds at 0.9 then two
at 0.02, and a sine at amplitude A has RMS A/√2, so the loud passages must read **0.636** and the
quiet ones **0.014**: numbers with one explanation. The same file on both audio tracks must read
about **1.27**, because two identical signals sum — a mixer that played whichever clip it noticed
last would read 0.636 and look perfectly healthy.

Measured over 222 transport notifications, the sequence's time and the audio device's own are
**exactly** the same number in more than 99% of them, the rest being readings where the audio clock
ticked over while the rest of the app was still being told.

#### Level, mute and solo

Each audio track carries a level in decibels, a mute and a solo, and all three are part of the
sequence — so they are the user's edit, and they are saved with the project. **Decibels** rather than
a multiplier because that is what the number means to whoever sets it: -6 is half as loud, and a
project file that says `"gain": -6` can be read. The mixer converts once, where it hands the number
to the audio device.

**Solo picks the subset, mute silences within it.** A track that is both soloed and muted stays
silent. That is the rule that surprises nobody, because each button keeps meaning exactly one thing
rather than one of them quietly overruling the other. In the header, a track dims when it is silent
*for any reason* — muted, or something else soloed — while the M button keeps showing only what it
is itself doing.

The level is **dragged, not typed**, the way every parameter in a compositor is: a fader is a
gesture, and stopping to select a number and commit it is not how anyone rides a level.
Double-click puts it back to unity.

Each track gets a `GainNode` between its clips and the master. A muted track is **still decoded and
still scheduled** — which sounds wasteful and is the only way unmuting can be instant, because
skipping the work would mean nothing was in the pipe and the sound would arrive a scheduling window
after the button was pressed. Levels ramp over about twelve milliseconds rather than being assigned,
since a gain that steps from 1 to 0 partway through a waveform is a discontinuity, and a
discontinuity is a click.

> **A ramp lies about where it is.** For the milliseconds a ramp is running, `gain.value` still
> reports the value it is *leaving*. Deciding whether anything changed by reading it therefore
> compares a new request against a number already on its way somewhere else — so a second change
> arriving mid-ramp looks like no change and is dropped, and the first one wins. That is not an
> exotic case: it is unmute-then-mute, and it is every fader drag. The mixer remembers what each
> fader was last *told* to be, which is a different number from what it currently is.

Not yet: audio scrubbing, loop, frame stepping, and a cut that does not re-open a source — the index
is cached, but the *decoder* is still torn down and rebuilt when the playhead crosses one.

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
                importPipeline · thumbnails · mediaProbe
                batchImport · batchExport · renderBridge           (the seams)
    media/      the decode pipeline: demux index -> VideoDecoder -> frames
                audio peaks -> the waveform on a clip
                the mixer: every audio clip under the playhead, summed
                (the compositor lives in the Viewer, which owns the canvas)
                and the cache that means a file is read once, not once per open
  launcher/     the project chooser, shown until a project is open
  panels/       the five built-in panels, registered via the SDK
  shell/        command palette · the import-choice host
  styles/       theme tokens + app styles
shared/         media types, footage filter, project naming, the .flux and .fluxseq formats,
                the archive encode settings, the mp4 demuxer, and the on-disk shape of its
                index and of audio peaks
                — imported by BOTH main and renderer, and by the harness
build/          icons, generated by npm run icons (the script is the source)
electron/       main process · preload bridge · filesystem reads · project layout
                media cache (indexes, kept with the app's data, not the project)
                render: one ffmpeg cut, verified · renderQueue: many, with a log
scripts/        verification harnesses
```

---

## Verifying

#### What CI checks, and what it cannot

[`.github/workflows/verify.yml`](.github/workflows/verify.yml) runs on every PR and on `main`, on
both Ubuntu and Windows: `typecheck`, `build`, and the three suites that need no app, no GPU and no
footage — `verify:fs`, `verify:project-fs` and `verify:demux`, with the fixtures built on the
runner.

That is a third of the suites, and the gap is worth stating plainly rather than letting a green
tick imply otherwise. Everything that needs the running app, and everything that needs NVENC and
this archive's own footage on a drive letter, runs on a machine with both — which means **no encode
is ever verified by CI, because no encode happens there**. A green tick means the parts that can be
checked without a machine of your own are checked.

The demuxer is the one most worth having up there. It is the module where being wrong is silent: a
misread offset does not throw, it hands the decoder bytes from the middle of another frame, and
that arrives later as garbage with no obvious cause.

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

```bash
npm run verify:demux
```

A second argument points it at a real camera file, for the one sample layout no fixture can carry —
ffmpeg will not write an `lpcm` version 2 entry, and that is what the cameras here record:

```bash
npm run verify:demux -- ~/flux-media-test "E:\FOOTAGE\AG GROUPS\REELS\DSCF1906.MOV"
```

`verify:demux` needs no app either — the demuxer reads through a `ByteReader`, so a file handle
stands in for ranged fetches. It checks the index *against the file*: every sample inside its
bounds, no two overlapping, timestamps counting evenly, keyframes where ffmpeg was told to put them,
and containers it cannot read refused rather than guessed at. A demuxer that misreads an offset does
not throw — it hands the decoder bytes from the middle of another frame, and that arrives later as
garbage with no obvious cause.

It also covers the modules that let an index be kept rather than rebuilt, and the shape of audio
peaks, for the same reason: none of them imports electron, so all of them run against a real file in
a temp directory. The questions there are whether a restored index is the *same* index in every
element of every array, and whether a stale, torn or rotted one is refused rather than believed.

#### Against real footage, not fixtures

Four suites take a path and run against whatever a camera actually wrote. The fixtures are built to
be awkward in known ways, which is what makes them good for the demuxer and useless for the things
below — each of these checks something that could only have been found on real material.

```bash
npm run verify:footage -- "E:\FOOTAGE\WANDER\DSCF2308.MOV"
```

Decodes a file through the real pipeline in the running app: the demuxer's answer compared against
`ffprobe`'s, a frame actually drawn, the canvas confirmed non-black, and the picture confirmed to
have reached it through the **pipeline rather than the element**. That last one is the check that
matters — a fallback plays, so nothing looks wrong when HEVC quietly stops being decoded here.

```bash
npm run verify:render -- "E:\FOOTAGE\WANDER\DSCF2308.MOV"
```

No app. Encodes a cut and checks the output is the length, rate, frame count and format it was asked
for, that a **rotated** source comes out upright and is *accepted* rather than failed for changing
shape, that a cancel leaves nothing finished-looking behind, and that resume only skips an output
that genuinely verifies.

Two of its checks are canaries, and without them the suite proves nothing — a verifier that accepts
everything passes all the others. One truncates a good output and requires it to be **rejected**;
the other deliberately reproduces the Adobe failure, re-encoding at 29.97 from a 50fps source, and
requires that to be rejected too. That is the exact error the whole verification step was built for.

```bash
npm run verify:queue -- "E:\FOOTAGE\WANDER\DSCF2308.MOV" "E:\FOOTAGE\AG GROUPS\REELS\DSCF1906.MOV"
```

No app. Runs the queue: every job reaching a terminal state, the log carrying a verifiable row per
job, a second run skipping what already verified, a damaged output being **re-encoded rather than
skipped**, and cancel stopping it promptly. Each source is cut twice so the `_02` naming is
exercised.

```bash
npm run verify:render-queue -- "E:\FOOTAGE\AG GROUPS\REELS"
```

The queue, in the running app, and mostly one property: that a queued job is a snapshot. It
imports, selects, adds, then **deletes one queued clip and razors another**, and requires both
jobs to survive unchanged and still render. It also checks that re-adding replaces a row rather
than doubling it, that a stretched clip queues with a forced rate and renders at it, that Start
writes the files, and that the queue survives a round trip through its file on disk.

```bash
npm run verify:sequence-render -- "E:\FOOTAGE\AG GROUPS\REELS"
```

The composite, and the one suite that cannot take ffmpeg's word for anything. Everything that goes
wrong with a composite produces a file that opens, plays and looks plausible — a gap that shortened
the file, a layer drawn behind the one it should be in front of, a rotated source composited on its
side, a mix halved by `amix` normalising it, a mute honoured on playback and ignored by the render.
So it **reads the output back**: luma at chosen moments, measured loudness, counted frames.

It lays its sequences out clip by clip rather than importing a folder and editing it down, because
every check is about a *shape* — a gap of a known length, a clip on the track above another, a
track at a known gain — and reaching those by razoring an imported batch would make the shape a
side effect rather than the request. Measured on this archive's own footage:

| | |
|---|---|
| **Gaps** | A two-second hole in the middle and two seconds of nothing at the end came out 8.00s and 200 frames, black at 3s and 7s, with the mix at −20.6 dB and the gap at −91 dB peak. |
| **Rotation** | A `rotation: 90` source composited into a deliberately **landscape** frame read 64 — 10-bit black — down both side strips, with picture in the middle. Ignore the rotation and the coded 1920×1080 frame fills the frame edge to edge and the strips are not black. |
| **Layers** | At a moment covered by both tracks the frame read 490 against the top clip's own 497 and the bottom's 388; a moment covered only by the bottom read 445 against its 442. |
| **The mix** | −6 on the fader moved the rendered file by 5.90 dB. A muted track rendered at −91 dB peak and still verified as a full picture. |
| **Speed** | A 2× clip placed one second in came out 100 frames with the second before it and the tail after it both still black — which is what catches the `setpts` precedence error that would divide the *placement* by the speed. |

> **`signalstats` reports in the pixel format's own range.** The same picture reads 110 out of an
> 8-bit h264 source and 442 out of the 10-bit composite made from it — four times the number, for
> the two extra bits. Comparing a source reading with an output reading without normalising first
> says the layers were drawn in the wrong order, convincingly, when they were not. Every reading
> here is forced to 10-bit, on which black is 64.

Three of its checks are the canary, and without them none of the others proves anything, because
all of them end in the verifier saying yes. A good render is required to pass; then the same
verifier is handed the same render **truncated to a third**, **scaled to half size**, and **stripped
of its audio**, and is required to reject all three with a complaint naming the right thing.

```bash
npm run verify:batch -- "E:\FOOTAGE\AG GROUPS\REELS"
```

The round trip, and the only check that proves the idea. It walks the folder itself — not sharing
the scan's implementation, only the two shared definitions it is contracted to — and compares. Then
it imports, checks the import is **one undo step**, that clips abut exactly with no gap or overlap,
that they are in scan order, and that a vertical first clip gives a vertical sequence.

Then it *edits*: deletes most of the clips, razors one in two, trims the head of another — exactly
what a review pass does — and exports. No export list is ever built, so the number of files that
appear has to follow from what was left on the timeline. It then looks at the folder on disk: one
`.mp4` per surviving clip, exactly one carrying the `_02` suffix, a log beside them, and nothing
empty.

> **A cache is very good at hiding the code that fills it.** Two checks here passed with the builder
> deliberately broken, because clearing the in-memory layer still left the entry on disk and the
> check read that instead. Anything asking whether building still works has to *forget* first —
> which is why `forgetIndex` and `forgetPeaks` exist, and they are also the primitive behind the
> "delete the media cache" button every NLE has.

`verify:playback` is the one suite where "it looks right" proves nothing: a viewer showing a stale
frame while the clock has moved on, and a clock running while the video is paused, both photograph
perfectly. So it checks that the sequence's time and the element's time stay in agreement, in
seconds, against a real decode of a real file.

`verify:app`, `verify:tree`, `verify:timeline`, `verify:playback` and `verify:demux` expect fixture
media in `~/flux-media-test`. One command builds the lot:

```bash
npm run fixtures
```

They clear the project's asset list and sequence so runs are repeatable.

Not one of these is a nice file. Each is shaped around one thing that is hard to get right and
silent when it is wrong, so a suite reading them is reading a trap rather than a sample —
`scripts/make-fixtures.mjs` is where each awkwardness is argued, and the rest of this section is
the short version. They are **built rather than committed**: a few megabytes of generated mp4s in
the history would carry the files without the reasons, which is the wrong half of the trade.

> **The numbers in there are load-bearing.** `verify:demux` asserts that `clipA.mp4` is 96 samples
> and `shot_B.mp4` is 72 — 4s and 3s at 24fps — and those are assertions about *the index this
> demuxer built*, checked against a count known from outside it. A fixture quietly regenerated at a
> different length would turn a real check into one that only ever agrees with itself.

One fixture is not short. `long_take.mp4` is a minute long, because everything a four-second file
can tell you about playback it can also tell you while a completely broken server is underneath it:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=25:duration=60" -f lavfi -i "sine=frequency=440:duration=60" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 700k -g 50 -c:a aac -b:a 64k -shortest ~/flux-media-test/long_take.mp4
```

Two fixtures are flat colours in different shapes. `layer_red.mp4` is red and landscape,
`layer_blue.mp4` is blue and portrait — composited, the blue one is letterboxed over the red, and
that is the only way to see from the pixels that both layers were drawn:

```bash
ffmpeg -y -f lavfi -i "color=c=red:size=1280x720:rate=25:duration=6" -f lavfi -i "sine=frequency=300:duration=6" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 200k -g 25 -c:a aac -b:a 96k -shortest ~/flux-media-test/layer_red.mp4
```

```bash
ffmpeg -y -f lavfi -i "color=c=blue:size=480x640:rate=25:duration=6" -f lavfi -i "sine=frequency=900:duration=6" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 200k -g 25 -c:a aac -b:a 96k -shortest ~/flux-media-test/layer_blue.mp4
```

One fixture has an open GOP. `open_gop.mp4` is encoded so that its sync samples after the first are
**not IDR frames** — which is what phone and drone footage does routinely, and what a decoder refuses
to start on:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=12" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 200k -x264-params "open_gop=1:keyint=50:min-keyint=50:scenecut=0:bframes=3" -an ~/flux-media-test/open_gop.mp4
```

`verify:demux` checks the fixture is still like that, by reading the first NAL of every sync sample.
Nothing in the index is wrong here and ffprobe agrees with it — both are reading `stss`. What the
check guards is that a future encoder does not quietly start emitting IDRs, which would leave the
recovery checks passing while exercising nothing.

One fixture has audio FLUX cannot read. `foreign_audio.mp4` carries AC-3, which the demuxer refuses
as an unsupported codec — the point being that this is *not* the same as `clipA.mp4`, which has no
soundtrack at all, and the app has to say which of the two it is looking at:

```bash
ffmpeg -y -f lavfi -i "color=c=green:size=320x180:rate=25:duration=4" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 150k -g 25 -c:a ac3 -b:a 96k -shortest ~/flux-media-test/foreign_audio.mp4
```

One fixture is loud and quiet on a schedule. `voice_over.mp4` alternates two seconds at 0.9 with two
seconds at 0.02, three times — because a waveform drawn from audio that never changes cannot show
whether it is following the audio or drawing a band of its own:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=12" -f lavfi -i "aevalsrc=sin(2*PI*300*t)*if(eq(mod(floor(t/2)\,2)\,0)\,0.9\,0.02):d=12:s=48000" -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 300k -g 25 -c:a aac -b:a 128k -shortest ~/flux-media-test/voice_over.mp4
```

`verify:timeline` synthesises drag and drop with a real `DataTransfer` and real `DragEvent`s
dispatched at the actual DOM nodes, so the app's own handlers run as they do under a mouse.
`verify:tree` clicks real chevrons and dispatches real arrow keys.

> **Three rules the UI harnesses learned the hard way.** Wait for a *condition*, never a duration —
> a cold directory read is slower than any sleep you would guess. Identify a tree row by *path*,
> never by label — `Users` and `Program Files` exist on most drives, so a label match silently
> picks a row on the wrong one. And let every check build the state it needs from scratch, so none
> of them depends on what another happened to leave behind.

> **Two worktrees cannot both run `npm run dev` without being told to.** The dev port is pinned
> with `strictPort`, so the second checkout does not get a port of its own — and the failure is not
> a refusal, it is a harness in worktree B attaching to `:9222` and silently driving the app vite
> is serving from worktree A. Every check then passes or fails for reasons that have nothing to do
> with the code under test. Three variables move the three halves of it:
>
> ```bash
> FLUX_DEV_PORT=5274 npx vite
> FLUX_DEV_PORT=5274 npx electron . --remote-debugging-port=9223 --user-data-dir=/tmp/flux-wt
> FLUX_DEBUG_PORT=9223 npm run verify:timeline
> ```
>
> `--user-data-dir` is the one that is easy to miss: `app.requestSingleInstanceLock` keys off the
> user-data directory, so without it the second app quits the moment it starts — after printing
> *DevTools listening*, which makes it look like it is up.

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
proxies, the audio graph, plugins, skinning UI. Audio files are not importable yet — the Content
Browser is image and video only. A *soundtrack* inside a video file is read either way: AAC through
WebCodecs, and uncompressed PCM without a decoder at all.

**Rendering covers two shapes and no more.** [Render](#render-add-then-start) writes one file per
clip, or the whole sequence as one composited file — and that is the end of it. There are no
**preview render files**, so nothing is ever cached for playback; no **per-clip transform or
effect** to render, because none exists to apply; no **stills** in a composite; and no unattended
whole-tree mode. What exists is the path this archive needs — cut or composite, encode, verify,
log.

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
