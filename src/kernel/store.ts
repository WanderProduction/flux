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

export async function saveStore<T>(name: string, value: T): Promise<void> {
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
