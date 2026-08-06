/**
 * Is this pane's terminal actually on screen?
 *
 * Two states hide a pane while its agent keeps running at full speed:
 *
 *  - its workspace is a background tab (`content-visibility: hidden` on the
 *    whole layer), or
 *  - another pane in the same workspace is maximized, so this one sits behind
 *    it — also `content-visibility: hidden`, see the `:has(.is-focused)` rule
 *    in styles.css.
 *
 * In both, xterm's DOM renderer would still pay a full ANSI parse plus DOM
 * mutation for every write into a subtree the compositor skips entirely. So
 * TerminalPane buffers output while this returns false and replays it, byte for
 * byte, when the pane comes back. Nothing is dropped and nothing is throttled:
 * status detection, the bell, notifications and the work timer all read the RAW
 * pty stream, which is untouched by any of this.
 *
 * Pure and dependency-free so it can be unit-tested — vitest only collects
 * `src/**\/*.test.ts`, never `.tsx`, so logic that needs a test cannot live in
 * the component.
 */
export interface PaneVisibility {
  /** The workspace currently on screen (null before the first one opens). */
  activeWorkspaceId: string | null
  /** The workspace this pane belongs to. */
  workspaceId: string
  /** The maximized pane in THIS pane's workspace, if any. */
  focusedId: string | null
  /** This pane's agent id. */
  agentId: string
}

/** True when the pane is being painted — i.e. writes should reach xterm now. */
export function isPaneOnScreen(v: PaneVisibility): boolean {
  if (v.activeWorkspaceId !== v.workspaceId) return false
  // A maximized pane covers the stage; its siblings are skipped by the
  // compositor. The maximized pane itself is, of course, the one you're looking
  // at. With nothing maximized every pane in the active workspace is on screen.
  if (v.focusedId && v.focusedId !== v.agentId) return false
  return true
}

/**
 * Cap on buffered-but-unwritten output for an off-screen pane.
 *
 * There is deliberately NO timer alongside this: a background pane used to
 * flush every 400ms, which meant it re-rendered 2.5 times a second into a
 * surface nobody could see. The only reasons to write early are this ceiling
 * (so a runaway `yes` in a background tab can't grow the heap without bound)
 * and coming back on screen, which App drives through the flush registry.
 *
 * 256KB is far more than a terminal can show at once, so a flush at the cap
 * still ends up scrolled past — no visible content is skipped, only redundant
 * intermediate frames.
 */
export const OFFSCREEN_BUFFER_CAP = 256 * 1024
