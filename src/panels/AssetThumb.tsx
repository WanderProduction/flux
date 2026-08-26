import { type MediaKind } from '../kernel/fsBridge'
import { useThumbnail } from './useThumbnail'

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
  const src = useThumbnail(path, kind, !missing)

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
