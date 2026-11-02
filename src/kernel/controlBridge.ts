/**
 * The renderer's end of the control surface.
 *
 * Registering the handler is a side effect of importing this, once, from
 * main.tsx — not something a panel does. The surface has to answer whether or
 * not anything is on screen, and a handler that arrived with a panel would
 * stop answering the moment someone closed it.
 */

import { operations } from './controlOps'

interface ControlBridge {
  start: (port?: number) => Promise<
    { ok: true; port: number; token: string; tokenFile?: string; already?: boolean }
    | { ok: false; error: string }
  >
  stop: () => Promise<boolean>
  status: () => Promise<{ running: boolean; port?: number }>
  onCall: (
    handler: (op: string, params: Record<string, unknown>) => Promise<unknown>,
  ) => () => void
}

const bridge: ControlBridge | undefined = (
  globalThis as { flux?: { control?: ControlBridge } }
).flux?.control

export const hasControl = Boolean(bridge)

/** Starts answering. Safe to call twice; the second call replaces the first. */
export function listenForControl(): void {
  if (!bridge) return
  bridge.onCall(async (op, params) => {
    const operation = operations[op]
    if (!operation) {
      throw new Error(
        `no operation "${op}". This build has: ${Object.keys(operations).sort().join(', ')}`,
      )
    }
    return operation(params)
  })
}

export const startControlServer = (port?: number) =>
  bridge ? bridge.start(port) : Promise.resolve({ ok: false as const, error: 'desktop only' })
export const stopControlServer = () => (bridge ? bridge.stop() : Promise.resolve(false))
export const controlStatus = () =>
  bridge ? bridge.status() : Promise.resolve({ running: false })
