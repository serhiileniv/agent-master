# Visual refresh

- **Status:** draft
- **Written:** 2026-07-21
- **Shipped in:** v0.0.0 _(fill on merge)_

> **Note, 2026-08-05 — the app was renamed to Spy Master.** "The idea" below derives this design
> from Leibniz's *monad*, and that naming rationale no longer holds. The **decisions** it produced
> are unaffected and still describe the shipped app: the warm oxblood substrate, the single accent,
> glass confined to transient surfaces, and the removal of the ambient orbs all stand on their own
> reasoning about contrast, cost, and restraint — none of them depend on the old name. Left as
> written rather than retro-fitted to a new metaphor, because rewriting the argument after the fact
> would misrepresent why these choices were made. Re-arguing the identity around the new name is
> separate work.

## Problem

Monad has no design idea. It has a collection of default treatments — frosted glass on every
persistent surface, drifting coloured orbs behind them, a saturated red on a blue-black field, a
gradient poured into the wordmark, heavy shadows under everything — and each one is the reflexive
choice rather than a decision. The result is an app that could be reskinned into any other agent
tool without anyone noticing, because nothing in it belongs specifically to this product.

The base palette is the clearest symptom. The canvas is `#0a0c10` with a `#3b5bd9` navy ambient
wash: cool blue-charcoal with a saturated accent on top, which is the default dark theme every
product ships when nobody chose one. On top of that, the accent red and the ambient navy are the
worst possible pairing on a dark ground — long and short wavelengths focus at different depths in
the eye, so the red visibly fringes and floats.

And the app is already paying to run all this. The top bar had to be made solid and the ambient orbs
had to stop moving, both because re-blurring the screen every frame cost too much. A design system
being switched off piece by piece to keep the app responsive is not a design system.

## The idea

Leibniz's *monad* is an indivisible unit that contains no parts, yet mirrors the whole universe from
its own vantage point. That is what this app is: each agent sealed in its own worktree, every one
reflecting the same repository, none able to reach into another. Leibniz's line about them —
**"monads have no windows"** — is the tension worth designing around, in an app made of panes.

Four properties, each producing one concrete decision:

| Property | Design consequence |
|---|---|
| **Sealed** — no windows, real isolation | **The seam.** Every pane edge is a doubled hairline: inner rule, a hair of bare substrate, outer rule. Not a border — a seal. This is the app's one invented geometry, and it appears on every contained surface. |
| **Reflection** — each unit mirrors one whole | **The plate.** The stage is a single composed engraved surface with indexed cells set into it, not cards floating on a field. The working screen is the signature artifact; no hero prop is needed. |
| **Harmony** — units resolve without touching | **Merge is the only earned motion.** It is rare, so it is where delight is permitted. Everything else moves as little as possible. |
| **Substance** — one material | **Warm ink.** Oxblood-black, not blue-charcoal. The red lives in the substrate rather than on top of it, so the palette is near-monochrome and coheres by construction. Engraved, never glowing. |

### The substrate

Chosen direction, to be tuned in OKLCH during Stage 1 rather than shipped as these literal hexes —
they are here to fix the intent, not the values.

```
SUBSTRATE   #14100f   #1a1514   #221b19   #2b2321
            canvas    chrome    raised    overlay

SEAM        inner  rgba(255, 240, 235, 0.06)
            outer  rgba(0, 0, 0, 0.5)

INK         #f2ece9   #b5a8a3   #8a7b76
            primary   secondary muted

ACCENT      #d97a68   a tonal step within the family, never a fill
STATUS      #7d9b6a working   #c9924e attention   #c2564a error
```

Every substrate step and every ink step sits in the same warm hue family, so the palette reads as
one material at four depths rather than as a set of colours. The accent is a lightness step inside
that family, which is why it can never fringe or float the way the old saturated red did. Status
colours are the only place genuine hue difference is permitted, because there the colour is
semantic — and each is paired with a non-colour cue so hue is never load-bearing alone.

## Behaviour

Staged so each stage ships and is reviewed on its own.

### Stage 1 — substance

1. The app's background is a warm near-black. No part of the interface is blue-tinted.
2. The drifting coloured orbs are gone. Nothing glows, blooms, or radiates anywhere in the app.
3. Surfaces are told apart by lightness and by the seam, not by shadow. Of any two adjacent
   surfaces, the nearer one is lighter.
