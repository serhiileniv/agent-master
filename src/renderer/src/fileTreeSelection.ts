/**
 * The file tree's selection model and the placement rules around it.
 *
 * All of this is pure so it can be tested without rendering a tree: what is
 * visible after expansion, what ⌘/⇧-click do to a selection, where a new entry
 * lands, and which part of a filename is pre-selected when a rename starts.
 * Every rule here matches VS Code's Explorer, including the ones that look
 * arbitrary in isolation — they are the ones muscle memory depends on.
 */

/** One row as it appears on screen, in top-to-bottom order. */
export interface TreeRow {
  rel: string
  name: string
  kind: 'dir' | 'file'
  depth: number
}

export interface FlattenInput {
  rootEntries: FileEntry[] | null
  /** Listings for directories that have been expanded at least once. */
  cache: Map<string, FileEntry[]>
  expanded: Set<string>
}

/**
 * The visible rows, in render order. ⇧-click ranges and arrow-key movement are
 * both defined over *what you can see*, not over the underlying tree, so they
 * need this list rather than the nested structure.
 */
export function flattenTree({ rootEntries, cache, expanded }: FlattenInput): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (entries: FileEntry[], parentRel: string, depth: number): void => {
    for (const e of entries) {
      const rel = parentRel ? `${parentRel}/${e.name}` : e.name
      out.push({ rel, name: e.name, kind: e.kind, depth })
      if (e.kind === 'dir' && expanded.has(rel)) {
        const children = cache.get(rel)
        if (children) walk(children, rel, depth + 1)
      }
    }
  }
  walk(rootEntries ?? [], '', 0)
  return out
}

export interface Selection {
  /** Rel paths, in no particular order. */
  selected: string[]
  /** The row a ⇧-range extends FROM. Survives ⌘-clicks so ⌘ then ⇧ behaves. */
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { selected: [], anchor: null }

export interface ClickModifiers {
  /** ⌘ on macOS, Ctrl elsewhere — toggles one row in or out. */
  meta?: boolean
  /** ⇧ — selects everything between the anchor and this row. */
  shift?: boolean
}

/**
 * Apply a click to a selection.
 *
 * ⇧ without an anchor behaves as a plain click rather than doing nothing, which
 * is what happens when the first interaction with the tree is a ⇧-click.
 */
export function applyClick(
  sel: Selection,
  rel: string,
  mods: ClickModifiers,
  visible: TreeRow[]
): Selection {
  if (mods.shift && sel.anchor) {
    const from = visible.findIndex((r) => r.rel === sel.anchor)
    const to = visible.findIndex((r) => r.rel === rel)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      return { selected: visible.slice(lo, hi + 1).map((r) => r.rel), anchor: sel.anchor }
    }
    // The anchor scrolled out of existence (its folder collapsed) — fall back.
    return { selected: [rel], anchor: rel }
  }
  if (mods.meta) {
    const has = sel.selected.includes(rel)
    const selected = has ? sel.selected.filter((r) => r !== rel) : [...sel.selected, rel]
    // Deselecting the anchor leaves the anchor where it was: a following
    // ⇧-click should still range from the row you started at.
    return { selected, anchor: rel }
  }
  return { selected: [rel], anchor: rel }
}

/** Drop rows that no longer exist — after a delete, or after a folder collapsed
 *  out from under part of the selection. */
export function pruneSelection(sel: Selection, visible: TreeRow[]): Selection {
  const live = new Set(visible.map((r) => r.rel))
  const selected = sel.selected.filter((r) => live.has(r))
  if (selected.length === sel.selected.length) return sel
  return { selected, anchor: sel.anchor && live.has(sel.anchor) ? sel.anchor : null }
}

export type ArrowKey = 'up' | 'down' | 'left' | 'right'

export interface ArrowResult {
  selection: Selection
  /** A folder the caller should expand (→ on a collapsed folder). */
  expand?: string
  /** A folder the caller should collapse (← on an expanded folder). */
  collapse?: string
  /** The row to scroll into view / open, when the move implies one. */
  focus?: string
}

