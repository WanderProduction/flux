/**
 * Which folders a footage scan walks past — the single definition.
 *
 * Imported by BOTH the Electron main process (the recursive scan) and the
 * renderer (so a batch import can say what it skipped and why), for the same
 * reason mediaTypes.js is shared: two copies of a list like this drift, and the
 * drift is silent.
 *
 * ## Why this is a folder list and not an extension list
 *
 * The obvious junk in a camera archive is per-file — `.cfa` conformed audio,
 * `.pek` peak files, `.lrv` and `.thm` GoPro sidecars. None of it is listed
 * here, because none of it is a format FLUX reads: mediaTypes.js already
 * decides what counts as media, and a sidecar never passes it.
 *
 * What does pass, and is still not footage, is **a whole folder of real video
 * files that duplicate footage already in the scan**. An editing suite writes
 * these beside the originals:
 *
 *   Proxies\          low-resolution stand-ins. Same shots, same filenames
 *                     with a suffix, a fifth of the resolution. Measured in
 *                     this library: folders of 178 of them sitting next to the
 *                     178 originals. Importing both means every clip twice,
 *                     and the second copy is the one that looks soft.
 *   Media Cache\      Premiere's decoded-audio and index cache.
 *   Peak Files\       waveform caches.
 *   Auto-Save\        project snapshots, which can contain rendered previews.
 *   Project Backups\  the same.
 *   LOCAL CACHE\      scratch from a shared-storage workflow.
 *
 * ## What is deliberately NOT here
 *
 * Render and intermediate folders — `EX\`, `AE\`, `Pre-comp\` — hold finished
 * exports and comps. They are not duplicates of camera footage and some of
 * them are the only copy of a delivered piece, so skipping them would be a
 * decision about someone's work rather than about clutter. They are scanned;
 * whether they are wanted is a question for the review, which is what the
 * review is for.
 *
 * Matching is on the folder's own name, case-insensitively, at any depth. Not
 * on a path fragment: `...\Proxies\` and `...\PROXIES\` are the same intent,
 * while a shoot folder legitimately named `Media Cache Promo` is not, and a
 * substring match would swallow it.
 */

/** @type {ReadonlySet<string>} */
export const SKIPPED_FOLDERS = new Set([
  'proxies',
  'media cache',
  'peak files',
  'auto-save',
  'project backups',
  'local cache',
])

/**
 * Folders every file browser hides and every scan should: they sit in each
 * drive root, hold nothing a person put there, and only ever produce a
 * permission error. The same two listDirectory already hides.
 *
 * @type {ReadonlySet<string>}
 */
export const SYSTEM_FOLDERS = new Set(['$recycle.bin', 'system volume information'])

/**
 * Why a folder was skipped, or null to walk into it.
 *
 * Returns a reason rather than a boolean so a scan can report what it passed
 * over. "Skipped 9 folders" is a number someone has to take on trust; "skipped
 * 9 Proxies folders holding 1,247 files" is a number they can check, and the
 * one that catches a filter which has quietly eaten something real.
 *
 * @param {string} name a folder's own name, not a path
 * @returns {'proxies-or-cache' | 'system' | null}
 */
export function skipReasonFor(name) {
  const lower = name.toLowerCase()
  if (SYSTEM_FOLDERS.has(lower)) return 'system'
  if (SKIPPED_FOLDERS.has(lower)) return 'proxies-or-cache'
  return null
}