4. Large tonal areas carry a fine grain, so no gradient or fill shows visible banding.
5. The accent no longer appears to hover in front of what it sits on. It reads as a lighter step of
   the same material rather than a different colour laid over it.
6. Status colours — working, needs attention, error — remain distinguishable from each other, and
   each is paired with a non-colour cue so colour is never the only signal.
7. No element in the app has a drop shadow bloomed evenly on all sides.

### Stage 2 — the seam and the plate

8. Every pane, menu, modal, dropdown, input and command palette carries the same doubled-hairline
   seam at its edge. Nothing in the app uses a plain single-line border.
9. The stage reads as one continuous engraved surface with panes set into it, not as cards resting
   on top of a background.
10. Each pane carries its index, set into the seam rather than floating inside the pane.
11. The frosted-glass treatment appears only on the command palette, dropdown menus, context menus
    and modals — surfaces that appear on demand and dismiss on click-away. Where it appears, it
    shows no banding, no halo behind the shape, no shadow leaking out from under it, and it does not
    visibly pop when opened or pressed.
12. Turning on the system "reduce transparency" setting replaces those surfaces with solid ones,
    without restarting the app.
13. Icons are recognisably one drawn set with a construction detail specific to this app. No icon
    sits inside a filled tile, chip or circle.
14. The wordmark is a single flat ink colour. No gradient is poured into any text in the app.

### Stage 3 — voice

15. Buttons, labels, tab names, menu items and settings rows are set in the operating system's own
    interface font — Segoe UI Variable on Windows, SF Pro on macOS.
16. The wordmark, Home screen, workspace names and modal titles are set in one self-hosted display
    face used nowhere else.
17. Monospace appears only where the content is genuinely data: terminal output, file paths, branch
    names, commit hashes. No label, button, eyebrow or caption is set in mono.
18. No text is smaller than 11px.
19. Numbers that change while you watch — agent counts, diff line counts, timers — hold their digits
    in fixed columns, so nothing beside them shifts as they count.
20. Small labels do not all share one treatment. Tracked-out uppercase appears in at most one role
    in the whole app.
21. Text never touches the edge of its container or the window.
22. No headline or display line in the app wraps onto more than two lines.

### Stage 4 — focus, motion and truth

23. Panes that are not focused recede: dimmer and less saturated. The focused pane is not ringed,
    outlined or highlighted — it is simply the one that has not receded.
24. When the app window loses focus, the whole interface desaturates, and returns when it regains
    focus.
25. Hovering a control does not change the cursor to a hand. The cursor stays an arrow except on
    links that open outside the app.
26. Interface text cannot be selected by dragging. Terminal output, file contents and inputs remain
    selectable.
27. Keyboard-initiated actions — switching pane, opening the palette, moving focus — happen with no
    animation at all.
28. No control moves, lifts, scales up or bounces on hover. Hover changes tone only.
29. Nothing in the app pulses, breathes or throbs on a loop.
30. Menus open in about 150ms, modals in about 300ms. Nothing animates for longer than 300ms.
31. Completing a merge is the one moment the app animates expressively: the seams of the merged
    panes align and resolve. It is specific to merging and appears nowhere else.
32. Focus rings follow the rounded corners of the control they mark.
33. Menus and dropdowns open on mouse-down, not on release.
34. Terminal output shows no ligatures: `--`, `==`, `->` and `!=` render as separate characters.
35. Every control that looks interactive responds when clicked. Nothing is a decorative prop.
36. Long names that do not fit are truncated with an ellipsis rather than pushing neighbours aside
    or being sliced by an edge.

## Out of scope

- Layout, tiling maths, and where things live on screen. This changes how the interface looks and
  what it is made of, not its structure.
- Terminal ANSI palettes. They should be derived from the new substrate, but that is its own spec —
  it changes how agent output reads, which is a separate review surface.
- Syntax highlighting in the file panel editor.
- The marketing site and download page. They will diverge from the app until refreshed separately.
- The `vec-` legacy class prefix. Out of scope per CONTEXT.md.

## Acceptance checks

`src/renderer/src/styles.test.ts` already lints the stylesheet as text. Most checks extend it with
the same technique, which makes them cheap and genuinely regression-proof.

