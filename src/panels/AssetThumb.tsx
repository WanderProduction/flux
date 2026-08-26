import { useEffect, useState } from 'react'
import { assetUrl, hasFilesystem, type MediaKind } from '../kernel/fsBridge'
import { cachedThumbnail, requestThumbnail } from '../kernel/thumbnails'

/**
 * A card's picture. Renders from cache instantly when the thumbnail is already
 * known, otherwise decodes through the shared queue and shows a quiet
 * placeholder until it lands.
 */
export function AssetThumb({
  path,
  kind,
  missing,
}: {
  path: string
  kind: MediaKind
  missing?: boolean
}) {
  const [src, setSrc] = useState<string | null | undefined>(() => cachedThumbnail(path))

  useEffect(() => {
    if (missing || !hasFilesystem) return

    const known = cachedThumbnail(path)
    if (known !== undefined) {
      setSrc(known)
      return
    }

    let cancelled = false
    setSrc(undefined)
    void requestThumbnail(path, kind, assetUrl(path)).then((thumbnail) => {
      // The card can be scrolled away or the folder changed while a decode is
      // queued; setting state then would warn and waste a render.
      if (!cancelled) setSrc(thumbnail)
    })

    return () => {
      cancelled = true
    }
  }, [path, kind, missing])

  if (missing) {
    return (
      <div className="thumb thumb--missing">
        <span>offline</span>
      </div>
    )
  }

  if (src) {
    return <img className="thumb" src={src} alt="" draggable={false} />
  }

  return (
    <div className={`thumb thumb--${src === null ? 'failed' : 'loading'}`}>
      <span>{src === null ? 'no preview' : ''}</span>
    </div>
  )
}
