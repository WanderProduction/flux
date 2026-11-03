# FLUX — Accounts and workspaces

### Three layers in front of the editor, and why each one exists

> The account and the workspace are **built**. Being invited to somebody else's workspace is
> not, and the screen that will offer it says so rather than showing a disabled field. This
> file is what each layer is for, what is actually stored, and what the next piece needs.

Once past them, **Settings → Account** and **Settings → Workspace** edit the same two records:
the names, the pictures, the password, the key fingerprint, where the workspace folder is, and
every project filed under it.

FLUX opens on one of four screens, and which one is decided by the first question that has no
answer yet:

| | Shown when | What it asks for |
|---|---|---|
| **Make an account** | There is no account on this machine | A nickname, a name for the machine, a picture, a password |
| **Make a workspace** | There is an account but no workspace | A name, a description, a picture, a banner, optionally a folder |
| **Dashboard** | There is a workspace but no project open | Nothing — it shows the projects in it as cards |
| **Editor** | A project is open | — |

The order is fixed rather than routed, because it is not a navigation choice: you cannot pick a
workspace before there is an account to own it, and a project card cannot be drawn before there
is a workspace to list it in.

**The loading gate matters more than it looks.** "There is no account" and "the account file has
not been read yet" are both falsy, and confusing them means every launch flashes a Create
Account form at somebody who has had an account for months. There is a fourth, blank state for
the moment before the answer arrives, and `verify:accounts` asserts the screen against the
state behind it.

---

## The account

One per installation, local, and never sent anywhere. It holds a nickname, a name for the
machine, an optional picture, and an **Ed25519 keypair**.

### Why there is an account at all when nothing is online

Because of what comes next. A workspace is going to be shareable — between your own two machines
first, and between people after that — and sharing needs each end to be able to say who it is
without a company in the middle vouching for them. That is a keypair. The account is where it
lives.

It is deliberately not a sign-up: no email, no verification, no terms, and the first screen says
so in those words. An app that opens with a password field and does not explain itself has every
user assuming the worst, and here the worst is wrong.

### The password encrypts something, or it is theatre

A local password that only gates a screen protects nothing. The projects are plain folders on
the same disk and anybody sitting at the machine can open them with Explorer — so a lock screen
would be the app claiming a security it does not have.

So the password does real work. **scrypt** (N=2¹⁷, ~190ms, 128MB) derives a 32-byte key, and that
key encrypts the account's private key with **AES-256-GCM**. The GCM authentication tag is the
password check: there is no separate comparison to get wrong and nothing to compare against,
and a wrong password cannot be skipped by editing the JSON because it produces a key that fails
authentication.

The parameters are stored with the record rather than hardcoded at the read site, so an account
written today still opens after the cost is raised for accounts written tomorrow.

**The consequence is stated on the screen where the password is chosen**, not in a settings page
nobody opens, and stated precisely — because the thing most people will assume it means is the
thing it does not mean:

> Forgetting the password loses the **identity**. It loses no work. Every project and every
> workspace is an ordinary folder that opens without any of this.

### Two names

A nickname for the person and a name for the machine, shown together as `laptop · nikoflow`.
The second is not decoration: the first time somebody runs FLUX on a tower as well as a laptop,
the nickname is identical on both and the device name is the only thing distinguishing two rows
in a workspace. Asking for it now costs one field; asking for it later means two accounts that
look the same. The machine's hostname is offered as the default, because it is already what the
person calls this computer.

### What is published, and what is not

The renderer is handed the id, the names, the picture, the **public** key and a fingerprint —
four groups of four hex characters, short enough to read down a phone line when two devices
claim to be the same account. The encrypted private key never crosses the bridge; it is
decrypted in the main process and stays there, which is what makes encrypting it worth doing.

`signChallenge` and `verifyChallenge` exist and nothing calls them yet. They are there because
they are the only thing that makes the keypair more than a number in a file — and because the
harness signs and verifies, which is how we know the encrypt-decrypt round trip gives back a key
that still *works* rather than 32 bytes that merely decrypt.

---

## The workspace

A folder with a `workspace.json` in it. The same decision projects were given, for the same
reasons: it can be copied to another drive, backed up by anything that backs up files, and
opened by a FLUX that has never heard of it. Nothing about a workspace lives only in a database
this app happens to keep, because then losing the app would lose the work.

It goes in FLUX's own data folder **by default rather than by rule**. That default is right for
somebody who has not thought about it — one place, no decision on the first run. The custom
folder is for everybody who has: the fast scratch disk, or the NAS the rest of the room can
reach. The choice is offered when the workspace is made because a workspace is not a thing you
want to move after twenty projects are filed under it.

### The project list is stored, not scanned

A workspace's projects are mostly **not** inside its folder — they are wherever the user put
them, frequently on a different drive. So the list is kept, with each path, and checked against
the disk when it is read. Scanning would only ever find the projects filed underneath and would
quietly drop the rest.

