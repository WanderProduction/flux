/**
 * The media cache, accounted for rather than used.
 *
 * Three modules write into one directory — a demuxed sample table per track
 * (media/indexCache.ts), audio peaks (media/peaks.ts) and asset thumbnails
 * (thumbnails.ts) — and each one used to name its own entries with a private
 * constant. That is fine until something has to *report* on the directory,
 * at which point the names have to be known in one place or the report
 * invents a fourth bucket called "unrecognised" the first time somebody
 * renames one.
 *
 * So the names live here and the producers import them. The cache's namespace
 * is part of its contract, not an implementation detail of whoever happens to
 * fill it.
 *
 * ## What this module is not
 *
 * Not the budgets. How many decoders may be open, how much decoded picture may
 * be held, how far ahead to warm and how much disk the cache may use are all
 * in kernel/performance.ts, measured against the machine, and the main process
 * reads the disk one directly at startup to prune to it. A second copy of that
 * number here would be a second answer to a question that already has one.
 *
 * This module answers the question that had no owner: what is actually on disk
 * right now, and how do I get rid of it.
 */

/** What a kind of entry is, in the user's words. */
export interface CacheKind {
  id: string
  label: string
  /** What throwing it away costs, which is the only thing worth knowing. */
  note: string
}

/**
 * Everything the media cache holds, in the order it is worth showing.
 *
 * Ordered by what it costs to rebuild rather than by size, because that is the
 * order somebody clearing a cache selectively wants to read it in: the cheap
 * thing to lose first, the expensive thing last. Thumbnails are a second and a
 * few kilobytes; a sample table for a long clip is a megabyte and twenty-two
 * milliseconds of ranged reads every time a Viewer opens the file.
 */
export const CACHE_KINDS: CacheKind[] = [
  {
    id: 'thumb',
    label: 'Thumbnails',
    note: 'The pictures on asset cards. Cheapest to lose — redrawn as the folder scrolls.',
  },
  {
    id: 'peaks',
    label: 'Audio peaks',
    note: 'The waveform behind a clip. Rebuilt by decoding the whole audio track again.',
  },
  {
    id: 'video-index',
    label: 'Frame indexes',
    note: 'Where every frame of picture is in the file. The expensive one: without it, opening a clip means stepping through the file again.',
  },
  {
    id: 'audio-index',
    label: 'Audio indexes',
    note: 'The same table for the sound track, kept separately because most clips only ever need their picture.',
  },
]

/** The name a kind is filed under. Imported by whoever writes that kind. */
export const KIND = {
  thumb: 'thumb',
  peaks: 'peaks',
  videoIndex: 'video-index',
  audioIndex: 'audio-index',
} as const

interface CacheBridge {
  measure: () => Promise<RawReport>
  clear: (kind: string | null) => Promise<{ removed: number; bytes: number }>
  clearWindow: () => Promise<{ bytes: number }>
  reveal: () => Promise<string>
}

interface RawReport {
  media: {
    dir: string
    budget: number
    bytes: number
    entries: number
    byKind: Record<string, { bytes: number; entries: number }>
    unreadable: number
    newest: number
  }
  window: {
    dir: string
    bytes: number
    parts: { id: string; name: string; bytes: number }[]
  }
}

function bridge(): CacheBridge | null {
  return (globalThis as { flux?: { cache?: CacheBridge } }).flux?.cache ?? null
}

/** Whether any of this can be answered at all. False in a plain browser. */
export const hasCacheReport = (): boolean => bridge() !== null

export interface KindUsage extends CacheKind {
  bytes: number
  entries: number
}

export interface CacheReport {
  media: {
    dir: string
    budget: number
    bytes: number
    entries: number
    /** Entries whose preamble could not be read — a crash mid-write leaves these. */
    unreadable: number
    /** When anything here was last *used*, not written. 0 when the cache is empty. */
    newest: number
    kinds: KindUsage[]
  }
  window: {
    dir: string
    bytes: number
    parts: { id: string; name: string; bytes: number }[]
  }
}

/**
 * What is on disk, grouped the way the page shows it.
 *
 * A kind with nothing in it is still listed, at zero. The alternative — hiding
 * empty kinds — makes a cache that has only ever thumbnailed look like a cache
 * that cannot hold anything else, and the list is four rows long.
 *
 * A bucket that is *not* one of the four known kinds is listed too, under the
 * name the entry gave. That is how a rename shows up as a visible row rather
 * than as a total that silently stops adding up.
 */
export async function measureCaches(): Promise<CacheReport | null> {
  const api = bridge()
  if (!api) return null

  let raw: RawReport
  try {
    raw = await api.measure()
  } catch {
    return null
  }
  if (!raw?.media) return null

  const seen = raw.media.byKind ?? {}
  const kinds: KindUsage[] = CACHE_KINDS.map((kind) => ({
    ...kind,
    bytes: seen[kind.id]?.bytes ?? 0,
    entries: seen[kind.id]?.entries ?? 0,
  }))

  const known = new Set(CACHE_KINDS.map((kind) => kind.id))
  for (const [id, usage] of Object.entries(seen)) {
    if (known.has(id)) continue
    kinds.push({
      id,
      label: id === '' ? 'Unreadable entries' : id,
      note:
        id === ''
          ? 'Entries whose header could not be read — usually a write interrupted by a crash. Cleared with everything else.'
          : 'Written by something that does not name itself. Cleared with everything else.',
      bytes: usage.bytes,
      entries: usage.entries,
    })
  }

  return { media: { ...raw.media, kinds }, window: raw.window }
}

/**
 * Throws away one kind of entry, or all of them.
 *
 * Nothing here is the user's work and nothing here is unrecoverable: every
 * byte was derived from media that is still on disk. That is what makes this
 * safe to offer without a dialog full of warnings — the cost of pressing it by
 * mistake is that the next open is slower.
 */
export async function clearMedia(kind?: string): Promise<{ removed: number; bytes: number }> {
  const api = bridge()
  if (!api) return { removed: 0, bytes: 0 }
  try {
    return await api.clear(kind ?? null)
  } catch {
    return { removed: 0, bytes: 0 }
  }
}

/**
 * Empties the window's own caches — Chromium's fetched files and V8's compiled
 * code.
 *
 * Worth a separate button because it is a separate owner. We chose the media
 * cache's budget; nobody chose this one, and on the machine this page was
 * built on it was twenty times larger.
 */
export async function clearWindowCache(): Promise<{ bytes: number }> {
  const api = bridge()
  if (!api) return { bytes: 0 }
  try {
    return await api.clearWindow()
  } catch {
    return { bytes: 0 }
  }
}

/** Opens the cache directory, which is the other half of saying where it is. */
export async function revealCache(): Promise<void> {
  await bridge()?.reveal().catch(() => '')
}
