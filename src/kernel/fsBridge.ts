/**
 * Typed access to the filesystem, via the Electron preload bridge.
 *
 * In a plain browser there is no bridge and `hasFilesystem` is false. The
 * Content Browser renders an explicit "desktop only" state in that case rather
 * than pretending to browse — the renderer stays loadable outside Electron so
 * the rest of the shell can still be worked on and tested there.
 */

export type MediaKind = 'image' | 'video'

export interface FolderEntry {
  name: string
  path: string
}

export interface FileEntry {
  name: string
  path: string
  kind: MediaKind
  size: number
  mtimeMs: number
}

export interface DirectoryListing {
  path: string
  parent: string | null
  folders: FolderEntry[]
  files: FileEntry[]
  truncated: boolean
}

export type ListResult =
  | { ok: true; listing: DirectoryListing }
  | { ok: false; error: 'denied' | 'unreadable' }

export type SubfolderResult =
  | { ok: true; folders: FolderEntry[]; truncated: boolean }
  | { ok: false; error: 'denied' | 'unreadable' }

/** A folder a scan walked past, and why. See shared/footageFilter.js. */
export interface SkippedFolder {
  path: string
  reason: 'proxies-or-cache' | 'system'
}

export interface FootageScan {
  root: string
  files: FileEntry[]
  /** Folders walked, including those that held nothing. */
  folders: number
  skipped: SkippedFolder[]
  unreadable: Array<{ path: string; error: string }>
  /** True when the scan hit its file cap and stopped. */
  truncated: boolean
}

export type ScanResult =
  | { ok: true; scan: FootageScan }
  | { ok: false; error: 'denied' | 'unreadable' }

export interface Places {
  places: FolderEntry[]
  drives: FolderEntry[]
}

interface FsBridge {
  places: () => Promise<Places>
  list: (dirPath: string) => Promise<ListResult>
  subfolders: (dirPath: string) => Promise<SubfolderResult>
  exists: (paths: string[]) => Promise<Record<string, boolean>>
  scan: (dirPath: string) => Promise<ScanResult>
  pickFiles: () => Promise<string[]>
  assetUrl: (filePath: string) => string
}

interface FluxBridge {
  fs?: FsBridge
  platform: string
}

const bridge: FluxBridge | undefined = (globalThis as { flux?: FluxBridge }).flux

export const hasFilesystem = Boolean(bridge?.fs)

function requireFs(): FsBridge {
  if (!bridge?.fs) throw new Error('filesystem bridge unavailable outside Electron')
  return bridge.fs
}

export const listPlaces = (): Promise<Places> => requireFs().places()
export const listDirectory = (dirPath: string): Promise<ListResult> => requireFs().list(dirPath)
export const listSubfolders = (dirPath: string): Promise<SubfolderResult> =>
  requireFs().subfolders(dirPath)
export const existsMany = (paths: string[]): Promise<Record<string, boolean>> =>
  requireFs().exists(paths)
/** Every media file under a folder, proxy and cache folders walked past. */
export const scanFootage = (dirPath: string): Promise<ScanResult> => requireFs().scan(dirPath)
export const pickFiles = (): Promise<string[]> => requireFs().pickFiles()
export const assetUrl = (filePath: string): string => requireFs().assetUrl(filePath)

/** `C:\Users\nikol\Videos` -> crumbs labelled per segment, each with its own absolute path. */
export function breadcrumbsOf(fullPath: string): Array<{ label: string; path: string }> {
  const isWindows = fullPath.includes('\\')
  const separator = isWindows ? '\\' : '/'
  const segments = fullPath.split(/[\\/]+/).filter(Boolean)

  return segments.map((label, i) => {
    const joined = segments.slice(0, i + 1).join(separator)
    // A Windows drive needs its trailing slash to be a valid path: `C:` alone
    // resolves to the process's working directory on that drive, not its root.
    if (isWindows) return { label, path: i === 0 ? `${joined}\\` : joined }
    return { label, path: `/${joined}` }
  })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
