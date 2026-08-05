// Diagnostic for the Moveable/Selecto stage: render cards, select one (so
// Moveable shows handles), screenshot, and report DOM state + console errors.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const TMP = os.tmpdir()
const SHOT = join(os.tmpdir(), 'spymaster-shot.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: '#0a1018',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e6e9f0', height: 40 },
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  registerIpc(() => win)
  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))

  const script = `(async () => {
    const store = window.__agentStore
    if (!store) return { err: 'no store' }
    const g = () => store.getState()
    g().openProject({ path: ${JSON.stringify(TMP)}, name: 'diag' }, null, { isGit: false, repoRoot: null, branch: null })
    g().addAgent(); g().addAgent()
    await new Promise(r => setTimeout(r, 3500))
    g().arrangeGrid()
    await new Promise(r => setTimeout(r, 300))
    const panes = document.querySelectorAll('.vec-pane').length
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const id0 = g().agents[0].id
    g().renameAgent(id0, 'Renamed')
    const renamed = g().agents[0].label === 'Renamed'
    g().addAgent({ command: 'echo hi' })
    const hasStartup = g().agents[g().agents.length - 1].startupCommand === 'echo hi'
    g().focusTerminal(id0)
    const focused = g().focusedId === id0
    g().clearFocus()
    const unfocused = g().focusedId === null
    // command palette
    g().setPaletteOpen(true)
    await new Promise(r => setTimeout(r, 500))
    const paletteStateOpen = g().paletteOpen
    const modal = !!document.querySelector('.modal')
    const paletteOpen = !!document.querySelector('.palette')
    const paletteItems = document.querySelectorAll('.palette__item').length
    return { panes, accent, renamed, hasStartup, focused, unfocused, paletteStateOpen, modal, paletteOpen, paletteItems }
  })()`

  let r
  try {
    r = await win.webContents.executeJavaScript(script, true)
  } catch (e) {
    console.log('[diag] exec failed: ' + e.message)
    process.exit(8)
  }

  await new Promise((res) => setTimeout(res, 500))
  try {
    fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
    console.log('[diag] screenshot: ' + SHOT)
  } catch (e) {
    console.log('[diag] capture failed: ' + e.message)
  }

  console.log('[diag] ' + JSON.stringify(r))
  console.log('[diag] console errors: ' + (errors.length ? errors.slice(0, 8).join(' | ') : 'none'))
  process.exit(0)
})

setTimeout(() => {
  console.log('[diag] TIMEOUT')
  process.exit(3)
}, 30000)
