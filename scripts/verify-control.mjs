/**
 * Verifies the local control surface against a running FLUX.
 *
 *   npm run dev:renderer
 *   npm run dev:debug
 *   node scripts/verify-control.mjs
 *
 * This is the surface an MCP server — and through it, a model — drives the app
 * with. It can write into a project and spend hours of GPU time, so the checks
 * are in two halves and the first half is the one that matters:
 *
 *   - **it is shut.** No token, a wrong token, a token of the wrong length,
 *     the wrong method, an unknown route, an oversized body: all refused.
 *   - and then that the operations actually do what they say.
 *
 * The surface is started through the renderer, the way the command does, so
 * what is exercised is the real path rather than a server stood up beside it.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { attach, createChecker, ensureProject, evaluate, resetProject } from './cdp.mjs'

const VERIFY_PROJECT = path.join(os.homedir(), 'flux-verify-project')
/** Not the default, so a running instance of the real thing is never touched. */
const PORT = 8913

const { check, report } = createChecker()
const cdp = await attach(Number(process.env.FLUX_CDP_PORT) || 9222)

/** Calls the surface the way a client would. */
async function call(op, params, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-flux-token': token }),
    },
    body: JSON.stringify({ op, params }),
  })
  return { status: res.status, body: await res.json() }
}

let token = null

