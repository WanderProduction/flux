/**
 * Which files FLUX treats as media — the single definition.
 *
 * Imported by BOTH the Electron main process (directory listing, and the
 * flux-asset protocol's allowlist) and the renderer (card rendering,
 * thumbnails). Two copies of this list would drift, and the drift would be
 * silent: the browser would offer a file the protocol then refuses to serve,
 * which reads as a mysterious broken thumbnail rather than a mismatch.
 *
 * The lists are deliberately limited to what Chromium can actually decode,
 * because a card we cannot draw a thumbnail for is a promise we cannot keep.
 * Notable exclusions and why:
 *   .mkv, .avi, .wmv  — Chromium has no demuxer for these containers.
 *   .tif, .tiff       — no decoder.
 *   ProRes / DNxHD    — not supported in the mp4/mov Chromium builds ship.
 * Widening this list is an engine question, not a UI one: it needs real
 * decoding behind it first.
 */

/** @type {ReadonlySet<string>} */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
])

/** @type {ReadonlySet<string>} */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv'])

/**
 * Lowercase extension including the leading dot, or '' when there is none.
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/**
 * @param {string} name
 * @returns {'image' | 'video' | null}
 */
export function mediaKindOf(name) {
  const ext = extensionOf(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isMediaFile(name) {
  return mediaKindOf(name) !== null
}

/** Extensions without the dot, for the native open dialog's filters. */
export const DIALOG_FILTERS = [
  {
    name: 'Media',
    extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((e) => e.slice(1)),
  },
  { name: 'Images', extensions: [...IMAGE_EXTENSIONS].map((e) => e.slice(1)) },
  { name: 'Video', extensions: [...VIDEO_EXTENSIONS].map((e) => e.slice(1)) },
]
