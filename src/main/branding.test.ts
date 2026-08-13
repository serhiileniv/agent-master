import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

/**
 * App identity is spread across three files that have to agree, and the icons
 * are binaries nothing else validates. Both have a failure mode that ships
 * quietly: electron-builder derives the userData directory, the executable name
 * and every artifact filename from `productName`, so a drift here is not a
 * cosmetic bug — it is a build that installs under a different name and cannot
 * see the previous profile. A missing or wrong-sized icon PNG likewise produces
 * a successful build with a blank icon.
 *
 * Vitest runs from the repo root (vitest.config.ts lives there).
 */
const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** Width/height straight out of the PNG's IHDR chunk. */
function pngSize(rel: string): { width: number; height: number } {
  const b = readFileSync(join(ROOT, rel))
  expect(b.readUInt32BE(12)).toBe(0x49484452) // 'IHDR'
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

describe('app identity', () => {
  const builder = read('electron-builder.yml')
  const pkg = JSON.parse(read('package.json')) as { name: string; description: string }

  it('ships as Agent Master under the agentmaster slug, consistently', () => {
    expect(pkg.name).toBe('agentmaster')
    // productName drives userData, the executable and every artifact filename.
    expect(builder).toMatch(/^productName: Agent Master$/m)
    expect(builder).toMatch(/^appId: com\.serhiileniv\.agentmaster$/m)
    // The update feed and the download page have to point at the same repo.
    expect(builder).toMatch(/^ {2}repo: agentmaster$/m)
  })

  // The app has been renamed four times. Packaging is the one place where a
  // leftover old name is not cosmetic: it silently changes the userData
  // directory, the executable, or an artifact URL.
  it('has no earlier-era identity left in the packaging', () => {
    for (const old of [/monad/i, /vectro/i, /spy ?master/i]) {
      expect(builder).not.toMatch(old)
      expect(pkg.name).not.toMatch(old)
      expect(pkg.description).not.toMatch(old)
    }
  })

  it('points the update checker at the renamed repo', () => {
    const update = read('src/main/update.ts')
    expect(update).toContain('serhiileniv/agentmaster')
    expect(update).not.toMatch(/serhiileniv\/(Monad|spymaster)/i)
  })

  // The account handle is `serhiileniv`. A hyphenated `serhii-leniv` spelling
  // shipped for months and 404s: GitHub redirects a renamed *account* for repo
  // and API URLs, which is why the release feed kept working, but Pages URLs do
  // not redirect — so the in-app "Download" link was dead and nothing caught it.
  /**
   * v0.1.30 shipped broken because `artifactName` interpolated `${productName}`,
   * and the product name contains a space. Every layer sanitised it differently
   * — GitHub uploaded `Spy.Master-*`, electron-builder wrote `Spy-Master-*` into
   * latest.yml, and the docs linked `Spy%20Master-*`. Two of the three 404'd, so
   * the download links were dead and electron-updater fetched a file that did
   * not exist. Nothing failed at build time; the release just did not work.
   *
   * "Agent Master" has a space in exactly the same place, so this stays.
   */
  it('gives artifacts space-free fixed names, never interpolating productName', () => {
    const names = [...builder.matchAll(/^ {2}artifactName: (.+)$/gm)].map((m) => m[1].trim())
    expect(names.length).toBeGreaterThanOrEqual(3)
    for (const n of names) {
      expect(n).not.toMatch(/\$\{productName\}/)
      // Only electron-builder's own ${arch}/${ext} placeholders may remain.
      expect(n.replace(/\$\{(arch|ext)\}/g, '')).not.toMatch(/\s/)
      expect(n).toMatch(/^AgentMaster-/)
    }
  })

  it('links the docs at the artifact names the build actually produces', () => {
    for (const f of ['README.md', 'docs/RELEASING.md']) {
      const t = read(f)
      expect(t).not.toMatch(/Agent%20Master-(macOS|Windows|Linux)/)
      expect(t).not.toMatch(/Agent[ .-]Master-(macOS|Windows|Linux)/)
    }
    expect(read('README.md')).toContain('download/AgentMaster-Windows-Setup.exe')
  })

  it('uses the real account handle, not the hyphenated one that 404s on Pages', () => {
    for (const f of ['src/main/update.ts', 'electron-builder.yml', 'README.md']) {
      expect(read(f)).not.toMatch(/serhii-leniv/i)
    }
    expect(read('src/main/update.ts')).toContain('https://serhiileniv.github.io/agentmaster')
  })
})

describe('app icons', () => {
  // Regenerate with `npm run icons` (scripts/icon/render-icons.cjs).
  it('ships a full-bleed and a squircle master, both 1024 square', () => {
    for (const f of ['build/icon.png', 'build/icon-mac.png']) {
      expect(existsSync(join(ROOT, f))).toBe(true)
      // electron-builder needs >=512 to generate the full .ico/.icns set.
      expect(pngSize(f)).toEqual({ width: 1024, height: 1024 })
    }
  })

  it('wires the macOS master into the mac build and the full-bleed one elsewhere', () => {
    const builder = read('electron-builder.yml')
    expect(builder).toMatch(/^ {2}icon: build\/icon-mac\.png$/m)
    expect(builder).toMatch(/^ {2}icon: build\/icon\.png$/m)
  })

  it('keeps the Home hero wordmark asset the stylesheet masks with', () => {
    const wordmark = 'src/renderer/src/assets/wordmark.png'
    expect(existsSync(join(ROOT, wordmark))).toBe(true)
    const { width, height } = pngSize(wordmark)
    // The stylesheet pins aspect-ratio to these numbers so the hero cannot
    // reflow while the mask loads; if the asset is re-rendered at a different
    // size, that rule has to move with it.
    expect(read('src/renderer/src/styles.css')).toContain(`aspect-ratio: ${width} / ${height}`)
  })
})

/**
 * The artwork itself. The PNGs above only prove a file of the right size exists
 * — they would pass just as happily with the icon that was replaced here, which
 * was illegible at 16px and invisible in a dark dock. These assert the
 * properties that made the new one work, because every one of them is a mistake
 * this icon has already made once.
 */
interface Art {
  winSvg: () => string
  panes: (color?: string) => string
  PANES: number[][]
  C: Record<string, string>
}
const art = createRequire(import.meta.url)(join(ROOT, 'scripts/icon/art.cjs')) as Art

describe('icon artwork', () => {
  const mark = art.panes()
  const rects = [...mark.matchAll(/<rect\b[^>]*\/>/g)].map((m) => m[0])
  const attr = (r: string, name: string): number => Number(new RegExp(`${name}="([\\d.]+)"`).exec(r)?.[1])

  it('draws three panes with exactly one at full strength', () => {
    expect(rects).toHaveLength(3)
    // The lit pane IS the meaning: three agents, one wants you. Light every
    // pane equally and the icon says nothing the app doesn't already say.
    const lit = rects.filter((r) => /fill-opacity="1"/.test(r))
    expect(lit).toHaveLength(1)
  })

  it('carries no effect that would mush when downscaled to 16px', () => {
    // The icon this replaced was built from a drop shadow, two radial glows and
    // 7px rim strokes. That is why it survived 1024px and died in the taskbar.
    // Flat fill-opacity is fine and load-bearing — it is how the unlit panes
    // are held back. What is banned is anything the rasterizer has to blur.
    for (const banned of ['filter', 'feDropShadow', 'stroke', 'Gradient']) {
      expect(mark).not.toContain(banned)
    }
    // The Windows master is full-bleed, so it has nothing to cast a shadow onto.
    expect(art.winSvg()).not.toContain('feDropShadow')
  })

  it('puts every pane edge on a whole pixel, down to 16px', () => {
    // Laid out on a 32-unit grid, so at 16px one unit is half a pixel. Odd
    // values would land edges mid-pixel and blur exactly where legibility is
    // scarcest.
    expect(art.PANES).toHaveLength(3)
    for (const rect of art.PANES) {
      expect(rect).toHaveLength(4)
      for (const v of rect) expect(v % 2).toBe(0)
    }
  })

  it('does not stand the panes on a shared baseline', () => {
    // The guard on the mistake that cost this design a round: shapes sharing a
    // baseline at differing heights read as a column chart no matter what
    // rhythm they are given. The panes must divide the tile, not stand on it.
    const bottoms = new Set(art.PANES.map(([, y, , h]) => y + h))
    expect(bottoms.size).toBeGreaterThan(1)
  })

  it('keeps the whole mark inside the tile', () => {
    for (const [x, y, w, h] of art.PANES) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(32)
      expect(y + h).toBeLessThanOrEqual(32)
    }
    for (const r of rects) {
      expect(attr(r, 'x') + attr(r, 'width')).toBeLessThanOrEqual(1024)
      expect(attr(r, 'y') + attr(r, 'height')).toBeLessThanOrEqual(1024)
    }
  })

  it('paints itself only in colours the app itself uses', () => {
    // The icon and the UI have to be demonstrably the same product; a hex that
    // drifts out of the token set is how a brand quietly splits in two.
    const css = read('src/renderer/src/styles.css')
    for (const hex of Object.values(art.C)) {
      expect(css.toLowerCase()).toContain(hex.toLowerCase())
    }
  })
})
