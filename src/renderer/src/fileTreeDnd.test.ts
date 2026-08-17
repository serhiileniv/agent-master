import { describe, it, expect } from 'vitest'
import {
  canDrop,
  distinctRoots,
  dropTargetDir,
  parentDir,
  plannedMoves,
  DRAG_AUTO_EXPAND_MS
} from './fileTreeDnd'
import type { TreeRow } from './fileTreeSelection'

const row = (rel: string, kind: 'dir' | 'file'): TreeRow => ({
  rel,
  name: rel.slice(rel.lastIndexOf('/') + 1),
  kind,
  depth: 0
})

describe('dropTargetDir', () => {
  it('drops INTO a folder', () => {
    expect(dropTargetDir(row('src/components', 'dir'))).toBe('src/components')
  })

  // Dropping on a file must never overwrite that file — VS Code retargets to
  // the file's parent, so a drop always means "into a folder".
  it('retargets a drop on a file to that file’s folder', () => {
    expect(dropTargetDir(row('src/index.ts', 'file'))).toBe('src')
    expect(dropTargetDir(row('README.md', 'file'))).toBe('')
  })

  it('targets the root when dropped on empty space', () => {
    expect(dropTargetDir(null)).toBe('')
  })
})

describe('parentDir', () => {
  it('returns the containing folder, or the root', () => {
    expect(parentDir('a/b/c.ts')).toBe('a/b')
    expect(parentDir('c.ts')).toBe('')
  })
})

describe('canDrop', () => {
  it('allows a move into a different folder', () => {
    expect(canDrop(['src/index.ts'], 'src/components').ok).toBe(true)
  })

  it('refuses dropping something onto itself', () => {
    expect(canDrop(['src'], 'src').ok).toBe(false)
  })

  // rename() on some platforms reports success here and detaches the subtree,
  // so this has to be caught before the filesystem ever sees it.
  it('refuses moving a folder into its own descendant', () => {
    const r = canDrop(['src'], 'src/components')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/into itself/)
  })

  it('refuses a move back into the folder it already lives in', () => {
    expect(canDrop(['src/index.ts'], 'src').ok).toBe(false)
  })

  // …but with the copy modifier that same gesture is a duplicate-in-place,
  // which IS meaningful.
  it('allows a copy into the folder it already lives in', () => {
    expect(canDrop(['src/index.ts'], 'src', true).ok).toBe(true)
  })

  it('refuses an empty drag', () => {
    expect(canDrop([], 'src').ok).toBe(false)
  })

  it('refuses the whole drop if any one source is invalid', () => {
    expect(canDrop(['README.md', 'src'], 'src/components').ok).toBe(false)
  })
})

describe('distinctRoots', () => {
  // Dragging a folder and a file inside it must move the folder once, not move
  // the folder and then fail to find the file.
  it('drops sources that an ancestor already covers', () => {
    expect(distinctRoots(['src', 'src/index.ts', 'src/components/Icon.tsx'])).toEqual(['src'])
  })

  // Order is the order the rows were selected in, and the caller uses the last
  // one to decide what ends up selected after the drop.
  it('keeps genuinely separate sources, in the order given', () => {
    expect(distinctRoots(['src/index.ts', 'README.md'])).toEqual(['src/index.ts', 'README.md'])
  })

  // `src2` is not inside `src`, despite the prefix.
  it('does not treat a name-prefix as containment', () => {
    expect(distinctRoots(['src', 'src2/a.ts'])).toEqual(['src', 'src2/a.ts'])
  })

  it('drops duplicates', () => {
    expect(distinctRoots(['a.ts', 'a.ts'])).toEqual(['a.ts'])
  })
})

describe('plannedMoves', () => {
  it('keeps each name and re-parents it under the destination', () => {
    expect(plannedMoves(['src/index.ts', 'README.md'], 'docs')).toEqual([
      { from: 'src/index.ts', to: 'docs/index.ts' },
      { from: 'README.md', to: 'docs/README.md' }
    ])
  })

  it('moves to the root without a leading slash', () => {
    expect(plannedMoves(['src/index.ts'], '')).toEqual([
      { from: 'src/index.ts', to: 'index.ts' }
    ])
  })

  it('plans one move for a folder dragged with its own children', () => {
    expect(plannedMoves(['src', 'src/index.ts'], 'docs')).toEqual([
      { from: 'src', to: 'docs/src' }
    ])
  })
})

describe('DRAG_AUTO_EXPAND_MS', () => {
  // Long enough that dragging ACROSS a folder doesn't open it, short enough
  // that hovering deliberately feels responsive. VS Code's value.
  it('matches VS Code’s hover-to-expand delay', () => {
    expect(DRAG_AUTO_EXPAND_MS).toBe(500)
  })
})
