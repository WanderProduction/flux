import { useEffect, useMemo, useState } from 'react'

import {
  clearClipEffects,
  getSequence,
  setClipEffects,
  subscribeSequence,
  type Clip,
  type SequenceState,
} from '../kernel/sequence'
import { getSelection, subscribeSelection } from '../kernel/selection'
import {
  defaultAudio,
  defaultTransform,
  isAudioTouched,
  isTransformed,
  resolveAudio,
  resolveTransform,
  MIN_LEVEL_DB,
  type ClipAudio,
  type Transform,
} from '../kernel/clipEffects'
import { PanelFrame } from './PanelFrame'

/**
 * Effect Controls — what the selected clip does to its picture and its sound.
 *
 * ## Why it reads the selection rather than the playhead
 *
 * Premiere's panel follows the selection, and so does this, for a reason worth
 * stating: the playhead is where you are *looking*, the selection is what you
 * are *working on*, and they are often different. Scrubbing to check a cut
 * elsewhere must not swap the parameters out from under a hand that is halfway
 * through typing a number.
 *
 * ## One selection, two clips
 *
 * Selecting a clip selects everything linked to it, so picking up a shot
 * hands this panel both halves of it — the picture on a video track and the
 * sound on an audio one. They are separate clips with separate parameters, and
 * the panel shows both: Motion, Opacity and Crop belong to the picture, Volume
 * and Panner to the sound. That is also what Premiere shows for a linked clip,
 * and it means unlinking a pair does not change what you can reach.
 *
 * Several clips selected shows nothing. Editing many at once is a real feature
 * — Premiere has it — but it needs an answer for what a field shows when two
 * clips disagree, and inventing one here would mean a number that is not any
 * clip's number. Saying so is better than guessing.
 */

/** A labelled number, which is nearly every control in here. */
function Field({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  title,
}: {
  label?: string
  value: number
  onChange: (next: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  title?: string
}) {
  /*
   * Held as text while it is being typed.
   *
   * A controlled number input that rounds on every keystroke fights the hand:
   * typing "-" or "0." or deleting the last digit all produce something that
   * is not a number yet, and writing the parsed value back mid-word moves the
   * caret and eats characters. The field keeps what was typed until it is
   * committed, and only a value that actually parses reaches the clip.
   */
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? String(Math.round(value * 100) / 100)

  const commit = (raw: string) => {
    setText(null)
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    const bounded = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed))
    if (bounded !== value) onChange(bounded)
  }

  return (
    <label className="ec-field" title={title}>
      {label && <span className="ec-label">{label}</span>}
      <span className="ec-input">
        <input
          type="text"
          inputMode="decimal"
          value={shown}
          step={step}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit((event.target as HTMLInputElement).value)
              ;(event.target as HTMLInputElement).blur()
            }
            if (event.key === 'Escape') setText(null)
          }}
        />
        {suffix && <span className="ec-suffix">{suffix}</span>}
      </span>
    </label>
  )
}

/** Two fields that belong together, like a position or a skew. */
function Pair({
  label,
  x,
  y,
  onChange,
  suffix,
  title,
}: {
  label: string
  x: number
  y: number
  onChange: (next: { x: number; y: number }) => void
  suffix?: string
  title?: string
}) {
  return (
    <div className="ec-row" title={title}>
      <span className="ec-label">{label}</span>
      <div className="ec-pair">
        <Field value={x} onChange={(next) => onChange({ x: next, y })} suffix={suffix} />
        <Field value={y} onChange={(next) => onChange({ x, y: next })} suffix={suffix} />
      </div>
    </div>
  )
}

function Group({
  title,
  touched,
  onReset,
  children,
}: {
  title: string
  touched: boolean
  onReset: () => void
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className={`ec-group${touched ? ' ec-group--touched' : ''}`}>
      <header className="ec-group-head">
        <button className="ec-disclose" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} {title}
        </button>
        {/* Only offered once there is something to undo. A reset that is always
            available invites the question of what it would do. */}
        {touched && (
          <button className="ec-reset" onClick={onReset} title={`Put ${title} back to its default`}>
            reset
          </button>
        )}
      </header>
      {open && <div className="ec-group-body">{children}</div>}
    </section>
  )
}

