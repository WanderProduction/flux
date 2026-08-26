# FLUX — Interaction Model

### Panels, Workspaces & the Nested Node Graph (the "dual-view")

> Concept doc, one level below [`VISION.md`](../VISION.md). Still no language, framework, or
> platform — this is about *how it feels to use*, not how it's built.
>
> **This started as a "dual-view flip" idea. You redirected it, and the result is better:**
> there is no flip and no mode-switch. There are **panels** you arrange into **workspaces**, and
> the timeline and the node graph are just two of those panels — two *lenses* on the same
> **recursively nested** project, kept in sync by a shared clock, selection, and scope.

---

## The one idea

Three sentences hold the whole model:

1. **Everything on screen is a dockable panel; a saved arrangement of panels is a *workspace*.**
   (Premiere / FL / AE docking + DaVinci's task-separation, done as *your* layouts.)
2. **The whole project is one recursively nested node graph** — a composition is a node you dive
   *into*, a clip inside it is a node you dive *into*, all the way down. Every effect is procedural.
3. **The timeline and the node map are two lenses on whatever level you're currently inside**,
   bound into one thing by a shared **playhead/clock**, shared **selection**, and shared **scope**.

The timeline answers *"what plays, and when."* The node graph answers *"how it's built, and what
drives it."* They are never separate projects and you never "switch" between them — they're two
windows open at once, looking at the same thing from two angles.

---

## Part A — Panels & Workspaces

### Everything is a panel

There is no fixed UI. There's a set of panels you dock, undock, float, split, and resize freely —
exactly the Premiere / FL Studio / After Effects feel you like. The default panel set:

| Panel | What it shows |
|-------|---------------|
| **Viewer** | The rendered output at the playhead (your preview screen). |
| **Timeline** | Time arrangement of the current scope — tracks, clips, keyframes. |
| **Node Map** | Signal wiring of the current scope — the graph. |
| **Files** | Media browser / project bin. |
| **Inspector** | Parameters of the selected node/clip. |
| **Mixer** | Audio buses, channel strips, meters (the DAW surface). |
| **Palette** | The command / effect / node search bar (also summonable anywhere). |

More panels arrive with later phases (scopes/waveforms, curve editor, etc.), but they're all just
panels — same rules.

### Workspaces = saved grid layouts

A **workspace** is a named, saved arrangement of panels. This is the *fix* for DaVinci's pages:
you get the "focus on one task" benefit, but the layouts are **yours**, they aren't rigid tabs, and
nothing stops several "tasks" from sharing one screen.

You build layouts, name them, and **fast-switch by hotkey**:

```
[1] EDIT            [2] SOUND DESIGN        [3] NODES / MOTION
┌─ Viewer ──┬Files┐  ┌─ Viewer ──┬ Mixer ─┐  ┌─ Node Map ───────┐
│           │     │  │           │ ▮▮▮▯▯  │  │  ○──○──■          │
├─ Timeline ┴─────┤  ├─ Timeline ─────────┤  ├─ Viewer ─┬ Inspec┤
│ ▓▓▓ ▓▓  ▓▓▓▓    │  │ ♪♪♪  ♪♪   ♪♪♪♪      │  │          │ params│
└─────────────────┘  └────────────────────┘  └──────────┴───────┘
 timeline is home     mixer takes the stage    graph takes the stage
```

- Switching workspace is **instant and keyboard-driven** (`1`/`2`/`3`, or the palette).
- A workspace is just a layout — it does **not** change the project or the scope. Your selection
  and playhead stay put; only the arrangement of windows changes.
- Ships with sensible presets (Edit, Sound, Nodes, Color, …); users make and share their own.
  Custom skins (from the vision doc) restyle these; the marketplace ships more.

**Key consequence:** a reels editor lives in the **Edit** workspace and may *never open the Node
Map panel at all*. The node graph is opt-in scenery, not a mandatory room.

---

## Part B — The nested node graph (Houdini model)

### Everything is a node, all the way down

The project is not a timeline with graphs bolted on. It's **one graph that nests infinitely**, and
the timeline is a way of *viewing a level* of it.

- The **project** contains **composition** nodes (your sequences).
- **Double-click a composition** → you're now *inside* it. You see its child nodes — the media you
  put in it — sitting there, **initially unconnected**, like clips dropped on a table.
- You **wire them by attributes** (TouchDesigner-style) and add nodes to build the output:
  - **Element nodes** — a video, an image, an audio clip, a title.
  - **Generator / input nodes** — `random float (range)`, `LFO`, `oscillator`, `noise`, `curve`,
    a constant, a data source, simple geometry. These *make* signal.
  - **Operator / effect nodes** — `color curves`, `blur`, `transform`, `EQ`, `reverb`. These
    *process* signal. **Every effect is a node** — there are no baked black-box effects.
  - **Output node** — what this level renders (its picture + sound).
- **Click into any element node** → you're a level deeper, building *its* internal graph. A clip's
  color correction is itself a little network inside the clip. Turtles all the way down.

```
PROJECT
└─ ▸ Sequence 1                         ← a composition node
     (double-click to enter)
     ┌──────────────────────────────────────────────┐
     │  ○ clipA ─┐                                   │
     │           ├─► ■ output                        │   ← this level's graph
     │  ○ clipB ─┘        ▲                          │
     │                    │                          │
     │  △ LFO ────────────┘  (ambient driver)        │
     └──────────────────────────────────────────────┘
          │
          └─ double-click clipA ▸ enter clipA's own graph
             ┌────────────────────────────────┐
             │ ○ source ─► ▣ curves ─► ■ out   │   ← procedural, nested
             └────────────────────────────────┘
```

### Diving & breadcrumbs

Navigating the nest is core, so it's fast and keyboard-first:

- **Dive in:** double-click a node (or `Enter` on the selected node).
- **Climb out:** `Esc` / backspace / click the breadcrumb.
- **Breadcrumb** always shows where you are: `Project ▸ Sequence 1 ▸ clipA ▸ colorFX`. This is the
  single source of truth for **scope** — and, crucially, *both the Timeline and Node Map panels
  follow it* (see Part D).

---

## Part C — The dual view: two lenses on one scope

Here's the resolution of "how can a timeline and a node graph be the same project." They're not the
same *picture* — they're the same *set of nodes*, shown two ways:

- **The Node Map shows the full graph** at the current scope — *every* node, including the ones
  that have no place in time (an LFO, a random-float driver, a math node).
- **The Timeline shows only the time-occupying subset** of that same scope — the nodes that
  actually own a span of time (clips), laid out on tracks against the clock.

```
        CURRENT SCOPE  ( Sequence 1 )

  NODE MAP  (the whole graph)      TIMELINE  (the time-occupying subset)
  ┌────────────────────────┐       ┌───────────────────────────────┐
  │ ○ clipA ─┐             │       │ V2                   ▓▓▓ clipB │
  │ ○ clipB ─┼─► ■ out     │  ⇄    │ V1  ▓▓▓▓▓ clipA               │
  │ △ LFO ───┘             │       │ A1  ♪♪♪♪♪ music               │
  │ (LFO has no time slot) │       │     (LFO not shown — no time) │
  └────────────────────────┘       └───────────────────────────────┘
```

So: **the node graph is the superset; the timeline is the clock-facing shadow of it.** Two panels,
one scope, no duplication — a clip is *one* node that simply appears in both lenses, while an
ambient driver appears only in the Node Map.

---

## Part D — What binds the two lenses into ONE

Three pieces of shared state make the panels feel like one organism instead of two windows:

### 1. Shared selection
Select `clipA` in the Timeline → its node highlights in the Node Map, and the Inspector shows its
params. Select the node in the Node Map → the clip highlights on the Timeline. One selection,
many lenses.

### 2. Shared clock — *this is the magic*
There is **one global playhead**. Scrubbing it — in either panel — updates **every signal in the
graph** to its value at that instant. Because the LFO, the audio bands, and the color node are all
live at the playhead, wiring *audio → color* means the grade **breathes with the music as you
scrub**, in the Viewer, with **no pre-render and no baking.** The shared clock is *why* the two
views are one: they're both readouts of the same running signal at the same instant of time.

### 3. Shared scope
Dive into `clipA` and **both panels re-scope together**: the Timeline now shows `clipA`'s internal
time arrangement, the Node Map shows `clipA`'s internal graph, the breadcrumb updates once for
both. You are never "in the graph of X but the timeline of Y." One scope, followed by every lens.

---

## Part E — Two lenses, one edit (single source of truth)

The lenses don't just *view* the same project — they *edit* the same project. Every parameter has
exactly one value; the panels are all editors of it.

- **Apply an effect on the Timeline** (via the palette, keyboard) → a node is added to that clip's
  internal graph. The timeline action *is* a graph edit. Same event, two lenses.
- **The Inspector is the node's parameters.** Tweaking a slider in the Inspector and moving a
  keyframe on the Timeline and nudging a node value in the Node Map all touch the same number.

### The parameter model (static → keyframed → driven)

A parameter can be in one of three states, and there's a clean rule for conflict:

1. **Static** — a fixed value.
2. **Keyframed** — a value curve over time (Timeline / curve editor owns it).
3. **Driven** — a wire from another node feeds it (Node Map owns it).

**Rule:** if nothing is wired into a parameter's input, its keyframes/static value apply. **Wire a
driver in and the driver takes over** — combined through a mode you pick: *replace · add · multiply
· offset*. So "keyframe the exposure, then add an audio-reactive shimmer on top" is just *offset*.

**Expose-as-input** is the bridge between the lenses: right-click any Inspector parameter →
*"expose as node input"* → it becomes a pluggable socket in the Node Map that anything can drive.
That single gesture is how a plain timeline edit becomes a procedural, reactive one.

---

## Part F — Progressive disclosure (protecting the reels editor)

The nesting + panels + workspaces conspire to keep it dead simple by default and infinitely deep on
demand. The same app, four depths:

| Level | Who | What they touch |
|-------|-----|-----------------|
| **0** | Reels / short-form | **Edit** workspace only: Timeline + Viewer + Files. Cuts clips. **Never opens the Node Map.** Effects still create nodes underneath — invisibly. |
| **1** | Casual finisher | Adds effects from the palette, tweaks them in the Inspector. Still never dives. |
| **2** | Motion / sound | Opens the Node Map (or the Nodes/Sound workspace), dives into a clip to wire *one* reactive thing (audio → color). |
| **3** | Power / TD-brain | Lives in the Node Map. Builds generative patches, ambient drivers, deep nests, saves reusable nodes. |

Nothing about Level 3 is *visible* at Level 0. Depth is behind a double-click and a panel nobody
forced you to open.

---

## Part G — Keyboard-first across every lens

The identity from the vision doc, made concrete here — nothing below needs a mouse:

- **Palette** (`Ctrl/⌘+K`, or a resting-finger key): search & run *anything* — add a node, apply an
  effect, drop a generator, switch workspace, dive/climb, jump to a panel.
- **Workspaces:** number-key hotkeys (`1` Edit, `2` Sound, `3` Nodes, …).
- **Scope:** `Enter` to dive into the selected node, `Esc` to climb, breadcrumb is focusable.
- **Timeline:** full keyboard editing (blade, ripple, trim, nudge, marker) — detailed in the
  Phase-1 doc.
- **Node Map:** arrow/`hjkl` to move focus between nodes; a wire gesture (select output socket →
  key → select input socket) to connect without dragging; `Tab` to spawn a node at the cursor.
- **Panels:** a key to focus/cycle panels so your hands stay home.

Automation (recordable action chains) sits on top of all of this — because if every action has a
keyboard verb, every action is scriptable.

---

## Worked example — audio-reactive color correction, end to end

The flagship demo, walked through this exact model, to prove the pieces fit:

1. In the **Edit** workspace, you drop `music.wav` and `clipA` into *Sequence 1*. Timeline shows a
   clip on `V1` and audio on `A1`. (Under the hood: two element nodes at this scope, unconnected to
   anything but the output.)
2. You press `3` → **Nodes** workspace. Node Map + Viewer + Inspector fill the screen; same scope,
   same selection, same playhead. Nothing about the project changed — just the window layout.
3. You **dive into `clipA`** (`Enter`). Both panels re-scope to clipA. You add a **`color curves`**
   node: `source ─► curves ─► out`.
4. You **expose** the curves' *lift* parameter as a node input (right-click → expose).
5. Back at the sequence scope, you add an **`audio band`** node reading `music.wav`'s low end, and
   **wire it into** clipA's exposed *lift* input, combine mode = *add*.
6. You **scrub the playhead.** The shared clock drives the audio-band value live; it adds into the
   curve; the Viewer shows the grade **pumping with the kick** — no render, no bake.
7. Happy with it, you **save the whole clipA network as a reusable node** ("AudioGrade") and drop
   it on the next clip. (Marketplace-shareable, per the vision doc.)

Every capability the doc describes shows up once in that story: panels, workspaces, nesting, the two
lenses, shared clock/selection/scope, expose-as-input, the parameter combine mode, keyboard flow,
and reuse.

---

## Vocabulary (so later docs share terms)

- **Panel** — a dockable window (Viewer, Timeline, Node Map, Files, Inspector, Mixer, Palette).
- **Workspace** — a saved, named panel layout; fast-switched by hotkey. *Not* a project state.
- **Composition** — a node you dive into that holds a sub-graph (a sequence, or a clip's interior).
- **Node** — anything in the graph: element, generator/input, operator/effect, or output.
- **Scope** — the level you're currently inside (shown by the breadcrumb); *all lenses follow it*.
- **Signal** — what travels on wires between nodes.
- **Timeline-visible vs ambient** — nodes that own time (clips) vs nodes that don't (LFO, drivers).
- **Driver** — an ambient node wired into a parameter to control it.
- **Clock / playhead** — the single global time; scrubbing it animates the whole graph live.

---

## Open sub-questions (for later, not now)

None of these threaten the model; they're the next layer of detail:

- **Combine-mode UX** — how *replace/add/multiply/offset* is chosen and shown on a driven param.
- **Reusable nodes / macros** — exact save/version/share flow, and how it feeds the marketplace.
- **Cross-scope wiring reach** — can a driver at Sequence scope reach a param nested 3 levels deep,
  and how is that surfaced without spaghetti?
- **Timeline of ambient nodes** — do drivers ever get an *optional* time representation (an
  automation lane) for users who think in timelines, not graphs?
- **Default keybindings** — the actual key map (its own reference doc).
- **Performance** — how the shared-clock live evaluation stays real-time (ties into the
  golden-midpoint cache from the vision doc).

---

*Next natural doc: the **Phase 1 breakdown** (what "usable NLE + render pipeline" concretely
contains), or the **default keymap**. Your call — but only once this model feels right.*
