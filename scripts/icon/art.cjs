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
 * Every colour is lifted from the app's own tokens in src/renderer/src/styles.css
 * so the icon and the UI are demonstrably the same product. The cigar ember is
 * --accent (#d97a68) and is the only saturated thing in the frame.
 */

/**
 * The icon is a SILHOUETTE: a near-black figure against a lit warm ground. That
 * value structure — not detail — is what makes it readable at 16px, and it is
 * why the ground is the lighter end of the app's substrate ramp rather than the
 * darker end. A dark figure on a dark tile is what the first pass got wrong.
 */
const C = {
  lampCore: '#8a6e5d', // the interrogation-lamp hotspot behind the head
  lampMid: '#4e3e37', // between --sub-4 and the hotspot
  lampEdge: '#261e1b', // a lifted --sub-4
  corner: '#151110', // corners drop below the ramp so the tile has weight

  // The figure sits a long way below the ground in value. Closing that gap is
  // what made the first two passes read as mud.
  inkLit: '#171110', // figure, upper-left facing planes
  ink: '#0c0908', // figure, base
  inkDeep: '#060505', // figure, shadow side and under the brim

  shirt: '#9c8578',
  shirtShade: '#63524a',

  cream: '#f2ece9', // --text
  creamHot: '#f7f3f1', // --ink-strong
  ember: '#d97a68', // --accent
  emberHot: '#e3907f', // --accent-2
  emberRim: '#e6a79b', // --accent-ink
  amber: '#c9924e' // --status-attention
}

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

/** Gradients, glows and the brim's cast shadow. Shared by both framings. */
function defs() {
  return `
  <!-- The ground is a lamp, not a flat fill: brightest just behind the hat, so
       the silhouette has something to be a silhouette against. -->
  <radialGradient id="tile" cx="0.5" cy="0.42" r="0.78">
    <stop offset="0" stop-color="${C.lampCore}"/>
    <stop offset="0.4" stop-color="${C.lampMid}"/>
    <stop offset="0.75" stop-color="${C.lampEdge}"/>
    <stop offset="1" stop-color="${C.corner}"/>
  </radialGradient>

  <!-- Warm cast from the ember, low and to the right. -->
  <radialGradient id="bloom" cx="0.7" cy="0.66" r="0.42">
    <stop offset="0" stop-color="${C.ember}" stop-opacity="0.26"/>
    <stop offset="0.5" stop-color="${C.ember}" stop-opacity="0.08"/>
    <stop offset="1" stop-color="${C.ember}" stop-opacity="0"/>
  </radialGradient>

  <!-- Light comes from the upper left, consistently, on every surface. The
       figure barely modulates: it is meant to read as one solid mass. -->
  <linearGradient id="hat" x1="0.12" y1="0" x2="0.8" y2="1">
    <stop offset="0" stop-color="${C.inkLit}"/>
    <stop offset="1" stop-color="${C.ink}"/>
  </linearGradient>
  <linearGradient id="brim" x1="0.12" y1="0" x2="0.7" y2="1">
    <stop offset="0" stop-color="${C.inkLit}"/>
    <stop offset="0.6" stop-color="${C.ink}"/>
    <stop offset="1" stop-color="${C.inkDeep}"/>
  </linearGradient>
  <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.inkDeep}"/>
    <stop offset="1" stop-color="#050404"/>
  </linearGradient>
  <linearGradient id="coat" x1="0.1" y1="0" x2="0.85" y2="1">
    <stop offset="0" stop-color="${C.inkLit}"/>
    <stop offset="0.55" stop-color="${C.ink}"/>
    <stop offset="1" stop-color="${C.inkDeep}"/>
  </linearGradient>
  <!-- The jaw catches just enough light to separate the chin from the coat. -->
  <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.inkDeep}"/>
    <stop offset="0.6" stop-color="#120c0b"/>
    <stop offset="1" stop-color="#2c1f19"/>
  </linearGradient>
  <linearGradient id="lens" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="${C.creamHot}"/>
    <stop offset="0.5" stop-color="${C.cream}"/>
    <stop offset="1" stop-color="#c3b6b0"/>
  </linearGradient>
  <linearGradient id="shirt" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="${C.shirt}"/>
    <stop offset="1" stop-color="${C.shirtShade}"/>
  </linearGradient>
  <linearGradient id="cigar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7d5f4f"/>
    <stop offset="1" stop-color="#3a2a23"/>
  </linearGradient>

  <radialGradient id="emberGlow">
    <stop offset="0" stop-color="${C.amber}" stop-opacity="0.85"/>
    <stop offset="0.28" stop-color="${C.ember}" stop-opacity="0.45"/>
    <stop offset="1" stop-color="${C.ember}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="emberCore">
    <stop offset="0" stop-color="#ffd9a8"/>
    <stop offset="0.45" stop-color="${C.emberHot}"/>
    <stop offset="1" stop-color="${C.ember}"/>
  </radialGradient>

  <!-- The brim throws a real shadow onto the face; this is most of why the
       icon reads as dimensional rather than as a flat sticker.
       color-interpolation-filters="sRGB" is not optional: SVG filters default to
       linearRGB, which pushed an olive cast across the whole hat. -->
  <filter id="brimCast" x="-30%" y="-30%" width="160%" height="200%" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000" flood-opacity="0.8"/>
  </filter>`
}

/**
 * The agent. Drawn bottom-anchored in a 1024 box: the coat runs off the bottom
 * edge the way a real bust portrait does, rather than floating in the middle.
 *
 * Order matters — face first, then the brim on top of it, so the brim's cast
 * shadow falls across the eyes and the face genuinely disappears into it.
 */
function figure() {
  return `
  <g>
    <!-- neck -->
    <path d="M464,640 h96 v96 q-48,26 -96,0 Z" fill="${C.inkDeep}"/>

    <!-- coat: suit shoulders, angular rather than round, running off the bottom -->
    <path d="M512,716
             C448,716 378,740 328,772
             C264,812 224,890 204,1024
             L820,1024
             C800,890 760,812 696,772
             C646,740 576,716 512,716 Z" fill="url(#coat)"/>

    <!-- Shirt as negative space in the coat, notched for the collar. A light V
         under a dark mass is what says "suit" without drawing a single button. -->
    <path d="M448,712 L512,860 L576,712 L548,694 L512,762 L476,694 Z" fill="url(#shirt)"/>
    <path d="M492,760 L532,760 L540,838 L512,864 L484,838 Z" fill="#0d0a09"/>
    <!-- rim light down the left lapel only: one light source, upper left -->
    <path d="M448,716 L512,856" stroke="${C.emberRim}" stroke-opacity="0.26" stroke-width="5"
          fill="none" stroke-linecap="round"/>

    <!-- face, then the shades, then the brim's shadow lands across both -->
    <path d="M392,440 L632,440 L632,610
             C632,660 588,690 512,690
             C436,690 392,660 392,610 Z" fill="url(#face)"/>

    <!-- cigar, clenched right of centre. Drawn before the shades so nothing
         competes with them for the brightest mark. -->
    <g>
      <path d="M556,634 L716,684" stroke="url(#cigar)" stroke-width="30" stroke-linecap="round" fill="none"/>
      <path d="M562,636 L600,648" stroke="#9a7660" stroke-width="30" opacity="0.45" fill="none"/>
      <circle cx="732" cy="689" r="96" fill="url(#emberGlow)"/>
      <circle cx="732" cy="689" r="22" fill="url(#emberCore)"/>
      <circle cx="728" cy="685" r="8" fill="#ffe6bd" opacity="0.9"/>
    </g>

    <!-- shades: the two bright marks ARE the icon at 16px, so they are the
         largest, brightest, highest-contrast thing in the frame. -->
    <g>
      <rect x="368" y="512" width="120" height="88" rx="22" fill="url(#lens)"/>
      <rect x="536" y="512" width="120" height="88" rx="22" fill="url(#lens)"/>
      <rect x="486" y="540" width="52" height="20" rx="9" fill="${C.cream}"/>
      <!-- specular streak, the same angle on both lenses -->
      <path d="M384,596 L428,516 L458,516 L414,596 Z" fill="#ffffff" opacity="0.5"/>
      <path d="M552,596 L596,516 L626,516 L582,596 Z" fill="#ffffff" opacity="0.5"/>
    </g>

    <!-- HAT. Drawn last so the brim's cast shadow falls across the face. -->
    <g filter="url(#brimCast)">
      <!-- crown, tall enough to carry the brim, with the fedora's pinch on top -->
      <path d="M292,376
               L306,190
               C310,150 336,126 370,120
               C424,166 600,166 654,120
               C688,126 714,150 718,190
               L732,376 Z" fill="url(#hat)"/>
      <!-- band -->
      <path d="M300,286 L724,286 L732,376 L292,376 Z" fill="url(#band)"/>
      <!-- Brim: the single hard horizontal the whole icon hangs on. Width is
           ~1.65x the crown — push past that and it stops being a fedora and
           starts being a flying saucer, which is what the last pass drew. -->
      <path d="M150,438
               C150,388 288,350 512,350
               C736,350 874,388 874,438
               C874,476 812,502 730,516
               C668,528 592,544 512,544
               C432,544 356,528 294,516
               C212,502 150,476 150,438 Z" fill="url(#brim)"/>
    </g>
    <!-- Rim light, one source, upper left. The brim's highlight runs only along
         the two exposed wings — carried across the middle it draws a line over
         the crown, which is in front of the brim, not behind it. -->
    <path d="M186,428 C214,398 252,376 302,362"
          stroke="${C.emberRim}" stroke-opacity="0.45" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M722,362 C772,376 810,398 838,428"
          stroke="${C.emberRim}" stroke-opacity="0.28" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M307,188 C311,150 337,127 370,121"
          stroke="${C.emberRim}" stroke-opacity="0.34" stroke-width="7" fill="none" stroke-linecap="round"/>
  </g>`
}

/** The charcoal ground plus its top-lit edge, clipped to whatever shape wraps it. */
function tileBody(clipId) {
  return `
  <g ${clipId ? `clip-path="url(#${clipId})"` : ''}>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#tile)"/>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#bloom)"/>
    ${figure()}
  </g>`
}

/**
 * Windows / Linux: full-bleed. No rounding, no inset — the OS supplies neither,
 * so anything we add here is dead space in the taskbar.
 */
function winSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${defs()}</defs>
  ${tileBody(null)}
</svg>`
}

/**
 * macOS: the artwork inside an 824px squircle on a 1024 canvas, with the soft
 * contact shadow every Mac icon carries. Everything is drawn in the same 1024
 * space and scaled down as one group, so the two icons cannot drift apart.
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
      <!-- lit top lip: the hairline that makes a Mac tile read as a solid object -->
      <path d="${squirclePath(512, 512, 1024)}" fill="none"
            stroke="#ffffff" stroke-opacity="0.10" stroke-width="6"/>
    </g>
  </g>
</svg>`
}

module.exports = { winSvg, macSvg, squirclePath, C }
