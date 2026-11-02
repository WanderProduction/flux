#!/usr/bin/env node
/**
 * An MCP server that drives a running FLUX.
 *
 *   npm install            (in this folder, once)
 *   node mcp/server.mjs
 *
 * In FLUX: **Start Local Control Server** from the palette. This finds the
 * token itself, in the app's data directory.
 *
 * ## Why this is its own package
 *
 * FLUX ships with one runtime dependency. The MCP SDK is a reasonable
 * dependency for a server and an unreasonable one for an Electron bundle that
 * will never import it, so it lives here with its own `package.json` and the
 * app's dependency count does not move.
 *
 * ## Why the tools are coarse
 *
 * There is no `cutClip`, no `moveClip`, no `setInPoint`, and that is the
 * single most important thing about this file.
 *
 * A verb per gesture is the obvious API and the wrong one. A two-hundred-cut
 * reel becomes two hundred round trips, each one a request, a reply and a
 * model turn, with the model holding the whole timeline in its head between
 * them to stay consistent. The same edit as one `import_cut_list` is one call,
 * one undo step, and one thing to be right about.
 *
 * The rule throughout: **the model writes a document; the app does the work.**
 *
 * ## What it deliberately cannot do
 *
 * Nothing here deletes a file, moves one, or writes outside the render output
 * folder. Removing a clip removes it from a timeline, which is undoable and
 * leaves the footage untouched — that is the only kind of "delete" in FLUX,
 * and it is worth saying out loud in the place an agent reads.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const PORT = Number(process.env.FLUX_CONTROL_PORT) || 8912

/**
 * Where FLUX writes the token.
 *
 * Read from disk on every call rather than cached, because FLUX mints a new
 * one each launch — and a server that cached it would start failing with a
 * 401 the moment the app was restarted, which reads as "the tool is broken"
 * rather than "it reconnected".
 */
function tokenFile() {
  if (process.env.FLUX_CONTROL_TOKEN_FILE) return process.env.FLUX_CONTROL_TOKEN_FILE
  const name = 'flux'
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), name, 'control-token')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name, 'control-token')
  }
  return path.join(os.homedir(), '.config', name, 'control-token')
}

async function callFlux(op, params = {}) {
  let token
  try {
    token = (await fs.readFile(tokenFile(), 'utf8')).trim()
  } catch {
    throw new Error(
      'FLUX is not accepting control calls. Open FLUX and run "Start Local Control Server" ' +
        'from the command palette (Ctrl K).',
    )
  }

  let res
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flux-token': token },
      body: JSON.stringify({ op, params }),
      signal: AbortSignal.timeout(130_000),
    })
  } catch (err) {
    throw new Error(
      `Could not reach FLUX on 127.0.0.1:${PORT}. Is it running, with the control server ` +
        `started? (${err.message})`,
    )
  }

  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body.value
}

