# FLUX — Settings

### Three levels, nineteen pages, and the order to build them in

> Plan doc. The shell is built and every page in it is reachable. **Three of the nineteen are
> real** — Hotkeys & Presets, Appearance and Cache — and seven of the rest point at a setting
> that already exists somewhere else in FLUX. This is the document that says what each page
> will hold and, more usefully, what has to exist underneath it first.
>
> Open it in the app with `3` or `Ctrl ,` and read it there: each page states its own plan,
> and the side panel's search reads those plans, so "VST" finds Plugins without knowing it is
> called Plugins. This file is the same content with the dependencies and the ordering added.

---

## The one idea

**A setting's level is a statement about where it travels.** That is the whole reason there are
three of them rather than one long list, and getting it wrong is the kind of mistake that stays
invisible until somebody opens FLUX on a second machine.

| Level | It belongs to | It follows you to | It must never hold |
|---|---|---|---|
| **Account** | you | every machine you sign into | anything about a disk, a device, or other people |
| **Workspace** | the shared world | every member and every device in it | anything true of only one computer |
| **This device** | this computer | nowhere — it stays here | anything another machine would need |

The user's framing of the third was *"local settings level, or device, or project — you name
it"*. It is named for the device, because that is what the answers are about: which audio
interface, which disks, how much of this machine's memory. **A project setting is a different
idea and it already has a home** — sequence settings live in the `.fluxseq` document, which is
where something that must still be true tomorrow on somebody else's computer has to live. If a
setting ever wants to be in the document, it is not a settings page, it is a document field.

### Why an account exists at all

Because of the goal underneath this whole app: *edit anywhere, connect to any project, let
others in when it helps.* That needs a thing that is **you** separately from the machine you
happen to be sitting at, and a thing that is **the shared work** separately from either. An
account is local first — it exists on this machine whether or not it has ever spoken to a
server — so signing in is about claiming an account that is already here, not about being
issued one. Nothing in FLUX stops working if the cloud is never switched on.

---

## Account

Four pages. These are the ones a person notices in the first ten minutes.

| Page | What it will hold | Needs first |
|---|---|---|
| **General** | Display name, email, avatar, sign in and out. Which workspace and project open on launch. | An account record on disk, and a store for it that is not the project document |
| **Appearance** | **Built.** Three dark themes, five accents, density and text size. Still to come: a custom stylesheet, and fonts once FLUX ships some. | — |
| **Notifications** | Per event: render done, render failed, batch finished, update ready, a collaborator saved. Toast, the work ring, the OS, or a phone. | An event bus worth subscribing to; most of these events are already emitted somewhere |
| **Hotkeys & Presets** | **Built.** Every command with its binding, click to rebind, conflict detection, named sets. Export and import are a clipboard round trip. | — |

**Appearance and Hotkeys were the two to build first**, for the same reason: the data model was
already right. A skin is a file that redefines the tokens in `styles/theme.css` and nothing
else; a keymap editor is a view over `defaultKeymap`. Neither needs an account, a workspace, or
a server — so they are the pages that prove the shell with the least underneath them. Both are
built now, and both found the same shape of problem: the model was right and something was
quietly bypassing it.

### Three dark themes, and no light one

Default, Darker and Neutral. A theme is a block of token overrides selected by
`data-flux-theme`, which is the mechanism a hand-written skin will use — so the switcher could
not invent a second one. The blocks are not rooted to `:root`, which is what lets each theme's
swatch on the page carry its own `data-flux-theme` and be painted by the very block it selects.
A picker whose swatches are hardcoded approximations stops matching the first time somebody
edits the palette.

**No light theme, deliberately.** An editor is dark because the picture is the brightest thing
on screen and anything around it biases how you read it. A light theme for a tool whose job is
judging images is not a preference, it is a worse instrument. So the axis offered is how dark
and how neutral — the same axis Resolve and Premiere offer, and the one people actually ask for.

Neutral is the one with a real argument behind it: a tinted interface shifts your perception of
a grade and a desaturated one does not, which is also why it pairs with the grey accent. Nothing
in that theme has one channel differing from another, and the harness asserts it.

