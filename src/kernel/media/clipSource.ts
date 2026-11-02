import type { Shown, SourceInfo } from './videoSource'

/**
 * What the Viewer needs from whatever is behind a clip.
 *
 * Two things satisfy it: a `VideoSource`, which is a decoder and an index and
 * a buffer of borrowed frames, and a `StillSource`, which is one picture. The
 * composite asks both the same question — "what is on screen at this moment" —
 * and that is the only question it has ever asked, so stating it as an
 * interface costs nothing and lets a still take its place in a stack beside
 * footage rather than beside it on a separate path.
 *
 * Deliberately narrow. Everything else `VideoSource` exposes — runs, the
 * lookahead, keyframe-only serving, the live set — exists because decoding is
 * expensive and is meaningless for a picture that was decoded once. A wider
 * interface would make a still pretend to have a decoder, and the first thing
 * anyone wrote against it would be code that reconciled a decoder pool for
 * objects that hold none.
 */
export interface ClipSource {
  /** The file this reads. The decoder pool is keyed by it. */
  readonly path: string
  readonly info: SourceInfo
  /** True once it has given up and the caller should fall back. */
  readonly broken: boolean
  shownFor(
    time: number,
    options?: { backwards?: boolean; width?: number; coarse?: boolean },
  ): Promise<Shown | null>
  close(): void
}
