/**
 * Undo for file operations — ⌘Z with the tree focused.
 *
 * The model is VS Code's, including its limits, because they are inherent
 * rather than incidental: undoing a delete means replaying bytes that were
 * buffered before the delete, so a FOLDER is not undoable (recreating a whole
 * subtree from memory is not something to be clever about) and neither is a
 * file past a size cap (holding arbitrary megabytes to make ⌘Z work is a bad
 * trade). Both cases are stated in the delete confirmation rather than
 * discovered afterwards, and both are still recoverable from the Trash.
 *
 * The stack is per scope root: switching the panel to another project must not
 * offer to undo an operation that happened somewhere else.
 */

/** What happened, and enough to reverse it. */
export type FileOp =
  | { kind: 'create'; rels: string[] }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'move'; items: Array<{ from: string; to: string }> }
  | { kind: 'copy'; rels: string[] }
  /** `snapshots` is empty for the parts that could not be buffered. */
  | { kind: 'delete'; rels: string[]; snapshots: EntrySnapshot[] }

export interface UndoEntry {
  root: string
  op: FileOp
  /** Shown in the confirmation: "Would you like to undo 'Rename a.ts to b.ts'?" */
  label: string
  /** False when replaying it would not restore what was there — a folder
   *  delete, or a file too large to have been buffered. */
  undoable: boolean
}

/** How many operations back ⌘Z reaches. Deep enough to cover a mistake,
 *  shallow enough that buffered delete bytes can't accumulate unbounded. */
export const UNDO_DEPTH = 20

/** Human-readable name for an operation, used in the undo confirmation. */
export function describeOp(op: FileOp): string {
  switch (op.kind) {
    case 'create':
      return op.rels.length === 1 ? `Create ${baseName(op.rels[0])}` : `Create ${op.rels.length} files`
    case 'rename':
      return `Rename ${baseName(op.from)} to ${baseName(op.to)}`
    case 'move':
      return op.items.length === 1
        ? `Move ${baseName(op.items[0].from)}`
        : `Move ${op.items.length} files`
    case 'copy':
      return op.rels.length === 1 ? `Copy ${baseName(op.rels[0])}` : `Copy ${op.rels.length} files`
    case 'delete':
      return op.rels.length === 1 ? `Delete ${baseName(op.rels[0])}` : `Delete ${op.rels.length} files`
  }
}

function baseName(rel: string): string {
  return rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
}

/**
 * Can this operation actually be reversed?
 *
 * Only delete can fail the test: every snapshot must exist and, for files, must
 * carry buffered content. A folder snapshot never does, which is what makes a
 * folder delete un-undoable.
 */
export function isUndoable(op: FileOp): boolean {
  if (op.kind !== 'delete') return true
  if (op.snapshots.length !== op.rels.length) return false
  return op.snapshots.every((s) => s.kind === 'file' && s.content != null)
}

/**
 * Undoing a CREATE deletes a file that now exists, so it gets a confirmation
 * even though the others don't. This is VS Code's `default` confirmUndo level:
 * prompt before destructive undo, stay quiet otherwise.
 */
export function needsConfirm(op: FileOp): boolean {
  return op.kind === 'create' || op.kind === 'copy'
}

export function pushOp(stack: UndoEntry[], root: string, op: FileOp): UndoEntry[] {
  const entry: UndoEntry = { root, op, label: describeOp(op), undoable: isUndoable(op) }
  return [...stack, entry].slice(-UNDO_DEPTH)
}

/** The top entry for this root, or null. Entries from other roots are skipped
 *  rather than popped — switching back to that project should still find them. */
export function peek(stack: UndoEntry[], root: string): UndoEntry | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].root === root) return stack[i]
  }
  return null
}

/** Remove a specific entry after it has been undone (or found unusable). */
export function dropEntry(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const i = stack.lastIndexOf(entry)
  if (i === -1) return stack
  return [...stack.slice(0, i), ...stack.slice(i + 1)]
}

/**
 * What actually has to happen on disk to reverse an operation, as a plan the
 * caller executes against the file API. Keeping this a description rather than
 * a set of calls is what makes the whole model testable without a filesystem.
 */
export type UndoPlan =
  | { kind: 'delete'; rels: string[] }
  | { kind: 'move'; items: Array<{ from: string; to: string }> }
  | { kind: 'restore'; snapshots: EntrySnapshot[] }

export function planUndo(op: FileOp): UndoPlan {
  switch (op.kind) {
    // Undo of a create/copy is a delete of what it made.
    case 'create':
    case 'copy':
      return { kind: 'delete', rels: op.rels }
    case 'rename':
      return { kind: 'move', items: [{ from: op.to, to: op.from }] }
    case 'move':
      return { kind: 'move', items: op.items.map((i) => ({ from: i.to, to: i.from })) }
    case 'delete':
      return { kind: 'restore', snapshots: op.snapshots }
  }
}
