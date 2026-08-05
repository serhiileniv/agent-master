/**
 * Folder-path comparison for the renderer.
 *
 * Paths reach the store from three places that disagree about spelling: the OS
 * folder dialog, saved JSON from an older build, and hand-typed values. On
 * Windows `D:\repo`, `D:/repo` and `D:\repo\` are the same folder, but `===`
 * says otherwise — and dedupe checks built on `===` let the same repo open as
 * two tabs whose agents then fight over one `.spymaster-worktrees` container.
 */

/** Canonical form for comparison only — never display or pass this to the OS. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Compare two folder paths as the OS would: separator- and (on Windows)
 *  case-insensitive. Null/empty never matches, including against itself. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normPath(a) === normPath(b)
}
