import { useEffect, useState } from 'react'

import { hasFilesystem, type MediaKind } from '../kernel/fsBridge'
import { audioStateFor, type AudioState } from '../kernel/media/peaks'

/**
 * What a card has learned about a file's sound, kept for as long as the app
 * runs. Cheap — three fields per path — and it does two things: a card that
 * scrolls back into view shows its badge immediately rather than blinking
 * through an unknown state, and a known answer skips the queue below entirely.
 *
 * Not invalidated on its own. The underlying index is keyed on the file's size
 * and mtime, so a file replaced on disk answers afresh the next time anything
 * asks; what is stale here is only the badge on a card already on screen.
 */
const known = new Map<string, AudioState>()

/*
 * At most a few probes at once.
 *
 * The same rule thumbnails follow, for the same reason: opening a folder of two
 * hundred clips would otherwise start two hundred demuxes in one frame. Each is
 * only a handful of ranged reads, but a thousand of them at once is a stalled
 * window — and the drop path deliberately does NOT come through here, because
 * the one question that must be answered immediately is the one a hand is
 * waiting on.
 */
const CONCURRENCY = 4
let active = 0
const waiting: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < CONCURRENCY) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else active -= 1
}

/**
 * Whether a file has sound, for a card or a clip that wants to say so.
 *
 * A drop already asks this question — it is the whole of what decides whether
 * an audio block appears — and it used to be asked only there, in private. A
 * file shot without a microphone then landed as picture alone with no
 * explanation, which reads exactly like the audio half of the app being broken.
 * Saying it before the drop is what turns that into a fact about the footage.
 *
 * Costs the audio sample table and nothing more: six ranged reads the first
 * time, then memory, and concurrent askers for one path share a single job (see
 * media/indexCache.ts). Nothing here decodes.
 *
 * Returns `undefined` while it is still finding out, so a card shows nothing
 * rather than flashing "no audio" at a file that has plenty.
 */
export function useSound(
  path: string | undefined,
  kind: MediaKind | undefined,
  enabled = true,
): AudioState | undefined {
  // Images are not silent, they are pictures. Asking would cost ranged reads to
  // learn something nobody was wondering about.
  const wanted = Boolean(path && kind === 'video' && enabled && hasFilesystem)
  const [state, setState] = useState<AudioState | undefined>(() =>
    wanted && path ? known.get(path) : undefined,
  )

  useEffect(() => {
    if (!wanted || !path) {
      setState(undefined)
      return
    }

    const held = known.get(path)
    if (held) {
      setState(held)
      return
    }

    let cancelled = false
    setState(undefined)
    void acquire().then(async () => {
      try {
        // Still asked even if this card has scrolled away: the answer is worth
        // keeping, and abandoning it would only mean asking again in a moment.
        const found = await audioStateFor(path)
        known.set(path, found)
        if (!cancelled) setState(found)
      } finally {
        release()
      }
    })

    return () => {
      cancelled = true
    }
  }, [path, wanted])

  return state
}

