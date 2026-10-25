import { useEffect, useState } from 'react'

import { assetUrl, hasFilesystem, type MediaKind } from '../kernel/fsBridge'
import { abandonThumbnail, cachedThumbnail, requestThumbnail } from '../kernel/thumbnails'

/**
 * A file's thumbnail, decoding it through the shared queue if it is not cached.
 *
 * Shared by asset cards and timeline clips. The clip used to read the cache
 * directly and show nothing on a miss, which meant a clip's picture depended on
 * whether the Content Browser had happened to render that card first — the
 * block was blank if you dropped an asset you had never scrolled past.
 *
 * Returns:
 *   undefined — still decoding
 *   null      — decoded and failed; render a placeholder
 *   string    — a data URL
 */
export function useThumbnail(
  path: string | undefined,
  kind: MediaKind | undefined,
  enabled = true,
): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(() =>
    path ? cachedThumbnail(path) : undefined,
  )

  useEffect(() => {
    if (!path || !kind || !enabled || !hasFilesystem) return

    const known = cachedThumbnail(path)
    if (known !== undefined) {
      setSrc(known)
      return
    }

    let cancelled = false
    setSrc(undefined)
    void requestThumbnail(path, kind, assetUrl(path)).then((thumbnail) => {
      // The card can be scrolled away, or the clip deleted, while a decode is
      // queued; setting state then would warn and waste a render.
      if (!cancelled) setSrc(thumbnail)
    })

    return () => {
      cancelled = true
      // The card scrolled away or the block left the drawn window. If the
      // decode has not started, nothing should start it for something that is
      // no longer on screen.
      abandonThumbnail(path)
    }
  }, [path, kind, enabled])

  return src
}
