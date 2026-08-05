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
    expect(update).toContain('Serhii-Leniv/spymaster')
    expect(update).not.toMatch(/Serhii-Leniv\/Monad/)
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
