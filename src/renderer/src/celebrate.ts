/**
 * The merge moment.
 *
 * Merging is the rarest and most consequential thing that happens in this app —
 * it is the only path that lands an agent's work on the user's real branch — so
 * it is the one place expressive motion is earned. Everywhere else, motion in a
 * tool used hundreds of times a day costs more than it returns.
 *
 * What it shows is what a merge IS rather than a generic celebration. Two lines
 * of work ran in isolation, never touching, and now resolve into one: so two
 * hairlines travel in from opposite edges and meet, the seam closing. It reads
 * as harmony rather than applause, and it is drawn in the app's own accent
 * rather than in party colours.
 *
 * This replaced a 26-particle confetti burst that used five colours, three of
 * which (a cyan, a purple, a yellow) appeared nowhere else in the interface.
 *
 * Pure DOM plus a compositor-only transform animation, removed once it has run,
 * and suppressed entirely under prefers-reduced-motion — see `.merge-seal` in
 * styles.css.
 */
export function celebrate(): void {
  const host = document.createElement('div')
  host.className = 'merge-seal'

  // Two halves of one line. They are separate elements rather than one scaling
  // element because a seam is two rules meeting, not one rule growing.
  host.appendChild(document.createElement('i'))
  host.appendChild(document.createElement('i'))

  document.body.appendChild(host)

  // Comfortably past the 300ms animation so the node is gone before anything
  // else could re-trigger it, without the removal itself being visible.
  setTimeout(() => host.remove(), 600)
}
