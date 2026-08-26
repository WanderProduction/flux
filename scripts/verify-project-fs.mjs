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
  PROJECT_DIRS,
  PROJECT_FORMAT,
  copyIntoImports,
  createProject,
  isProject,
  manifestPath,
  openProject,
  projectStorePath,
  readProjectStore,
  writeProjectStore,
} from '../electron/project.js'

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
  const projectA = path.join(tmp, 'Project A')
  await fs.mkdir(projectA)

  await check('creating a project makes the three folders', async () => {
    const result = await createProject(projectA, 'Project A', '0.0.1')
    assert.equal(result.ok, true, `create failed: ${result.error}`)

    for (const dir of PROJECT_DIRS) {
      const stat = await fs.stat(path.join(projectA, dir))
      assert.ok(stat.isDirectory(), `${dir} is not a directory`)
    }
  })

  await check('imports and exports start empty', async () => {
    assert.deepEqual(await fs.readdir(path.join(projectA, 'imports')), [])
    assert.deepEqual(await fs.readdir(path.join(projectA, 'exports')), [])
  })

  await check('the manifest records the name, app version and format', async () => {
    const manifest = JSON.parse(await fs.readFile(manifestPath(projectA), 'utf8'))
    assert.equal(manifest.name, 'Project A')
    assert.equal(manifest.flux.version, '0.0.1')
    assert.equal(manifest.flux.format, PROJECT_FORMAT)
    assert.ok(manifest.createdAt > 0)
  })

  await check('the manifest lives in project_files, not the project root', async () => {
    const rootEntries = await fs.readdir(projectA)
    assert.deepEqual(rootEntries.sort(), ['exports', 'imports', 'project_files'])
  })

  await check('an empty name falls back rather than producing a blank project', async () => {
    const blank = path.join(tmp, 'blank')
    await fs.mkdir(blank)
    const result = await createProject(blank, '   ', '0.0.1')
    assert.equal(result.ok, true)
    assert.equal(result.project.name, 'Untitled')
  })

  await check('creating over an existing project is refused', async () => {
    const result = await createProject(projectA, 'Again', '0.0.1')
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

  await check('a project from a newer format is refused, not misread', async () => {
    const future = path.join(tmp, 'future')
    await fs.mkdir(future)
    await createProject(future, 'Future', '0.0.1')
    const manifest = JSON.parse(await fs.readFile(manifestPath(future), 'utf8'))
    manifest.flux.format = PROJECT_FORMAT + 1
    await fs.writeFile(manifestPath(future), JSON.stringify(manifest), 'utf8')

    const result = await openProject(future)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'newer-format')
  })

  await check('a corrupt manifest is reported rather than throwing', async () => {
    const broken = path.join(tmp, 'broken')
    await fs.mkdir(broken)
    await createProject(broken, 'Broken', '0.0.1')
    await fs.writeFile(manifestPath(broken), 'not json at all', 'utf8')

    const result = await openProject(broken)
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

  // ── project-scoped stores ─────────────────────────────────────

  await check('project stores read and write inside project_files', async () => {
    await writeProjectStore(projectA, 'assets', [{ id: 'a1' }])
    const read = await readProjectStore(projectA, 'assets')
    assert.deepEqual(read, [{ id: 'a1' }])
    await fs.access(projectStorePath(projectA, 'assets'))
  })

  await check('two projects keep separate state', async () => {
    const projectB = path.join(tmp, 'Project B')
    await fs.mkdir(projectB)
    await createProject(projectB, 'Project B', '0.0.1')

    await writeProjectStore(projectB, 'assets', [{ id: 'b1' }])
    assert.deepEqual(await readProjectStore(projectA, 'assets'), [{ id: 'a1' }])
    assert.deepEqual(await readProjectStore(projectB, 'assets'), [{ id: 'b1' }])
  })

  await check('a missing project store reads as null, not an exception', async () => {
    assert.equal(await readProjectStore(projectA, 'never-written'), null)
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
