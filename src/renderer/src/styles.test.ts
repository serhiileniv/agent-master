import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// styles.css is the whole design system, and a custom property that references
// itself is invalid at computed-value time — the browser drops it silently, and
// takes the ENTIRE declaration with it. `--shadow-pop: var(--shadow-pop)` shipped
// that way: every modal, menu, palette, confirm and the review panel lost both its
// drop shadow AND the `--glass-specular` highlight sharing the same box-shadow,
// so they rendered as flat rectangles in the default dark theme. Light was fine,
// which is why it survived. There is no build error for this — only these tests.
// Read from disk rather than importing: the point is to inspect the authored CSS
// text, and under jsdom `import.meta.url` is not a file: URL. vitest runs from the
// repo root.
const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** Every `--name: value` declaration in the sheet, in source order. */
function declarations(): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = []
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) out.push({ name: m[1], value: m[2].trim() })
  return out
}

/** The base (dark) `:root` block — not the `:root[data-theme=…]` overrides. */
function baseRoot(): string {
  const m = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  if (!m) throw new Error('could not locate the base :root block in styles.css')
  return m[1]
}

/** Every `selector { … }` rule in the sheet, as [selector, body] pairs. */
function rules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] })
  return out
}

// An endlessly-animating element under backdrop-filtered chrome is the app's
// dominant GPU cost: every frame it moves, the glass above it re-blurs, at
// Retina 2x, forever. powerIdle.ts stamps is-blurred/is-hidden/is-idle so CSS
// can freeze that motion — but the pause list is plain text that silently stops
// matching when markup is reworked, with no build error and no visible symptom.
// That is exactly what happened: the Home hero became `.home__wordmark` and the
// pause list kept naming `.empty__card > img`, an element that no longer
// existed, so of 15 infinite animations only the aurora actually paused.
describe('animation power coverage', () => {
  // Functional "come look at me" cues, deliberately still animating while the
  // window is merely unfocused or idle — they pause only when truly invisible.
  // Plus genuinely transient states (a spinner is on screen for a moment).
  const ALLOWED = ['attention-breathe', 'badge-pulse', 'dot-pulse', 'modal-spin', 'overlay-in']

  it('pauses every endless decorative animation when nobody is watching', () => {
    const pausedSelectors = rules()
      .filter((r) => /animation-play-state\s*:\s*paused/.test(r.body))
      .map((r) => r.selector)
      .join(' ')

    const uncovered = rules()
      .filter((r) => /animation:[^;]*\binfinite\b/.test(r.body))
      .filter((r) => !ALLOWED.some((name) => new RegExp(`animation:[^;]*\\b${name}\\b`).test(r.body)))
      // Covered when the pause list names any class from the selector. Not
      // `every`: the cursor rule legitimately lists sibling classes
      // (.xterm-cursor-block/-bar/-underline) that share one paused animation.
      //
      // Limitation worth stating: this catches an animation nothing pauses, not
      // an animation whose selector has quietly stopped matching any markup —
      // which is the form the original regression took. Catching that needs
      // cross-referencing the .tsx files, and is not attempted here.
      .filter((r) => {
        const classes = r.selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []
        return !classes.some((c) => pausedSelectors.includes(c))
      })
      .map((r) => r.selector)

    expect(uncovered).toEqual([])
  })

  // The aurora sits directly under the glass, so drifting it was the single
  // most expensive thing in the app. Held still it is painted once and never
  // repainted — the look survives, the cost does not.
  it('keeps the aurora orbs static', () => {
    const orbs = rules().filter((r) => /\.aurora__orb/.test(r.selector))
    expect(orbs.length).toBeGreaterThan(0)
    for (const r of orbs) {
      expect(r.body, `${r.selector} must not animate`).not.toMatch(/animation:/)
      // will-change on a static element pins a compositor layer for nothing.
      expect(r.body, `${r.selector} must not pin a layer`).not.toMatch(/will-change/)
    }
  })

  // With the window opaque there is no OS backdrop behind the body veil, so the
  // semi-transparent scene would wash out to near-flat black. The override has
  // to restate both layers at full strength.
  it('paints a solid scene when the window is opaque', () => {
    const rule = rules().find((r) => /body\.is-opaque-window/.test(r.selector))
    expect(rule, 'no body.is-opaque-window rule found').toBeTruthy()

    const grad = rule!.body.match(/linear-gradient\(([^)]*)\)/)
    expect(grad, 'opaque scene must restate the base linear-gradient').toBeTruthy()
    // An angle followed by a comma. `linear-gradient(180deg: …)` is invalid, and
    // a browser drops the ENTIRE declaration for one bad token — silently, with
    // no build error, leaving the body with no background at all.
    expect(grad![1]).toMatch(/^\s*\d+deg\s*,/)
    // The base layer must be opaque; an rgba() with alpha here is the bug.
    expect(grad![1]).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/)
  })

  // `filter` is not a paint tweak — it forces the element into its own render
  // pass and runs a shader over the whole surface every time its content
  // repaints. On a terminal full of streaming agent output that is "constantly",
  // and it was applied to EVERY unselected pane plus (while the app sat in the
  // background) the entire window. Both were replaced by scrims, which the
  // compositor blends during the normal draw. Panes and the app root are the
  // two high-traffic surfaces; a filter on transient chrome is still fine.
  it('never filters a surface that repaints with terminal output', () => {
    const hot = rules()
      .filter((r) => /\.vec-pane\b|(^|[\s,])\.app(?![\w-])/.test(r.selector))
      // `backdrop-filter` samples what is BEHIND and is a separate,
      // deliberately-scoped decision (see the has-wallpaper rules).
      .filter((r) => /(^|[^-])\bfilter\s*:/.test(r.body.replace(/-webkit-backdrop-filter/g, '')))
      .filter((r) => !/filter\s*:\s*none/.test(r.body))
      .map((r) => r.selector)
    expect(hot).toEqual([])
  })

  // Panes behind a maximized one are invisible at 10% opacity, but xterm kept
  // parsing and mutating the DOM for all of them and the compositor kept
  // drawing them. Skipping the subtree is what makes maximize — the mode people
  // actually work in — stop costing nine terminals to show one.
  it('skips the panes hidden behind a maximized one', () => {
    const rule = rules().find(
      (r) => /:has\(\.vec-pane\.is-focused\)/.test(r.selector) && /:not\(\.is-focused\)/.test(r.selector)
    )
    expect(rule, 'no rule targets the siblings of a maximized pane').toBeTruthy()
    expect(rule!.body).toMatch(/content-visibility\s*:\s*hidden/)
  })

  // The cursor pause rule named `.xterm-cursor-blink`, a class xterm only adds
  // when its OWN cursorBlink option is on — and it is off, because the blink is
  // ours. So the rule matched nothing and the pause never fired. It has to name
  // the same elements the animation does.
  it('pauses the cursor blink with the selectors the animation actually uses', () => {
    const blinkRule = rules().find((r) => /animation:[^;]*vec-cursor-blink/.test(r.body))
    expect(blinkRule, 'no rule runs the vec-cursor-blink animation').toBeTruthy()
    const animated = new Set(blinkRule!.selector.match(/\.xterm-cursor-[a-z]+/g) ?? [])
    expect(animated.size).toBeGreaterThan(0)

    const paused = rules()
      .filter((r) => /animation-play-state\s*:\s*paused/.test(r.body))
      .map((r) => r.selector)
      .join(' ')
    for (const cls of animated) {
      expect(paused, `${cls} blinks but is never paused`).toContain(cls)
    }
  })

  // A full-viewport blend mode forces everything beneath it into a compositing
  // group, so every terminal write pays an extra full-screen pass.
  it('has no full-viewport blend layer', () => {
    const blended = rules()
      .filter((r) => /mix-blend-mode\s*:\s*(overlay|soft-light|hard-light|color-dodge)/.test(r.body))
      .filter((r) => /position\s*:\s*fixed/.test(r.body) && /inset\s*:\s*0/.test(r.body))
      .map((r) => r.selector)
    expect(blended).toEqual([])
  })
})

