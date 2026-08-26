/**
 * Persistence for state that belongs to this *installation* rather than to any
 * project: workspace layouts, the keymap, pinned folders, the recents list, UI
 * preferences.
 *
 * Anything belonging to the work itself — assets, the sequence, per-project
 * settings — lives in the `.flux` document instead, written by kernel/project.ts.
 * Keeping the two apart is what makes a project folder self-contained: copy it
 * to another machine and nothing it needs was left behind in userData.
 *
 * Runs two ways on purpose: through the Electron preload bridge in the desktop
 * app, and through localStorage in a plain browser. The browser path is not a
 * toy — it keeps `npm run dev:renderer` usable and the UI testable without
 * booting Electron.
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
    if (bridge) return ((await bridge.store.get(name)) as T) ?? fallback
    const raw = localStorage.getItem(`flux:${name}`)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch (err) {
    console.warn(`[flux] could not read store "${name}" — using defaults`, err)
    return fallback
  }
}

const inFlight = new Set<Promise<void>>()

/**
 * The last queued write for each key, so writes to the same key run in order.
 *
 * Each write is a separate IPC round trip and IPC gives no ordering guarantee,
 * so two rapid saves of the same key can land out of order and leave the older
 * value on disk. That is silent data loss: the app shows the new state, the file
 * holds the old one, and the difference only appears after a restart.
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
