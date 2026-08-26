import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  breadcrumbsOf,
  listSubfolders,
  type FolderEntry,
  type SubfolderResult,
} from '../kernel/fsBridge'
import { TreeIcon, type TreeIconKind } from './TreeIcon'

/**
 * Tree rendering and navigation, shared by the local-disk tree and the project
 * tree.
 *
 * Rows are a FLAT list rather than nested components. A tree drawn by recursion
 * makes "move to the next visible row" — the thing every arrow key needs — a
 * traversal problem, when on a flat list it is index + 1. Since every function
 * here has to be reachable from the keyboard, the flat shape is what keeps that
 * promise cheap to keep.
 */

export interface TreeRow {
  /** Stable identity: a path for folders, an asset id for project leaves. */
  id: string
  label: string
  depth: number
  icon: TreeIconKind
  expandable: boolean
  expanded: boolean
  loading?: boolean
  error?: 'denied' | 'unreadable'
  /** Shown in place of children, e.g. an empty folder. */
  note?: string
  title?: string
  /** Set on rows that stand in for content rather than being content. */
  placeholder?: boolean
}

export function TreeView({
  rows,
  selectedId,
  onSelect,
  onToggle,
  onDragStartRow,
  emptyNote,
}: {
  rows: TreeRow[]
  selectedId: string | null
  onSelect: (row: TreeRow) => void
  onToggle: (row: TreeRow) => void
  onDragStartRow?: (row: TreeRow, event: React.DragEvent) => void
  emptyNote?: string
}) {
  const [focusIndex, setFocusIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  // Only steal DOM focus in response to a key press inside the tree; moving it
  // on every render would yank focus away from whatever the user was using.
  const shouldFocus = useRef(false)

  useEffect(() => {
    if (!shouldFocus.current) return
    shouldFocus.current = false
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)
    el?.focus()
  }, [focusIndex, rows])

  const move = useCallback(
    (next: number) => {
      if (rows.length === 0) return
      shouldFocus.current = true
      setFocusIndex(Math.max(0, Math.min(next, rows.length - 1)))
    },
    [rows.length],
  )

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const row = rows[index]
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(index - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        // A closed node opens; an already-open one steps into its first child.
        if (row.expandable && !row.expanded) onToggle(row)
        else move(index + 1)
        break
      case 'ArrowLeft': {
        event.preventDefault()
        if (row.expandable && row.expanded) {
          onToggle(row)
          break
        }
        // Otherwise climb: the nearest row above at a shallower depth.
        for (let i = index - 1; i >= 0; i--) {
          if (rows[i].depth < row.depth) {
            move(i)
            break
          }
        }
        break
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        onSelect(row)
        break
      default:
        break
    }
  }

  if (rows.length === 0 && emptyNote) {
    return <p className="tree-empty">{emptyNote}</p>
  }

  return (
    <div className="tree" ref={containerRef} role="tree">
      {rows.map((row, index) => (
        <div
          key={row.id}
          role="treeitem"
          aria-expanded={row.expandable ? row.expanded : undefined}
          aria-selected={row.id === selectedId}
          data-index={index}
          data-path={row.id}
          tabIndex={index === focusIndex ? 0 : -1}
          title={row.title ?? row.id}
          draggable={Boolean(onDragStartRow) && !row.placeholder}
          onDragStart={(event) => onDragStartRow?.(row, event)}
          className={`tree-row${row.id === selectedId ? ' tree-row--selected' : ''}${
            row.error ? ' tree-row--error' : ''
          }${row.placeholder ? ' tree-row--placeholder' : ''}${
            row.loading ? ' tree-row--loading' : ''
          }`}
          style={{ paddingLeft: 6 + row.depth * 12 }}
          onClick={() => {
            setFocusIndex(index)
            if (!row.placeholder) onSelect(row)
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {row.expandable ? (
            <button
              className={`tree-chevron${row.expanded ? ' tree-chevron--open' : ''}`}
              // Decoration for keyboard users, who have ArrowLeft/Right. Taking
              // it out of the tab order stops every row costing two tab stops.
              tabIndex={-1}
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              onClick={(event) => {
                event.stopPropagation()
                onToggle(row)
              }}
            />
          ) : (
            <span className="tree-chevron tree-chevron--leaf" />
          )}
          <TreeIcon kind={row.icon} />
          <span className="tree-label">{row.label}</span>
          {row.loading && <span className="tree-note">…</span>}
          {row.error && <span className="tree-note">{row.error}</span>}
          {row.note && <span className="tree-note">{row.note}</span>}
        </div>
      ))}
    </div>
  )
}

type ChildState = { status: 'loading' } | { status: 'done'; result: SubfolderResult }

/**
 * Lazy expansion state for a disk tree.
 *
 * Children load on first expand and are cached after: collapsing and
 * re-expanding a branch should not hit the disk again, and on a network drive
 * that difference is seconds rather than milliseconds.
 */
export function useDiskTree(roots: FolderEntry[]) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Map<string, ChildState>>(new Map())

  const load = useCallback(async (dirPath: string) => {
    let alreadyKnown = false
    setChildren((current) => {
      if (current.has(dirPath)) {
        alreadyKnown = true
        return current
      }
      const next = new Map(current)
      next.set(dirPath, { status: 'loading' })
      return next
    })
    if (alreadyKnown) return

    const result = await listSubfolders(dirPath)
    setChildren((current) => {
      const next = new Map(current)
      next.set(dirPath, { status: 'done', result })
      return next
    })
  }, [])

  const setExpansion = useCallback(
    (dirPath: string, open: boolean) => {
      setExpanded((current) => {
        if (current.has(dirPath) === open) return current
        const next = new Set(current)
        if (open) next.add(dirPath)
        else next.delete(dirPath)
        return next
      })
      if (open) void load(dirPath)
    },
    [load],
  )

  const toggle = useCallback(
    (dirPath: string) => setExpansion(dirPath, !expanded.has(dirPath)),
    [expanded, setExpansion],
  )

  /** Closes every branch. The loaded-children cache is kept, so reopening is instant. */
  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  /** Opens one branch without touching the rest. */
  const expand = useCallback((dirPath: string) => setExpansion(dirPath, true), [setExpansion])

  /**
   * Opens every ancestor so `target` becomes visible in the tree.
   *
   * Sequential on purpose: each level's children must be read before the next
   * level is known to exist, so this cannot be parallelised.
   */
  const reveal = useCallback(
    async (target: string) => {
      const ancestors = breadcrumbsOf(target).map((crumb) => crumb.path)
      for (const ancestor of ancestors) {
        if (ancestor === target) break
        setExpansion(ancestor, true)
        await load(ancestor)
      }
    },
    [load, setExpansion],
  )

  const rows = useMemo(() => {
    const out: TreeRow[] = []

    const walk = (entry: FolderEntry, depth: number, icon: TreeIconKind) => {
      const isOpen = expanded.has(entry.path)
      const state = children.get(entry.path)
      const failed = isOpen && state?.status === 'done' && !state.result.ok

      out.push({
        id: entry.path,
        label: entry.name,
        depth,
        icon,
        expandable: true,
        expanded: isOpen,
        loading: isOpen && state?.status === 'loading',
        error: failed && state?.status === 'done' && !state.result.ok ? state.result.error : undefined,
        title: entry.path,
      })

      if (!isOpen || state?.status !== 'done' || !state.result.ok) return

      if (state.result.folders.length === 0) {
        out.push({
          id: `${entry.path}::empty`,
          label: 'no subfolders',
          depth: depth + 1,
          icon: 'folder',
          expandable: false,
          expanded: false,
          placeholder: true,
          title: entry.path,
        })
        return
      }
      state.result.folders.forEach((child) => walk(child, depth + 1, 'folder'))
    }

    roots.forEach((root) => walk(root, 0, 'drive'))
    return out
  }, [roots, expanded, children])

  return { rows, toggle, expand, collapseAll, reveal, expanded }
}
