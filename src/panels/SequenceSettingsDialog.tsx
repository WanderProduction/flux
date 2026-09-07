import { useEffect, useRef } from 'react'

import {
  contentDuration,
  updateSequenceSettings,
  type SequenceState,
} from '../kernel/sequence'
import { formatTimecode } from '../kernel/playback'
import {
  AUDIO_BIT_DEPTHS,
  CHANNEL_LAYOUTS,
  COLOUR_DEPTHS,
  COLOUR_SPACES,
  FIELD_ORDERS,
  FRAME_PRESETS,
  FRAME_RATES,
  PIXEL_ASPECTS,
  PIXEL_FORMATS,
  PREVIEW_CODECS,
  PREVIEW_SCALES,
  SAMPLE_RATES,
  TRANSFERS,
} from '../../shared/sequenceFormat.js'

/**
 * What a sequence *is*, as a dialog.
 *
 * Two halves, and the split is the whole design: settings that drive the app
 * today, and settings that are written to the file and not yet acted on. FLUX
 * has no exporter and no preview render files, so a preview codec cannot do
 * anything yet — and a control that appears to do something and does not is
 * worse than one that is honestly labelled. Sorting these by topic instead
 * would read better and lie.
 *
 * It edits the *active* sequence, which is why opening it from a sequence card
 * activates that sequence first. Every editing function in kernel/sequence.ts
 * works on the one that is on screen, deliberately — there is no way to mutate
 * a sequence nobody is looking at, and settings are not the place to punch the
 * first hole in that.
 */
