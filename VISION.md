# FLUX — Vision

> **Working codename: FLUX.** Not final — see [Naming](#naming) at the end.
> This is the **concept doc**. It describes *what we're building and why*, not *how* or in
> *what language*. Every technical choice comes later. Nothing here is committed except the
> vision itself.

---

## One line

**A keyboard-driven media engine where the timeline and the node graph are the same project —
and every kind of media can drive every other kind, in real time.**

Premiere's timeline + After Effects' compositing + a real DAW + Media Encoder's render farm +
TouchDesigner's data-flow reactivity — fused into **one** program, built so you almost never
have to touch the mouse.

---

## Why this exists (the pain)

Right now, finishing one piece of work means living in six apps at once. That's not a workflow,
it's a tax. Concretely, here's what's broken — in the order it hurts:

1. **Performance is insulting.** Even on a strong machine with smart caching and clean footage
   management, Premiere stutters and After Effects makes you *pre-render just to watch your own
   footage*. There's no middle ground between "full quality, frozen" and "render and wait."

2. **You click too much.** Presets exist, but you still hover → click a button → go back to the
   keyboard → hover again, all day. Repetitive tasks — dragging footage, applying an effect,
   *searching* for an effect by hand — eat hours that automation and smart hotkeys should erase.

3. **App-switching is ADHD in software form.** Premiere → AE → encoder → back, waiting on
   round-trips, broken dynamic links, re-renders. It's poison for a production pipeline.

4. **Nothing is open enough to fix.** The apps aren't hackable, so building anything genuinely
   useful means reverse-engineering — you shouldn't have to reverse-engineer an app *to get
   captions right.*

5. **No AI in the pipeline.** No built-in path to Topaz-style enhancement, to generative
   image/video/audio (Seedance, Kling, nano-banana…), to ElevenLabs, to an LLM with MCP that
   could actually help or automate. It all lives outside the tool.

6. **The render pipeline is stone-age.** Why can't you bulk-render clips? Render with a custom
   prefix/suffix naming template? Keep folder-destination presets? AI-enhance on export?
   *Schedule* a render? Partial-render a range? Squeeze the bitrate for a quick preview export?
   None of it exists.

7. **Audio is an afterthought — the worst pain of all.** Premiere's audio effect control is
   weak, and you can't group a few unique clips scattered across different tracks into *one*
   mixer channel and treat them as a real sound-design bus. DaVinci ships basically zero audio
   presets, no built-in room/surround effects, no 3D-space placement of a sound source, no
   oscillators or synths to *generate* sound. For anyone who cares about audio, both are dead ends.

**FLUX exists to erase all seven.**

---

## What it is (in one paragraph)

FLUX is a **generative, node-driven media engine with a dead-simple timeline on top**. A project
is a single living graph of signals — video, audio, images, 3D, data, code — and you view that
graph two ways: as a **timeline** when you're editing, and as a **node graph** when you're
building behavior. Because everything is a signal, anything can drive anything: wire an audio
band into a color-correction node and your grade breathes with the music, live, with no baking.
On top of that engine sits a UI that *feels native and minimal* to whoever's using it — a reels
editor sees a timeline and a search bar; a motion designer sees comps and keyframes; a sound
designer sees a real mixer and a synth rack. And nearly every action in the entire app can be
driven from the keyboard.

Think: **TouchDesigner's soul + Premiere's simple timeline + Resolve-grade effects (with a
node graph that doesn't suck) + a native DAW + a real render pipeline.** It leans *away* from
being a full 3D package, and *away* from being a real-time game renderer. It is a **media-files
engine for doing whatever you can imagine.**

---

## The core idea: one project, two views, one signal

This is the single decision everything else hangs on.

- **Everything is a signal on a shared graph.** A clip, a track, an effect, a mask, an audio
  bus, a value, a bit of generated data — all nodes producing and consuming signals. This is the
  engine. It's invisible until you want it.

- **The timeline is a view of the graph.** Cutting, trimming, sequencing — the familiar,
  approachable NLE surface. This is where reels get made in five minutes. It is *home base*.

- **The node graph is the same project, opened up.** When you want an effect to react to audio,
  or to build something procedural, you flip to the graph (like changing editor type in Blender)
  and wire it. The graph reads like **blueprints / Blender geometry nodes** — clean, legible,
  left-to-right — explicitly **not** DaVinci's cramped node mess.

- **Cross-domain by default.** The TouchDesigner magic: data converts and flows between types.
  Audio → drives a parameter. Image luminance → drives audio. A value curve → drives 3D position.
  The headline example: **real-time audio-reactive color correction, built by dragging two nodes
  together.** No pre-render, no baking, no scripting required.

The point of the dual view is that **you never leave the project to gain power.** Simplicity and
depth are the same file, seen at two zoom levels.

---

## Design pillars

### 1. Keyboard-first, automation-first — *the* signature feature

The reason the app exists in your hands, not just in concept.

- **Every function in the app is reachable by keyboard alone.** The mouse is optional, never
  required. No action is buried where only a click can reach it.
- **A command / search palette** for *everything* — effects, actions, panels, presets, nodes.
  Stop hunting the effects bin by hand; type three letters, hit enter.
- **Smart, remappable hotkeys** with sane placement — you decide, and the layout is designed so
  common actions land under resting fingers instead of forcing hover-click-return trips.
- **Automation as a first-class surface.** Repetitive chains (drag → apply → rename → export)
  become recordable, replayable, scriptable actions. The app should let you *stop doing the same
  thing twice.*

### 2. Progressive simplicity — native to each craft

One app, but it never shows you more than your craft needs.

- **Reels / short-form editor:** timeline, a few effects, a little audio, a search bar. That's it.
  Feels as light as CapCut.
- **Motion designer:** comps, keyframes, the node graph, masks, expressions.
- **Sound designer:** a real mixer, buses, VST/effect racks, synths, spatial audio.
- The advanced engine is **always there underneath** but **never in the way.** Complexity is
  opt-in, revealed by the surface you choose — not dumped on everyone at once.

### 3. The cross-domain node engine

- Media types are interchangeable signals: **video · audio · image · 3D · data · code.**
- Any attribute of any type can **drive** any parameter of any other type, live.
- Node graph UX modeled on **blueprints / geonodes**, not Resolve.
- Real-time reactivity is the headline capability, not a hidden expert feature.

### 4. A native DAW, not a bolted-on audio track

Audio is a first-class creative surface, because that's the deepest current pain.

- **Group any clips into one mixer bus** — regardless of which track they sit on or where they
  are in time. Treat scattered clips as a single sound-design channel.
- **Real effect control:** VST/plugin hosting, proper reverb, EQ, dynamics — dialed like an
  actual DAW, not Premiere's thin panel.
- **Spatial / 3D audio:** place a source in space, room and surround effects built in.
- **Generate sound, don't just cut it:** oscillators, synths, MIDI. FL Studio energy, living
  inside the same project as the picture.

### 5. Advanced effects with a graph that doesn't suck

- Resolve-grade compositing and effect power…
- …through a node graph that reads like **blueprints / Blender geonodes** — legible, groupable,
  reusable.

### 6. Performance: the golden-midpoint cache

The fix for pain #1. The app should be *smart about what deserves quality.*

- **Never block playback to watch your own footage.** No forced pre-render.
- A tiered strategy that automatically balances:
  - **Pre-render** the things that genuinely need it,
  - **Low-quality preview** the things that don't,
  - **Skip / drop frames gracefully** rather than freeze,
- The system decides the balance so you don't babysit render bars. Responsiveness is a feature,
  not an afterthought.

### 7. A render pipeline that respects your time

Everything Media Encoder should have been:

- **Bulk render** clips / sequences in one pass.
- **Naming templates** — custom prefix / suffix / tokens.
- **Folder-destination presets** — remember where things go.
- **Scheduled renders** — queue it for later / overnight.
- **Partial / range render.**
- **Preview compressor** — a fast, bitrate-squeezed export for quick previews.
- **AI-enhance on export** (via your own credentials — see pillar 9).

### 8. Radically hackable & extensible

"Super flexible + open source" made concrete. This is what makes FLUX outlive its first version.

- **Custom UI skins by script** — anyone can restyle the whole app: windows, panels, add-ons,
  make it look exactly how they want (Obsidian-CSS energy).
- **Custom nodes / SDK** — write new nodes, effects, generators and drop them in. The graph is
  extensible to the core.
- **Full scripting API** — automate and generate anything; build your own tools on top.
- **Hackable core** — open and forkable; power users can rewire fundamental behavior, not just
  add plugins.
- **A community marketplace** (Obsidian-style) where the community ships the add-ons that
  complete the missing functionality — skins, nodes, effects, automations, tools.

### 9. AI: optional, and bring-your-own-key

Deliberately **not** AI-native at the core (open-source + weak local models = a bad promise).

- **A little built-in AI** where it genuinely helps and stays local/cheap: masking, small
  suggestions. Useful, never mandatory — the app is fully usable with all of it off.
- **Bring-your-own credentials.** Users plug in their **own** API keys — Topaz, ElevenLabs,
  Seedance / Kling / nano-banana, an LLM with MCP — and unlock in-app superpowers:
  direct upscale, generative fill, generate media, AI-enhance-on-render, prompt-driven help
  and automation.
- **Billing stays isolated per user.** Your keys, your usage, your bill — never pooled, never
  ours.
- **Later:** an external automation API + MCP so FLUX itself can be driven and orchestrated
  by other tools and agents.

---

## What FLUX is *not* (scope guardrails)

Saying no is how this ships. FLUX is deliberately:

- **Not a full 3D DCC.** It uses 3D as *one signal type* — cameras, placement, importing/
  compositing 3D — but it is not trying to replace Blender's modeling/sculpting/simulation.
- **Not a real-time game renderer.** It borrows Unreal's *interactivity/data-flow spirit*, not
  its job. No trying to out-render UE5.
- **Not a bloated everything-app on day one.** The first version is small and sharp (see phases).
- **Not locked down.** No proprietary black boxes where an open format would do.

---

## Who it's for, and when

- **Now — you (builder & first user).** Built around a real editing workflow, tested daily by
  the person making it.
- **First audience — solo creators.** Indie editors, motion designers, sound designers, VJs,
  reels-makers who are tired of six apps. Single-user workflows, done beautifully.
- **Later — production teams.** Once the solo core is solid: **shared cache servers**,
  **live editing while filming**, collaborative/shared projects, review pipelines, and the
  team infrastructure that comes with them.

---

## Rough roadmap (phases, not promises)

> Order and contents will move. This is a sketch of the climb, not a contract.

- **Phase 0 — Foundations.** The signal-graph engine and the dual-view (timeline ⇄ node graph)
  concept proven on the simplest possible slice.
- **Phase 1 — Editable & exportable.** **Video editing (NLE)** on the timeline + a **real render
  pipeline (export/encoding)**. The keyboard-first command palette from the very start. This is
  the first genuinely *usable* FLUX.
- **Phase 2 — Motion & compositing.** Keyframes, effects, masks, comps — the node graph earns
  its keep. The good-looking blueprint/geonode UX.
- **Phase 3 — Native audio / DAW.** Mixer buses across tracks, VST hosting, spatial audio,
  synths/oscillators.
- **Phase 4 — Cross-domain reactivity.** The TouchDesigner payoff: any signal drives any other,
  live. Audio-reactive grading as the flagship demo.
- **Phase 5 — Extensibility & marketplace.** Skins, node SDK, scripting API, community add-ons.
- **Phase 6 — AI (BYO-key) & performance polish.** Credential-based AI features; the
  golden-midpoint cache matured.
- **Phase 7 — Teams.** Shared cache servers, live-on-set editing, collaboration.
- **Later — External API + MCP** for orchestration and automation from outside.

*(The smart cache and keyboard-first control aren't a single phase — they're threaded through
every phase, because they're the identity of the app.)*

---

## Open questions (for the next docs, not now)

Parked deliberately — none of these change the vision, they're the *next* layer down:

- ~~The exact **dual-view interaction model**~~ → resolved in
  [`docs/INTERACTION-MODEL.md`](docs/INTERACTION-MODEL.md): panels + workspaces, a recursively
  nested node graph, and timeline/node as two lenses bound by a shared clock, selection & scope.
- **Signal-type taxonomy** — the precise set of media/data types and how conversions are defined.
- **Performance strategy** — what the golden-midpoint cache actually keys on to decide quality.
- **Extension/plugin security** — how far "hackable core" goes without becoming a footgun or a
  malware vector in the marketplace.
- **Project file format** — must be open, inspectable, ideally diff-friendly.
- **Platform & tech** — *explicitly deferred.* No language, framework, or platform chosen yet.

---

## Naming

**FLUX** is a placeholder — it fits (signal *flow*, reactive, everything in motion) but isn't
locked. A few directions to react to:

- **Flux** — flow, reactivity, signals in motion.
- **Loom** — weaving every media thread into one fabric.
- **Continuum** — one unbroken workspace; no app-switching.
- **Nodal / Synapse** — leans into the node-graph identity.
- **Forge** — a maker's engine.

Tell me which way you lean (or bring your own) and I'll thread it through everything from here.

---

*This is the north star. Next doc down is where we start making it real — but only when you're
happy this captures the vision.*