try {
  await ensureProject(cdp, VERIFY_PROJECT)
  await resetProject(cdp)

  const started = await evaluate(
    cdp,
    `const { controlBridge } = window.__fluxDev;
     await controlBridge.stopControlServer();
     return controlBridge.startControlServer(${PORT});`,
  )
  assert.ok(started.ok, `the surface would not start: ${started.error}`)
  token = started.token
  assert.ok(token && token.length >= 32, 'the token is too short to be worth having')

  // ── it is shut ─────────────────────────────────────────────────
  await check('no token is refused', async () => {
    const { status, body } = await call('describeProject', {}, null)
    assert.equal(status, 401)
    assert.equal(body.ok, false)
  })

  await check('a wrong token of the right length is refused', async () => {
    // Same length, so this cannot pass by failing the length check alone.
    const wrong = 'f'.repeat(token.length)
    assert.notEqual(wrong, token)
    const { status } = await call('describeProject', {}, wrong)
    assert.equal(status, 401)
  })

  await check('a token of the wrong length is refused without throwing', async () => {
    /*
     * timingSafeEqual throws on a length mismatch, so a surface that fed it
     * the offered token directly would 500 — and a 500 on a bad credential is
     * a crash, not a refusal.
     */
    const { status } = await call('describeProject', {}, 'short')
    assert.equal(status, 401)
  })

  await check('an unknown operation is refused, and says what exists', async () => {
    const { status, body } = await call('deleteEverything', {}, token)
    assert.equal(status, 404)
    assert.ok(Array.isArray(body.operations), 'a caller should be told what it can call')
    assert.ok(body.operations.includes('describeProject'))
  })

  await check('GET and unknown routes are refused', async () => {
    const get = await fetch(`http://127.0.0.1:${PORT}/call`, {
      headers: { 'x-flux-token': token },
    })
    assert.equal(get.status, 405)

    const elsewhere = await fetch(`http://127.0.0.1:${PORT}/anything`, {
      method: 'POST',
      headers: { 'x-flux-token': token },
    })
    assert.equal(elsewhere.status, 404)
  })

  await check('an oversized body is refused rather than buffered', async () => {
    const huge = 'x'.repeat(5 << 20)
    const res = await fetch(`http://127.0.0.1:${PORT}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flux-token': token },
      body: JSON.stringify({ op: 'describeProject', params: { huge } }),
    })
    assert.equal(res.status, 413)
  })

  await check('it listens on loopback only', async () => {
    /*
     * The address it bound, read from the OS rather than trusted from the
     * configuration. A surface that can start a render has no business being
     * reachable from the network, and "we passed 127.0.0.1" is not the same
     * claim as "it is bound to 127.0.0.1".
     */
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((one) => one && one.family === 'IPv4' && !one.internal)
      .map((one) => one.address)

    for (const address of addresses) {
      await assert.rejects(
        () =>
          fetch(`http://${address}:${PORT}/operations`, {
            headers: { 'x-flux-token': token },
            signal: AbortSignal.timeout(2000),
          }),
        `it answered on ${address}, which is not loopback`,
      )
    }
    if (addresses.length === 0) console.log('       (no external interface to test against)')
  })

  // ── and then it works ──────────────────────────────────────────
  await check('describeProject says what is open', async () => {
    const { status, body } = await call('describeProject', {}, token)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.ok(body.value.project, 'no project reported')
    assert.ok(Array.isArray(body.value.sequences))
    assert.ok(body.value.queue, 'no queue summary')
  })

  await check('a cut list becomes a sequence, atomically', async () => {
    const fixture = path.join(os.homedir(), 'flux-media-test', 'clipA.mp4')
    const before = await evaluate(cdp, `return window.__fluxDev.sequence.historyDepth().past;`)

    const { body } = await call(
      'importCutList',
      {
        name: 'From a cut list',
        cutList: {
          name: 'From a cut list',
          frameRate: 30,
          width: 1920,
          height: 1080,
          sources: [fixture],
          video: [[{ src: 0, in: 0, out: 2, why: 'the first two seconds' }, { src: 0, in: 3, out: 4 }]],
        },
      },
      token,
    )
    assert.equal(body.ok, true, `refused: ${body.error}`)
    assert.equal(body.value.placed, 2, `placed ${body.value.placed}`)
    assert.deepEqual(body.value.missing, [], 'the fixture should have resolved')

    const after = await evaluate(cdp, `return window.__fluxDev.sequence.historyDepth().past;`)
    assert.equal(after - before, 1, `an import must be one undo step, not ${after - before}`)
  })

  await check('inspectSequence comes back small, and carries the markers', async () => {
    const { body } = await call('inspectSequence', { limit: 1 }, token)
    assert.equal(body.ok, true, body.error)
    assert.equal(body.value.clips.length, 1, 'the limit was ignored')
    assert.equal(body.value.truncated, 1, 'it did not say it had truncated')
    assert.ok(Array.isArray(body.value.markers))
    assert.equal(body.value.name, 'From a cut list')
  })

  await check('a cut past the end of its source is trimmed, and says so', async () => {
    /*
     * A model guessing an out point will ask for more than exists. Placing it
     * anyway produces a clip that claims more frames than it can render, and
     * the thing that catches it is the render verifier — hours later, as a
     * failed job. Trimming at import turns that into a warning at the point
     * the mistake was made.
     */
    const fixture = path.join(os.homedir(), 'flux-media-test', 'clipA.mp4')
    const { body } = await call(
      'importCutList',
      {
        name: 'Past the end',
        cutList: {
          frameRate: 30,
          width: 1920,
          height: 1080,
          sources: [fixture],
          video: [[{ src: 0, in: 0, out: 600 }]],
        },
      },
      token,
    )
    assert.equal(body.ok, true, body.error)
    assert.equal(body.value.placed, 1, 'it should still place the part that exists')
    const trimmed = body.value.warnings.find((one) => one.includes('trimmed to'))
    assert.ok(trimmed, `no warning about the trim: ${JSON.stringify(body.value.warnings)}`)

    const inspected = await call('inspectSequence', {}, token)
    const clip = inspected.body.value.clips[0]
    assert.ok(
      clip.duration > 0 && clip.duration <= 4.01,
      `a 4s source produced a ${clip.duration}s clip`,
    )
  })

  await check('a bad cut list reports every problem at once', async () => {
    const { status, body } = await call(
      'importCutList',
      { cutList: { sources: ['x.mp4'], video: [[{ src: 0, in: 5, out: 3 }, { src: 9, out: 1 }]] } },
      token,
    )
    assert.equal(status, 500)
    assert.equal(body.ok, false)
    assert.ok(body.error.includes('not after'), `unhelpful: ${body.error}`)
    assert.ok(body.error.includes('not in sources'), 'only reported the first problem')
  })

  await check('queueing is separate from starting', async () => {
    const queued = await call('queueRender', { scope: 'sequence' }, token)
    assert.equal(queued.body.ok, true, queued.body.error)
    assert.ok(queued.body.value.queue.waiting > 0, 'nothing is waiting')

    const status = await call('renderStatus', {}, token)
    assert.equal(status.body.value.rendering, false, 'queueing started a render on its own')
  })

  await check('starting without an output folder refuses, with a reason', async () => {
    await evaluate(
      cdp,
      `window.__fluxDev.renderSettings.updateRenderSettings({ outDir: null }); return true;`,
    )
    const { status, body } = await call('startRender', {}, token)
    assert.equal(status, 500)
    assert.match(body.error, /output folder/, `unhelpful: ${body.error}`)
  })

  await check('/operations lists what this build understands', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/operations`, {
      headers: { 'x-flux-token': token },
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    for (const op of ['describeProject', 'importCutList', 'queueRender', 'startRender']) {
      assert.ok(body.operations.includes(op), `${op} is missing from the listing`)
    }
  })

  await check('stopping it closes the port', async () => {
    await evaluate(cdp, `return window.__fluxDev.controlBridge.stopControlServer();`)
    await assert.rejects(
      () =>
        fetch(`http://127.0.0.1:${PORT}/operations`, {
          headers: { 'x-flux-token': token },
          signal: AbortSignal.timeout(2000),
        }),
      'the port is still answering after it was stopped',
    )
  })
} finally {
  // Never leave it listening, whatever happened above.
  await evaluate(cdp, `return window.__fluxDev.controlBridge.stopControlServer();`).catch(() => {})
  report()
  cdp.close()
}