**Contrast is measured, not eyeballed.** Three text tiers against the panel they sit on,
in all three themes. Body reads 13.1–13.6:1 and dim 4.7–5.2:1, which clear AAA and AA. The
faint tier reads 2.9:1 in the shipped default — below AA, and already true before this page
existed — so the harness holds every theme to *at least* the default rather than pretending
otherwise. Both new themes measure 3.3:1, above the 3:1 line the default misses. Raising the
default palette is a design decision for whoever owns the app, not something to slip into a
settings page.

**Density and text size are separate controls**, because "I cannot fit enough on screen" and "I
cannot read this" are different complaints and one slider for both makes each harder to fix.
Density moves chrome heights and the gutter; the scale moves only type. The harness asserts the
separation in both directions.

### And the audit Appearance forced

`styles/theme.css` opens by saying that a component which hardcodes a colour has punched a hole
in the skinning system. Measured on the way into this page, `app.css` held **54 colour literals
and 67 hardcoded font sizes** — so the claim was decoration, and a theme switcher built on top
of it would have half worked in a way nobody could have predicted from reading the file.

Two kinds of hole mattered.

**Four token names that were used and never declared.** `--flux-ok`, `--flux-danger`,
`--flux-dim` and `--flux-line` appeared only as `var(--flux-dim, #8b93a1)`, with the fallback
doing all the work. A skin that redefined them would in fact have worked, which makes this the
worst kind of hole in a token system: not broken, just undiscoverable. They are declared now,
the dead fallbacks are gone, and the harness fails on any `var(--flux-…, literal)` because a
fallback is how this hid for months.

One of them was hiding a second value. `--flux-danger` had two different fallbacks — `#d05f5f`
on borders and text, `#b3403a` on a filled destructive hover — so collapsing them would have
lightened a button. The fill has its own token now, at exactly the value it had.

**Two near-black chrome surfaces.** The viewer stage and the node-map backdrop were literals, so
a darker theme would have left two large rectangles at the old brightness. They are
`--flux-bg-stage` and `--flux-bg-canvas`.

**And the type.** 67 font sizes were hardcoded px against 106 that used the tokens, so a text
scale would have resized 61% of the interface and left the rest — which reads as a bug, not as a
setting. Every one of them is `calc(Npx * var(--flux-text-scale))` now, identical at 100%.

#### What is still hardcoded, and why

Not everything should be a token, and the two groups that stay are worth naming because the
reasons are different.

**Content black** — the viewer frame, the letterbox bars, a sequence thumbnail. A picture is
judged against black, not against whatever the chrome happens to be; theming these would make
the app lie about the footage. **Shadows** — black at low alpha, which reads correctly over any
surface in any theme.

Those, plus fourteen cosmetic details (tinted text on tinted badges, the grid dot, the two
shades of the loading barber pole), are held in an allowlist in `verify-appearance.mjs` as a
budget *per reason* rather than one total — so removing a shadow does not quietly buy somebody
the right to hardcode a surface. A new literal fails the run. That is what turns the paragraph
at the top of `theme.css` from a claim into a check.



### What building Hotkeys actually took

The prediction held: the page is a view over the map, and most of the work was the two things
the map did not have.

**A store to keep an edited map in.** `kernel/keybindings.ts` — the bindings in force, loaded
at boot, written on every change, with named sets beside them. Two rules in it are worth
stating because they are the ones that would be wrong by default:

- **A stored map is the whole truth**, not a layer over the defaults. Merge them and a binding
  somebody deliberately *cleared* comes back on the next launch, which is why `resetAll` is an
  explicit act rather than an implicit one.
- **A set is the whole map**, not a diff from the defaults. A diff is smaller and is the wrong
  shape: a saved set has to still mean the same thing after a release changes a default, and a
  diff would silently absorb that change.

**A way to capture a chord while the app is listening for the same keys.** Press `Ctrl M` to
rebind something and FLUX would send the sequence to render while you were still choosing. So
capture installs its listener in the **capture phase** on `window`, which runs before the
keymap's own bubble-phase listener, and calls `preventDefault`; the controller checks
`defaultPrevented` and steps aside. That is the same mechanism the folder tree already uses to
keep its arrow keys away from the playhead.

