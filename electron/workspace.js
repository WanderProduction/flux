import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { folderIn } from '../shared/projectNaming.js'

/**
 * A workspace: the thing that holds projects, and the people who will share
 * them.
 *
 * ## It is a folder, like everything else here
 *
 * The same decision projects were given, for the same reasons. A workspace is
 * a directory with a `workspace.json` in it, so it can be copied to another
 * drive, backed up by anything that backs up files, and opened by a FLUX that
 * has never heard of it. Nothing about a workspace lives only in a database
 * this app happens to keep, because then losing the app would lose the work.
 *
 * It sits in the app's data directory **by default** rather than by rule. That
 * default is the right one for somebody who has not thought about it — one
 * place, no decision to make on the first run. The custom directory is for
 * everybody who has: a workspace on the fast scratch disk, or on the NAS the
 * rest of the room can reach.
 *
 * ## The project list is stored, not scanned
 *
 * A workspace's projects are mostly *not* inside its folder — they are
 * wherever the user put them, which is frequently a different drive from the
 * one the workspace lives on. So the list is kept, with each entry's path,
 * and checked against the disk when it is read. Scanning would only ever find
 * the projects that happened to be filed underneath, and it would quietly drop
 * the rest.
 *
 * A missing project is reported as missing rather than removed. The usual
 * reason a path stops resolving is an unplugged drive, and an app that tidies
 * away your projects while the drive is out is an app you stop trusting.
 *
 * ## No electron import
 *
 * The directory is passed in, so all of this runs against a temp directory
 * from a plain Node script with no app. See scripts/verify-workspace.mjs.
 */

const FILE = 'workspace.json'
const RECORD_VERSION = 1

const manifestPath = (root) => path.join(root, FILE)

/** Where a workspace with this title would land inside `parent`. */
export function workspacePathIn(parent, title) {
  return folderIn(parent, title)
}

/** Is there a workspace here? */
export async function isWorkspace(root) {
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
    return raw?.version === RECORD_VERSION && typeof raw.id === 'string'
  } catch {
    return false
  }
}

function clean(raw, root) {
  return {
    root,
    id: raw.id,
    title: raw.title,
    description: raw.description ?? '',
    avatar: raw.avatar ?? null,
    banner: raw.banner ?? null,
    createdAt: raw.createdAt ?? 0,
    projects: Array.isArray(raw.projects)
      ? raw.projects.filter((one) => one && typeof one.root === 'string')
      : [],
  }
}

/**
 * One queue per workspace, so two writes to the same manifest run in order.
 *
 * Every writer here is a read-modify-write of one JSON file, and a project
 * files itself whenever one opens — so two of them overlap the moment anything
 * opens projects back to back, which `verify:timeline` does. Two things went
 * wrong and the second is the one that loses work: both renames raced for the
 * same temp name and the loser threw ENOENT, and underneath that both had read
 * the same manifest, so whichever wrote second saved a list the first project
 * had never been in.
 *
 * Same shape, and the same reason, as the per-key chain in kernel/store.ts.
 */
const queues = new Map()

/** Runs `job` after whatever is already queued for `root`. */
function inOrder(root, job) {
  const key = path.resolve(root).toLowerCase()
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job)
  // Dropped once nothing is waiting, so the map does not keep an entry for
  // every workspace ever touched.
  const forget = () => {
    if (queues.get(key) === next) queues.delete(key)
  }
  queues.set(key, next.then(forget, forget))
  return next
}

/** A temp name no concurrent write can be using: this process, and a counter. */
let writeCounter = 0