A missing project is **reported as missing, not removed**. The usual reason a path stops
resolving is an unplugged drive, and an app that tidies your projects away while the drive is
out is an app you stop trusting. The card says "folder not found" and cannot be clicked.

A *workspace* that has gone is dropped from the known list instead, and the difference is
deliberate: a workspace lives in the app's own folder by default, so a missing one is almost
always one somebody deleted, and a dead row in a picker nobody can act on is worse than
forgetting it.

### Projects file themselves

Opening a project files it under the open workspace, so the dashboard fills itself rather than
asking anybody to curate it — a workspace you have to add things to by hand is one that is
always out of date.

That is driven off the **project subscription**, not a React effect, and that distinction was a
bug before it was a design note. An effect keyed on the open project only sees states React
renders, so a project created and closed inside one batch goes from null to null and is never
filed at all. The subscription fires on the change itself, synchronously.

The dependency points one way: workspaces know about projects, projects know nothing about
workspaces. A project has to open on a machine with no workspace at all — in a browser, or
before the first one is made.

### Pictures live in the manifest

Avatars and banners are data URLs inside `workspace.json` and `account.json`. A second file
would mean a second path to serve, a second thing to copy when a workspace moves, and a second
way for a workspace to arrive somewhere with a broken image in it. A manifest that carries its
own pictures is one file that is always complete.

That only works because they are small: every chosen image is decoded, cropped to fill and
re-encoded as JPEG at the size it is actually drawn — 192px for an avatar, 1600×400 for a
banner. A phone photograph goes in at eight megabytes and lands at a few tens of kilobytes.
Nothing is ever upscaled.

---

## The rename that had to happen first

FLUX already called its panel arrangements **workspaces** — Premiere's word for them. The thing
that holds projects wanted the same word, and two meanings of one word in one app is a bug
waiting for somebody to read the wrong comment. Worse, it was already live in the command ids:
`workspace.switch.edit` meant a panel arrangement while `workspace.general` and
`workspace.members` in the settings pages already meant the project container.

So panel arrangements are **layouts** now:

| Was | Is |
|---|---|
| `kernel/workspaces.ts` | `kernel/layouts.ts` — the three built-in arrangements |
| `kernel/layouts.ts` | `kernel/layoutPresets.ts` — the ones you save and name |
| `workspace.switch.*`, `workspace.save`, `workspace.reset` | `layout.switch.*`, `layout.save`, `layout.reset` |
| command category `Workspace` | `Layout` |
| store key `workspaces` | `layouts` |
| `ViewState.workspace` in the .flux document | `ViewState.layout` |
| `LayoutPreset.workspace` | `LayoutPreset.layoutId` |

**Three of those needed migrations, and missing any one would have been silent.**

A **stored keymap is the whole truth** — deliberately, so a binding somebody cleared stays
cleared — which means anybody who had ever opened the Hotkeys page would find `1`, `2` and
`3` bound to commands that no longer exist, with nothing on screen to say why. There is a
rename table in `kernel/keybindings.ts` now, applied to the stored map and to every preset,
and the entries stay rather than being deleted once "everybody has migrated" — there is no way
to know that, and a line in a table is cheaper than a key that stops working on one person's
machine.

A **.flux document** written before the rename says `workspace`. The reader accepts either and
the writer only ever emits `layout`, so a project from last week opens in the arrangement it
was left in rather than silently back in Edit.

The **layouts store** was literally `workspaces.json` in userData, which is also the obvious
name for the new workspace registry — so the registry is `workspace-folders` instead, and the
layout restore reads the old key when the new one is empty.

---

## What comes next

**Being invited to a workspace**, which is the other way in and the reason the keypair exists.
Somebody shares a workspace, the account proves it is you, and the workspace appears beside your
own. It needs a transport — the two devices have to be able to reach each other — and a format
for the invitation, and both of those are decisions this file does not make yet.

**Archiving a project** rather than removing it from the list. Today removing takes it off the
dashboard and leaves the folder alone, which is the honest minimum. Ordering is the same gap:
most-recently-opened is the right default and the wrong answer for somebody with forty projects
and six they care about.

**Moving a workspace** to another folder. It is chosen once, when the workspace is made, because
moving means moving a directory and rewriting every path that points into it — and a
half-finished version of that loses track of projects.

```bash
npm run verify:accounts
```

Twenty-two checks in three parts. The identity and the workspace store run against a real temp
directory from plain Node with no app — and the identity checks are built around *signing*
rather than around the stored bytes, because a password check that only compared a hash would
pass a test written against the hash and still have lost the key.

The screen checks run against the app and adapt: on a profile with no account they drive the
real first run, type a mismatched confirmation to see the button stay disabled, and assert that
the folder created is the one the screen promised. On a profile that already has an account they
check the invariants that do not need a fresh machine. The suite says which it did.

The settings pages are driven the same way: a rename typed in and saved, a password changed and
changed back, a project removed from the list with the folder checked afterwards.
