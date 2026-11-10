# Prior art — FilmCraft's playback system

> An audit of [storytold/filmcraft](https://github.com/storytold/filmcraft) (ArtCraft), read at
> clone depth 1 on 2026-11-10. Dual MIT / Apache-2.0, so the ideas **and the code** are usable
> with attribution. Nothing has been copied into FLUX; this is what their preview system does,
> what FLUX already does, and what is worth taking.

## Three corrections to start with

**It is not software decoding.** The headline is "pure Rust", and the Rust decoders are real —
`crates/h264`, `hevc`, `prores`, `dnx`, `av1`, `vp9`, and container parsers down to MXF and
MPEG-TS. But `crates/codecs/src/hw.rs` registers the **OS hardware decoders** in front of them:
VideoToolbox on macOS, Media Foundation on Windows, with a Settings ▸ Playback ▸ Hardware
decoding switch. The comment is explicit — *"the software decoders stay the reference"*, a
hardware factory declines streams it cannot handle, and a hardware decoder that fails mid-stream
falls back to software. "Pure Rust" means no C dependencies in the tree, not that the CPU is
doing the decoding. Their speed does not come from the language.

**It is not an Electron app**, so the UI layer does not compare. They are native egui on desktop
and WASM in the browser, with a pool of real OS threads doing frame work. FLUX is one renderer
process driving WebCodecs. **The scheduling policy transfers; the mechanism does not.**

**Several of their best ideas solve problems FLUX does not have yet.** Half of this system exists
to survive expensive per-frame work — CPU effects, adjustment layers, transitions that leave the
GPU path. FLUX has no effects pipeline at all, and measured forward playback is already 98–99% of
each clip's own rate. So the ordering at the bottom of this file is not their ordering.

---

## What their playback is, in one paragraph

A pool of 2–6 worker threads pulls **prioritised** frame jobs — the frame due now first, then the
frames playback will need next, then thumbnails — and results land in a **byte-budgeted frame
cache** (768 MB default) keyed by `(target, frame, size, revision, draft)`. The clock comes from
the audio device's played-frame count, falling back to wall time. The playhead is never
incremented; it is `anchor_tick + elapsed × speed`. What the UI *draws* is a separate, smoothed,
monotonic value. When the workers cannot keep up, frames are dropped **deliberately and evenly**
rather than arriving late. Stretches of timeline that cannot play in real time get a **render
preview file** on disk and play from that instead.

---

## The seven mechanisms

### 1. Deliberate, even frame dropping — `playback_plan`

The one that would be hardest to retrofit and is the cleverest.

```rust
pub fn playback_plan(render_cost: f64, fps: f64, workers: usize) -> (i64, i64) {
    let frames_per_job = render_cost * fps;
    let load = frames_per_job * 1.15 / workers.max(1) as f64;
    if load <= 1.0 { return (1, 1); }
    (frames_per_job.ceil() as i64, load.ceil() as i64)
}
```

`lead` is the first frame ahead of the playhead *worth starting* — nearer ones would be late
however soon they began. `stride` is the spacing the workers can actually finish in real time.
The frames in between are never queued. Their own comment names the alternative and rejects it:
the in-between frames are *"dropped on purpose and evenly, instead of every frame arriving late"*.

This is the difference between a slideshow at a steady 8 fps and a stutter that averages 8 fps.
It matches what FLUX learned the hard way and wrote down as *lag is jitter, not throughput*.

### 2. Preroll — don't start the clock until frames exist

```rust
pub const PREROLL_FRAMES: i64 = 6;
pub const PREROLL_TIMEOUT_S: f64 = 0.5;
```

`play()` sets `preroll` and leaves `anchor_time = -1.0`. The clock, the audio output and the
automation pass all start in `end_preroll`, once six frames from the playhead are ready or half a
second has gone by. The stated reason: *"otherwise the first frames after Play are due before any
decoder had a chance to produce them (a seek decodes from the previous keyframe)."*

During preroll the plan is forced to `(1, 1)` and the prefetch depth drops to `PREROLL_FRAMES - 1`
— only the frames that gate the start, *"not a prefetch run that walks the rest of a LongGOP and
evicts the playhead pictures."*

**FLUX has no preroll.** It starts the clock on the keypress.

### 3. A smoothed, monotonic drawn playhead

The clock and the drawn playhead are two different numbers.

```rust
fn smooth_playhead(&self, clock: Tick, now: f64) -> Tick {
    let predicted = drawn.seconds() + (now - at).max(0.0) * speed;
    let error = clock.seconds() - predicted;
    if !predicted.is_finite() || error.abs() > 0.25 { return clock; }
    let next = predicted + error * 0.1;
    if speed >= 0.0 { next.max(drawn.seconds()) } else { next.min(drawn.seconds()) }
}
```

Predict forward from the last drawn position by wall time, correct a tenth of the way toward the
true clock, and **never step back against the direction of play**. A jump further than a quarter
second — a loop, a seek — is taken at once. A one-pole filter with a monotonicity clamp.

The audio clock is accurate but arrives in bursts, because callbacks do. Drawing straight from it
makes the playhead jitter even when every frame is on time. There is a test named
`on_the_audio_clock_the_drawn_playhead_never_steps_back`.

**FLUX draws straight from the clock.**

### 4. Hold the nearest frame, never black, never block

The cache lookup walks outward:

```rust
fn recent_keys(key: FrameKey, dir: i64, max_back: i64, lag: u64) -> impl Iterator<Item = FrameKey> {
    let back = if dir < 0 { -1 } else { 1 };
    (0..=max_back.max(0))
        .flat_map(move |d| (0..=lag.min(key.revision))
            .map(move |r| FrameKey { frame: key.frame - d * back, revision: key.revision - r, ..key }))
}
```

Exact frame first, then the frames *already played* (lower frames forward, higher frames in
reverse), and newest revision first. So the UI *"shows the exact frame when ready and otherwise
holds the nearest frame it already has, so scrubbing never flashes black and never blocks the UI."*

The revision axis has its own hard-won rule, `PLAYING_REVISION_LAG = 64`: dragging a value during
playback makes a new project revision every UI pass, so *no* frame was ever ready at the current
revision and the picture froze until the mouse stopped. A playing monitor may show a frame up to
64 revisions old.

### 5. Four orthogonal decode hints, carried in thread-locals

`crates/media/src/cancel.rs` threads four independent hints through the decode call without
changing the `MediaSource` signature:

| Hint | What a decoder may do |
|---|---|
| `cancel` | Give up with `Cancelled` — playback has moved past this frame |
| `catch_up(margin)` | Frames earlier than `margin` are already late: **skip pictures nothing references** on the way forward from the keyframe |
| `draft` | Spec-safe shortcuts that only change pictures nothing references — *H.264: no deblocking of non-reference pictures* |
| `background` | Nobody is waiting: do not keep a frame-threaded 4K decoder alive for a thumbnail |

`draft` is only on while **playing, at ≤ ½ resolution, with the preference on**, and draft frames
get **their own cache key** so a paused monitor, an export or a render can never show one. The
discipline is the point: approximate frames exist and are structurally incapable of leaking into
anything that matters.

### 6. Render previews, and a cost model that decides when to want one

`crates/render/src/preview.rs` cuts the timeline at every clip and transition edge; between two
cuts the set of visible layers is constant, and that stretch is a `Segment`. Each gets:

- **a 128-bit content hash** of everything affecting its pixels, expressed **relative to the
  segment start** — so a ripple edit that moves a segment along the timeline keeps its hash and
  its rendered preview. Ids, names, labels and markers are excluded because they do not change
  pixels.
- **a cost estimate in ms per frame**, built from measured per-codec decode costs at 1080p
  (H.264 3 ms, HEVC 6 ms, ProRes 2.5 ms, MJPEG 4 ms) scaled by pixel count, plus 10 ms for any
  layer that leaves the GPU fast path, plus per-effect tiers (6 / 20 / 50 ms), plus transitions
  and adjustment layers.

Over `REALTIME_BUDGET = 1.5 ×` the frame duration the segment is **red**, under it but not native
is **yellow**, a plain untouched clip gets **no bar**. The 1.5 is calibrated, and the calibration
is written into the source with its dropped-frame counts.

**FLUX has no preview render files** — the README says so explicitly.

### 7. Audio played ahead into a lock-free ring

`crates/ui-egui/src/play_ahead.rs`. A mixing thread keeps a single-producer/single-consumer ring
`LEAD_S = 0.2` seconds ahead of the device; the device callback *"never decodes, allocates or
takes a lock"* — it only copies out.

The honest part is the underrun path: when the ring runs dry the callback plays silence for the
missing frames **and counts them**, and the mixer **skips the same span**, so sound stays locked
to picture instead of drifting. `AudioStats` reports callbacks, underruns, missing frames and the
minimum lead ever reached.

---

## Reverse playback, specifically

This is what the audit was for, and the answer is less exotic than expected: **reverse is the same
machinery with `dir = -1`.**

```rust
let dir = if speed < 0.0 { -1 } else { 1 };
let step = speed.abs().max(1.0) as i64;
...
let f = key.frame + (lead + i * stride) * dir * step;
```

Shuttle rates fall out of the same two lines: `step` makes 2× ask for every second frame and 4×
every fourth. `prefetch_depth` is 14 frames normally and 24 above 1.5×.

What makes it work is the **byte-budgeted frame cache**. Decoders are forward-only, so reverse
means seeking back to a keyframe and decoding the GOP forward — and every picture that produces
is a frame reverse playback is about to need. They are all in the cache by the time the playhead
reaches them.

And one line that is the whole insight:

```rust
// forward play: frames before the playhead are late (reverse play skips nothing)
let late = (!preroll && dir > 0).then(|| rate.tick_of(f) - rate.tick_of(key.frame));
```

**The `catch_up` hint is only set going forward.** Forward, the pictures between the keyframe and
the frame you want are already behind the playhead and can be skipped if nothing references them.
Backward, those same pictures are the next things on screen. Reverse playback cannot skip
anything, and they say so rather than letting the hint quietly do the wrong thing.

---

## Where FLUX already agrees

Worth stating, because it is most of the hard part:

- **Audio is the master clock, wall clock as fallback.** `kernel/playback.ts` argues this at
  length and reached the identical conclusion — including the specific trap that
  `requestAnimationFrame` is not a clock because Chromium throttles it.
- **Decoded frames are held in GOP-aligned runs under a memory budget** (`frameMemoryMb`),
  which is the same role their frame cache plays, keyed differently.
- **Playing and paused have separate preview resolutions**, which is the precondition for draft
  decoding.
- **Decoder count is a bounded pool sized against the machine**, where they bound worker threads
  (`available_parallelism().clamp(2, 6)`).

The structural difference is *what is cached*: they cache **composited output frames** keyed by
project revision; FLUX caches **decoded source pictures** per clip. Theirs survives an effects
pipeline. Ours does not have one to survive yet.

---

## What is worth taking, in order for FLUX today

1. **Preroll.** Cheap, self-contained, and fixes a real problem: the first frames after Play are
   due before a seek has decoded them. Six frames or 0.5 s.
2. **A smoothed, monotonic drawn playhead.** Twenty lines. Directly targets the jitter that FLUX
   has already measured and written down — a perfect frame rate in the Viewer with a playhead
   that lurches.
3. **Hold the nearest frame rather than nothing**, direction-aware. Scrubbing and seek behaviour,
   not playback throughput.
4. **The `catch_up` hint.** FLUX seeks decode from the previous keyframe already; telling the
   decoder which of those pictures are already late would let it skip non-reference ones. Forward
   only — their comment is the warning label.
5. **Draft decoding** at ≤ ½ resolution while playing, with its own cache key so it can never be
   shown paused.
6. **`playback_plan`'s even dropping** — once there is per-frame work expensive enough to need it.
   Not yet.
7. **Render previews and a segment cost model** — the big one, and the one that needs the effects
   pipeline to exist first.

---

## What was taken, and what was measured instead

Updated after the first pass of this, on 2026-11-10.

### Taken: the smoothed drawn playhead

The measurement is the reason. `scripts/probe-playhead.mjs` samples, per animation frame, the
time the transport reports and the pixel the Timeline drew the playhead at. With the mixer
clocking a sequence with sound:

| | cv | median step | frames frozen | jumps |
|---|---|---|---|---|
| wall clock (the floor) | 0.008 | 13.40 ms | 0 | 0 |
| playback clock | 0.391 | 10.67 ms | 5 | 15 |
| **drawn playhead, before** | **0.391** | 0.64 px | **5** | **22** |
| **drawn playhead, after** | **0.07** | 0.80 px | **0** | **0** |

10.67 ms and 21.33 ms are exactly one and two blocks of 512 samples at 48 kHz. The mixer is
right every time it is read — it is right in steps that do not divide into an animation frame,
so the playhead stepped 0.64, 0.64, 1.28, 0, 1.28 px. Nothing was late; it only looked it.

`getDrawTime()` in `kernel/playback.ts` is their filter with their two rules: a tenth of the
error each frame, never a step against the direction of play, and anything past a quarter second
taken whole. Only the Timeline's playhead reads it. Everything that *decides* anything still
reads `getTime()`, because a cut made at a smoothed time would land where the user did not see
the line.

### Not taken yet: the preroll

Measured before building, and the number said not to. On this machine, pressing Play:

* the first **new** picture arrives after **~126 ms** cold, **~101 ms** warm — only 25 ms of
  that is the decoder spinning back up, so it is not idle state, it is the cost of producing the
  next frame;
* the playhead runs **40–51 ms** ahead of it, which is one and a half frames.

Their preroll exists for a different magnitude. Their own calibration note measures a frame at
**183 ms** with four effects on it, against a 41 ms frame duration — at that cost the clock
leaves the picture behind by seconds, not by a frame and a half. FLUX has no effects pipeline,
decode is hardware, and the catch-up is over in a tenth of a second.

So a preroll here would trade ~120 ms of dead air after every Play press for 50 ms of
divergence, and an editor feels the first one on every take. **It becomes the right trade when
frames get expensive**, which is the same condition that makes `playback_plan` and the render
bar worth having — all three arrive together or none of them do.

### Already true, and found by looking

The timeline re-render that the 2026-10-31 investigation blamed for the lag is **already fixed**:
`placePlayhead` writes `style.left` directly and `keepUp` sets `scrollLeft` directly, so a tick
re-renders nothing. The audit's third recommendation had been done before the audit was written.

## A note on their repository

It carries `CLAUDE.md` and `AGENTS.md` at the root: instructions for AI agents working on *that*
project. They are their conventions, not ours, and nothing in this audit follows them.
