'use strict'

/**
 * Rasterizes the Agent Master icon (scripts/icon/art.cjs) into the PNGs that
 * electron-builder and the README consume. Run with `npm run icons`.
 *
 * Why a canvas inside the page rather than capturePage(): a BrowserWindow is
 * clamped to the display's work area, so a 1024px window on a 1080p screen may
 * silently come back smaller — exactly the trap the og-image render hit, which
 * is why that asset ended up 1800px wide instead of 2400. Drawing into a canvas
 * of an explicit size and reading it back with toDataURL() makes the output
 * dimensions a property of the code, not of whatever monitor is attached.
 *
 * electron-builder converts these PNGs to .ico (7 sizes) and .icns itself at
 * package time, so no .ico/.icns is committed.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const { join } = require('path')
const { winSvg, macSvg } = require('./art.cjs')

const BUILD = join(__dirname, '..', '..', 'build')
const FONTS = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'fonts')
const WORDMARK_OUT = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'wordmark.png')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

/** Reads a PNG's IHDR. The whole point of this script is that these match. */
function pngSize(file) {
  const b = fs.readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) throw new Error(`${file}: not a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function write(file, dataUrl, expectW, expectH) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
  const got = pngSize(file)
  if (got.width !== expectW || got.height !== expectH) {
    throw new Error(`${file}: expected ${expectW}x${expectH}, got ${got.width}x${got.height}`)
  }
  console.log(`[icons] ${file.replace(/.*[\\/]/, '')}  ${got.width}x${got.height}`)
}

/** Rasterize one SVG string at `size`, plus any extra downscales requested. */
const RASTER = `async (svg, sizes) => {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const out = {}
  for (const s of sizes) {
    const c = document.createElement('canvas')
    c.width = s; c.height = s
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, s, s)
    ctx.drawImage(img, 0, 0, s, s)
    out[s] = c.toDataURL('image/png')
  }
  return out
}`

/**
 * The Home hero wears the wordmark as a CSS mask, so this only needs alpha —
 * white text on transparent. Set in Lora, the display face the app already
 * bundles and the face the previous wordmark's outlines were traced from, so
 * this is the same letterforms rather than a substitute. Measured and cropped
 * tight in-page, because the mask is sized by aspect-ratio in CSS.
 */
const WORDMARK = `async (fontB64, text) => {
  const face = new FontFace('WordmarkLora', 'url(data:font/woff2;base64,' + fontB64 + ')', { weight: '400 700' })
  await face.load()
  document.fonts.add(face)
  await document.fonts.ready

  const px = 400
  const font = '600 ' + px + 'px WordmarkLora'
  // Canvas falls back to a system face silently if the @font-face never landed,
  // which would ship a wordmark set in Arial and look like nothing was wrong.
  if (!document.fonts.check(font)) throw new Error('Lora did not load; refusing to render a fallback face')
  const m = document.createElement('canvas').getContext('2d')
  m.font = font
  const t = m.measureText(text)
  const pad = Math.round(px * 0.06)
  const w = Math.ceil(t.actualBoundingBoxLeft + t.actualBoundingBoxRight) + pad * 2
  const h = Math.ceil(t.actualBoundingBoxAscent + t.actualBoundingBoxDescent) + pad * 2

  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  ctx.font = font
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, pad + t.actualBoundingBoxLeft, pad + t.actualBoundingBoxAscent)
  return { url: c.toDataURL('image/png'), w, h }
}`

app.whenReady().then(async () => {
  // Size is irrelevant — nothing is captured from the window itself.
  const win = new BrowserWindow({ width: 480, height: 320, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body>'))

  const run = (fn, ...args) =>
    win.webContents.executeJavaScript(`(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`, true)

  try {
    const winIcon = await run(RASTER, winSvg(), [1024, 256])
    write(join(BUILD, 'icon.png'), winIcon[1024], 1024, 1024)
    write(join(BUILD, 'icon-256.png'), winIcon[256], 256, 256)

    const macIcon = await run(RASTER, macSvg(), [1024])
    write(join(BUILD, 'icon-mac.png'), macIcon[1024], 1024, 1024)

    const lora = fs.readFileSync(join(FONTS, 'lora-var.woff2')).toString('base64')
    const wm = await run(WORDMARK, lora, 'Agent Master')
    write(WORDMARK_OUT, wm.url, wm.w, wm.h)
    console.log(`[icons] wordmark aspect-ratio: ${wm.w} / ${wm.h}`)
  } catch (e) {
    console.error('[icons] FAILED: ' + (e && e.message ? e.message : e))
    process.exit(1)
  }

  console.log('[icons] done')
  process.exit(0)
})

setTimeout(() => {
  console.error('[icons] TIMEOUT')
  process.exit(3)
}, 60000)
