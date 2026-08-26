import type { ReactNode } from 'react'

/**
 * Shared panel chrome. Panels get a thin header strip for their own controls
 * and a scrolling body. Keeping this in one place means a skin restyles every
 * panel — including community ones — by touching a single rule.
 */
export function PanelFrame({
  toolbar,
  children,
  scroll = true,
}: {
  toolbar?: ReactNode
  children: ReactNode
  scroll?: boolean
}) {
  return (
    <div className="panel">
      {toolbar && <div className="panel-toolbar">{toolbar}</div>}
      <div className={scroll ? 'panel-body panel-body--scroll' : 'panel-body'}>{children}</div>
    </div>
  )
}

/**
 * Marks a region as not-yet-built. Used instead of leaving panels empty so the
 * shell reads as intentional while it is still a shell — and so nothing in here
 * can be mistaken for a working feature.
 */
export function Scaffold({ note }: { note: string }) {
  return <div className="scaffold-note">{note}</div>
}
