/**
 * Drag-and-drop rules for the file tree.
 *
 * Pure, because the interesting part of a drop is the decision, not the
 * pointer handling: which folder a drop actually lands in, and which drops must
 * be refused before anything touches the disk. All of it matches VS Code's
 * `FileDragAndDrop`.
 */

import type { TreeRow } from './fileTreeSelection'

/**
 * The folder a drop lands in.
 *
 * Dropping on a FILE does not overwrite that file — it retargets to the file's
 * parent folder, so a drop is always "into a folder". Dropping on empty space
 * below the tree targets the root.
 */
export function dropTargetDir(target: TreeRow | null): string {
  if (!target) return ''
  if (target.kind === 'dir') return target.rel
  return target.rel.includes('/') ? target.rel.slice(0, target.rel.lastIndexOf('/')) : ''
}

/** The folder an entry currently lives in. */
export function parentDir(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
}

export interface DropCheck {
  ok: boolean
  /** Why not — for a tooltip, and for the test to assert on. */
  reason?: string
}

/**
 * Whether these sources can be dropped into this folder.
 *
 * Four refusals, and each one is a real failure mode rather than a nicety:
 *
 * - onto itself — nothing to do.
 * - into its own subfolder — `rename()` on some platforms reports success and
 *   detaches the subtree, so this must be caught before the filesystem sees it.
 * - into the folder it already lives in — a no-op move. Held with ⌥ it becomes
 *   a duplicate-in-place, which IS meaningful, so copy is allowed through.
 * - nothing selected.
 */
export function canDrop(sources: string[], targetDir: string, copy = false): DropCheck {
  if (!sources.length) return { ok: false, reason: 'nothing to move' }
  for (const src of sources) {
    if (src === targetDir) return { ok: false, reason: 'cannot drop an item onto itself' }
    if (targetDir === src || targetDir.startsWith(src + '/')) {
      return { ok: false, reason: 'cannot move a folder into itself' }
    }
    if (!copy && parentDir(src) === targetDir) {
      return { ok: false, reason: 'already in this folder' }
    }
  }
  return { ok: true }
}

/**
 * Drop a source that is redundant because an ancestor of it is also being
 * dragged — dragging a folder and a file inside it moves the folder, and moving
 * the file separately afterwards would fail or duplicate it.
 */
export function distinctRoots(rels: string[]): string[] {
  const seen = new Set<string>()
  // Original order is preserved deliberately: it is the order the rows were
  // selected in, and the caller uses the last one to decide what ends up
  // selected after the drop.
  return rels.filter((rel) => {
    if (seen.has(rel)) return false
    seen.add(rel)
    return !rels.some((other) => other !== rel && rel.startsWith(other + '/'))
  })
}

/** Where each source ends up after being dropped into `targetDir`. */
export function plannedMoves(sources: string[], targetDir: string): Array<{ from: string; to: string }> {
  return distinctRoots(sources).map((from) => {
    const name = from.includes('/') ? from.slice(from.lastIndexOf('/') + 1) : from
    return { from, to: targetDir ? `${targetDir}/${name}` : name }
  })
}

/** How long a closed folder must be hovered mid-drag before it opens.
 *  VS Code's value; short enough to feel intentional, long enough that dragging
 *  ACROSS a folder doesn't open it. */
export const DRAG_AUTO_EXPAND_MS = 500