export function SequenceSettingsDialog({
  sequence,
  onClose,
}: {
  sequence: SequenceState
  onClose: () => void
}) {
  const s = sequence.settings
  const panel = useRef<HTMLDivElement>(null)

  /*
   * Escape closes it, and focus starts inside.
   *
   * A dialog that can only be dismissed by finding the button with the mouse
   * is a dialog that traps a keyboard. This one has no destructive action and
   * no OK/Cancel — every change is applied as it is made, so closing is the
   * only exit there needs to be.
   */
  useEffect(() => {
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const number = (value: string, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const orZero = (value: string, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }

  /** Which preset the current size is, so the menu shows it rather than "Custom". */
  const preset =
    FRAME_PRESETS.find((one) => one.width === s.width && one.height === s.height)?.id ?? 'custom'

  const content = contentDuration()
  const seconds = (label: string, value: number) =>
    `${label} — ${formatTimecode(value, s.frameRate, 0)}`

  return (
    <div className="seq-settings-scrim" onClick={onClose}>
      <div
        className="seq-settings"
        ref={panel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${sequence.name} settings`}
      >
        <div className="seq-settings-head">
          <span className="seq-settings-title">{sequence.name}</span>
          <span className="seq-settings-sub">
            {s.width} × {s.height} · {s.frameRate} fps
          </span>
          <button className="cb-btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="seq-settings-body">
          {/* ── in force ─────────────────────────────────────── */}
          <div className="seq-settings-group">
            <span className="seq-settings-legend">In force</span>

            <label className="seq-field">
              <span>Frame size</span>
              <select
                value={preset}
                onChange={(e) => {
                  const found = FRAME_PRESETS.find((one) => one.id === e.target.value)
                  if (found) updateSequenceSettings({ width: found.width, height: found.height })
                }}
              >
                {/* Custom is listed but cannot be *chosen* — it is what the
                    width and height fields below say when they are not one of
                    the presets, not a mode you switch into. */}
                {preset === 'custom' && <option value="custom">Custom</option>}
                {FRAME_PRESETS.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Width</span>
              <input
                type="number"
                value={s.width}
                min={2}
                onChange={(e) => updateSequenceSettings({ width: number(e.target.value, s.width) })}
              />
            </label>
            <label className="seq-field">
              <span>Height</span>
              <input
                type="number"
                value={s.height}
                min={2}
                onChange={(e) =>
                  updateSequenceSettings({ height: number(e.target.value, s.height) })
                }
              />
            </label>
            <label className="seq-field">
              <span>Frame rate</span>
              <select
                value={String(s.frameRate)}
                onChange={(e) => updateSequenceSettings({ frameRate: Number(e.target.value) })}
              >
                {[...new Set([...FRAME_RATES, s.frameRate])]
                  .sort((a, b) => a - b)
                  .map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {rate} fps
                    </option>
                  ))}
              </select>
            </label>

            <label className="seq-field">
              <span>Duration</span>
              <input
                type="number"
                className="seq-duration"
                value={s.duration}
                min={0}
                step={0.5}
                onChange={(e) =>
                  updateSequenceSettings({ duration: orZero(e.target.value, s.duration) })
                }
              />
              <span className="seq-note">
                {s.duration > 0
                  ? seconds('ends at', s.duration)
                  : `follows the clips — ${formatTimecode(content, s.frameRate, 0)}`}
              </span>
            </label>
            {/* Said plainly, because it is the one setting here that can make
                work look lost. It has not been: the clips past the end are
                still in the sequence and still in the file. */}
            {s.duration > 0 && content > s.duration && (
              <p className="seq-warn">
                {formatTimecode(content - s.duration, s.frameRate, 0)} of clips sit past the end.
                They are still there — the sequence just stops before them.
              </p>
            )}

            <label className="seq-field">
              <span>Start timecode</span>
              <input
                type="number"
                value={s.startTimecode}
                min={0}
                step={1}
                onChange={(e) =>
                  updateSequenceSettings({ startTimecode: orZero(e.target.value, s.startTimecode) })
                }
              />
              <span className="seq-note">{formatTimecode(0, s.frameRate, s.startTimecode)}</span>
            </label>
            <button
              className="cb-btn seq-inline-btn"
              onClick={() => updateSequenceSettings({ startTimecode: s.startTimecode > 0 ? 0 : 3600 })}
            >
              {s.startTimecode > 0 ? 'Start at zero' : 'Start at 01:00:00:00'}
            </button>
          </div>

          {/* ── recorded ─────────────────────────────────────── */}
          <div className="seq-settings-group">
            <span className="seq-settings-legend">
              Recorded — saved with the sequence, not yet acted on
            </span>

            <label className="seq-field">
              <span>Pixel aspect</span>
              <select
                value={String(s.pixelAspect)}
                onChange={(e) => updateSequenceSettings({ pixelAspect: Number(e.target.value) })}
              >
                {[...PIXEL_ASPECTS].map((one) => (
                  <option key={one.id} value={String(one.ratio)}>
                    {one.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Scan</span>
              <select
                value={s.fieldOrder}
                onChange={(e) => updateSequenceSettings({ fieldOrder: e.target.value })}
              >
                {FIELD_ORDERS.map((one) => (
                  <option key={one} value={one}>
                    {one === 'progressive'
                      ? 'Progressive'
                      : one === 'upper-first'
                        ? 'Interlaced — upper field first'
                        : 'Interlaced — lower field first'}
                  </option>
                ))}
              </select>
            </label>

            <label className="seq-field">
              <span>Colour space</span>
              <select
                value={s.colour.space}
                onChange={(e) =>
                  updateSequenceSettings({ colour: { ...s.colour, space: e.target.value } })
                }
              >
                {COLOUR_SPACES.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Transfer</span>
              <select
                value={s.colour.transfer}
                onChange={(e) =>
                  updateSequenceSettings({ colour: { ...s.colour, transfer: e.target.value } })
                }
              >
                {TRANSFERS.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Bit depth</span>
              <select
                value={String(s.colour.depth)}
                onChange={(e) =>
                  updateSequenceSettings({
                    colour: { ...s.colour, depth: Number(e.target.value) },
                  })
                }
              >
                {COLOUR_DEPTHS.map((one) => (
                  <option key={one} value={String(one)}>
                    {one}-bit
                  </option>
                ))}
              </select>
            </label>

            <label className="seq-field">
              <span>Sample rate</span>
              <select
                value={String(s.audio.sampleRate)}
                onChange={(e) =>
                  updateSequenceSettings({
                    audio: { ...s.audio, sampleRate: Number(e.target.value) },
                  })
                }
              >
                {SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={String(rate)}>
                    {(rate / 1000).toFixed(1)} kHz
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Channels</span>
              <select
                value={String(s.audio.channels)}
                onChange={(e) =>
                  updateSequenceSettings({ audio: { ...s.audio, channels: Number(e.target.value) } })
                }
              >
                {CHANNEL_LAYOUTS.map((one) => (
                  <option key={one.id} value={String(one.channels)}>
                    {one.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Audio bit depth</span>
              <select
                value={String(s.audio.bitDepth)}
                onChange={(e) =>
                  updateSequenceSettings({ audio: { ...s.audio, bitDepth: Number(e.target.value) } })
                }
              >
                {AUDIO_BIT_DEPTHS.map((one) => (
                  <option key={one} value={String(one)}>
                    {one === 32 ? '32-bit float' : `${one}-bit`}
                  </option>
                ))}
              </select>
            </label>

            <label className="seq-field">
              <span>Preview codec</span>
              <select
                value={s.preview.codec}
                onChange={(e) =>
                  updateSequenceSettings({ preview: { ...s.preview, codec: e.target.value } })
                }
              >
                {PREVIEW_CODECS.map((codec) => (
                  <option key={codec} value={codec}>
                    {codec}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Pixel format</span>
              <select
                value={s.preview.pixelFormat}
                onChange={(e) =>
                  updateSequenceSettings({ preview: { ...s.preview, pixelFormat: e.target.value } })
                }
              >
                {PIXEL_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field">
              <span>Preview size</span>
              <select
                value={String(s.preview.scale)}
                onChange={(e) =>
                  updateSequenceSettings({
                    preview: { ...s.preview, scale: Number(e.target.value) },
                  })
                }
              >
                {PREVIEW_SCALES.map((one) => (
                  <option key={one} value={String(one)}>
                    {one === 1 ? 'Full' : one === 0.5 ? 'Half' : 'Quarter'}
                  </option>
                ))}
              </select>
            </label>
            <label className="seq-field seq-field--check">
              <input
                type="checkbox"
                checked={s.preview.cacheFrames}
                onChange={(e) =>
                  updateSequenceSettings({
                    preview: { ...s.preview, cacheFrames: e.target.checked },
                  })
                }
              />
              <span>Cache preview frames</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
