'use strict'

/**
 * The Spy Master app icon, authored as SVG so it stays editable and
 * re-renderable rather than living as an opaque PNG. `npm run icons` rasterizes
 * what is built here into build/icon.png (Windows/Linux) and build/icon-mac.png.
 *
 * Two framings, one drawing:
 *   • Windows/Linux — full-bleed square. Windows 11 neither rounds nor insets
 *     app icons, so any margin we add is margin the user sees as wasted space.
 *   • macOS — the artwork inside Apple's icon grid: an 824x824 squircle centred
 *     on a 1024 canvas, leaving the ~100px margin every native Mac icon has.
 *
 * THE MARK: a tiled workspace. One full-height pane at full strength beside a
 * column split in two, held back — three agents running in parallel, and the one
 * that wants you is the bright one. That is the product's differentiator, so
 * that is what the icon draws. It replaces a fedora-and-shades figure, which was
 * a character portrait: a category signal for games and privacy apps, not for a
 * tool that runs coding agents.
 *
 * WHY THE PANES DIVIDE THE TILE RATHER THAN STAND ON IT. An earlier pass drew
 * three panes bottom-aligned on a shared baseline at different heights, and
 * rendering it settled the question — shapes sharing a baseline at varying
 * heights are a column chart, whatever rhythm you give them. Carving the tile up
 * instead removes the baseline, and it is a truer picture of the app anyway: a
 * tiled canvas is a space divided, not bars on a floor.
 *
 * WHY THE GROUND IS THE SATURATED THING. The previous icon was a dark figure on
 * a dark tile, which in the dark Dock and taskbar every developer runs had
 * nothing to be seen against. An icon has to work on ANY background — white,
 * black, photographic. --accent is mid-luminance, so it clears both ends;
 * neither the old charcoal nor a cream tile does.
 *
 * WHY THERE ARE NO EFFECTS. Drop shadows, glows and fractional strokes do not
 * survive being downscaled to 16px — they were most of what the old icon was
 * built from, and they are why it mushed. The only soft thing here is one
 * diagonal gradient on the ground, plus the contact shadow macOS tiles carry,
 * which sits under the tile rather than inside the mark.
 */

/** Every value is a token from src/renderer/src/styles.css. */
const C = {
  groundLit: '#e3907f', // --accent-2, upper left
  ground: '#d97a68', // --accent
  groundDeep: '#b35f4f', // --accent-active, lower right
  pane: '#f2ece9', // --text
  cream: '#f2ece9', // alias: the monochrome mark's colour
  sub1: '#14100f', // --sub-1, the og card's ground
  sub2: '#1a1514', // --sub-2
  sub4: '#2b2321', // --sub-4
  accentInk: '#e6a79b' // --accent-ink, the og tagline
}

/**
 * The drawing is laid out on a 32-unit grid and scaled up, rather than drawn at
 * 1024 and scaled down. At 16px one unit is half a pixel, so keeping every
 * position and dimension EVEN puts every edge of every pane on a whole pixel at
 * 16, 32, 64, 128, 256, 512 and 1024 alike. That is the entire reason the left
 * pane is 10 units wide and not 9 or 11.
 */
const U = 32
const S = 1024 / U // 32px per unit

/**
 * The mark, as [x, y, w, h] in grid units. A 4-unit margin all round; a 2-unit
 * gutter between the panes, matching the gap between real panes on the canvas.
 * PANES[LIT] is the agent at full strength — it is first in the list because it
 * is leftmost, which is where the eye lands.
 */
const PANES = [
  [4, 4, 10, 24], // the watched agent: full height
  [16, 4, 12, 10], // behind it, upper
  [16, 16, 12, 12] // behind it, lower
]
const LIT = 0
const HELD = 0.6 // the unlit panes, so "needs you" reads as brightness
const RADIUS = 2 // units

/**
 * Apple's icon corner is a continuous-curvature squircle, not a rounded rect —
 * the difference is small per-corner and very visible once the icon sits in a
 * Dock next to real ones. Sampling the superellipse |x/a|^n + |y/b|^n = 1 at
 * n=5 lands within a pixel of Apple's shape, and 240 points is far past the
 * resolution of a 1024px render.
 */