It also has to produce chords the keymap can hold, which includes the held-key ones: `S` is both
a command and a modifier, so eight of the shipped bindings look like `s+arrowup`. Capture keeps
its own held set and asks `chordOf` — the same function the controller asks — rather than
assembling a chord string itself. A page that could display a binding it could not reproduce
would be a page that quietly refuses to edit eight of its rows.

### And one thing the plan did not see

**A command registry is not a catalogue.** Most commands belong to panels and are registered
when the panel mounts, so `commands.list()` is whatever is open right now — and the settings
page lives in a workspace with no Timeline, Viewer, Content Browser or Render in it. Measured:
**47 commands loaded there, against 117 the build actually has.** A hotkeys page built on that
list would hide the entire Timeline from the one page made for rebinding it.

The fix is not to move panel commands into the app; they belong to their panels, and that is the
SDK seam working. What was missing was the distinction between *runnable now* and *exists in
this build*, so the registry gained `catalogue()` — everything it has been told about since
launch, kept when the command goes away. The page lists that, and marks a command whose panel is
closed, because such a command can still be rebound (the keymap is data, and the binding works
the moment the panel opens) while the key does nothing in the meantime. A row that looked
identical to a live one would make that read as a broken rebind.

The gap this leaves is honest and small: a session that has never opened a panel does not know
its commands. Opening the Edit workspace once fills it, which is what an editor does before
reaching for the settings.

---

## Workspace

Seven pages. This is where the collaboration story lives, and where almost nothing exists yet.

| Page | What it will hold | Needs first |
|---|---|---|
| **General** | Name, logo, the projects in it, in an order you set. Archive without deleting. | A workspace record, and projects knowing which workspace they are in |
| **Members and devices** | Invited people with roles, and your own machines — laptop, phone, workstation — each named and each sign-out-able | Identity, and then the sync layer |
| **Automation and MCP** | Triggers and actions. The MCP server as something you can see: running, which tools, which model, and a log of what it did | Partly built — the control surface and MCP server work today |
| **API and Webhooks** | Keys you can issue, scope and revoke. Webhooks per event with payload shapes, a delivery log and a retry | The same event bus Notifications needs |
| **AI** | Bring-your-own-key per provider for language, vision, audio and upscale models. Direct providers and aggregators. A map from *job* to model | A secret store that is not a JSON file in plain text |
| **Libraries** | Render presets, effect presets, title styles, LUTs, sound beds — stored with the workspace so every device has them | Presets existing as saveable things at all |
| **Cloud** | The switch, and then what syncs, what happens to a file too large to send, and what happens when two people edit one sequence | Everything above it |

Two notes on shape:

**Members and devices is one page on purpose.** A colleague's laptop and your own phone are the
same kind of thing to this app: something that may hold a copy of the workspace and sync changes
into it. The question *"what can reach my work"* should have one answer, not two lists in two
places that can disagree.

**Automation and API are deliberately separate.** Automation is FLUX acting on itself — when a
folder gains footage, import it; when a render finishes, move the file. API and Webhooks is FLUX
talking to things that are not FLUX. They feel adjacent and they have different failure modes:
an automation that misfires makes a mess in your project, a webhook that misfires makes a mess
in somebody else's system.

**Automation and MCP is the page to build first in this level**, because half of it already
runs. The control surface and the MCP server are working today — a loopback port with a
per-launch token, ten tools, and a model that can import an edit and start a render. What is
missing is any way to *see* it: whether it is running, what it is allowed to do, and what it
has actually done. That last one is the real feature. A model that can start a render on your
machine should keep a log you can read.

---

## This device

Eight pages. The least glamorous level and the one with the most immediate payoff, because
these are the settings that decide whether the app is fast and whether the sound comes out of
the right box.

