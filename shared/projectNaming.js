/**
 * Turning a project name into a folder name - the single definition.
 *
 * Imported by BOTH the Electron main process (which creates the folder) and the
 * renderer (which shows the user the path they are about to get). Two copies
 * would drift, and the drift would show up as the launcher promising one path
 * and FLUX creating another.
 */

/**
 * Written as a code point rather than an escape, so no amount of copying this
 * file between tools can turn it into something else.
 */
const BACKSLASH = String.fromCharCode(92)

/** Characters Windows forbids in a path segment. */
const ILLEGAL_CHARS = '<>:"/|?*' + BACKSLASH

/**
 * Names Windows refuses regardless of extension. Creating one silently fails or
 * produces something unopenable, so they get a prefix.
 */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/**
 * Tested by code point rather than a regex, so no escaping subtleties can creep
 * in. Spaces and hyphens are legal and deliberately kept: "My Project" should
 * get the folder the user expects, not "MyProject".
 * @param {string} ch
 * @returns {boolean}
 */
function isIllegalChar(ch) {
  return ch.codePointAt(0) < 32 || ILLEGAL_CHARS.includes(ch)
}

/**
 * @param {string} name
 * @returns {string} a folder name that is safe to create on Windows
 */
export function safeFolderName(name) {
  let cleaned = [...String(name ?? '')]
    .filter((ch) => !isIllegalChar(ch))
    .join('')
    .trim()

  // Windows silently strips trailing dots and spaces, so a name ending in one
  // would resolve to a folder the user did not ask for.
  while (cleaned.endsWith('.') || cleaned.endsWith(' ')) cleaned = cleaned.slice(0, -1)

  if (!cleaned) return 'Untitled'
  if (RESERVED.has(cleaned.toUpperCase())) cleaned = `_${cleaned}`
  // Long names are a real limit on Windows once the parent path is prepended.
  return cleaned.slice(0, 80)
}

/**
 * The folder a project with this name would get inside `parent`.
 * @param {string} parent
 * @param {string} name
 * @returns {string}
 */
export function projectFolderPath(parent, name) {
  const sep = parent.includes(BACKSLASH) ? BACKSLASH : '/'
  let trimmed = parent
  while (trimmed.endsWith('/') || trimmed.endsWith(BACKSLASH)) trimmed = trimmed.slice(0, -1)
  return `${trimmed}${sep}${safeFolderName(name)}`
}