| # | Check | Kind | Where |
|---|---|---|---|
| 1 | Every surface and text token's hue sits in the warm half of the wheel; none is blue-tinted | unit | `src/renderer/src/tokens.test.ts` _(new)_ |
| 2 | No `radial-gradient` orb selectors remain; no rule declares a glow (`filter: blur` or a spread-only shadow) on a non-transient element | unit | `src/renderer/src/styles.test.ts` |
| 3 | Surface token lightness increases monotonically along the elevation ramp | unit | `src/renderer/src/tokens.test.ts` |
| 4 | A grain layer is applied beneath content on every large tonal surface | unit | `src/renderer/src/styles.test.ts` |
| 5 | For all 9 accent presets, the accent's chroma sits below the saturated threshold and within the substrate's hue family | unit | `src/renderer/src/accent.test.ts` _(new)_ |
| 6 | Each status state sets a non-colour cue (glyph or text) alongside its colour | unit | `src/renderer/src/components/*.test.ts` |
| 7 | No `box-shadow` in the stylesheet is symmetric with zero Y-offset; none exceeds 10% alpha | unit | `src/renderer/src/styles.test.ts` |
| 8 | Every contained-surface selector uses the seam mixin; no rule declares a plain `border` | unit | `src/renderer/src/styles.test.ts` |
| 9, 10 | Manual — the stage reads as one plate; indices sit in the seam. **Visual, manual only.** | manual | running app |
| 11 | `backdrop-filter` appears only on the four allowlisted transient selectors | unit | `src/renderer/src/styles.test.ts` |
| 11 | Manual — glass shows no banding, halo, leak or pop. **Visual, manual only.** | manual | running app, over live terminal output |
| 12 | A `prefers-reduced-transparency` block nulls `backdrop-filter` for every allowlisted selector | unit | `src/renderer/src/styles.test.ts` |
| 13 | No icon wrapper declares a `background` or `border`; every icon shares the house stroke and the house construction detail | unit | `src/renderer/src/components/Icons.test.tsx` _(new)_ |
| 14 | No `background-clip: text` anywhere; the wordmark mask is a flat fill | unit | `src/renderer/src/styles.test.ts` |
| 15 | `--font-ui` resolves to the system stack | unit | `src/renderer/src/tokens.test.ts` |
| 16 | The display face is referenced by no selector outside the allowlisted brand surfaces | unit | `src/renderer/src/styles.test.ts` |
| 17 | `--font-mono` is referenced only by terminal, path, branch and hash selectors | unit | `src/renderer/src/styles.test.ts` |
| 18 | No `font-size` below `11px`; every value matches one of the four scale tokens | unit | `src/renderer/src/styles.test.ts` |
| 19 | Every selector showing a live count or duration declares `font-variant-numeric: tabular-nums` | unit | `src/renderer/src/styles.test.ts` |
| 20 | At most one selector combines `text-transform: uppercase` with positive `letter-spacing` | unit | `src/renderer/src/styles.test.ts` |
| 21 | Every text-bearing container declares padding on all sides | unit | `src/renderer/src/styles.test.ts` |
| 22 | Manual — no display line wraps past two lines at any window width. **Visual, manual only.** | manual | running app, narrow and ultra-wide |
| 23 | Unfocused panes reduce opacity and saturation; no focused-pane outline rule exists | unit | `src/renderer/src/styles.test.ts` |
| 24 | Window blur/focus toggles a body class with a matching desaturation rule | unit | `src/renderer/src/windowFocus.test.ts` _(new)_ |
| 25 | `cursor: pointer` appears only on external-link selectors | unit | `src/renderer/src/styles.test.ts` |
| 26 | `user-select: none` is global; terminal, file-content and input selectors re-enable it | unit | `src/renderer/src/styles.test.ts` |
| 27 | Manual — keyboard pane switching and palette open are instant. **Visual, manual only.** | manual | running app |
| 28 | No `:hover` rule declares `transform` | unit | `src/renderer/src/styles.test.ts` |
| 29 | No `infinite` animation remains except the terminal cursor | unit | `src/renderer/src/styles.test.ts` (tightens the existing lint) |
| 30 | No `transition-duration` or `animation-duration` exceeds 300ms; no `transition: all`; no transition targets `width`, `height`, `top` or `left` | unit | `src/renderer/src/styles.test.ts` |
| 31 | The merge resolution animation exists and is referenced by exactly one selector | unit | `src/renderer/src/styles.test.ts` |
| 32 | No focus style uses `outline`; focus rings are `box-shadow` | unit | `src/renderer/src/styles.test.ts` |
| 33 | Menu triggers bind `onMouseDown`, not `onClick` | unit | `src/renderer/src/components/*.test.ts` |
| 34 | The terminal grid sets `font-variant-ligatures: none`, or the mono stack leads with a non-ligature face | unit | `src/renderer/src/styles.test.ts` |
| 35 | Every rendered control with an interactive role has a bound handler | unit | `src/renderer/src/components/*.test.ts` |
| 36 | Every flex child containing truncatable text sets a zero min-width; no `clip-path` or fixed height crops a text-bearing element | unit | `src/renderer/src/styles.test.ts` |