| Page | What it will hold | Needs first |
|---|---|---|
| **Controllers + Hardware** | A game controller mapped to the transport, touch adaptation, a headset later. CPU, GPU, memory, and every disk with its kind and free space | A hardware probe in main; partly there already |
| **Audio** | Output device, sample rate, buffer. Input for live recording with a meter and monitoring. What to do when a USB interface disappears mid-session | Device enumeration, and the mixer taking a device rather than the default |
| **Plugins** | Installed panels and extensions, VST/VST3 scan paths with what was found and what failed, and a folder of scripts | Nothing for panels — the registry is already the public seam |
| **Saves** | Autosave interval and how many versions, where backups go, a list of them, opening one without overwriting. Save before a render | A backup writer |
| **Display** | Pixel format and bit depth for the preview, colour management for this monitor, HDR, which screen a full-screen preview uses | Colour management, which is the real work |
| **Mapping** | Clip label colours and what each means, marker colours, media icons, the colours the readiness strip uses | Nothing |
| **Cache** | **Built.** Where the caches are, how much is in them by kind, and a clear for each. Still to come: prerender and bake policy, a shared bake folder, per-project cache locations | — |
| **3D** | Import formats, scale and axis conventions, what to do with cameras and lights, which renderer | Reading a mesh at all |

**Cache was first, and it is built.** The three questions a cache page exists to answer are
where it is, how big it has got and how to empty it, and FLUX could answer none of them — the
honest answer was "open AppData and look", which is the answer every editor has been mocked for
giving. The page answers all three, by kind, and clears them the same way.

### It is a measurement, not another set of sliders

The budgets were already there. How many decoders may be open, how much decoded picture may be
held, how far ahead to warm and **how much disk the cache may use** are all in the performance
dialog, resolved against the machine, and the main process reads the disk one out of the store to
prune to at startup. A second slider on this page would have meant two places to change one
number and the loser would be whichever the user did not open. So the page points at that dialog
and owns the half nothing owned.

Which is how it found the bug.

### The prune and the dialog disagreed by a factor of twenty-three

The page draws a bar of what is cached against the budget it is pruned to, and the two numbers
had to be fetched from opposite sides of the app to put next to each other. They did not match:
**256MB on one side and 5991MB on the other.**

`kernel/performance.ts` scales the disk budget with system memory — 64MB per gigabyte — which on
a 94GB machine is around six gigabytes. The main process could not run that formula: it is
TypeScript in the renderer bundle, and the prune happens at startup, before any renderer exists
to be asked. So it read the store, found nothing pinned, and fell back to the media cache's own
`CACHE_BUDGET_BYTES` of 256MB.

Nothing pinned is the normal state. It is every machine where nobody has opened the performance
dialog, which is nearly all of them. So the index cache was being trimmed to a twenty-third of
its intended size on first launch, every launch, and the only symptom was clips occasionally
taking the slow path to open again for no reason anybody could point at. A cache quietly too
small does not look like a bug; it looks like the app.

The formula now lives in `shared/performanceDefaults.js` — plain JS with no imports, like the
rest of `shared/` — and both sides read it. One formula, two readers, and a check that fails if
they ever disagree again.

### Two caches, and only one of them is ours

The other thing measuring turned up: on the machine this was built on, FLUX's media cache held
**30MB** and Chromium's caches beside it held **619MB**. Fetched files and V8's compiled code,
in the same app-data folder, twenty times the size of the cache we designed — and nothing in
FLUX had ever cleared them or counted them.

So they are on the page, in their own group, labelled as not ours. A page that reported only the
cache we chose the layout and the budget for would have been wrong by a factor of twenty and
would have sent anybody short of disk looking in the wrong folder. They are cleared through
`session.clearCache()` and `clearCodeCaches()` rather than by deleting the directories, which
are open — on Windows that fails halfway and leaves a cache Chromium believes in and cannot read.

The shader caches next to them are left alone and not mentioned: a couple of megabytes, held open
by the GPU process, rebuilt by the driver whether we like it or not. A button that cannot work is
worse than no button, which is the same rule the rest of these pages follow.

### What a kind is, and why the names moved

Entries are hex-named files in one directory, so a report has to open each one to know what it
holds. Four kinds do: thumbnails, audio peaks, and a frame index each for picture and sound. They
are listed in that order — cheapest to rebuild first — because that is the order somebody
clearing selectively wants to read them in. A thumbnail is a second; a sample table for a long
clip is a megabyte and twenty-two milliseconds of ranged reads on every open.

