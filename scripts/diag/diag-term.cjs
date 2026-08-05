// Diagnostic: reproduce the REAL (acrylic/transparent) window, add an agent,
// screenshot it, and inspect terminal DOM.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const TMP = os.tmpdir()
const SHOT = join(os.tmpdir(), 'spymaster-shot.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    vibrancy: 'under-window',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e6e9f0', height: 44 },
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  registerIpc(() => win)

  try {
    await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  } catch (e) {
    console.log('[diag] could not load renderer:', e.message)
    process.exit(9)
  }

  const script = `(async () => {
    const store = window.__agentStore
    if (!store) return { err: 'no __agentStore' }
    store.getState().openProject({ path: ${JSON.stringify(TMP)}, name: 'diag' }, [], { isGit: false, repoRoot: null, branch: null })
    store.getState().addAgent()
    store.getState().addAgent()
    store.getState().addAgent()
    await new Promise((r) => setTimeout(r, 3500))
    // Shell detection + spawn a non-default shell (cmd) and echo through it.
    const shells = await window.api.shells.list()
    const cmdShell = shells.find((s) => s.id === 'cmd')
    let cmdEcho = null
    if (cmdShell) {
      cmdEcho = await new Promise((resolve) => {
        let buf = ''
        window.api.pty
          .spawn({ shell: cmdShell.command, args: cmdShell.args, cols: 80, rows: 24 })
          .then((pid) => {
            const off = window.api.pty.onData(pid, (d) => {
              buf += d
              if (buf.includes('HELLO_CMD')) { off(); window.api.pty.kill(pid); resolve(true) }
            })
            setTimeout(() => { off(); window.api.pty.kill(pid); resolve(buf.includes('HELLO_CMD')) }, 8000)
            window.api.pty.write(pid, 'echo HELLO_CMD\\r')
          })
      })
    }
    // Snapping math (new signature with hysteresis flags): drag 'a' left edge
    // (595) 5px from b.left (600) -> snaps to 600.
    const cs = window.__computeSnap
    const snapA = cs
      ? cs([{ id: 'a', x: 595, y: 0, w: 520, h: 360 }, { id: 'b', x: 600, y: 0, w: 520, h: 360 }], 'a', 595, 0, 1, false, false)
      : null
    const snapB = cs
      ? cs([{ id: 'a', x: 500, y: 0, w: 520, h: 360 }, { id: 'b', x: 600, y: 0, w: 520, h: 360 }], 'a', 500, 0, 1, false, false)
      : null
    const handleEl = document.querySelector('.react-flow__resize-control.rs-handle')
    const handleBg = handleEl ? getComputedStyle(handleEl).backgroundColor : null
    const vpScale = (() => {
      const t = document.querySelector('.react-flow__viewport')?.style.transform || ''
      const m = t.match(/scale\\(([0-9.]+)\\)/)
      return m ? Number(m[1]) : null
    })()
    const vp = document.querySelector('.react-flow__viewport')
    const rfRect = document.querySelector('.react-flow')?.getBoundingClientRect()
    const rects = [...document.querySelectorAll('.agent-node')].map((n) => {
      const r = n.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    })
    return {
      nodeCount: document.querySelectorAll('.agent-node').length,
      win: [window.innerWidth, window.innerHeight],
      reactFlowRect: rfRect ? { x: Math.round(rfRect.x), y: Math.round(rfRect.y), w: Math.round(rfRect.width), h: Math.round(rfRect.height) } : null,
      viewportTransform: vp ? vp.style.transform : null,
      viewportScale: vpScale,
      shells: shells.map((s) => s.label),
      cmdShellEcho: cmdEcho,
      snapNear: snapA ? { x: Math.round(snapA.x), vertical: snapA.vertical } : null,
      snapFar: snapB ? { x: Math.round(snapB.x), vertical: snapB.vertical ?? null } : null,
      resizeHandleBg: handleBg,
      cardCount: document.querySelectorAll('.agent-node__frame').length
    }
  })()`

  let r
  try {
    r = await win.webContents.executeJavaScript(script, true)
  } catch (e) {
    console.log('[diag] exec failed:', e.message)
    process.exit(8)
  }

  await new Promise((res) => setTimeout(res, 600))
  try {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(SHOT, img.toPNG())
    // Zoomed crop over the card region so detail survives downscaling.
    const crop = img.crop({ x: 180, y: 95, width: 820, height: 600 })
    fs.writeFileSync(SHOT.replace('.png', '-crop.png'), crop.toPNG())
    console.log('[diag] screenshot: ' + SHOT)
  } catch (e) {
    console.log('[diag] capture failed: ' + e.message)
  }

  console.log('[diag] ' + JSON.stringify(r))
  process.exit(0)
})

setTimeout(() => {
  console.log('[diag] TIMEOUT')
  process.exit(3)
}, 25000)
