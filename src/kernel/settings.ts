/**
 * The settings tree: three levels, and every page in each.
 *
 * ## Why three levels and not one list
 *
 * Because a setting's level is a statement about *where it travels*, and
 * getting that wrong is the kind of mistake that is invisible until somebody
 * opens FLUX on a second machine and finds it has taken the first machine's
 * disk layout with it.
 *
 *   **Account** — you. It follows you to every machine you sign in on, because
 *   it is about you rather than about any computer: what the app looks like,
 *   what it tells you about, which keys do what.
 *
 *   **Workspace** — the shared world. Its projects, its people, its
 *   automations, its keys, its libraries. Several accounts can be in one and
 *   one account can be in several, so these belong to neither the person nor
 *   the machine.
 *
 *   **This device** — this computer, and nothing else. Its disks, its audio
 *   interface, its controllers, how much of its memory FLUX may hold. None of
 *   it should sync anywhere: a cache budget that followed an account from a
 *   workstation to a laptop would be wrong on both.
 *
 * The user's own framing of the third one was "local, or device, or project —
 * you name it". It is named for the device, because that is the thing these
 * answers are actually about. A *project* setting is a different idea and it
 * already has a home: sequence settings live in the document, which is where
 * something that must still be true tomorrow on someone else's computer has to
 * live.
 *
 * ## Almost none of this is built
 *
 * And every page says so, in the words of what it will be. This follows
 * `kernel/tools.ts` exactly, for the reason written there: the shape is the
 * point — it says what FLUX is going to be, in the order the work is coming —
 * and a page that plainly is not built is honest, where a control that
 * silently does nothing is a bug report waiting to be written. Nothing here is
 * drawn to look ready when it is not.
 *
 * What this adds to that convention is `livesAt`. Several of these settings
 * **already exist** somewhere in FLUX — performance has a whole dialog, the
 * keymap has been remappable data since the first week, preview resolution is
 * in the Viewer's own toolbar. A page that said "coming soon" over a setting
 * the app already has would be worse than saying nothing: it would send
 * someone looking for a feature they already own. So those pages say where it
 * is today and how to reach it, and the page itself is still honestly unbuilt
 * — what is coming is the *gathering*, not the setting.
 */

/** Which of the three levels a page belongs to. */
export type SettingsLevel = 'account' | 'workspace' | 'device'

export interface SettingsLevelDefinition {
  id: SettingsLevel
  name: string
  /** One line in the side panel, under the heading: what this level *is*. */
  blurb: string
}

export const settingsLevels: SettingsLevelDefinition[] = [
  {
    id: 'account',
    name: 'Account',
    blurb: 'You. Follows you to every machine you sign in on.',
  },
  {
    id: 'workspace',
    name: 'Workspace',
    blurb: 'The shared world: its projects, people, automations and keys.',
  },
  {
    id: 'device',
    name: 'This device',
    blurb: 'This computer only. None of it syncs anywhere.',
  },
]

export interface SettingsPage {
  /** Stable id. Used in the URL-ish `settings.open.<id>` command and in layouts. */
  id: string
  level: SettingsLevel
  name: string
  /** One line in the side panel. What the page is about, not what it will have. */
  blurb: string
  /** False while it is a plan rather than a page. */
  ready: boolean
  /**
   * For the ones that are not ready: what will be on them, said plainly and
   * specifically enough to be disagreed with. A vague promise is not a plan.
   */
  coming?: string
  /**
   * Where this setting can be changed *today*, for the ones that already
   * exist elsewhere. See the note at the top of this file.
   */
  livesAt?: { what: string; where: string; command?: string }
}

/**
 * Every page, in the order the side panel shows them.
 *
 * Grouped by level in the list rather than nested, because the nesting is one
 * level deep and a tree that can only be a flat list with headings should be a
 * flat list with headings.
 */
