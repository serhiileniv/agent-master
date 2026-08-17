import { describe, it, expect } from 'vitest'
import {
  applyArrow,
  applyClick,
  cycleRenameRange,
  EMPTY_SELECTION,
  flattenTree,
  newEntryParent,
  pruneSelection,
  renameRange,
  type TreeRow
} from './fileTreeSelection'

// A small tree, expanded as far as `expanded` says:
//   src/            (dir)
//     components/   (dir)
//       Icon.tsx
//     index.ts
//   README.md
const rootEntries: FileEntry[] = [
  { name: 'src', kind: 'dir' },
  { name: 'README.md', kind: 'file' }
]
const cache = new Map<string, FileEntry[]>([
  [
    'src',
    [
      { name: 'components', kind: 'dir' },
      { name: 'index.ts', kind: 'file' }
    ]
  ],
  ['src/components', [{ name: 'Icon.tsx', kind: 'file' }]]
])

const tree = (...expandedRels: string[]): TreeRow[] =>
  flattenTree({ rootEntries, cache, expanded: new Set(expandedRels) })

describe('flattenTree', () => {
  it('lists only what is visible, in render order', () => {
    expect(tree().map((r) => r.rel)).toEqual(['src', 'README.md'])
    expect(tree('src').map((r) => r.rel)).toEqual([
      'src',
      'src/components',
      'src/index.ts',
      'README.md'
    ])
    expect(tree('src', 'src/components').map((r) => r.rel)).toEqual([
      'src',
      'src/components',
      'src/components/Icon.tsx',
      'src/index.ts',
      'README.md'
    ])
  })

  it('carries depth so rows can be indented', () => {
    const rows = tree('src', 'src/components')
    expect(rows.find((r) => r.rel === 'src')?.depth).toBe(0)
    expect(rows.find((r) => r.rel === 'src/components')?.depth).toBe(1)
    expect(rows.find((r) => r.rel === 'src/components/Icon.tsx')?.depth).toBe(2)
  })

  // Expanded but not yet listed — the tree shows a loading row, and the
  // selection model must not invent children that haven't arrived.
  it('skips an expanded dir whose listing has not loaded', () => {
    const rows = flattenTree({ rootEntries, cache: new Map(), expanded: new Set(['src']) })
    expect(rows.map((r) => r.rel)).toEqual(['src', 'README.md'])
  })
})

describe('applyClick', () => {
  const visible = tree('src')

  it('replaces the selection on a plain click', () => {
    const s = applyClick(EMPTY_SELECTION, 'src/index.ts', {}, visible)
    expect(s.selected).toEqual(['src/index.ts'])
    expect(s.anchor).toBe('src/index.ts')
  })

  it('toggles one row in and out with the meta modifier', () => {
    let s = applyClick(EMPTY_SELECTION, 'src', {}, visible)
    s = applyClick(s, 'README.md', { meta: true }, visible)
    expect(s.selected).toEqual(['src', 'README.md'])
    s = applyClick(s, 'src', { meta: true }, visible)
    expect(s.selected).toEqual(['README.md'])
  })

  it('selects the range between the anchor and the shift-clicked row', () => {
    const s = applyClick(
      applyClick(EMPTY_SELECTION, 'src', {}, visible),
      'README.md',
      { shift: true },
      visible
    )
    expect(s.selected).toEqual(['src', 'src/components', 'src/index.ts', 'README.md'])
  })

  it('ranges upward as well as downward', () => {
    const s = applyClick(
      applyClick(EMPTY_SELECTION, 'README.md', {}, visible),
      'src/components',
      { shift: true },
      visible
    )
    expect(s.selected).toEqual(['src/components', 'src/index.ts', 'README.md'])
  })

  it('keeps the anchor across a shift-click so the range can be redrawn', () => {
    const first = applyClick(EMPTY_SELECTION, 'src', {}, visible)
    const wide = applyClick(first, 'README.md', { shift: true }, visible)
    const narrow = applyClick(wide, 'src/components', { shift: true }, visible)
    expect(narrow.selected).toEqual(['src', 'src/components'])
  })

  // The first interaction with the tree being a shift-click is not an error.
  it('behaves as a plain click when there is no anchor', () => {
    const s = applyClick(EMPTY_SELECTION, 'src/index.ts', { shift: true }, visible)
    expect(s.selected).toEqual(['src/index.ts'])
  })
})

describe('pruneSelection', () => {
  it('drops rows that no longer exist', () => {
    const sel = { selected: ['src', 'src/index.ts'], anchor: 'src/index.ts' }
    const pruned = pruneSelection(sel, tree())
    expect(pruned.selected).toEqual(['src'])
    expect(pruned.anchor).toBeNull()
  })

  it('returns the same object when nothing changed, so React can skip the render', () => {
    const sel = { selected: ['src'], anchor: 'src' }
    expect(pruneSelection(sel, tree())).toBe(sel)
  })
})

