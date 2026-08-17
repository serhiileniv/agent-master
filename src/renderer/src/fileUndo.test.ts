import { describe, it, expect } from 'vitest'
import {
  describeOp,
  dropEntry,
  isUndoable,
  needsConfirm,
  peek,
  planUndo,
  pushOp,
  UNDO_DEPTH,
  type FileOp,
  type UndoEntry
} from './fileUndo'

const ROOT = '/project'
const file = (rel: string): EntrySnapshot => ({ rel, kind: 'file', content: 'eA==' })
/** A file that was past the undo cap: snapshotted, but with no bytes held. */
const unbuffered = (rel: string): EntrySnapshot => ({ rel, kind: 'file' })

describe('isUndoable', () => {
  it('treats create, rename, move and copy as reversible', () => {
    expect(isUndoable({ kind: 'create', rels: ['a.ts'] })).toBe(true)
    expect(isUndoable({ kind: 'rename', from: 'a.ts', to: 'b.ts' })).toBe(true)
    expect(isUndoable({ kind: 'move', items: [{ from: 'a.ts', to: 'x/a.ts' }] })).toBe(true)
    expect(isUndoable({ kind: 'copy', rels: ['a copy.ts'] })).toBe(true)
  })

  it('can undo a delete whose bytes were buffered', () => {
    expect(isUndoable({ kind: 'delete', rels: ['a.ts'], snapshots: [file('a.ts')] })).toBe(true)
  })

  // Recreating a whole subtree from memory is not something to be clever about,
  // so a folder delete is reported as un-undoable up front rather than half
  // restored afterwards.
  it('cannot undo a folder delete', () => {
    expect(
      isUndoable({ kind: 'delete', rels: ['src'], snapshots: [{ rel: 'src', kind: 'dir' }] })
    ).toBe(false)
  })

  // A snapshot with no content is a file that was past the size cap.
  it('cannot undo a delete of a file too large to have been buffered', () => {
    expect(
      isUndoable({ kind: 'delete', rels: ['big.bin'], snapshots: [unbuffered('big.bin')] })
    ).toBe(false)
  })

  it('cannot undo a delete where some entry produced no snapshot at all', () => {
    expect(isUndoable({ kind: 'delete', rels: ['a.ts', 'b.ts'], snapshots: [file('a.ts')] })).toBe(
      false
    )
  })
})

describe('needsConfirm', () => {
  // Undoing a create DELETES a file that now exists — that is the destructive
  // direction, and the only one VS Code prompts for at its default level.
  it('asks before undoing something that created files', () => {
    expect(needsConfirm({ kind: 'create', rels: ['a.ts'] })).toBe(true)
    expect(needsConfirm({ kind: 'copy', rels: ['a copy.ts'] })).toBe(true)
  })

  it('does not ask before reversing a move or restoring a delete', () => {
    expect(needsConfirm({ kind: 'rename', from: 'a.ts', to: 'b.ts' })).toBe(false)
    expect(needsConfirm({ kind: 'move', items: [] })).toBe(false)
    expect(needsConfirm({ kind: 'delete', rels: [], snapshots: [] })).toBe(false)
  })
})

describe('planUndo', () => {
  it('reverses a create by deleting what it made', () => {
    expect(planUndo({ kind: 'create', rels: ['a.ts'] })).toEqual({
      kind: 'delete',
      rels: ['a.ts']
    })
  })

  it('reverses a rename by moving it back', () => {
    expect(planUndo({ kind: 'rename', from: 'a.ts', to: 'b.ts' })).toEqual({
      kind: 'move',
      items: [{ from: 'b.ts', to: 'a.ts' }]
    })
  })

  it('reverses every leg of a multi-item move', () => {
    const op: FileOp = {
      kind: 'move',
      items: [
        { from: 'a.ts', to: 'x/a.ts' },
        { from: 'b.ts', to: 'x/b.ts' }
      ]
    }
    expect(planUndo(op)).toEqual({
      kind: 'move',
      items: [
        { from: 'x/a.ts', to: 'a.ts' },
        { from: 'x/b.ts', to: 'b.ts' }
      ]
    })
  })

  it('reverses a delete by replaying the buffered bytes', () => {
    const snaps = [file('a.ts')]
    expect(planUndo({ kind: 'delete', rels: ['a.ts'], snapshots: snaps })).toEqual({
      kind: 'restore',
      snapshots: snaps
    })
  })
})

describe('describeOp', () => {
  it('names a single-item operation by its file', () => {
    expect(describeOp({ kind: 'rename', from: 'src/a.ts', to: 'src/b.ts' })).toBe(
      'Rename a.ts to b.ts'
    )
    expect(describeOp({ kind: 'delete', rels: ['src/a.ts'], snapshots: [] })).toBe('Delete a.ts')
  })

  it('counts a multi-item operation', () => {
    expect(describeOp({ kind: 'delete', rels: ['a.ts', 'b.ts'], snapshots: [] })).toBe(
      'Delete 2 files'
    )
  })
})

describe('the stack', () => {
  it('records operations and returns the most recent first', () => {
    let stack: UndoEntry[] = []
    stack = pushOp(stack, ROOT, { kind: 'create', rels: ['a.ts'] })
    stack = pushOp(stack, ROOT, { kind: 'rename', from: 'a.ts', to: 'b.ts' })
    expect(peek(stack, ROOT)?.label).toBe('Rename a.ts to b.ts')
  })

  it('marks each entry undoable at the time it was recorded', () => {
    const stack = pushOp([], ROOT, {
      kind: 'delete',
      rels: ['src'],
      snapshots: [{ rel: 'src', kind: 'dir' }]
    })
    expect(stack[0].undoable).toBe(false)
  })

  // Switching the panel to another project must not offer to undo something
  // that happened somewhere else.
  it('only sees operations from the same scope root', () => {
    let stack: UndoEntry[] = []
    stack = pushOp(stack, ROOT, { kind: 'create', rels: ['a.ts'] })
    stack = pushOp(stack, '/other', { kind: 'create', rels: ['z.ts'] })
    expect(peek(stack, ROOT)?.label).toBe('Create a.ts')
    expect(peek(stack, '/other')?.label).toBe('Create z.ts')
    expect(peek(stack, '/nowhere')).toBeNull()
  })

  it('removes an entry once it has been undone', () => {
    let stack: UndoEntry[] = []
    stack = pushOp(stack, ROOT, { kind: 'create', rels: ['a.ts'] })
    stack = pushOp(stack, ROOT, { kind: 'create', rels: ['b.ts'] })
    const top = peek(stack, ROOT)!
    stack = dropEntry(stack, top)
    expect(stack).toHaveLength(1)
    expect(peek(stack, ROOT)?.label).toBe('Create a.ts')
  })

  // Buffered delete bytes live on the stack, so it must not grow without bound.
  it('keeps only the most recent operations', () => {
    let stack: UndoEntry[] = []
    for (let i = 0; i < UNDO_DEPTH + 5; i++) {
      stack = pushOp(stack, ROOT, { kind: 'create', rels: [`f${i}.ts`] })
    }
    expect(stack).toHaveLength(UNDO_DEPTH)
    expect(peek(stack, ROOT)?.label).toBe(`Create f${UNDO_DEPTH + 4}.ts`)
  })
})