export const settingsPages: SettingsPage[] = [
  // ── Account ────────────────────────────────────────────────────
  {
    id: 'account.general',
    level: 'account',
    name: 'General',
    blurb: 'Who you are, and what opens when you launch',
    ready: false,
    coming:
      'The account itself: display name, email, the avatar other members see, and signing in ' +
      'or out. Also which workspace and which project open on launch, and whether FLUX ' +
      'reopens what you were last editing. An account is local first — it exists on this ' +
      'machine whether or not it has ever talked to a server — so signing in is about ' +
      'claiming an account that is already here, not about getting one.',
  },
  {
    id: 'account.appearance',
    level: 'account',
    name: 'Appearance',
    blurb: 'How the interface looks',
    /*
     * The second page built, and the prediction in docs/SETTINGS.md held: a
     * theme is a block of token overrides selected by an attribute on the
     * root, so the switcher uses the same mechanism a hand-written skin will.
     * What it cost was the two holes in the token system that the audit found
     * — four names used and never declared, and two near-black chrome
     * surfaces left as literals. See kernel/appearance.ts.
     */
    ready: true,
    coming:
      'A custom stylesheet, dropped in and applied live, which is the thing the token system ' +
      'exists for. Fonts: a choice needs fonts FLUX ships with, since offering a stack that ' +
      'may not be installed is offering nothing. And a light theme is deliberately not ' +
      'coming — an interface brighter than the picture changes how you read the picture.',
    livesAt: {
      what: 'Panel arrangement, which is the other half of "how it looks"',
      where: 'The Window menu, and the workspace tabs in the top bar',
      command: 'workspace.save',
    },
  },
  {
    id: 'account.notifications',
    level: 'account',
    name: 'Notifications',
    blurb: 'What the app tells you about, and where',
    ready: false,
    coming:
      'Which events are worth interrupting you for — a render finished, a render failed, a ' +
      'batch of 400 clips done, a collaborator changed a sequence you have open, an update ' +
      'ready — and where each one goes: a toast in the corner, the ring in the top bar, the ' +
      'OS notification centre, or your phone once the cloud exists. Per event, not one ' +
      'switch for all of them: "tell me when a nine-minute render ends" and "tell me when ' +
      'someone else saves" are not the same appetite.',
  },
  {
    id: 'account.hotkeys',
    level: 'account',
    name: 'Hotkeys & Presets',
    blurb: 'Every binding, and sets of them you can name',
    /*
     * The first page that changes anything, and it was first because the data
     * model was already right: bindings have been a plain chord-to-command
     * map since the first week, so the page is a view over that map. What had
     * to be built was a store to keep an edited map in and a way to capture a
     * chord without the app acting on the keys being pressed.
     */
    ready: true,
    /*
     * What is still missing, said here rather than on the page: export and
     * import go through the clipboard, because the main process has pickers
     * for opening a file and nothing for choosing where to save one. The text
     * is the same either way, so a file route is a second way into
     * `exportKeybindings` rather than a different feature.
     */
    coming:
      'Export and import as a file rather than through the clipboard, which needs a save ' +
      'dialog the main process does not have yet. Sets that ship with FLUX — a Premiere ' +
      'set, a Resolve set — so muscle memory arrives with the app rather than being rebuilt ' +
      'by hand.',
  },

  // ── Workspace ──────────────────────────────────────────────────
  {
    id: 'workspace.general',
    level: 'workspace',
    name: 'General',
    blurb: 'Its name, its mark, and the projects in it',
    ready: false,
    coming:
      'The workspace name and logo, and the projects it holds — in an order you set, with ' +
      'the ones you are not working on out of the way. Archiving a project without deleting ' +
      'it, and seeing where each one actually lives on disk. A workspace is a folder of ' +
      'projects plus the people and settings around them, so this page is mostly that list ' +
      'and the handful of facts that are true of all of them.',
  },
  {
    id: 'workspace.members',
    level: 'workspace',
    name: 'Members and devices',
    blurb: 'Who is in it, and which machines are yours',
    ready: false,
    coming:
      'Two lists that are the same list. Other *people* — invited, their role, what they may ' +
      'open and what they may render — and your own other *machines*: the laptop, the phone, ' +
      'the workstation, each named and each able to be signed out remotely. Both are things ' +
      'that may hold a copy of this workspace and sync changes into it, which is why they ' +
      'belong on one page: the question "what can reach my work" has one answer.',
  },
  {
    id: 'workspace.automation',
    level: 'workspace',
    name: 'Automation and MCP',
    blurb: 'Triggers, actions, and the port a model drives',
    ready: false,
    coming:
      'Scripts built from a trigger and a list of actions — when a folder gains footage, ' +
      'import it; when a render finishes, move the file and post a webhook; when a sequence ' +
      'is marked approved, queue it. And the MCP server itself as something you can see: ' +
      'running or not, which tools are exposed, which model is connected, and a log of what ' +
      'it has actually done to your project.',
    livesAt: {
      what: 'The control surface and the MCP server, already working',
      where:
        'A loopback port with a per-launch token, and mcp/server.mjs — started by hand, ' +
        'see the README section on driving FLUX from outside',
    },
  },
  {
    id: 'workspace.api',
    level: 'workspace',
    name: 'API and Webhooks',
    blurb: 'Keys out, and events out',
    ready: false,
    coming:
      'API keys you can issue, scope and revoke, so something outside FLUX can ask about a ' +
      'render or start one. And webhooks the other way: a URL per event — render queued, ' +
      'render done, render failed, project saved, member joined — with the payload shape ' +
      'written down, a delivery log, and a retry you can press. Distinct from Automation ' +
      'above on purpose: automation is FLUX acting on itself, this is FLUX talking to things ' +
      'that are not FLUX.',
  },
  {
    id: 'workspace.ai',
    level: 'workspace',
    name: 'AI',
    blurb: 'Your own keys, and which model does what',
    ready: false,
    coming:
      'Bring your own key, per provider, for every kind of model this app will reach for: ' +
      'language models for the editing decisions, vision models for what is in a shot, audio ' +
      'models for transcription and sound, and upscalers. Direct providers and the ' +
      'aggregators that front them, each with its key, its model list and its cost per call ' +
      'where a provider publishes one. Then a mapping from *job* to model, because "which ' +
      'model reads my footage" and "which model writes my cut list" want different answers ' +
      'and different budgets.',
  },
  {
    id: 'workspace.libraries',
    level: 'workspace',
    name: 'Libraries',
    blurb: 'Presets that follow the workspace, not the machine',
    ready: false,
    coming:
      'Saved render settings, effect presets, title styles, LUTs, sound beds — stored with ' +
      'the workspace so every device signed into it has them, rather than in one computer ' +
      "where they are lost with it. Which is the whole reason this is a workspace page and " +
      'not a device one: a preset you made on the workstation is useless on the laptop.',
  },
  {
    id: 'workspace.cloud',
    level: 'workspace',
    name: 'Cloud',
    blurb: 'What syncs, when, and what it costs',
    ready: false,
    coming:
      'The switch that turns a local workspace into a synced one, and then the details that ' +
      'decide whether it is usable: what syncs (the documents always, the media only if you ' +
      'say so), what happens to a file too big to send, what happens when two people edited ' +
      'the same sequence apart, and how much space is used. Local-first is the rule, so this ' +
      'page can be left alone forever and nothing stops working.',
  },

  // ── This device ────────────────────────────────────────────────
  {
    id: 'device.controllers',
    level: 'device',
    name: 'Controllers + Hardware',
    blurb: 'What is plugged in, and what this machine is made of',
    ready: false,
    coming:
      'Input first: a game controller mapped to the transport — a thumbstick that shuttles ' +
      'and a trigger that trims is a better jog wheel than most jog wheels — plus touch ' +
      'adaptation for a tablet, and eventually a headset. Then the machine itself: CPU, GPU, ' +
      'how much memory, and every disk with its kind and its free space, so the decisions ' +
      'that depend on hardware can be made from what is there rather than from a guess. The ' +
      'disks matter more than they sound: this archive has an NVMe holding the footage and a ' +
      '5400rpm laptop drive with 15GB free, and a cache that cannot tell them apart will ' +
      'eventually pick the second one.',
    livesAt: {
      what: 'What the machine would choose for playback, read from the machine',
      where: 'The performance dialog — every row shows the machine’s own answer',
      command: 'app.performance',
    },
  },
  {
    id: 'device.audio',
    level: 'device',
    name: 'Audio',
    blurb: 'Which interface plays, and which records',
    ready: false,
    coming:
      'Output device and its sample rate and buffer, so the mixer can be told to use the ' +
      'interface rather than the motherboard. Input for live recording: which microphone, ' +
      'which channels, a level meter and a monitoring switch. And what to do when the device ' +
      'disappears mid-session, which on USB audio is a matter of when rather than if.',
    livesAt: {
      what: 'The sequence’s own rate and channel count, which is a document fact',
      where: 'Sequence settings, per sequence, saved in the .fluxseq',
    },
  },
  {
    id: 'device.plugins',
    level: 'device',
    name: 'Plugins',
    blurb: 'What else is loaded, and from where',
    ready: false,
    coming:
      'Installed panels and extensions — the panel registry is already the public seam, so a ' +
      'third-party panel registers exactly as the built-in ones do — plus VST and VST3 scan ' +
      'paths for audio, a list of what was found, and which ones failed to load and why. ' +
      'Scripts too: a folder of them, each runnable from the palette. Enable, disable and ' +
      'remove, without a reinstall.',
  },
  {
    id: 'device.saves',
    level: 'device',
    name: 'Saves',
    blurb: 'Autosave, backups, and where they go',
    ready: false,
    coming:
      'How often autosave runs and how many versions it keeps, where the backups are ' +
      'written, and a list of them with the ability to open one without overwriting what you ' +
      'have. Whether a save happens before a render starts, which is the one moment it is ' +
      'always wanted. A device page rather than an account one because the folder it writes ' +
      'to is a fact about this disk.',
    livesAt: {
      what: 'Saving the project',
      where: 'Ctrl S writes the .flux document, and each sequence its own .fluxseq',
      command: 'project.save',
    },
  },
  {
    id: 'device.display',
    level: 'device',
    name: 'Display',
    blurb: 'How the picture gets to this screen',
    ready: false,
    coming:
      'Pixel format and bit depth for the preview path, colour management for this monitor ' +
      'and its profile, and HDR when the screen has it. Which monitor a full-screen preview ' +
      'uses, and whether a second one gets a clean feed. The preview resolution controls are ' +
      'the part of this that exists; what is missing is everything about colour, which is ' +
      'the part that decides whether what you see is what you graded.',
    livesAt: {
      what: 'Preview resolution, separately for playing and for a paused frame',
      where: 'The Viewer’s own toolbar',
      command: 'panel.focus.viewer',
    },
  },
  {
    id: 'device.mapping',
    level: 'device',
    name: 'Mapping',
    blurb: 'The colours and icons that mean things',
    ready: false,
    coming:
      'Clip label colours and what each one means to you, marker colours, the icons for each ' +
      'kind of media, and the colours the readiness strip and the work ring use. Small, and ' +
      'the reason it earns a page is that these are the app’s vocabulary: if green means ' +
      '"approved" in your edit room, the app should be able to say green.',
  },
  {
    id: 'device.cache',
    level: 'device',
    name: 'Cache',
    blurb: 'What is kept, where, and how much memory',
    ready: false,
    coming:
      'Where the index and thumbnail caches live and how large they may grow, with a button ' +
      'that says how much is there and clears it. Prerendered and baked segments: what to ' +
      'keep, when to build it, and whether a shared folder on the network serves a whole ' +
      'room from one bake. And the memory budgets, which are the ones that actually decide ' +
      'whether playback holds up — how many decoders may be open, how much decoded picture ' +
      'may be held, how far ahead to warm.',
    livesAt: {
      what: 'Decoder pool, frame memory and warm radius, each pinnable or left to follow the machine',
      where: 'The performance dialog',
      command: 'app.performance',
    },
  },
  {
    id: 'device.threed',
    level: 'device',
    name: '3D',
    blurb: 'Importing and rendering scenes',
    ready: false,
    coming:
      'Which 3D formats to import and how — scale and axis conventions, since every ' +
      'application disagrees about which way up is — what to do with cameras and lights that ' +
      'come with a scene, and which renderer draws it. Nothing in FLUX reads a mesh yet, so ' +
      'this page is the furthest out of all of them and is here to hold the place.',
  },
]

/** The pages of one level, in order. */
export function pagesInLevel(level: SettingsLevel): SettingsPage[] {
  return settingsPages.filter((page) => page.level === level)
}

export function getSettingsPage(id: string): SettingsPage | undefined {
  return settingsPages.find((page) => page.id === id)
}

/** Where the panel opens: the first page of the first level. */
export const FIRST_SETTINGS_PAGE = settingsPages[0].id
