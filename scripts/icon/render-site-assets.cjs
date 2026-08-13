'use strict'

/**
 * Renders the download site's brand assets from the same artwork as the app
 * icon, so the two can never drift. The site lives on the `gh-pages` branch, so
 * this writes into a directory you point it at rather than into the repo:
 *
 *   electron scripts/icon/render-site-assets.cjs <output-dir>
 *
 * Filenames are versioned (`-panes`) on purpose: social-unfurl caches key on the
 * image URL, so a rename is the only way to dislodge a preview still cached
 * under the old artwork. Same reason the previous assets were `-spymaster` and,
 * before those, `-monad-v2`. The gh-pages HTML has to be repointed to match.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const { join, resolve } = require('path')
const { winSvg, macSvg, ogSvg } = require('./art.cjs')

const OUT = resolve(process.argv[2] || '.')
const WORDMARK = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'wordmark.png')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

function pngSize(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32BE(12) !== 0x49484452) throw new Error(`${file}: not a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function write(name, dataUrl, w, h) {
  const file = join(OUT, name)
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
  const got = pngSize(file)
  if (got.width !== w || got.height !== h) {
    throw new Error(`${name}: expected ${w}x${h}, got ${got.width}x${got.height}`)
  }
  console.log(`[site] ${name}  ${got.width}x${got.height}`)
}

/** Rasterize an SVG at an explicit size — never the window's, which the OS clamps. */
const RASTER = `async (svg, w, h) => {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return c.toDataURL('image/png')
}`

app.whenReady().then(async () => {
  if (!fs.existsSync(OUT)) throw new Error(`output dir not found: ${OUT}`)
  const win = new BrowserWindow({ width: 480, height: 320, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body>'))
  const run = (fn, ...a) =>
    win.webContents.executeJavaScript(`(${fn})(${a.map((v) => JSON.stringify(v)).join(',')})`, true)

  try {
    write('icon-panes.png', await run(RASTER, winSvg(), 256, 256), 256, 256)

    // Header mark: the real squircle tile, not a knockout. The old mark had to
    // be flattened to cream because a dark tile disappeared into the dark bar —
    // terracotta was chosen precisely so it does not, so the site can show the
    // icon the user is about to download rather than a stand-in for it.
    write('logo-mark-panes.png', await run(RASTER, macSvg(), 512, 512), 512, 512)

    // Social card. The wordmark is embedded as a data URI because an SVG loaded
    // into an <img> cannot reach out to a sibling file.
    const wm = 'data:image/png;base64,' + fs.readFileSync(WORDMARK).toString('base64')
    write('og-image-panes.png', await run(RASTER, ogSvg(wm), 2400, 1260), 2400, 1260)
  } catch (e) {
    console.error('[site] FAILED: ' + (e && e.message ? e.message : e))
    process.exit(1)
  }

  console.log('[site] done -> ' + OUT)
  process.exit(0)
})

setTimeout(() => {
  console.error('[site] TIMEOUT')
  process.exit(3)
}, 60000)
