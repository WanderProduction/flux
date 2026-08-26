/**
 * Persistence, in two scopes.
 *
 *   app     — userData. Belongs to this installation, not to any project:
 *             workspace layouts, the keymap, the recents list, UI preferences.
 *   project — <project>/project_files. Belongs to the work itself: assets, the
 *             sequence. Opening a different project must show different
 *             contents, and copying a project folder to another machine has to
 *             bring them along.
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
  project?: {
    storeGet: (root: string, name: string) => Promise<unknown>
    storeSet: (root: string, name: string, value: unknown) => Promise<boolean>
  }
  platform: string
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const isDesktop = Boolean(bridge)

export type StoreScope = 'app' | 'project'

/**
 * Set by kernel/project.ts when a project opens or closes. Held here rather
 * than imported from there so this module stays dependency-free — project.ts
 * needs the app-scoped store for its own recents list, and the import would
 * otherwise be circular.
 */
let projectRoot: string | null = null

export function setProjectRoot(root: string | null) {
  projectRoot = root
}

export function getProjectRoot(): string | null {
  return projectRoot
}

/**
 * localStorage key. Project-scoped values are namespaced by root so the browser
 * fallback still keeps two projects apart.
 */
function localKey(name: string, scope: StoreScope): string {
  return scope === 'project' && projectRoot ? `flux:${projectRoot}:${name}` : `flux:${name}`
}

export async function loadStore<T>(
  name: string,
  fallback: T,
  scope: StoreScope = 'app',
): Promise<T> {
  try {
    if (scope === 'project') {
      // Reading project state with no project open is always a caller bug: it
      // would silently return defaults and look like an empty project rather
      // than a mistake.
      if (!projectRoot) throw new Error(`no project open; cannot read "${name}"`)
      if (bridge?.project) {
        return ((await bridge.project.storeGet(projectRoot, name)) as T) ?? fallback
      }
    } else if (bridge) {
      return ((await bridge.store.get(name)) as T) ?? fallback
    }

    const raw = localStorage.getItem(localKey(name, scope))
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
 * value on disk. That is silent data loss: the app shows the new state, the
 * file holds the old one, and the difference only appears after a restart.
 */
const chains = new Map<string, Promise<void>>()

async function write<T>(name: string, value: T, scope: StoreScope): Promise<void> {
  try {
    if (scope === 'project') {
      if (!projectRoot) throw new Error(`no project open; cannot write "${name}"`)
      if (bridge?.project) {
        await bridge.project.storeSet(projectRoot, name, value)
        return
      }
    } else if (bridge) {
      await bridge.store.set(name, value)
      return
    }

    localStorage.setItem(localKey(name, scope), JSON.stringify(value))
  } catch (err) {
    console.warn(`[flux] could not write store "${name}"`, err)
  }
}

export function saveStore<T>(name: string, value: T, scope: StoreScope = 'app'): Promise<void> {
  // Chain per key *and* scope, since an app and a project store can share a name.
  const chainKey = `${scope}:${name}`
  const previous = chains.get(chainKey) ?? Promise.resolve()
  const queued = previous.then(() => write(name, value, scope))

  chains.set(chainKey, queued)
  inFlight.add(queued)
  void queued.finally(() => {
    inFlight.delete(queued)
    // Only clear the chain if nothing newer has been queued behind this write.
    if (chains.get(chainKey) === queued) chains.delete(chainKey)
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
