/**
 * Turning a picture somebody chose into something small enough to keep.
 *
 * Avatars and banners are stored as data URLs inside the account and workspace
 * manifests, which is a decision worth defending: a second file means a second
 * path to serve, a second thing to copy when a workspace moves to another
 * drive, and a second way for a workspace to arrive somewhere with a broken
 * image in it. A manifest that carries its own pictures is one file that is
 * always complete.
 *
 * That only works if the pictures are small, which is what this module is for.
 * A phone photograph is four thousand pixels across and eight megabytes; at
 * the sizes these are actually drawn, 96px and 1600px, it is a few tens of
 * kilobytes. The resize is the difference between a manifest and a liability.
 *
 * JPEG rather than PNG, and the reason is the same: these are photographs and
 * logos being shown small, and a PNG of a photograph is several times the size
 * for a difference nobody can see at 96 pixels.
 */

/** An avatar is drawn at 48px or smaller. Twice that covers every display. */
export const AVATAR_EDGE = 192
/** A banner spans a dashboard. Wide, and short enough not to dominate it. */
export const BANNER_WIDTH = 1600
export const BANNER_HEIGHT = 400

export interface PictureLimits {
  width: number
  height: number
  /** When set, the image is cropped to fill rather than fitted inside. */
  fill?: boolean
  quality?: number
}

export const AVATAR: PictureLimits = { width: AVATAR_EDGE, height: AVATAR_EDGE, fill: true, quality: 0.85 }
export const BANNER: PictureLimits = {
  width: BANNER_WIDTH,
  height: BANNER_HEIGHT,
  fill: true,
  quality: 0.8,
}

/**
 * Reads a chosen file and returns a data URL at the size it will be shown.
 *
 * Cropped to fill rather than letterboxed, for both shapes. An avatar with
 * bars down the sides looks like a mistake, and a banner that does not reach
 * the edges of its own strip looks like a broken image — in both cases the
 * user's intent is "use this picture here", and filling the space is what that
 * means.
 *
 * @returns null when the file is not an image the browser can decode, which
 *   includes a HEIC straight off a phone — worth reporting to the user as
 *   "that format cannot be read" rather than failing silently.
 */
export async function pictureFrom(file: Blob, limits: PictureLimits): Promise<string | null> {
  let bitmap: ImageBitmap
  try {
    // `from-image` so a photograph that carries a rotation flag is stored the
    // way its owner sees it, not the way the sensor recorded it. The same flag
    // that two files in five of this user's footage carries.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = limits.width
    canvas.height = limits.height
    const context = canvas.getContext('2d')
    if (!context) return null

    const scale = limits.fill
      ? Math.max(limits.width / bitmap.width, limits.height / bitmap.height)
      : Math.min(limits.width / bitmap.width, limits.height / bitmap.height)
    // Never upscale: a 40px logo blown up to 192 is worse than a 40px logo,
    // and the canvas is cleared to transparent behind it either way.
    const used = Math.min(1, scale)
    const width = Math.round(bitmap.width * used)
    const height = Math.round(bitmap.height * used)

    if (!limits.fill) {
      canvas.width = width
      canvas.height = height
      context.drawImage(bitmap, 0, 0, width, height)
    } else {
      context.drawImage(
        bitmap,
        Math.round((limits.width - width) / 2),
        Math.round((limits.height - height) / 2),
        width,
        height,
      )
    }

    return canvas.toDataURL('image/jpeg', limits.quality ?? 0.85)
  } finally {
    bitmap.close()
  }
}

/** Roughly how many bytes a data URL costs, for anything that wants to say so. */
export function dataUrlBytes(url: string | null): number {
  if (!url) return 0
  const comma = url.indexOf(',')
  if (comma < 0) return 0
  return Math.floor(((url.length - comma - 1) * 3) / 4)
}