describe('design tokens', () => {
  it('never defines a custom property in terms of itself', () => {
    // The lookahead matters: `\b` would let `--accent` match its own longer
    // sibling `--accent-rgb`, since a hyphen counts as a word boundary.
    const cycles = declarations()
      .filter((d) => new RegExp(`var\\(\\s*${d.name}(?![\\w-])`).test(d.value))
      .map((d) => `${d.name}: ${d.value}`)
    expect(cycles).toEqual([])
  })

  // The + dropdown carries BOTH classes (`rail__menu tabbar__menu`). They were
  // equally specific, so source order picked the winner — and .rail__menu sits
  // ~1300 lines later, which meant every anchoring override in .tabbar__menu was
  // silently dropped. The menu took the rail's `left` (opening beside the dock
  // instead of under the +) and its `bottom: 0`, pinning both edges of an
  // absolutely positioned box so it was sized by the gap between them rather
  // than by its content — it rendered as a collapsed black slab over the stage.
  // Nothing else catches this: the CSS is valid and the build is silent.
  it('lets the tabbar dropdown out-specify the rail menu chrome it reuses', () => {
    const tabbar = css.match(/^([^\n{]*tabbar__menu[^\n{]*)\{/m)
    expect(tabbar, 'no rule targets .tabbar__menu any more').toBeTruthy()
    const selector = tabbar![1]
    const shared = ['bottom', 'left', 'min-width']

    // Either it out-specifies .rail__menu, or it is authored after it. Anything
    // else and these declarations lose again.
    const qualified = /\.rail__menu\s*\.?tabbar__menu|\.rail__menu\.tabbar__menu/.test(selector)
    const later = css.indexOf(selector) > css.indexOf('\n.rail__menu {')
    expect(
      qualified || later,
      `"${selector.trim()}" ties with .rail__menu but is authored before it, so ${shared.join('/')} are ignored`
    ).toBe(true)
  })

  // The dark theme is the default, so a token missing here is what users see.
  it('gives the floating-chrome shadows a real value in the dark base', () => {
    const root = baseRoot()
    for (const token of ['--shadow-pop', '--shadow-menu']) {
      const m = root.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
      expect(m, `${token} is not defined in the base :root`).toBeTruthy()
      // A shadow, not a var() indirection that could go stale again.
      expect(m![1]).toMatch(/^\d/)
    }
  })
})
