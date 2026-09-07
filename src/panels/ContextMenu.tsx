import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  id: string
  label: string
  /** Shown right-aligned: a shortcut, or a count. */
  hint?: string
  disabled?: boolean
  /** Draws a rule above this item. */
  separated?: boolean
  danger?: boolean
  run: () => void
}

/**
 * A right-click menu.
 *
 * Positioned at the pointer and then nudged back inside the window, because a
 * menu opened near the right edge would otherwise run off it — and the items
 * that fall off are the ones at the bottom, which is where the destructive
 * ones live.
 *
 * Dismissed by Escape, by a click anywhere, and by the window losing focus. All
 * three, because a menu that stays up after you have looked away is a menu that
 * will eventually catch a click meant for whatever is underneath it.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect()
    if (!box) return
    const margin = 4
    setAt({
      left: Math.max(margin, Math.min(x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - box.height - margin)),
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Stopped here so the keymap does not also act on it: while a menu is up,
      // Escape means "put this away" and nothing else.
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    // Capture, and on pointerdown rather than click: the press that dismisses a
    // menu should not also reach whatever was behind it.
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  if (items.length === 0) return null

  return (
    <div
      className="ctx-menu"
      ref={menu}
      role="menu"
      style={{ left: at.left, top: at.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          className={
            'ctx-item' +
            (item.separated ? ' ctx-item--sep' : '') +
            (item.danger ? ' ctx-item--danger' : '')
          }
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          <span className="ctx-label">{item.label}</span>
          {item.hint && <span className="ctx-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
