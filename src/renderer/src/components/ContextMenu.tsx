import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** One row. A separator carries no label and is not focusable. */
export interface MenuItem {
  key: string
  label?: string
  /** Right-aligned shortcut hint, e.g. `⌘⌫`. Display only — the binding itself
   *  lives with the key handler that actually implements it. */
  hint?: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  onSelect?: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/**
 * Renderer-side context menu.
 *
 * Deliberately not Electron's `Menu.popup`: a native menu would be a second
 * visual language in a window that draws everything else itself, and it cannot
 * be styled to match. The terminal pane already hand-rolls one of these; this
 * is the same idea extracted into something reusable, with the two things that
 * one leaves out — Escape to close, and staying inside the window when opened
 * near an edge.
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Measure after mount and pull the menu back inside the window if opening at
  // the pointer would push it off the bottom or right edge. Layout effect so it
  // never paints in the wrong place first.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x
    const ny = y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture: the tree's own key handler would otherwise see Escape first and
    // cancel an inline edit that isn't what the user meant to dismiss.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="ctxmenu__backdrop"
      onPointerDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        className="ctxmenu"
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map((it) =>
          it.separator ? (
            <div key={it.key} className="ctxmenu__sep" />
          ) : (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={'ctxmenu__item' + (it.danger ? ' is-danger' : '')}
              disabled={it.disabled}
              onClick={() => {
                onClose()
                it.onSelect?.()
              }}
            >
              <span className="ctxmenu__label">{it.label}</span>
              {it.hint && <span className="ctxmenu__hint">{it.hint}</span>}
            </button>
          )
        )}
      </div>
    </div>
  )
}