Six manual entries, each a genuine visual judgement no assertion can stand in for. Everything else
fails loudly if the change is reverted.

**Additionally, before this spec can be marked shipped:** a point-by-point pass of the whole app
against `https://pols.dev/slop.md`, in the running window, at the pixel level — every centred
element verified as actually centred, every clipped edge zoomed into, every blur checked for banding
and leak, every interactive control clicked. Recorded in the PR body as a completed checklist.

## Terms

- **Workspace**, **Stage**, **Agent**, **Worktree** — existing, per CONTEXT.md.
- **Seam** — the doubled-hairline edge treatment carried by every contained surface. The app's one
  invented geometry. _(new)_
- **Plate** — the engraved surface the stage presents, into which panes are set as cells. _(new)_
- **Substrate** — the warm near-black base material. _(new)_
- **Transient surface** — a surface that appears on demand and dismisses on click-away: command
  palette, menu, modal. The only surfaces permitted glass. _(new)_

Note the collision between the domain term **Stage** and this document's "Stage 1–4" rollout
phases. The numbered stages belong to this spec only and must not enter the codebase vocabulary.

Add **seam**, **plate**, **substrate** and **transient surface** to `CONTEXT.md` in the implementing
PR.

## Risk

**No danger zone from CLAUDE.md is touched.** This changes the stylesheet, `theme.ts`, `accent.ts`,
the icon set, a new window-focus listener, and terminal font configuration. It does not touch
`src/main/git.ts`, worktree lifecycle, agent cwd pinning, merge onto the base branch, file-panel
path handling, `workspaces.json`, or the preload bridge / CSP.

Mandatory smokes: **none** by the danger-zone table. Run `smoke:pty` at the end of Stage 4 anyway —
the terminal font and ligature change touches terminal rendering config, and that smoke proves the
terminal still starts.

The real risk is taste, not correctness. This is a large simultaneous change to how the app looks,
and it is not reviewable in a diff. That is why it is staged: each stage is meant to be looked at in
the running app before the next begins.

Second real risk: **the display typeface is a licensing decision.** It must be self-hosted, bundled,
and license-cleared for redistribution in a signed installer. That has to be confirmed before
Stage 3, not assumed.

## Decisions

- **The name is the idea.** Leibniz's monad — the sealed unit that mirrors the whole — describes the
  app's actual architecture, so the design language is derived from it rather than applied to it.
  Every decision below traces back to one of its four properties. _(→ worth an ADR: a future
  contributor could easily "tidy away" the seam or the substrate without knowing they carry the
  idea.)_
- **The substrate moves from blue-charcoal to oxblood ink.** Cool blue-black with a saturated accent
  is the default dark theme nobody chose. Absorbing the red into the base makes the palette
  near-monochrome, which coheres by construction, and dissolves the red-on-navy fringing rather than
  managing it. Rejected alternatives: a neutral warm charcoal, which is safer under arbitrary user
  wallpapers but makes the palette two things held together by discipline rather than one thing held
  together by construction; and a green-black, which is the most distinctive of the three but
  abandons the brand red and would ripple into the logo, installer and site.
- **The accent becomes tonal.** A lighter, desaturated step of the substrate rather than a
  poster-bright fill. Status colours keep genuine hue because they are semantic, and each gains a
  non-colour cue so hue is never load-bearing alone.
- **Depth is lightness plus the seam. No shadows.** Shadows do not read on dark surfaces, and
  stacking blur, sheen, inner highlight and drop shadow was four depth cues doing one job.
- **Glass survives only on transient surfaces, and only if flawless.** It sits over live terminal
  output, which is a backdrop genuinely worth refracting — the one case where it earns its place. If
  it cannot ship without banding, halo, leak or pop, it does not ship.
- **Chrome is set in the OS interface font.** The anti-slop answer and the native-desktop answer
  coincide: `system-ui` is the one genuinely neutral choice, and it is also what makes an Electron
  app stop reading as a web page in a window.
