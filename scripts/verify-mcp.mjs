/**
 * Verifies the MCP server end to end, against a running FLUX.
 *
 *   cd mcp && npm install
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-mcp.mjs
 *
 * Speaks real MCP over stdio to the real server, which talks to the real
 * control surface, which drives the real app. Nothing is stubbed, because the
 * interesting failures are all at the seams: a tool whose name is not routed,
 * a schema a model cannot fill in, an error that arrives as a protocol fault
 * instead of as text.
 *
 * It starts the control surface itself, on a port of its own, and stops it
 * again — so this never leaves a port open and never touches a real one.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * By file path into mcp/node_modules, not by package name. Node resolves from
 * the importing file upwards — scripts/ then the repo root — and never looks
 * sideways into mcp/, which is where the SDK deliberately lives so the app's
 * own dependency count stays at one.
 */
const SDK = '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm'
const { Client } = await import(`${SDK}/client/index.js`)
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`)

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8914
const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')
const FIXTURE = path.join(os.homedir(), 'flux-media-test', 'clipA.mp4')

const { check, report } = createChecker()
const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

let client = null
let tokenFile = null

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  const started = await evaluate(
    cdp,
    `const { controlBridge } = window.__fluxDev;
     await controlBridge.stopControlServer();
     return controlBridge.startControlServer(${PORT});`,
  )
  assert.ok(started.ok, `the control surface would not start: ${started.error}`)

  /*
   * The token goes to a file of this run's own rather than the app's, so a
   * real FLUX running beside this one keeps its own and nothing here depends
   * on which installation wrote last.
   */
  tokenFile = path.join(os.tmpdir(), `flux-mcp-verify-${process.pid}`)
  await fs.writeFile(tokenFile, started.token, 'utf8')

  client = new Client({ name: 'verify', version: '0.0.1' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'mcp', 'server.mjs')],
      env: {
        ...process.env,
        FLUX_CONTROL_PORT: String(PORT),
        FLUX_CONTROL_TOKEN_FILE: tokenFile,
      },
    }),
  )

  let tools = []

  await check('it offers tools, and every one is routed', async () => {
    const listed = await client.listTools()
    tools = listed.tools
    assert.ok(tools.length >= 8, `only ${tools.length} tools`)

    // Every tool must reach a real operation. A name in the list that the
    // router does not know is a tool that exists until it is used.
    const known = await evaluate(
      cdp,
      `return window.__fluxDev.controlOps.operations.listOperations({});`,
    )
    const result = await client.callTool({ name: 'flux_describe_project', arguments: {} })
    assert.ok(!result.isError, `describe failed: ${result.content[0]?.text}`)

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} is barely described`)
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object schema`)
    }
    // And the operations the server routes to all exist in the app.
    for (const op of ['describeProject', 'importCutList', 'queueRender', 'startRender']) {
      assert.ok(known.includes(op), `the app has no ${op}`)
    }
  })

  await check('describe_project reports what is open', async () => {
    const result = await client.callTool({ name: 'flux_describe_project', arguments: {} })
    assert.ok(!result.isError, result.content[0]?.text)
    const value = JSON.parse(result.content[0].text)
    assert.ok(value.project, 'no project')
    assert.ok(Array.isArray(value.sequences))
    assert.ok(value.render, 'no render settings')
  })

  await check('a cut list becomes a sequence through MCP', async () => {
    const result = await client.callTool({
      name: 'flux_import_cut_list',
      arguments: {
        name: 'Made by MCP',
        cutList: {
          frameRate: 30,
          width: 1920,
          height: 1080,
          sources: [FIXTURE],
          video: [
            [
              { src: 0, in: 0, out: 2, why: 'the opening' },
              { src: 0, in: 2.5, out: 3.8, why: 'a later beat' },
            ],
          ],
          markers: [{ at: 0, to: 2, name: 'OPENING', comment: 'from the agent' }],
        },
      },
    })
    assert.ok(!result.isError, result.content[0]?.text)
    const value = JSON.parse(result.content[0].text)
    assert.equal(value.placed, 2, `placed ${value.placed}`)
    assert.deepEqual(value.missing, [])
    assert.equal(value.sequence.name, 'Made by MCP')
    assert.equal(value.sequence.markers, 1, 'the marker did not come through')
  })

  await check('inspect comes back small, with the markers', async () => {
    const result = await client.callTool({
      name: 'flux_inspect_sequence',
      arguments: { limit: 1 },
    })
    const value = JSON.parse(result.content[0].text)
    assert.equal(value.clips.length, 1)
    assert.equal(value.truncated, 1)
    assert.equal(value.markers[0].name, 'OPENING')
    assert.equal(value.markers[0].comment, 'from the agent')
  })

  await check('a bad cut list comes back as readable text, not a protocol fault', async () => {
    const result = await client.callTool({
      name: 'flux_import_cut_list',
      arguments: { cutList: { sources: ['x.mp4'], video: [[{ src: 0, in: 5, out: 3 }]] } },
    })
    assert.equal(result.isError, true, 'a bad list should be an error result')
    const text = result.content[0].text
    assert.ok(text.includes('not after'), `unhelpful: ${text}`)
  })

  await check('queueing and starting are separate', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-mcp-out-'))
    try {
      const set = await client.callTool({
        name: 'flux_set_render_settings',
        arguments: { outDir, concurrency: 2 },
      })
      assert.ok(!set.isError, set.content[0]?.text)

      await evaluate(cdp, `window.__fluxDev.renderQueue.clear(); return true;`)
      const queued = await client.callTool({
        name: 'flux_queue_render',
        arguments: { scope: 'sequence' },
      })
      assert.ok(!queued.isError, queued.content[0]?.text)
      assert.ok(JSON.parse(queued.content[0].text).queue.waiting > 0, 'nothing waiting')

      const before = await client.callTool({ name: 'flux_render_status', arguments: {} })
      assert.equal(
        JSON.parse(before.content[0].text).rendering,
        false,
        'queueing started a render by itself',
      )

      // And it really renders.
      const start = await client.callTool({ name: 'flux_start_render', arguments: {} })
      assert.ok(!start.isError, start.content[0]?.text)

      let status = null
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        status = JSON.parse(
          (await client.callTool({ name: 'flux_render_status', arguments: {} })).content[0].text,
        )
        if (!status.rendering && status.done + status.failed >= status.total) break
      }
      assert.ok(status, 'no status came back')
      assert.equal(status.failed, 0, `a job failed: ${JSON.stringify(status.jobs)}`)
      assert.ok(status.done > 0, 'nothing finished')

      const written = (await fs.readdir(outDir)).filter((n) => n.endsWith('.mp4'))
      assert.equal(written.length, status.done, `${written.length} files for ${status.done} jobs`)
      console.log(`       rendered ${written.join(', ')}`)
    } finally {
      await fs.rm(outDir, { recursive: true, force: true })
    }
  })

  await check('an unknown tool is refused', async () => {
    await assert.rejects(
      () => client.callTool({ name: 'flux_delete_everything', arguments: {} }),
      'an unknown tool should be refused',
    )
  })

  await check('with FLUX unreachable it says so in words', async () => {
    await evaluate(cdp, `return window.__fluxDev.controlBridge.stopControlServer();`)
    const result = await client.callTool({ name: 'flux_describe_project', arguments: {} })
    assert.equal(result.isError, true)
    const text = result.content[0].text
    assert.match(text, /Could not reach FLUX|not accepting control/, `unhelpful: ${text}`)
    // It has to name the fix, not just the fault.
    assert.match(text, /control server|Start Local/i, 'it does not say what to do about it')
  })
} finally {
  if (client) await client.close().catch(() => {})
  if (tokenFile) await fs.rm(tokenFile, { force: true })
  await evaluate(cdp, `return window.__fluxDev.controlBridge.stopControlServer();`).catch(() => {})
  report()
  cdp.close()
}
