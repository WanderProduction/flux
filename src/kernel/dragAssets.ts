/**
 * The drag contract between the Content Browser and any drop target.
 *
 * A private MIME type rather than `text/plain` for two reasons: dockview drives
 * its own panel docking through drag events, so an unlabelled drag risks being
 * read as a request to move a panel; and a drop target can then reject foreign
 * drags — a file from Explorer, a selection of text — by simply not finding
 * this type, instead of having to guess at the payload.
 */

export const ASSET_DRAG_TYPE = 'application/x-flux-assets'

export function setAssetDragPayload(event: React.DragEvent, assetIds: string[]) {
  event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(assetIds))
  event.dataTransfer.effectAllowed = 'copy'
}

export function isAssetDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(ASSET_DRAG_TYPE)
}

export function readAssetDragPayload(event: React.DragEvent): string[] {
  try {
    const raw = event.dataTransfer.getData(ASSET_DRAG_TYPE)
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}
