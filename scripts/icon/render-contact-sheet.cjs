'use strict'

/**
 * Review tool, not part of the build. Draws the icon from art.cjs at every size
 * that matters, on a dark ground and a light one, plus the macOS framing:
 *
 *   electron scripts/icon/render-contact-sheet.cjs <output-dir>
 *
 * It writes a single PNG and touches nothing in build/, so artwork can be judged
 * before anything the app ships is replaced. This is what settled the current
 * design: an earlier candidate looked fine described in prose and was obviously
 * a bar chart the moment it was rendered next to itself at four sizes.
 *
 * The small sizes are downsampled from the 1024 render rather than rasterized
 * fresh at 32px, because that is what actually happens: electron-builder derives
 * the .ico's seven sizes from build/icon.png. Rasterizing the SVG directly at
 * 32px would flatter the design by giving it detail the shipped icon never has.
 *
 * Same explicit-canvas rule as render-icons.cjs — nothing is captured from the
 * window, whose size the OS clamps to the display work area.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const { join, resolve } = require('path')
const { winSvg, macSvg } = require('./art.cjs')

const OUT = resolve(process.argv[2] || '.')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const SHEET = `async (winSvgText, macSvgText) => {
  const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)

  // Rasterize once at 1024, then scale THAT down for every preview size,
  // mirroring how the shipped .ico is derived.
  const master = async (svg) => {
    const img = new Image()
    img.src = svgUrl(svg)
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 1024; c.height = 1024
    const x = c.getContext('2d')
    x.imageSmoothingEnabled = true
    x.imageSmoothingQuality = 'high'
    x.drawImage(img, 0, 0, 1024, 1024)
    return c
  }

  const winArt = await master(winSvgText)
  const macArt = await master(macSvgText)

  const W = 1100
  const BAND = 360
  const H = 74 + BAND * 3

  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.textBaseline = 'middle'

  const band = (y, h, fill) => { g.fillStyle = fill; g.fillRect(0, y, W, h) }
  const text = (s, x, y, fill, font, align) => {
    g.fillStyle = fill
    g.font = font
    g.textAlign = align
    g.fillText(s, x, y)
  }
  const CAP = '600 20px ui-sans-serif, Segoe UI, system-ui, sans-serif'
  const TAG = '600 15px ui-monospace, Consolas, monospace'

  // One 256px tile on the left, then the sizes it really lives at, on a shared
  // baseline so the falloff is directly comparable.
  const row = (art, y, ink, dim) => {
    g.drawImage(art, 60, y + 60, 256, 256)
    text('256', 188, y + 336, dim, TAG, 'center')
    const SIZES = [128, 64, 32, 16]
    const base = y + 60 + 256
    let x = 400
    for (const s of SIZES) {
      g.drawImage(art, Math.round(x), Math.round(base - s), s, s)
      text(String(s), Math.round(x + s / 2), y + 336, dim, TAG, 'center')
      x += s + 46
    }
    void ink
  }

  const DARK = '#17171a'
  const LIGHT = '#ffffff'
  const GREY = '#3a3a3e'

  band(0, 74, '#0e0e10')
  text('SPY MASTER - app icon at every size it ships at', W / 2, 37, '#e9e4e1', CAP, 'center')

  let y = 74
  band(y, BAND, DARK)
  text('on a dark taskbar', 60, y + 34, '#8d8781', CAP, 'left')
  row(winArt, y, '#e9e4e1', '#8d8781')

  y += BAND
  band(y, BAND, LIGHT)
  text('on a white page', 60, y + 34, '#77706b', CAP, 'left')
  row(winArt, y, '#1a1514', '#77706b')

  y += BAND
  band(y, BAND, GREY)
  text('macOS squircle framing', 60, y + 34, '#c9c4c0', CAP, 'left')
  row(macArt, y, '#e9e4e1', '#c9c4c0')

  return c.toDataURL('image/png')
}`

app.whenReady().then(async () => {
  if (!fs.existsSync(OUT)) throw new Error(`output dir not found: ${OUT}`)

  const win = new BrowserWindow({ width: 480, height: 320, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body>'))

  try {
    const url = await win.webContents.executeJavaScript(
      `(${SHEET})(${JSON.stringify(winSvg())},${JSON.stringify(macSvg())})`,
      true
    )
    const file = join(OUT, 'icon-contact-sheet.png')
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
    console.log(`[sheet] ${file}`)
  } catch (e) {
    console.error('[sheet] FAILED: ' + (e && e.message ? e.message : e))
    process.exit(1)
  }

  process.exit(0)
})

setTimeout(() => {
  console.error('[sheet] TIMEOUT')
  process.exit(3)
}, 60000)
