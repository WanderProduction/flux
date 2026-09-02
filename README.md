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
| **Trimming** | Drag either edge of a clip to change what it plays. Linked pairs trim together. |
| **Open GOP** | Files whose keyframes are not IDR frames — most phone footage — seek and play. |
| **Timeline wheel** | Scroll travels time · `Ctrl` travels tracks · `Alt` zooms, anchored on the pointer. |
| **Playback** | `Space` plays the sequence. Playhead in the timeline, picture in the viewer. |
| **Decode pipeline** | H.264 mp4 is demuxed here and decoded through WebCodecs onto a canvas. |
| **Audio tracks** | A file with sound lands as a linked picture-and-sound pair, with its waveform drawn. |
| **No sound, said out loud** | A file with none says so on its card and on the drop, rather than landing as picture alone in silence. |
| **Mixer** | Every audio clip under the playhead, summed on one AudioContext — which is also the clock. |
| **Level, mute, solo** | Per track, in decibels, saved with the project. |
| **Layers** | Every visible video track is composited into the sequence's frame; each has an eye. |
| **Sequences** | Many per project, each its own `.fluxseq` file, each a tab on the timeline. |

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

Not yet, and each is a real absence rather than an oversight: **no per-clip transform** (no position,
scale, rotation or opacity), **no blend modes**, and **no effects**. A layer covers what is under it
wherever it has pixels. Compositing several sources is the machinery those need; they are the next
thing it makes possible, not something it already does.

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
present only as layering: there are no effects and no per-clip transform to render.

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
                importPipeline · thumbnails · mediaProbe          (the seams)
    media/      the decode pipeline: demux index -> VideoDecoder -> frames
                audio peaks -> the waveform on a clip
                the mixer: every audio clip under the playhead, summed
                (the compositor lives in the Viewer, which owns the canvas)
                and the cache that means a file is read once, not once per open
  launcher/     the project chooser, shown until a project is open
  panels/       the three built-in panels, registered via the SDK
  shell/        command palette · the import-choice host
  styles/       theme tokens + app styles
shared/         media types, project naming, the .flux and .fluxseq formats,
                the mp4 demuxer, and the on-disk shape of its index and of audio peaks
                — imported by BOTH main and renderer, and by the harness
build/          icons, generated by npm run icons (the script is the source)
electron/       main process · preload bridge · filesystem reads · project layout
                media cache (indexes, kept with the app's data, not the project)
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

```bash
npm run verify:demux
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

> **A cache is very good at hiding the code that fills it.** Two checks here passed with the builder
> deliberately broken, because clearing the in-memory layer still left the entry on disk and the
> check read that instead. Anything asking whether building still works has to *forget* first —
> which is why `forgetIndex` and `forgetPeaks` exist, and they are also the primitive behind the
> "delete the media cache" button every NLE has.

`verify:playback` is the one suite where "it looks right" proves nothing: a viewer showing a stale
frame while the clock has moved on, and a clock running while the video is paused, both photograph
perfectly. So it checks that the sequence's time and the element's time stay in agreement, in
seconds, against a real decode of a real file.

`verify:app`, `verify:tree`, `verify:timeline` and `verify:playback` expect fixture media in
`~/flux-media-test`. Generate it with ffmpeg — two short H.264 mp4s, a VP9 webm, a png, a jpg, a
nested folder, a `notes.txt` that must never be listed, and a deliberately corrupt `.mp4` that must
resolve to "no preview" rather than hang. They clear the project's asset list and sequence so runs
are repeatable.

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
