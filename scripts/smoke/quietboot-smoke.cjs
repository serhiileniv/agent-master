// Quiet-boot smoke. A pane must not open on shell noise: the PowerShell startup
// banner ("Windows PowerShell / Copyright (C) Microsoft" plus the "Install the
// latest PowerShell" nag) used to sit above the agent in every Windows pane.
//
// Drives the real preload bridge:
//   1. shells:list hands back the args the app will actually spawn with
//   2. a PTY spawned on those args prints a prompt but no banner
//   3. the default spawn (no shell/args given — the fallback inside PtyManager)
//      is just as quiet
//
// The prompt assertion matters as much as the banner one: without it, a shell
// that failed to start would "pass" by printing nothing at all.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()

const BANNERS = ['Copyright (C) Microsoft', 'aka.ms/PSWindows']
const errors = []

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-gone: ' + d.reason))

  registerIpc(() => win)
  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))

  const script = `(async () => {
    const shells = await window.api.shells.list()
    const ps = (shells || []).filter((s) => s.id === 'powershell' || s.id === 'pwsh')

    // Collect everything a freshly spawned shell says on its own, then a marker
    // we ask for — the marker is how we know the shell got far enough to talk.
    const boot = (opts) => new Promise((resolve) => {
      let buf = ''
      window.api.pty.spawn(Object.assign({ cols: 100, rows: 30 }, opts)).then((pid) => {
        const done = () => { off(); window.api.pty.kill(pid); resolve(buf) }
        const off = window.api.pty.onData(pid, (d) => {
          buf += d
          if (buf.includes('QB_OK_1')) setTimeout(done, 150)
        })
        setTimeout(done, 10000)
        window.api.pty.write(pid, 'echo QB_OK_1\\r')
      })
    })

    const out = []
    for (const s of ps) out.push({ id: s.id, args: s.args, raw: await boot({ shell: s.command, args: s.args }) })
    out.push({ id: 'default', args: null, raw: await boot({}) })
    return out
  })()`

  let results
  try {
    results = await win.webContents.executeJavaScript(script, true)
  } catch (e) {
    console.log('[qb] executeJavaScript failed:', e.message)
    app.exit(5)
    return
  }

  // On Windows the banner is the whole point, so a missing PowerShell means the
  // assertion never ran and the smoke must not pass on a technicality. Elsewhere
  // only the default-spawn leg applies.
  let pass = process.platform !== 'win32' || results.length > 1
  if (!pass) console.log('[qb] no PowerShell detected — nothing to assert')

  for (const r of results) {
    const started = r.raw.includes('QB_OK_1')
    const banner = BANNERS.filter((b) => r.raw.includes(b))
    console.log(
      '[qb] ' + r.id.padEnd(11) + ': started=' + started +
        ' banner=' + (banner.length ? banner.join(' + ') : 'none') +
        (r.args ? ' args=' + JSON.stringify(r.args) : '')
    )
    if (!started || banner.length) pass = false
  }

  console.log('[qb] console errors       : ' + (errors.length ? errors.join(' | ') : 'none'))
  if (errors.length) pass = false
  console.log('[qb] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  clearTimeout(timer)
  // Delayed app.exit: exiting straight into node-pty's native teardown segfaults.
  setTimeout(() => app.exit(pass ? 0 : 2), 250)
})

const timer = setTimeout(() => {
  console.log('[qb] TIMEOUT')
  app.exit(3)
}, 45000)