/** Tool results are text; JSON is the most compact thing a model reads well. */
const asText = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const TOOLS = [
  {
    name: 'flux_describe_project',
    description:
      'What FLUX has open: the project, its sequences with clip and marker counts, the ' +
      'render settings, and the render queue. Call this first — everything else needs to ' +
      'know what is already there.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flux_inspect_sequence',
    description:
      'The clips and markers on a sequence. Markers come back whole and are the cheapest ' +
      'useful thing to read: they name what each part of the edit IS, which the camera ' +
      'filenames do not. Clips are capped and the reply says how many were left out.',
    inputSchema: {
      type: 'object',
      properties: {
        sequence: { type: 'string', description: 'Its name. Omit for the open one.' },
        limit: { type: 'number', description: 'Clips to return. Default 200.' },
      },
    },
  },
  {
    name: 'flux_scan_folder',
    description:
      'Every media file under a folder, with proxy and cache folders walked past. Use this ' +
      'to find footage before writing a cut list.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Absolute path.' },
        limit: { type: 'number' },
      },
      required: ['folder'],
    },
  },
  {
    name: 'flux_import_cut_list',
    description:
      'THE MAIN TOOL. Lays a whole edit down as a new sequence in one call — one undo step, ' +
      'however many cuts. Write the entire edit here rather than making cuts one at a time.\n\n' +
      '`src` is an INDEX into `sources`, not a path, because a reel cut from one interview ' +
      'repeats the same long path on every cut. `in`/`out` are seconds in the SOURCE. Cuts ' +
      'lay end to end automatically — only pass `at` when a cut must land at a specific ' +
      'point on the timeline. `why` is kept as a note on the clip.\n\n' +
      'Nothing is deleted: a cut list that leaves footage out simply does not place it, and ' +
      'the files are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What to call the sequence.' },
        cutList: {
          type: 'object',
          description: 'The edit.',
          properties: {
            frameRate: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            sources: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute paths. Referenced by index from the cuts.',
            },
            video: {
              type: 'array',
              description: 'Tracks, bottom first. Each is a list of cuts.',
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'number', description: 'Index into sources.' },
                    in: { type: 'number', description: 'Seconds into the source.' },
                    out: { type: 'number', description: 'Seconds into the source.' },
                    at: { type: 'number', description: 'Optional timeline position.' },
                    speed: { type: 'number' },
                    why: { type: 'string', description: 'Why this was kept.' },
                  },
                  required: ['src', 'out'],
                },
              },
            },
            audio: { type: 'array', description: 'Same shape as video.' },
            markers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  at: { type: 'number' },
                  to: { type: 'number' },
                  name: { type: 'string' },
                  comment: { type: 'string' },
                },
              },
            },
          },
          required: ['sources', 'video'],
        },
        remaps: {
          type: 'array',
          description:
            'Path prefixes to swap, when the sources were written on another machine.',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
          },
        },
      },
      required: ['cutList'],
    },
  },
  {
    name: 'flux_import_sequence_xml',
    description:
      'Import a Premiere or Resolve sequence (FCP7 XML). Pass the file CONTENTS. Nested ' +
      'sequences are refused by name rather than dropped, and markers come across even when ' +
      'none of the media resolves — which is the usual case for an export from another ' +
      'machine, and still worth doing for the structure.',
    inputSchema: {
      type: 'object',
      properties: {
        xml: { type: 'string', description: 'The file contents, not a path.' },
        name: { type: 'string' },
        remaps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
          },
        },
      },
      required: ['xml'],
    },
  },
  {
    name: 'flux_set_render_settings',
    description:
      'The output folder, and the quality/size trade. The codec itself is not negotiable — ' +
      'it was chosen by measurement. `frameRate` of "source" keeps every clip at the rate it ' +
      'was shot, which is what an archive wants; "sequence" conforms everything and will ' +
      'lose frames from 50fps slow motion.',
    inputSchema: {
      type: 'object',
      properties: {
        outDir: { type: 'string', description: 'Absolute path to render into.' },
        cq: { type: 'number', description: 'Quality. Lower is bigger and better. 26 default.' },
        gop: { type: 'number' },
        concurrency: { type: 'number', description: '1-8. Two suits spinning disks.' },
        frameRate: { type: 'string', enum: ['source', 'sequence'] },
      },
    },
  },
  {
    name: 'flux_queue_render',
    description:
      'Add clips to the render queue. Each clip becomes one file. Nothing starts — queueing ' +
      'and starting are separate so a queue can be built up across several sequences first.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['sequence', 'selection'],
          description: 'The whole open sequence, or what is selected in the app.',
        },
      },
    },
  },
  {
    name: 'flux_start_render',
    description:
      'Start the queue. Returns immediately — a batch runs for minutes or hours. Poll ' +
      'flux_render_status rather than waiting on this.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flux_render_status',
    description: 'How the render is going, per job, with compression ratios as they finish.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flux_stop_render',
    description: 'Stop after the clips currently encoding. Finished files are kept.',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** Tool name to the control operation behind it. */
const ROUTES = {
  flux_describe_project: 'describeProject',
  flux_inspect_sequence: 'inspectSequence',
  flux_scan_folder: 'scanFolder',
  flux_import_cut_list: 'importCutList',
  flux_import_sequence_xml: 'importSequenceXml',
  flux_set_render_settings: 'setRenderSettings',
  flux_queue_render: 'queueRender',
  flux_start_render: 'startRender',
  flux_render_status: 'renderStatus',
  flux_stop_render: 'stopRender',
}

const server = new Server(
  { name: 'flux', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const op = ROUTES[request.params.name]
  if (!op) throw new Error(`no tool "${request.params.name}"`)
  try {
    return asText(await callFlux(op, request.params.arguments ?? {}))
  } catch (err) {
    /*
     * Returned as a result rather than thrown, with isError set. A thrown
     * error reaches the model as a protocol failure it cannot read; this
     * reaches it as text it can act on — which for "FLUX is not running" is
     * the difference between it telling the user and it giving up.
     */
    return {
      isError: true,
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    }
  }
})

await server.connect(new StdioServerTransport())