/**
 * Keyboard movement over the visible rows.
 *
 * ← and → are the two that carry real behaviour beyond moving: → opens a closed
 * folder and only steps into it once it is already open; ← closes an open
 * folder and only jumps to the parent once it is already closed. That two-step
 * is what makes arrow navigation usable one-handed.
 */
export function applyArrow(
  sel: Selection,
  key: ArrowKey,
  visible: TreeRow[],
  expanded: Set<string>,
  shift = false
): ArrowResult {
  if (visible.length === 0) return { selection: sel }
  const currentRel = sel.anchor ?? sel.selected[sel.selected.length - 1] ?? null
  const idx = currentRel ? visible.findIndex((r) => r.rel === currentRel) : -1

  if (key === 'down' || key === 'up') {
    const next = idx === -1 ? (key === 'down' ? 0 : visible.length - 1) : idx + (key === 'down' ? 1 : -1)
    if (next < 0 || next >= visible.length) return { selection: sel }
    const rel = visible[next].rel
    if (shift) {
      // Extend from the anchor, exactly as a ⇧-click would.
      const anchorIdx = sel.anchor ? visible.findIndex((r) => r.rel === sel.anchor) : next
      const [lo, hi] = anchorIdx <= next ? [anchorIdx, next] : [next, anchorIdx]
      return {
        selection: { selected: visible.slice(lo, hi + 1).map((r) => r.rel), anchor: sel.anchor ?? rel },
        focus: rel
      }
    }
    return { selection: { selected: [rel], anchor: rel }, focus: rel }
  }

  if (idx === -1) return { selection: sel }
  const row = visible[idx]

  if (key === 'right') {
    if (row.kind === 'dir' && !expanded.has(row.rel)) return { selection: sel, expand: row.rel }
    // Already open (or a file): step to the next row, which for an open folder
    // is its first child.
    const next = visible[idx + 1]
    if (!next) return { selection: sel }
    return { selection: { selected: [next.rel], anchor: next.rel }, focus: next.rel }
  }

  // left
  if (row.kind === 'dir' && expanded.has(row.rel)) return { selection: sel, collapse: row.rel }
  const parentRel = row.rel.includes('/') ? row.rel.slice(0, row.rel.lastIndexOf('/')) : null
  if (!parentRel) return { selection: sel }
  return { selection: { selected: [parentRel], anchor: parentRel }, focus: parentRel }
}

/**
 * Which folder a new file or folder is created in.
 *
 * VS Code's rule, and it surprises people the first time: a selected FILE means
 * the new entry appears beside it, in that file's folder — not inside anything.
 * Only a selected folder creates inside. Nothing selected means the root.
 */
export function newEntryParent(selected: TreeRow | null): string {
  if (!selected) return ''
  if (selected.kind === 'dir') return selected.rel
  return selected.rel.includes('/') ? selected.rel.slice(0, selected.rel.lastIndexOf('/')) : ''
}

/** Character range pre-selected in the rename box, as [start, end]. */
export type NameRange = [number, number]

/**
 * What is highlighted when a rename opens: the name without its extension, so
 * typing replaces `index` in `index.ts` and leaves `.ts` alone.
 *
 * Two exceptions, both VS Code's: a dotfile like `.gitignore` has its dot at
 * index 0, which is not an extension separator, so the whole name is selected;
 * and folders always get the whole name even when it contains a dot.
 */
export function renameRange(name: string, isDir: boolean): NameRange {
  const dot = name.lastIndexOf('.')
  if (isDir || dot <= 0) return [0, name.length]
  return [0, dot]
}

export type RangeMode = 'prefix' | 'all' | 'suffix'

/** Pressing F2 again while renaming cycles name → whole → extension. A no-op
 *  for folders and for names with no extension, where all three are the same. */
export function cycleRenameRange(name: string, isDir: boolean, mode: RangeMode): {
  mode: RangeMode
  range: NameRange
} {
  const dot = name.lastIndexOf('.')
  if (isDir || dot <= 0) return { mode: 'all', range: [0, name.length] }
  const next: RangeMode = mode === 'prefix' ? 'all' : mode === 'all' ? 'suffix' : 'prefix'
  const range: NameRange =
    next === 'prefix' ? [0, dot] : next === 'all' ? [0, name.length] : [dot + 1, name.length]
  return { mode: next, range }
}