export function EffectControlsPanel() {
  const [sequence, setSequence] = useState<SequenceState>(getSequence)
  const [selected, setSelected] = useState<ReadonlySet<string>>(getSelection)

  useEffect(() => subscribeSequence(() => setSequence({ ...getSequence() })), [])
  useEffect(() => subscribeSelection(() => setSelected(new Set(getSelection()))), [])

  const frame = useMemo(
    () => ({ width: sequence.settings.width, height: sequence.settings.height }),
    [sequence.settings.width, sequence.settings.height],
  )

  const chosen = useMemo(
    () => sequence.clips.filter((clip) => selected.has(clip.id)),
    [sequence.clips, selected],
  )

  /*
   * A linked pair counts as one thing, which is what makes "select a shot and
   * change its scale" work: the selection holds two clips, and only one of
   * them has a picture.
   */
  const video = chosen.find((clip) => clip.kind === 'video')
  const audio = chosen.find((clip) => clip.kind === 'audio')
  const links = new Set(chosen.map((clip) => clip.linkId ?? clip.id))
  const single = chosen.length > 0 && links.size === 1

  if (!single) {
    return (
      <PanelFrame>
        <p className="ec-empty">
          {chosen.length === 0
            ? 'Select a clip on the timeline'
            : `${links.size} clips selected — one at a time for now`}
        </p>
      </PanelFrame>
    )
  }

  const name = (clip: Clip | undefined) => clip?.id ?? ''
  const transform = resolveTransform(video?.effects?.transform, frame)
  const sound = resolveAudio(audio?.effects?.audio)
  const base = defaultTransform(frame)

  const setTransform = (patch: Partial<Transform>) => {
    if (video) setClipEffects(video.id, { transform: patch })
  }
  const setSound = (patch: Partial<ClipAudio>) => {
    if (audio) setClipEffects(audio.id, { audio: patch })
  }

  const motionTouched =
    transform.position.x !== base.position.x ||
    transform.position.y !== base.position.y ||
    transform.anchor.x !== base.anchor.x ||
    transform.anchor.y !== base.anchor.y ||
    transform.scale !== 100 ||
    (!transform.uniform && transform.scaleWidth !== 100) ||
    !transform.uniform ||
    transform.rotation !== 0 ||
    transform.skew.x !== 0 ||
    transform.skew.y !== 0

  const cropTouched =
    transform.crop.left !== 0 ||
    transform.crop.top !== 0 ||
    transform.crop.right !== 0 ||
    transform.crop.bottom !== 0

  return (
    <PanelFrame
      toolbar={
        <>
          <span className="tool-label">Clip</span>
          <span className="tool-value">{video ? 'picture + sound' : 'sound'}</span>
          <span className="tool-sep" />
          <span className="tool-label">Frame</span>
          <span className="tool-value tool-value--dim">
            {frame.width}×{frame.height}
          </span>
          {(isTransformed(video?.effects?.transform, frame) ||
            isAudioTouched(audio?.effects?.audio)) && (
            <>
              <span className="tool-sep" />
              <button
                className="ec-reset"
                onClick={() => {
                  if (video) clearClipEffects(video.id)
                  if (audio) clearClipEffects(audio.id)
                }}
                title="Put every parameter on this clip back to its default"
              >
                reset all
              </button>
            </>
          )}
        </>
      }
    >
      <div className="ec-body" data-clip={name(video ?? audio)}>
        {video && (
          <>
            <Group title="Motion" touched={motionTouched} onReset={() => setTransform(base)}>
              <Pair
                label="Position"
                x={transform.position.x}
                y={transform.position.y}
                onChange={(position) => setTransform({ position })}
                title="Where the anchor point lands, in sequence pixels from the top left"
              />
              <Pair
                label="Anchor Point"
                x={transform.anchor.x}
                y={transform.anchor.y}
                onChange={(anchor) => setTransform({ anchor })}
                title="The point the clip is scaled and rotated about"
              />
              <Field
                label="Scale"
                value={transform.scale}
                onChange={(scale) => setTransform({ scale })}
                min={0}
                suffix="%"
                title="100% is the size FLUX already draws the clip at — fitted to the frame"
              />
              {!transform.uniform && (
                <Field
                  label="Scale Width"
                  value={transform.scaleWidth}
                  onChange={(scaleWidth) => setTransform({ scaleWidth })}
                  min={0}
                  suffix="%"
                />
              )}
              <label className="ec-row ec-check">
                <span className="ec-label">Uniform Scale</span>
                <input
                  type="checkbox"
                  checked={transform.uniform}
                  onChange={(event) => setTransform({ uniform: event.target.checked })}
                />
              </label>
              <Field
                label="Rotation"
                value={transform.rotation}
                onChange={(rotation) => setTransform({ rotation })}
                suffix="°"
                title="Degrees clockwise, about the anchor point"
              />
              <Pair
                label="Skew"
                x={transform.skew.x}
                y={transform.skew.y}
                onChange={(skew) => setTransform({ skew })}
                suffix="°"
                title="Shear, in degrees. Premiere has no such control; After Effects does"
              />
            </Group>

            <Group
              title="Opacity"
              touched={transform.opacity !== 100}
              onReset={() => setTransform({ opacity: 100 })}
            >
              <Field
                label="Opacity"
                value={transform.opacity}
                onChange={(opacity) => setTransform({ opacity })}
                min={0}
                max={100}
                suffix="%"
              />
            </Group>

            <Group
              title="Crop"
              touched={cropTouched}
              onReset={() => setTransform({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })}
            >
              {(['left', 'top', 'right', 'bottom'] as const).map((edge) => (
                <Field
                  key={edge}
                  label={edge[0].toUpperCase() + edge.slice(1)}
                  value={transform.crop[edge]}
                  onChange={(value) => setTransform({ crop: { ...transform.crop, [edge]: value } })}
                  min={0}
                  max={100}
                  suffix="%"
                  title="Percent taken off this edge, in the picture's displayed orientation"
                />
              ))}
            </Group>
          </>
        )}

        {audio ? (
          <Group
            title="Audio"
            touched={isAudioTouched(audio.effects?.audio)}
            onReset={() => setSound(defaultAudio())}
          >
            <label className="ec-row ec-check">
              <span className="ec-label">Mute</span>
              <input
                type="checkbox"
                checked={sound.mute}
                onChange={(event) => setSound({ mute: event.target.checked })}
              />
            </label>
            <Field
              label="Level"
              value={sound.level}
              onChange={(level) => setSound({ level })}
              min={MIN_LEVEL_DB}
              suffix="dB"
              title={`0 is the level it was recorded at; ${MIN_LEVEL_DB} is silence`}
            />
            <Field
              label="Balance"
              value={sound.pan}
              onChange={(pan) => setSound({ pan })}
              min={-100}
              max={100}
              title="-100 hard left, 0 centred, +100 hard right"
            />
          </Group>
        ) : (
          <p className="ec-note">This clip has no sound on the timeline.</p>
        )}
      </div>
    </PanelFrame>
  )
}
