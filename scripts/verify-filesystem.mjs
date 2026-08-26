/**
 * Exercises electron/filesystem.js against a real temp directory.
 *
 * This module is the Content Browser's whole view of the disk, and it is the
 * part that cannot be checked from the renderer — hence a standalone script
 * rather than a click-through. It imports the real module; nothing is mocked.
 *
 *   node scripts/verify-filesystem.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  existsMany,
  isHiddenEntry,
  isServableMediaPath,
  listDirectory,
  listDrives,
  listSubfolders,
} from '../electron/filesystem.js'

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-verify-'))

try {
  // A directory that looks like a real messy media folder.
  await fs.mkdir(path.join(root, 'Footage'))
  await fs.mkdir(path.join(root, 'Archive'))
  await fs.mkdir(path.join(root, '.hidden-folder'))

  const write = (name, bytes = 64) => fs.writeFile(path.join(root, name), Buffer.alloc(bytes))
  await write('clip10.mp4', 2048)
  await write('clip2.mp4', 1024)
  await write('shot.MOV', 512) // uppercase extension
  await write('photo.png', 256)
  await write('render.webm', 128)
  await write('notes.txt') // not media
  await write('project.prproj') // not media
  await write('sequence.mkv') // container Chromium cannot demux
  await write('.hidden.mp4') // dotfile

  const listing = await listDirectory(root)

  await check('lists only real subfolders, hiding dotfolders', () => {
    assert.deepEqual(
      listing.folders.map((f) => f.name),
      ['Archive', 'Footage'],
    )
  })

  await check('keeps media files and drops everything else', () => {
    assert.deepEqual(
      listing.files.map((f) => f.name),
      ['clip2.mp4', 'clip10.mp4', 'photo.png', 'render.webm', 'shot.MOV'],
    )
  })

  await check('sorts numerically, so clip2 precedes clip10', () => {
    const names = listing.files.map((f) => f.name)
    assert.ok(names.indexOf('clip2.mp4') < names.indexOf('clip10.mp4'))
  })

  await check('classifies kinds, uppercase extensions included', () => {
    const byName = Object.fromEntries(listing.files.map((f) => [f.name, f.kind]))
    assert.equal(byName['clip2.mp4'], 'video')
    assert.equal(byName['shot.MOV'], 'video')
    assert.equal(byName['photo.png'], 'image')
    assert.equal(byName['render.webm'], 'video')
  })

  await check('reports real sizes', () => {
    const clip10 = listing.files.find((f) => f.name === 'clip10.mp4')
    assert.equal(clip10.size, 2048)
    assert.ok(clip10.mtimeMs > 0, 'mtime should be populated')
  })

  await check('returns absolute paths', () => {
    assert.ok(listing.files.every((f) => path.isAbsolute(f.path)))
    assert.ok(listing.folders.every((f) => path.isAbsolute(f.path)))
  })

  await check('exposes a usable parent', () => {
    assert.equal(listing.parent, path.dirname(root))
  })

  await check('a drive root reports no parent, so "Up" cannot loop', async () => {
    const drives = await listDrives()
    const driveListing = await listDirectory(drives[0].path)
    assert.equal(driveListing.parent, null)
  })

  await check('not truncated for an ordinary folder', () => {
    assert.equal(listing.truncated, false)
  })

  await check('unreadable directory rejects rather than returning junk', async () => {
    await assert.rejects(() => listDirectory(path.join(root, 'does-not-exist')))
  })

  await check('a file path is rejected, not listed as a folder', async () => {
    await assert.rejects(() => listDirectory(path.join(root, 'photo.png')))
  })

  await check('listDrives finds at least one mounted root', async () => {
    const drives = await listDrives()
    assert.ok(drives.length > 0, 'expected at least one drive')
    assert.ok(drives.every((d) => d.name && d.path))
  })

  await check('existsMany distinguishes present from absent', async () => {
    const result = await existsMany([
      path.join(root, 'photo.png'),
      path.join(root, 'ghost.png'),
    ])
    assert.equal(result[path.join(root, 'photo.png')], true)
    assert.equal(result[path.join(root, 'ghost.png')], false)
  })

  await check('protocol allowlist admits media and refuses everything else', () => {
    assert.equal(isServableMediaPath('C:\\a\\b.mp4'), true)
    assert.equal(isServableMediaPath('C:\\a\\b.PNG'), true)
    assert.equal(isServableMediaPath('C:\\a\\b.txt'), false)
    assert.equal(isServableMediaPath('C:\\Windows\\System32\\config\\SAM'), false)
    assert.equal(isServableMediaPath('C:\\a\\.ssh\\id_rsa'), false)
    assert.equal(isServableMediaPath('C:\\a\\b.mkv'), false)
  })

  await check('a very large folder is truncated instead of sent whole', async () => {
    const big = path.join(root, 'big')
    await fs.mkdir(big)
    await Promise.all(
      Array.from({ length: 4200 }, (_, i) =>
        fs.writeFile(path.join(big, `f${i}.png`), Buffer.alloc(1)),
      ),
    )
    const bigListing = await listDirectory(big)
    assert.equal(bigListing.truncated, true, 'expected truncation past the cap')
    assert.ok(bigListing.files.length <= 4000)
  })

  await check('listSubfolders returns directories only', async () => {
    const { folders } = await listSubfolders(root)
    const names = folders.map((f) => f.name)
    // Not an exact match: an earlier check adds `big/` to this same fixture.
    assert.ok(names.includes('Archive') && names.includes('Footage'))
    assert.ok(!names.includes('.hidden-folder'), 'dotfolder leaked')
    assert.ok(
      !names.some((n) => n.endsWith('.mp4') || n.endsWith('.png') || n.endsWith('.txt')),
      `files leaked into the tree: ${names.join(', ')}`,
    )
    assert.ok(folders.every((f) => path.isAbsolute(f.path)))
  })

  await check('listSubfolders hides dotfolders and Windows system folders', () => {
    assert.equal(isHiddenEntry('.git'), true)
    assert.equal(isHiddenEntry('Footage'), false)
    if (process.platform === 'win32') {
      // These sit in every drive root and only ever produce EACCES.
      assert.equal(isHiddenEntry('$Recycle.Bin'), true)
      assert.equal(isHiddenEntry('System Volume Information'), true)
    }
  })

  await check('listSubfolders does not stat media, so it stays cheap', async () => {
    // A folder of files with no subfolders should come back empty and fast,
    // rather than paying for a stat per media file the tree never shows.
    const started = Date.now()
    const { folders } = await listSubfolders(path.join(root, 'big'))
    assert.deepEqual(folders, [])
    assert.ok(Date.now() - started < 4000, 'subfolder listing took too long')
  })

  await check('listSubfolders rejects an unreadable path', async () => {
    await assert.rejects(() => listSubfolders(path.join(root, 'nope')))
  })

  await check('every drive root can be expanded', async () => {
    const drives = await listDrives()
    for (const drive of drives) {
      const { folders } = await listSubfolders(drive.path)
      assert.ok(Array.isArray(folders), `${drive.name} did not enumerate`)
      assert.ok(
        folders.every((f) => !f.name.startsWith('$')),
        `${drive.name} leaked a system folder`,
      )
    }
  })
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
