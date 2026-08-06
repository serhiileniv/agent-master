// Diagnostic for the "recede when inactive" surfaces.
//
// Unfocused panes and the unfocused window used to recede via
// `filter: saturate()`, which forces a full-surface shader pass every time the
// content repaints — the app's dominant GPU cost with terminals streaming. They
// now recede via scrims instead. A scrim is cheap, but it is an APPROXIMATION of
// desaturation, so the only way to know whether it still looks right is to look.
//
// Renders three states and writes a PNG of each:
//   1-grid      three panes, one selected — the other two carry the pane scrim
//   2-blurred   the same, with the window-level scrim on (is-window-blurred)
//   3-maximized one pane maximized; the rest are content-visibility:hidden
//
// Not part of CI (scripts/diag never is). Run: npx electron scripts/diag/diag-recede.cjs
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const OUT = process.env.RECEDE_OUT || os.tmpdir()
const REPO = join(os.tmpdir(), 'spymaster-recede-' + process.pid)

app.setPath('userData', join(os.tmpdir(), 'spymaster-recede-ud-' + process.pid))

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
}

app.whenReady().then(async () => {
  fs.mkdirSync(REPO, { recursive: true })
  git(['init'])
  git(['config', 'user.email', 't@e.com'])
  git(['config', 'user.name', 'T'])
  fs.writeFileSync(join(REPO, 'README.md'), '# r\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    backgroundColor: '#07090c',
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

  const run = (code) => win.webContents.executeJavaScript(code, true)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = 'window.__agentStore.getState()'

  await sleep(1200)
  const info = await run(`window.api.git.info(${JSON.stringify(REPO)})`)
  await run(`${store}.setSetting('defaultIsolation','shared')`)
  await run(
    `${store}.openWorkspace({path:${JSON.stringify(REPO)},name:'demo'}, null, ${JSON.stringify(info)})`
  )
  await sleep(500)
  for (let i = 0; i < 3; i++) await run(`${store}.addAgent()`)
  await sleep(5000) // spawn + quiet-boot reveal, so the panes have real content

  const ids = await run(`${store}.liveWorkspaces[0].agents.map(a=>a.id)`)
  const ptyIds = await run(`${store}.liveWorkspaces[0].agents.map(a=>a.ptyId)`)
  // Give each pane visible output, so the scrim is judged over real text.
  for (const p of ptyIds) {
    if (p) await run(`window.api.pty.write(${JSON.stringify(p)}, 'git status\\r')`)
  }
  await sleep(2500)

  const shoot = async (name) => {
    const img = await win.webContents.capturePage()
    const file = join(OUT, `recede-${name}.png`)
    fs.writeFileSync(file, img.toPNG())
    console.log('[recede] wrote ' + file)
  }

  // 1. Grid, one selected: the other two wear the pane scrim.
  await run(`${store}.setSelected([${JSON.stringify(ids[0])}])`)
  await sleep(600)
  await shoot('1-grid')

  // 2. Window-level scrim. Stamped directly — a real OS blur can't be forced
  //    from here, and windowFocus.ts does nothing but toggle this class.
  await run(`document.body.classList.add('is-window-blurred')`)
  await sleep(700)
  await shoot('2-blurred')
  await run(`document.body.classList.remove('is-window-blurred')`)

  // 3. Maximized: siblings are content-visibility:hidden behind it.
  await run(`${store}.focusTerminal(${JSON.stringify(ids[0])})`)
  await sleep(900)
  await shoot('3-maximized')

  console.log('[recede] console errors: ' + (errors.length ? errors.join(' | ') : 'none'))
  try {
    fs.rmSync(REPO, { recursive: true, force: true })
    fs.rmSync(app.getPath('userData'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(0), 300)
}).catch((e) => {
  console.log('[recede] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  app.exit(4)
})
