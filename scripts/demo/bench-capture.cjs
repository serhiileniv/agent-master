// Measures capturePage+toJPEG throughput at several window sizes with a realistic
// six-pane canvas, so the demo's capture resolution is chosen from data instead of
// a guess. Prints achievable fps per size, then exits.
const { app, BrowserWindow } = require('electron')
const os = require('os')
const { join } = require('path')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const DEMO_ROOT = join(os.tmpdir(), 'spymaster-demo')
const NAMES = ['storefront', 'payments-api', 'mobile-app']
const PATHS = NAMES.map((n) => join(DEMO_ROOT, n))
const SIZES = [
  [1280, 720],
  [1600, 900],
  [1920, 1080]
]
const QUALITIES = [94, 82]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log('[bench] ' + m)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  registerIpc(() => win)

  const js = async (code) => {
    try {
      const r = await win.webContents.executeJavaScript(
        `(async () => { try { return { ok: true, v: await (${code}) } } catch (e) { return { ok: false, error: String(e) } } })()`,
        true
      )
      return r && r.ok ? r.v : null
    } catch {
      return null
    }
  }

  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  await js(`(() => {
    localStorage.setItem('vectro.openWorkspaces', ${JSON.stringify(JSON.stringify({ paths: PATHS, active: PATHS[0] }))});
    return true
  })()`)
  win.reload()
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await sleep(1500)

  await js(`(() => {
    window.__d = { S: () => window.__agentStore.getState(),
      AW() { const s = this.S(); return s.liveWorkspaces.find(w => w.id === s.activeWorkspaceId) } };
    const set = window.__d.S().setSetting;
    set('theme','dark'); set('fontSize',14); set('terminalOpacity',0.62);
    window.__agentStore.setState(s => ({ settings: { ...s.settings, defaultIsolation:'worktree', defaultShellId:'powershell' } }));
    return true
  })()`)

  // Six panes printing continuously — the worst case the real capture hits.
  await js(`(() => {
    const w = window.__d.AW();
    w.agents.map(a => a.id).forEach(id => window.__d.S().removeAgent(id, { keepWorktree: false }));
    return true
  })()`)
  await sleep(1200)
  for (let i = 0; i < 6; i++) {
    await js(
      `(() => { window.__d.S().addAgent({ command: "while ($true) { Write-Host 'working on src/module.ts  12 + const x = compute(y)' -ForegroundColor Green; Start-Sleep -Milliseconds 120 }", shellId: 'powershell', agentId: 'claude', agentLabel: 'Claude Code' }); return true })()`
    )
    await sleep(350)
  }
  await sleep(4000)
  log('six panes streaming — starting measurements')

  for (const [w, h] of SIZES) {
    win.setSize(w, h)
    await sleep(900)
    await js(`(() => { window.dispatchEvent(new Event('resize')); window.__d.S().relayout(); return true })()`)
    await sleep(1200)
    for (const q of QUALITIES) {
      const N = 30
      const t0 = Date.now()
      let bytes = 0
      for (let i = 0; i < N; i++) {
        const img = await win.webContents.capturePage()
        bytes += img.toJPEG(q).length
      }
      const secs = (Date.now() - t0) / 1000
      log(
        `${w}x${h}  q=${q}  ->  ${(N / secs).toFixed(2)} fps  ` +
          `(${((secs / N) * 1000).toFixed(0)} ms/frame, avg ${(bytes / N / 1024).toFixed(0)} KB)`
      )
    }
  }
  app.exit(0)
})

setTimeout(() => {
  log('TIMEOUT')
  app.exit(3)
}, 180000)