describe('applyArrow', () => {
  const visible = tree('src')
  const expanded = new Set(['src'])
  const at = (rel: string): { selected: string[]; anchor: string } => ({
    selected: [rel],
    anchor: rel
  })

  it('moves down and up through the visible rows', () => {
    expect(applyArrow(at('src'), 'down', visible, expanded).selection.selected).toEqual([
      'src/components'
    ])
    expect(applyArrow(at('src/components'), 'up', visible, expanded).selection.selected).toEqual([
      'src'
    ])
  })

  it('stops at the ends rather than wrapping', () => {
    expect(applyArrow(at('src'), 'up', visible, expanded).selection.selected).toEqual(['src'])
    expect(applyArrow(at('README.md'), 'down', visible, expanded).selection.selected).toEqual([
      'README.md'
    ])
  })

  it('extends the selection when shift is held', () => {
    const r = applyArrow(at('src'), 'down', visible, expanded, true)
    expect(r.selection.selected).toEqual(['src', 'src/components'])
  })

  // The two-step is what makes one-handed navigation work: right opens a closed
  // folder and only steps INTO it once it is already open.
  it('right expands a closed folder before stepping into it', () => {
    const closed = tree()
    const r1 = applyArrow(at('src'), 'right', closed, new Set())
    expect(r1.expand).toBe('src')
    expect(r1.selection.selected).toEqual(['src'])
    const r2 = applyArrow(at('src'), 'right', visible, expanded)
    expect(r2.expand).toBeUndefined()
    expect(r2.selection.selected).toEqual(['src/components'])
  })

  it('left collapses an open folder before jumping to the parent', () => {
    const r1 = applyArrow(at('src'), 'left', visible, expanded)
    expect(r1.collapse).toBe('src')
    expect(r1.selection.selected).toEqual(['src'])
    const r2 = applyArrow(at('src/index.ts'), 'left', visible, expanded)
    expect(r2.selection.selected).toEqual(['src'])
  })

  it('left at the top level does nothing', () => {
    expect(applyArrow(at('README.md'), 'left', visible, expanded).selection.selected).toEqual([
      'README.md'
    ])
  })
})

describe('newEntryParent', () => {
  const row = (rel: string, kind: 'dir' | 'file'): TreeRow => ({
    rel,
    name: rel.slice(rel.lastIndexOf('/') + 1),
    kind,
    depth: 0
  })

  it('creates inside a selected folder', () => {
    expect(newEntryParent(row('src/components', 'dir'))).toBe('src/components')
  })

  // VS Code's rule, and the one that surprises people: a selected FILE means
  // beside it, not inside anything.
  it('creates beside a selected file, in that file’s folder', () => {
    expect(newEntryParent(row('src/index.ts', 'file'))).toBe('src')
    expect(newEntryParent(row('README.md', 'file'))).toBe('')
  })

  it('creates at the root when nothing is selected', () => {
    expect(newEntryParent(null)).toBe('')
  })
})

describe('renameRange', () => {
  it('pre-selects the name without its extension', () => {
    expect(renameRange('index.ts', false)).toEqual([0, 5])
    expect(renameRange('index.test.ts', false)).toEqual([0, 10])
  })

  // The dot is at index 0, so it isn't an extension separator.
  it('selects the whole name of a dotfile', () => {
    expect(renameRange('.gitignore', false)).toEqual([0, 10])
  })

  it('selects the whole name of a folder even when it contains a dot', () => {
    expect(renameRange('my.folder', true)).toEqual([0, 9])
  })

  it('selects the whole name when there is no extension', () => {
    expect(renameRange('LICENSE', false)).toEqual([0, 7])
  })
})

describe('cycleRenameRange', () => {
  it('cycles name → whole → extension → name', () => {
    const a = cycleRenameRange('index.ts', false, 'prefix')
    expect(a).toEqual({ mode: 'all', range: [0, 8] })
    const b = cycleRenameRange('index.ts', false, 'all')
    expect(b).toEqual({ mode: 'suffix', range: [6, 8] })
    const c = cycleRenameRange('index.ts', false, 'suffix')
    expect(c).toEqual({ mode: 'prefix', range: [0, 5] })
  })

  it('is a no-op for folders and extensionless names, where all three are the same', () => {
    expect(cycleRenameRange('src', true, 'prefix')).toEqual({ mode: 'all', range: [0, 3] })
    expect(cycleRenameRange('LICENSE', false, 'all')).toEqual({ mode: 'all', range: [0, 7] })
  })
})