async function write(root, record) {
  const target = manifestPath(root)
  writeCounter += 1
  const temp = `${target}.tmp-${process.pid}-${writeCounter}`
  try {
    await fs.writeFile(temp, JSON.stringify(record, null, 2), 'utf8')
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Makes a workspace folder and its manifest.
 *
 * @returns {Promise<{ ok: true, workspace: object } | { ok: false, reason: string }>}
 */
export async function createWorkspace(parent, { title, description, avatar, banner } = {}) {
  const name = String(title ?? '').trim()
  if (!name) return { ok: false, reason: 'no-title' }

  const root = workspacePathIn(path.resolve(parent), name)
  if (await isWorkspace(root)) return { ok: false, reason: 'already-a-workspace' }

  const record = {
    version: RECORD_VERSION,
    id: crypto.randomBytes(12).toString('hex'),
    title: name,
    description: String(description ?? '').trim(),
    avatar: avatar ?? null,
    banner: banner ?? null,
    createdAt: Date.now(),
    projects: [],
  }

  try {
    await fs.mkdir(root, { recursive: true })
    await write(root, record)
  } catch (err) {
    return { ok: false, reason: err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'write-failed' }
  }

  return { ok: true, workspace: clean(record, root) }
}

/**
 * Reads a workspace, with each project checked against the disk.
 *
 * The existence check is what makes the dashboard honest: a card for a project
 * on a drive that is not plugged in should say so rather than opening into an
 * error.
 */
export async function readWorkspace(root) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
  } catch {
    return null
  }
  if (raw?.version !== RECORD_VERSION || !raw.id) return null

  const workspace = clean(raw, root)
  workspace.projects = await Promise.all(
    workspace.projects.map(async (one) => ({
      ...one,
      missing: !(await fs.stat(one.root).then((s) => s.isDirectory(), () => false)),
    })),
  )
  return workspace
}

/** Title, description, picture. Never the id, and never the project list. */
export function updateWorkspace(root, patch = {}) {
  return inOrder(root, async () => {
    let raw
    try {
      raw = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
    } catch {
      return { ok: false, reason: 'not-a-workspace' }
    }

    if (patch.title !== undefined) {
      const next = String(patch.title).trim()
      if (!next) return { ok: false, reason: 'no-title' }
      raw.title = next
    }
    if (patch.description !== undefined) raw.description = String(patch.description).trim()
    if (patch.avatar !== undefined) raw.avatar = patch.avatar || null
    if (patch.banner !== undefined) raw.banner = patch.banner || null

    await write(root, raw)
    return { ok: true, workspace: await readWorkspace(root) }
  })
}

/**
 * Files a project under this workspace.
 *
 * Keyed on the project's path, so opening the same project twice does not put
 * two cards on the dashboard. Re-adding one that is already there refreshes
 * its name and moves it to the front, which is what "I just worked on this"
 * should do to a list sorted by recency.
 */
export function rememberProject(root, { root: projectRoot, name, file } = {}) {
  if (!projectRoot) return Promise.resolve({ ok: false, reason: 'no-project' })
  // The whole read-modify-write is queued, not just the write: two opens in
  // quick succession would otherwise both read before either wrote, and the
  // second would save a list the first project had never been in.
  return inOrder(root, async () => {
    let raw
    try {
      raw = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
    } catch {
      return { ok: false, reason: 'not-a-workspace' }
    }

    const resolved = path.resolve(projectRoot)
    const same = (one) => path.resolve(one.root).toLowerCase() === resolved.toLowerCase()

    const existing = (raw.projects ?? []).find(same)
    const entry = {
      root: resolved,
      name: name ?? existing?.name ?? path.basename(resolved),
      file: file ?? existing?.file,
      addedAt: existing?.addedAt ?? Date.now(),
      openedAt: Date.now(),
    }
    raw.projects = [entry, ...(raw.projects ?? []).filter((one) => !same(one))]

    await write(root, raw)
    return { ok: true, workspace: await readWorkspace(root) }
  })
}

/**
 * Takes a project off the dashboard.
 *
 * The folder is untouched, and the wording in the UI has to say so. "Remove"
 * next to a project card reads as "delete my work" to anybody who has not
 * thought about it, and being wrong about that once is unforgivable.
 */
export function forgetProject(root, projectRoot) {
  return inOrder(root, async () => {
    let raw
    try {
      raw = JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
    } catch {
      return { ok: false, reason: 'not-a-workspace' }
    }
    const resolved = path.resolve(projectRoot).toLowerCase()
    raw.projects = (raw.projects ?? []).filter(
      (one) => path.resolve(one.root).toLowerCase() !== resolved,
    )
    await write(root, raw)
    return { ok: true, workspace: await readWorkspace(root) }
  })
}