function squirclePath(cx, cy, size, n = 5, steps = 240) {
  const a = size / 2
  const p = 2 / n
  const pt = (t) => {
    const ct = Math.cos(t)
    const st = Math.sin(t)
    const x = cx + a * Math.sign(ct) * Math.pow(Math.abs(ct), p)
    const y = cy + a * Math.sign(st) * Math.pow(Math.abs(st), p)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const pts = []
  for (let i = 0; i < steps; i++) pts.push(pt((i / steps) * Math.PI * 2))
  return `M${pts.join('L')}Z`
}

/** The one gradient in the icon: upper-left lit, lower-right deep. */
function defs() {
  return `
  <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.groundLit}"/>
    <stop offset="0.5" stop-color="${C.ground}"/>
    <stop offset="1" stop-color="${C.groundDeep}"/>
  </linearGradient>`
}

/**
 * The mark. Three rounded rects and nothing else — no filter, no stroke, no
 * gradient. That is what lets it be rasterized to 16px without losing anything,
 * and branding.test.ts asserts exactly that about this function's output.
 *
 * `color` overrides the pane fill for the monochrome mark; the held-back panes
 * keep their opacity either way, because losing that loses the "one of these
 * wants you" reading that is the whole point of the drawing.
 */
function panes(color = C.pane) {
  const out = PANES.map(([x, y, w, h], i) => {
    // Never let the radius eat a pane: a rect rounded past half its short side
    // stops being a pane and becomes a pill.
    const rx = Math.min(RADIUS, w / 2, h / 2) * S
    const o = i === LIT ? 1 : HELD
    return `<rect x="${x * S}" y="${y * S}" width="${w * S}" height="${h * S}" rx="${rx}" fill="${color}" fill-opacity="${o}"/>`
  })
  return `
  <g>
    ${out.join('\n    ')}
  </g>`
}

/** The terracotta ground plus the mark, clipped to whatever shape wraps it. */
function tileBody(clipId) {
  return `
  <g ${clipId ? `clip-path="url(#${clipId})"` : ''}>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#ground)"/>
    ${panes()}
  </g>`
}

/**
 * Windows / Linux: full-bleed. No rounding, no inset — the OS supplies neither,
 * so anything we add here is dead space in the taskbar. No contact shadow
 * either: Windows does not composite icons as objects sitting on a surface.
 */
function winSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${defs()}</defs>
  ${tileBody(null)}
</svg>`
}

/**
 * macOS: the artwork inside an 824px squircle on a 1024 canvas, with the soft
 * contact shadow every Mac icon carries. The shadow is under the TILE, not
 * inside the mark, so it costs the mark nothing when the icon is scaled down.
 * Everything is drawn in the same 1024 space and scaled down as one group, so
 * the two icons cannot drift apart.
 */
function macSvg() {
  const size = 824
  const inset = (1024 - size) / 2 // 100
  const scale = size / 1024
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${defs()}
    <clipPath id="squircle">
      <path d="${squirclePath(512, 512, 1024)}"/>
    </clipPath>
    <filter id="dock" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <g filter="url(#dock)">
    <g transform="translate(${inset},${inset}) scale(${scale})">
      ${tileBody('squircle')}
    </g>
  </g>
</svg>`
}

/**
 * Single-colour mark on transparent, for places that need the shape without the
 * tile. Note the download site's header no longer uses this: the terracotta tile
 * was chosen precisely because it reads on a dark bar, so the site shows the
 * real icon rather than a flattened stand-in.
 *
 * No mask is needed any more. The old figure required one to punch the shades
 * out of a silhouette; three panes are already their own shape.
 */
function knockoutSvg(color = '#ffffff') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${panes(color)}
</svg>`
}

/**
 * The social card. Rendered at 2x the 1200x630 unfurl size; because this goes
 * through a canvas of an explicit size rather than a window capture, it is not
 * clamped by the display the way the previous og-image was (which is why that
 * one ended up 1800px wide instead of a clean multiple).
 *
 * The card's ground is the app's substrate, and the icon sits on it as the real
 * squircle tile — the terracotta is the thing that should catch the eye in a
 * feed, so it is shown as it actually ships rather than knocked out to cream.
 */
function ogSvg(wordmarkDataUrl) {
  const W = 2400
  const H = 1260
  const tile = 460
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${defs()}
    <radialGradient id="card" cx="0.5" cy="0.44" r="0.85">
      <stop offset="0" stop-color="${C.sub4}"/>
      <stop offset="0.55" stop-color="${C.sub2}"/>
      <stop offset="1" stop-color="${C.sub1}"/>
    </radialGradient>
    <clipPath id="ogSquircle">
      <path d="${squirclePath(512, 512, 1024)}"/>
    </clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#card)"/>
  <g transform="translate(${W / 2 - tile / 2},150) scale(${tile / 1024})">
    ${tileBody('ogSquircle')}
  </g>
  <image href="${wordmarkDataUrl}" x="${W / 2 - 620}" y="700" width="1240" height="257"/>
  <text x="${W / 2}" y="1085" text-anchor="middle" fill="${C.accentInk}"
        font-family="Georgia, serif" font-size="58" font-style="italic">
    Run your AI coding agents in parallel
  </text>
</svg>`
}

module.exports = { winSvg, macSvg, knockoutSvg, ogSvg, panes, squirclePath, C, PANES }