Each of those names used to be a private constant in whichever module wrote it. They are in
`kernel/cache.ts` now and the producers import them, because a name declared privately is a name
the report cannot know: rename one and the page grows a mystery bucket instead of a row. An entry
whose header cannot be read — a write cut short by a crash — is counted and shown, and survives a
by-kind clear rather than being guessed at. Guessing wrong there deletes the expensive thing to
spare the cheap one.

```bash
npm run verify:cache
```

Thirteen checks, in two halves. The measurement is exercised against a real temp directory from
plain Node with no app running, writing entries through the real `writeDerived` so the preamble
the kind is read back out of is the one the app writes. The page is then checked against the
directory it is describing: the path it names is the one the app caches into, the bar is drawn
against the budget the main process prunes to, a hand-edited budget is held to the same bounds
on both sides, and a clear is pressed and the disk re-measured —
including the window one, pressed for real, because the two Electron APIs behind it are the only
part of this page that cannot be reasoned about from our own code.

**Then Audio**, because it is the one gap in this level that stops work rather than slowing it.
A session mixed through motherboard output is a session mixed wrong, and there is currently no
way to say otherwise.

**Mapping is the cheapest page in the whole document** and worth doing early for that reason
alone: it needs nothing to exist first, and it is a real customisation. If green means
"approved" in your edit room, the app should be able to say green.

---

## What is already true

Seven of the nineteen pages name a setting that **exists in FLUX today**, and each says so with
a button that takes you to it. This matters more than it sounds: a page promising a cache
setting the app has had for weeks is worse than a page saying nothing, because it sends somebody
looking for a feature they already own.

| Page | What exists | Where |
|---|---|---|
| Appearance | Panel arrangement and named layouts, which is the other half of how it looks | Window menu, layout tabs |
| Automation and MCP | The control surface and the MCP server | Loopback port with a per-launch token, `mcp/server.mjs` |
| Controllers + Hardware | What the machine would choose for playback, read from the machine | Performance dialog |
| Audio | The sequence's rate and channel count | Sequence settings (a document fact, not a device one) |
| Saves | Saving the project | `Ctrl S` |
| Display | Preview resolution, separately for playing and for a paused frame | Viewer toolbar |
| Cache | The budgets themselves — decoder pool, frame memory, warm radius, disk | Performance dialog |

---

## How the page is built

It is a **panel**, registered through the same `panels.register()` a community panel uses, shown
in a workspace of its own that fills the dock. Not a modal, and not a special case the shell
knows about — deleting one line from `src/panels/index.ts` removes it cleanly.

That is the Export page's pattern, and the reasoning in `kernel/workspaces.ts` applies
unchanged: Premiere, Resolve and Media Encoder all reach "a whole page rather than a dialog"
because a question you cannot answer from a corner of the screen should not be asked in a corner
of the screen. It also means Settings can be docked beside the Timeline — which is the only
honest way anybody has ever tuned a cache: change the budget and watch what playback does.

The content is data. `src/kernel/settings.ts` holds the levels and the pages; the panel is a
view over it. A page becoming real means giving it a component, not restructuring anything.

### The rule every page follows

From `kernel/tools.ts`, where half the tool strip has always been unbuilt and has always said
so: **an unbuilt thing says it is unbuilt and says what it will be. A control that silently
does nothing is a bug report waiting to be written.**

So there are no disabled sliders and no dead switches anywhere in here. A planned page has
*prose*, and prose cannot be mistaken for a feature. `npm run verify:settings` asserts exactly
that — it opens all nineteen pages and fails if any planned one carries an input, a select, a
textarea, a switch, a slider, or any button other than one that runs a command that really
exists.

```bash
npm run verify:settings
```

Five checks: all three ways in land on the same panel; three levels and nineteen pages, each one
opening to its own title with a plan long enough to be worth reading; no page drawn as working
that is not; search reading the plans and not just the names; and every "Take me there" pointing
at a registered command.

That last check found the one real bug in this work. `app.performance` was registered by the
**Timeline panel**, so the command existed only while that panel was mounted — and the Settings
workspace has no Timeline in it. The Cache page's button would have done nothing. The dialog and
its command now belong to the app, which is where a machine-wide setting always belonged: a
setting that disappears when a panel closes has the same shape as a mode owned by the panel that
displays it, which is the mistake `kernel/tools.ts` was written to avoid.
