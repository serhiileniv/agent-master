import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

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

  it('ships as Spy Master under the spymaster slug, consistently', () => {
    expect(pkg.name).toBe('spymaster')
    // productName drives userData, the executable and every artifact filename.
    expect(builder).toMatch(/^productName: Spy Master$/m)
    expect(builder).toMatch(/^appId: com\.serhiileniv\.spymaster$/m)
    // The update feed and the download page have to point at the same repo.
    expect(builder).toMatch(/^ {2}repo: spymaster$/m)
  })

  it('has no Monad-era identity left in the packaging', () => {
    expect(builder).not.toMatch(/monad/i)
    expect(pkg.name).not.toMatch(/monad/i)
    expect(pkg.description).not.toMatch(/monad/i)
  })

  it('points the update checker at the renamed repo', () => {
    const update = read('src/main/update.ts')
    expect(update).toContain('serhiileniv/spymaster')
    expect(update).not.toMatch(/serhiileniv\/Monad/)
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
   */
  it('gives artifacts space-free fixed names, never interpolating productName', () => {
    const names = [...builder.matchAll(/^ {2}artifactName: (.+)$/gm)].map((m) => m[1].trim())
    expect(names.length).toBeGreaterThanOrEqual(3)
    for (const n of names) {
      expect(n).not.toMatch(/\$\{productName\}/)
      // Only electron-builder's own ${arch}/${ext} placeholders may remain.
      expect(n.replace(/\$\{(arch|ext)\}/g, '')).not.toMatch(/\s/)
      expect(n).toMatch(/^SpyMaster-/)
    }
  })

  it('links the docs at the artifact names the build actually produces', () => {
    for (const f of ['README.md', 'docs/RELEASING.md']) {
      const t = read(f)
      expect(t).not.toMatch(/Spy%20Master-(macOS|Windows|Linux)/)
      expect(t).not.toMatch(/Spy[ .-]Master-(macOS|Windows|Linux)/)
    }
    expect(read('README.md')).toContain('download/SpyMaster-Windows-Setup.exe')
  })

  it('uses the real account handle, not the hyphenated one that 404s on Pages', () => {
    for (const f of ['src/main/update.ts', 'electron-builder.yml', 'README.md']) {
      expect(read(f)).not.toMatch(/serhii-leniv/i)
    }
    expect(read('src/main/update.ts')).toContain('https://serhiileniv.github.io/spymaster')
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
