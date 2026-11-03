import { useCallback, useId, useRef, useState } from 'react'

import { pictureFrom, type PictureLimits } from '../kernel/pictures'

/**
 * Choose a picture, see it immediately.
 *
 * A plain `<input type="file">` behind a styled button rather than a dialog
 * over IPC. The file is read, resized and turned into a data URL here in the
 * renderer — the main process never sees the original, which also means a
 * forty-megabyte RAW somebody drags in is discarded at the point it is
 * decoded rather than copied anywhere first.
 *
 * Drag and drop as well as clicking, because the gesture for "use this
 * picture" is dragging it, and a picker that only accepts clicks makes people
 * go and find the file they are already holding.
 */
export function PicturePicker({
  value,
  onChange,
  limits,
  shape,
  label,
  fallback,
}: {
  value: string | null
  onChange: (picture: string | null) => void
  limits: PictureLimits
  shape: 'circle' | 'banner'
  label: string
  /** Drawn when there is no picture — initials, usually. */
  fallback?: string
}) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const take = useCallback(
    async (file: Blob | undefined) => {
      if (!file) return
      setBusy(true)
      setError(null)
      const picture = await pictureFrom(file, limits)
      setBusy(false)
      if (!picture) {
        setError('That image could not be read. PNG, JPEG or WebP.')
        return
      }
      onChange(picture)
    },
    [limits, onChange],
  )

  return (
    <div className={`pick pick--${shape}`}>
      <button
        type="button"
        className={`pick-target${over ? ' pick-target--over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          void take(e.dataTransfer.files[0])
        }}
        aria-label={label}
      >
        {value ? (
          <img className="pick-image" src={value} alt="" />
        ) : (
          <span className="pick-empty">{busy ? '…' : (fallback ?? label)}</span>
        )}
        <span className="pick-hint">{value ? 'Change' : 'Add'}</span>
      </button>

      <input
        id={inputId}
        ref={input}
        className="pick-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        onChange={(e) => {
          void take(e.target.files?.[0])
          // Cleared so choosing the same file twice in a row still fires.
          e.target.value = ''
        }}
      />

      {value && (
        <button type="button" className="link-button pick-clear" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
      {error && <p className="pick-error">{error}</p>}
    </div>
  )
}
