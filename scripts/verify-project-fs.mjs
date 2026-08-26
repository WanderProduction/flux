/**
 * Exercises electron/project.js against real temp directories.
 *
 * Project creation is the one operation that writes into folders the user
 * chose, so its edge cases — an existing project, a missing folder, a name
 * collision in imports — are checked here against a real filesystem rather
 * than through the UI.
 *
 *   node scripts/verify-project-fs.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DOCUMENT_FORMAT,
  PROJECT_DIRS,
  autosavePath,
  copyIntoImports,
  createProject,
  findProjectFile,
  isProject,
  openProject,
  plannedProjectPath,
  saveProject,
  writeAutosave,
} from '../electron/project.js'
import { makeDocument } from '../shared/projectFormat.js'

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    process.exitCode = 1
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-project-'))

try {
  // `tmp` is the folder a user would pick; FLUX creates the project inside it.
  const projectA = path.join(tmp, 'Project A')

  await check('creating a project makes a folder named after it', async () => {
    const result = await createProject(tmp, 'Project A', '0.0.1')
    assert.equal(result.ok, true, `create failed: ${result.error}`)
    assert.equal(result.project.root, projectA, 'root should be <parent>/<name>')

    for (const dir of PROJECT_DIRS) {
      const stat = await fs.stat(path.join(projectA, dir))
      assert.ok(stat.isDirectory(), `${dir} is not a directory`)
    }
  })

  await check('the parent keeps the project folder, not its contents', async () => {
    const inParent = await fs.readdir(tmp)
    assert.ok(inParent.includes('Project A'))
    assert.ok(!inParent.includes('imports'), 'project contents leaked into the parent')
  })

  await check('two projects can sit side by side in one folder', async () => {
    const second = await createProject(tmp, 'Project B', '0.0.1')
    assert.equal(second.ok, true, `create failed: ${second.error}`)
    assert.equal(second.project.root, path.join(tmp, 'Project B'))
    assert.equal(await isProject(projectA), true, 'the first project should be untouched')
  })

  await check('an unsafe name still produces a usable folder', async () => {
    const messy = await createProject(tmp, 'A/B:C*D ', '0.0.1')
    assert.equal(messy.ok, true, `create failed: ${messy.error}`)
    assert.equal(path.basename(messy.project.root), 'ABCD')
    // The manifest keeps the name the user typed, not the sanitised folder name.
    assert.equal(messy.project.name, 'A/B:C*D')
    await fs.access(path.join(messy.project.root, 'imports'))
  })

  await check('plannedProjectPath agrees with where creation actually lands', async () => {
    const planned = plannedProjectPath(tmp, 'Preview Me')
    const made = await createProject(tmp, 'Preview Me', '0.0.1')
    assert.equal(made.ok, true)
    assert.equal(made.project.root, planned, 'the launcher would have shown the wrong path')
  })

  await check('imports and exports start empty', async () => {
    assert.deepEqual(await fs.readdir(path.join(projectA, 'imports')), [])
    assert.deepEqual(await fs.readdir(path.join(projectA, 'exports')), [])
  })

  await check('the document is named after the project and sits in its root', async () => {
    const rootEntries = await fs.readdir(projectA)
    assert.deepEqual(
      rootEntries.sort(),
      ['Project A.flux', 'exports', 'imports', 'project_files'],
      'the .flux document belongs beside the folders, where a user can see it',
    )
    assert.equal(await findProjectFile(projectA), path.join(projectA, 'Project A.flux'))
  })

  await check('the document records the name, app version and format', async () => {
    const doc = JSON.parse(await fs.readFile(path.join(projectA, 'Project A.flux'), 'utf8'))
    assert.equal(doc.name, 'Project A')
    assert.equal(doc.flux.version, '0.0.1')
    assert.equal(doc.flux.format, DOCUMENT_FORMAT)
    assert.ok(doc.createdAt > 0)
    assert.deepEqual(doc.assets, [])
  })

  await check('an empty name falls back rather than producing a blank project', async () => {
    const blank = path.join(tmp, 'blank-parent')
    await fs.mkdir(blank)
    const result = await createProject(blank, '   ', '0.0.1')
    assert.equal(result.ok, true)
    assert.equal(result.project.name, 'Untitled')
    assert.equal(path.basename(result.project.root), 'Untitled')
  })

  await check('creating the same project name twice in one folder is refused', async () => {
    const result = await createProject(tmp, 'Project A', '0.0.1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'already-a-project')
  })

  await check('creating in a folder that does not exist is refused', async () => {
    const result = await createProject(path.join(tmp, 'nope'), 'Ghost', '0.0.1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-such-directory')
  })

  await check('isProject distinguishes a project folder from a plain one', async () => {
    assert.equal(await isProject(projectA), true)
    assert.equal(await isProject(tmp), false)
  })

  await check('opening a project reads its manifest back', async () => {
    const result = await openProject(projectA)
    assert.equal(result.ok, true)
    assert.equal(result.project.name, 'Project A')
    assert.equal(result.project.root, path.resolve(projectA))
  })

  await check('opening a plain folder reports not-a-project', async () => {
    const result = await openProject(tmp)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'not-a-project')
  })

  await check('a document from a newer format is refused, not misread', async () => {
    const futureParent = path.join(tmp, 'future-parent')
    await fs.mkdir(futureParent)
    const future = (await createProject(futureParent, 'Future', '0.0.1')).project
    const doc = JSON.parse(await fs.readFile(future.file, 'utf8'))
    doc.flux.format = DOCUMENT_FORMAT + 1
    await fs.writeFile(future.file, JSON.stringify(doc), 'utf8')

    const result = await openProject(future.root)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'newer-format')
  })

  await check('a corrupt document is reported rather than throwing', async () => {
    const brokenParent = path.join(tmp, 'broken-parent')
    await fs.mkdir(brokenParent)
    const broken = (await createProject(brokenParent, 'Broken', '0.0.1')).project
    await fs.writeFile(broken.file, 'not json at all', 'utf8')

    const result = await openProject(broken.root)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'unreadable')
  })

  await check('opening restores a folder someone deleted', async () => {
    await fs.rm(path.join(projectA, 'exports'), { recursive: true, force: true })
    const result = await openProject(projectA)
    assert.equal(result.ok, true)
    const stat = await fs.stat(path.join(projectA, 'exports'))
    assert.ok(stat.isDirectory(), 'exports should have been recreated')
  })

  // ── saving and reopening ──────────────────────────

  await check('saving writes the assets and sequence into the document', async () => {
    const doc = makeDocument({
      name: 'Project A',
      appVersion: '0.0.1',
      assets: [{ id: 'a1', path: 'C:/x/clip.mp4', name: 'clip.mp4', kind: 'video' }],
      sequence: {
        name: 'Sequence 1',
        frameRate: 24,
        tracks: [{ id: 'V1', kind: 'video', name: 'V1' }],
        clips: [{ id: 'c1', assetId: 'a1', trackId: 'V1', start: 0, duration: 4 }],
      },
    })
    const result = await saveProject(path.join(projectA, 'Project A.flux'), doc)
    assert.equal(result.ok, true, `save failed: ${result.error}`)

    const reopened = await openProject(projectA)
    assert.equal(reopened.ok, true)
    assert.equal(reopened.project.assets.length, 1)
    assert.equal(reopened.project.assets[0].name, 'clip.mp4')
    assert.equal(reopened.project.sequence.clips.length, 1)
    assert.equal(reopened.dirty, false, 'a saved project opens clean')
  })

  await check('a project can be opened by its .flux file directly', async () => {
    const result = await openProject(path.join(projectA, 'Project A.flux'))
    assert.equal(result.ok, true)
    assert.equal(result.project.root, projectA, 'the folder is derived from the file')
    assert.equal(result.project.name, 'Project A')
  })

  await check('two projects keep separate documents', async () => {
    const b = path.join(tmp, 'Project B')
    const docB = makeDocument({ name: 'Project B', appVersion: '0.0.1', assets: [{ id: 'b1' }] })
    await saveProject(path.join(b, 'Project B.flux'), docB)

    const openA = await openProject(projectA)
    const openB = await openProject(b)
    assert.equal(openA.project.assets[0].id, 'a1')
    assert.equal(openB.project.assets[0].id, 'b1')
  })

  await check('an autosave newer than the document wins, and says so', async () => {
    // Losing whatever happened after the last save is exactly what an autosave
    // exists to prevent, so the newer file has to be the one that opens.
    const doc = makeDocument({
      name: 'Project A',
      appVersion: '0.0.1',
      assets: [{ id: 'later', name: 'unsaved.mp4', kind: 'video' }],
    })
    await new Promise((r) => setTimeout(r, 30))
    await writeAutosave(projectA, doc)

    const result = await openProject(projectA)
    assert.equal(result.ok, true)
    assert.equal(result.recovered, true, 'the newer autosave should have been taken')
    assert.equal(result.dirty, true, 'recovered work is unsaved work')
    assert.equal(result.project.assets[0].name, 'unsaved.mp4')
  })

  await check('saving clears the autosave, so the next open is clean', async () => {
    const doc = makeDocument({ name: 'Project A', appVersion: '0.0.1', assets: [] })
    await saveProject(path.join(projectA, 'Project A.flux'), doc)
    await assert.rejects(() => fs.access(autosavePath(projectA)), 'autosave should be gone')

    const result = await openProject(projectA)
    assert.equal(result.dirty, false)
    assert.equal(result.recovered, false)
  })

  await check('a completed save leaves no temp file behind', async () => {
    // Atomic write: a temp file plus a rename, so a crash mid-write cannot
    // truncate the real document.
    const file = path.join(projectA, 'Project A.flux')
    const leftovers = (await fs.readdir(projectA)).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
    const text = await fs.readFile(file, 'utf8')
    assert.doesNotThrow(() => JSON.parse(text), 'the document should always be valid JSON')
  })

  await check('a v1 folder project still opens, and comes back as unsaved', async () => {
    // Projects made before the format existed used project.json plus separate
    // assets/sequence files. They migrate on open rather than being refused.
    const legacy = path.join(tmp, 'legacy-parent', 'Legacy')
    await fs.mkdir(path.join(legacy, 'project_files'), { recursive: true })
    await fs.writeFile(
      path.join(legacy, 'project_files', 'project.json'),
      JSON.stringify({ flux: { version: '0.0.1', format: 1 }, name: 'Legacy', createdAt: 111 }),
      'utf8',
    )
    await fs.writeFile(
      path.join(legacy, 'project_files', 'assets.json'),
      JSON.stringify([{ id: 'old1', name: 'old.mp4', kind: 'video' }]),
      'utf8',
    )

    assert.equal(await isProject(legacy), true, 'a v1 folder is still a project')
    const result = await openProject(legacy)
    assert.equal(result.ok, true, `open failed: ${result.error}`)
    assert.equal(result.migrated, true)
    assert.equal(result.dirty, true, 'a migrated project holds work the document does not')
    assert.equal(result.project.name, 'Legacy')
    assert.equal(result.project.assets[0].name, 'old.mp4')
    assert.equal(result.project.createdAt, 111, 'the original creation date survives')
  })

  // ── copy into imports ─────────────────────────────────────────

  const source = path.join(tmp, 'source')
  await fs.mkdir(source)
  const clip = path.join(source, 'clip.mp4')
  await fs.writeFile(clip, Buffer.alloc(2048, 7))

  await check('copying a file puts it in imports and leaves the original', async () => {
    const result = await copyIntoImports(projectA, clip)
    assert.equal(result.ok, true, `copy failed: ${result.error}`)
    assert.equal(path.dirname(result.path), path.join(projectA, 'imports'))
    assert.equal(path.basename(result.path), 'clip.mp4')
    assert.equal(result.size, 2048)

    await fs.access(clip) // the original must still be there
    const copied = await fs.readFile(result.path)
    assert.equal(copied.length, 2048, 'the copy should be byte-identical in size')
  })

  await check('a name collision suffixes instead of overwriting', async () => {
    // The same filename from a different card is routine — every camera starts
    // over at C0001. Overwriting would destroy the first import.
    const other = path.join(tmp, 'source2')
    await fs.mkdir(other)
    const clash = path.join(other, 'clip.mp4')
    await fs.writeFile(clash, Buffer.alloc(999, 3))

    const result = await copyIntoImports(projectA, clash)
    assert.equal(result.ok, true)
    assert.equal(path.basename(result.path), 'clip (1).mp4')
    assert.equal(result.size, 999)

    // And the first one is untouched.
    const first = await fs.readFile(path.join(projectA, 'imports', 'clip.mp4'))
    assert.equal(first.length, 2048, 'the original import was overwritten')
  })

  await check('a third collision keeps counting', async () => {
    const third = path.join(tmp, 'source3')
    await fs.mkdir(third)
    const clash = path.join(third, 'clip.mp4')
    await fs.writeFile(clash, Buffer.alloc(11, 1))
    const result = await copyIntoImports(projectA, clash)
    assert.equal(path.basename(result.path), 'clip (2).mp4')
  })

  await check('copying a non-media file is refused', async () => {
    const notes = path.join(source, 'notes.txt')
    await fs.writeFile(notes, 'hello')
    const result = await copyIntoImports(projectA, notes)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'unsupported-type')
  })

  await check('copying a file that vanished is reported', async () => {
    const result = await copyIntoImports(projectA, path.join(source, 'ghost.mp4'))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'source-missing')
  })

  await check('an extensionless name still copies without mangling', async () => {
    // splitName has to cope with names that have no dot at all.
    const odd = path.join(source, 'RAWCLIP.mov')
    await fs.writeFile(odd, Buffer.alloc(4))
    const result = await copyIntoImports(projectA, odd)
    assert.equal(result.ok, true)
    assert.equal(path.basename(result.path), 'RAWCLIP.mov')
  })
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