- **The display face is self-hosted and used nowhere but brand surfaces.** A Google-shelf face
  cannot carry an identity. One face, one job.
- **Merge is the only expressive motion.** It is the rarest and most consequential action in the
  app, which is exactly where motion is earned; everywhere else, motion costs more than it returns.
- **Contrast is validated with APCA, not WCAG 2 ratios.** WCAG 2's formula degrades badly when the
  lighter colour is below `#a0a0a0` and wrongly passes a majority of pairs on dark grounds.

**Reversed from the previous draft of this spec**, on the basis of the anti-slop law:

- _Inter for chrome._ Named as the most common slop font. Replaced by `system-ui`, which is better
  on the native-feel axis too.
- _Lora retained for brand surfaces._ Google-shelf serif. Replaced by a self-hosted display face.
- _Softening the red on the existing blue-black base._ Treated a symptom. The base itself was the
  problem.

## Open questions

- [ ] **Which display face?** It must be self-hosted, license-cleared for a signed installer, and
      not from the Google shelf. Fontshare is the practical route (Sentient, Gambarino and Tanker
      are candidates with genuine character), but licensing must be verified against redistribution
      in a desktop binary, not assumed. **Blocks Stage 3.**
- [ ] **Does the warm-ink substrate hold with a user wallpaper set?** The dock and project bar
      currently sit over a user wallpaper and rely on translucency to feel part of it. Removing the
      glass changes that relationship, and the substrate change may fight arbitrary wallpapers.
      **Needs to be looked at with a wallpaper set before Stage 1 is agreed.**
- [ ] **Does the seam survive at 100% scaling on a 1080p display?** A doubled hairline with a hair of
      substrate between the rules needs roughly 3 device pixels. On a non-HiDPI screen it may
      collapse into a single fat line, which would take the app's one invented geometry with it.
      **Must be tested on real hardware before Stage 2 is agreed.**
- [ ] **What replaces the confetti burst on merge?** "The seams align and resolve" is a direction,
      not a design. Needs to be drawn before Stage 4.
- [ ] Is 11px still too small for peripheral badges at 1080p / 100% scaling?

## Notes

**Why the idea comes first.** The previous draft of this spec was a competent list of corrections —
flatten the chrome, fix the type scale, soften the accent — and it would have produced an app that
was correct and forgettable. Clean is the floor, not the achievement. The seam, the plate and the
substrate exist so that this app could not be reskinned into a competitor's, which no amount of
well-executed restraint achieves on its own.

**What is deliberately not being used.** The premium toolkit is not a checklist to run top to
bottom; using everything makes noise. Explicitly declined here: a full-bleed atmospheric hero (the
working stage is the artifact — a decorative hero would compete with it), gradient-filled icons, an
animated character-field background, scroll-authored motion (this is a desktop tool, not a page),
and a logo wall. Glass is retained in exactly one narrow role and will be cut if it cannot be
executed cleanly.

**Prior art.**

- Linear's UI redesign — collapsing 98 theme variables to three in LCH, generating elevation as
  lightness. https://linear.app/now/how-we-redesigned-the-linear-ui
- Linear's 2026 refresh — "Don't compete for attention you haven't earned."
  https://linear.app/now/behind-the-latest-design-refresh
- Radix Colors' 12-step scale — the surface/border/text vocabulary, and why borders and hovers on
  nested surfaces must be alpha.
  https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- Vercel's Web Interface Guidelines — a MUST/SHOULD/NEVER ruleset, published as a Claude Code skill.
  Worth adopting as an agent rule file independently of this spec.
  https://github.com/vercel-labs/web-interface-guidelines
- Emil Kowalski on when not to animate — the frequency matrix behind behaviour 27.
  https://emilkowal.ski/ui/you-dont-need-animations
- Raycast's technical deep dive — no pointer cursor, minimal hover, no flicker on transitions.
  https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast
- APCA — why WCAG 2 is the wrong instrument for dark UI.
  https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html
- The anti-slop design law, which governs this spec where it conflicts with any of the above.
  https://pols.dev/slop.md

**Worth revisiting later, not proposed here.** Warp's block model, where agent reasoning, diffs and
shell output flow through one list tracking only block height, not content type — the published
design to read before interleaving those three in a single scroll stream.
https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment

**Not verified.** Apple's Human Interface Guidelines pages and Linear's shipped motion values are
JavaScript-rendered and were not read directly; nothing here depends on a number from those sources
alone.
