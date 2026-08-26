/**
 * Persistence for user-owned state (workspaces, keymaps).
 *
 * Runs two ways on purpose: through the Electron preload bridge in the desktop
 * app, and through localStorage when the renderer is opened in a plain browser.
 * The browser path is not a toy — it keeps `npm run dev:renderer` usable on its
 * own and keeps the UI testable without booting Electron.
 */

interface FluxBridge {
  store: {
    get: (name: string) => Promise<unknown>
    set: (name: string, value: unknown) => Promise<boolean>
  }
  platform: string
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const isDesktop = Boolean(bridge)

export async function loadStore<T>(name: string, fallback: T): Promise<T> {
  try {
    if (bridge) {
      const value = await bridge.store.get(name)
      return (value as T) ?? fallback
    }
    const raw = localStorage.getItem(`flux:${name}`)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch (err) {
    console.warn(`[flux] could not read store "${name}" — using defaults`, err)
    return fallback
  }
}

/**
 * Writes still in flight.
 *
 * Callers fire-and-forget `saveStore` so the UI never blocks on a disk write,
 * which means a reload or a quit can outrun the write and lose whatever was
 * just changed. `flushStores` is the way to close that window at the moments
 * where it matters.
 */
const inFlight = new Set<Promise<void>>()

/**
 * The last queued write for each key, so writes to the same key run in order.
 *
 * Each write is a separate IPC round trip and IPC gives no ordering guarantee,
 * so two rapid saves of the same key can land out of order and leave the older
 * value on disk. That is silent data loss: the app shows the new state, the
 * file holds the old one, and the difference only appears after a restart.
 */
const chains = new Map<string, Promise<void>>()

async function write<T>(name: string, value: T): Promise<void> {
  try {
    if (bridge) {
      await bridge.store.set(name, value)
      return
    }
    localStorage.setItem(`flux:${name}`, JSON.stringify(value))
  } catch (err) {
    console.warn(`[flux] could not write store "${name}"`, err)
  }
}

export function saveStore<T>(name: string, value: T): Promise<void> {
  const previous = chains.get(name) ?? Promise.resolve()
  const queued = previous.then(() => write(name, value))

  chains.set(name, queued)
  inFlight.add(queued)
  void queued.finally(() => {
    inFlight.delete(queued)
    // Only clear the chain if nothing newer has been queued behind this write.
    if (chains.get(name) === queued) chains.delete(name)
  })
  return queued
}

/** Resolves once every pending write has landed. */
export async function flushStores(): Promise<void> {
  // A write can enqueue another (a listener reacting to the first), so drain
  // until the set is genuinely empty rather than snapshotting it once.
  while (inFlight.size > 0) {
    await Promise.all([...inFlight])
  }
}
