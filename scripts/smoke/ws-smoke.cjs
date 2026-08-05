// Multi-workspace integration test: the headline invariant is that switching
// between live workspaces keeps the previous workspace's agent PTY ALIVE (the
// pane stays mounted, so its ptyId is stable and it never exits). Also checks:
//   - two workspaces coexist live; switching updates the active one
//   - opening a 2nd workspace does NOT disturb the 1st's running pty
//   - the live set is persisted to the app-data store (restore across restart)
//   - closing a workspace tab detaches (kills the pty) but LEAVES its worktree
//     on disk (reopenable) — no worktree.remove on close
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()
// Isolate localStorage/userData so a real install's persisted tabs don't leak in.
app.setPath('userData', join(os.tmpdir(), 'spymaster-ws-ud-' + process.pid))

const A = join(os.tmpdir(), 'spymaster-ws-A-' + process.pid)
const B = join(os.tmpdir(), 'spymaster-ws-B-' + process.pid)
const WT_CONTAINER = join(os.tmpdir(), '.spymaster-worktrees')
const errors = []

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}
function setupRepo(repo) {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 't@e.com'])
  git(repo, ['config', 'user.name', 'T'])
  fs.writeFileSync(join(repo, 'README.md'), '# r\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])
}
function cleanup() {
  for (const p of [A, B, WT_CONTAINER, app.getPath('userData')]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

let win
const run = (code) => win.webContents.executeJavaScript(code, true)
const sleep = (ms) => run(`new Promise(r=>setTimeout(r,${ms}))`)
const store = 'window.__agentStore.getState()'
const wsA = `${store}.liveWorkspaces.find(w=>w.defaultPath===${JSON.stringify(A)})`
const wsB = `${store}.liveWorkspaces.find(w=>w.defaultPath===${JSON.stringify(B)})`

app.whenReady().then(async () => {
  setupRepo(A)
  setupRepo(B)

  win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  registerIpc(() => win)
  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  await sleep(700) // let the app boot (restoreWorkspaces is a no-op on empty userData)

  const bootLive = await run(`${store}.liveWorkspaces.length`)

  // Open workspace A (worktree isolation) and add one agent → it spawns a pty.
  await run(`${store}.setSetting('defaultIsolation','worktree')`)
  const gitA = await run(`window.api.git.info(${JSON.stringify(A)})`)
  await run(`${store}.openWorkspace({path:${JSON.stringify(A)},name:'A'}, null, ${JSON.stringify(gitA)})`)
  await run(`${store}.addAgent()`)

  // Poll until A's agent has a live ptyId (React must mount the pane + spawn).
  const ptyA = await run(
    `new Promise((res)=>{const t0=Date.now();const iv=setInterval(()=>{const ws=${wsA};const a=ws&&ws.agents[0];if(a&&a.ptyId){clearInterval(iv);res(a.ptyId)}else if(Date.now()-t0>10000){clearInterval(iv);res(null)}},100)})`
  )
  const aWtCwd = await run(`(()=>{const ws=${wsA};return ws&&ws.agents[0]&&ws.agents[0].cwd})()`)

  // Open workspace B and add an agent — this must NOT disturb A's pty.
  const gitB = await run(`window.api.git.info(${JSON.stringify(B)})`)
  await run(`${store}.openWorkspace({path:${JSON.stringify(B)},name:'B'}, null, ${JSON.stringify(gitB)})`)
  await run(`${store}.addAgent()`)
  await sleep(400)
  const liveCount = await run(`${store}.liveWorkspaces.length`)
  const activeIsB = await run(`(()=>{const st=${store};return st.activeWorkspaceId===(${wsB}||{}).id})()`)
  const ptyA_afterOpenB = await run(`(()=>{const ws=${wsA};return ws&&ws.agents[0]&&ws.agents[0].ptyId})()`)

  // Switch back to A — pane never unmounted, so its pty must be the SAME one.
  await run(`(()=>{const st=${store};st.setActiveWorkspace((${wsA}).id)})()`)
  await sleep(400)
  const ptyA_afterBack = await run(`(()=>{const ws=${wsA};return ws&&ws.agents[0]&&ws.agents[0].ptyId})()`)
  const aStatus = await run(`(()=>{const ws=${wsA};return ws&&ws.agents[0]&&ws.agents[0].status})()`)

  // The live set is mirrored to disk for restore-on-restart. Since Phase B that
  // is one app-data file (userData/workspaces.json), not a localStorage path
  // list — a folder-less workspace has no canvas.json to live in. Autosave is
  // debounced at 400ms, so give it room to land.
  await sleep(900)
  const openSet = JSON.stringify(await run(`window.api.workspaces.load()`))

  // Detach-only close: closing A's tab kills its pty but LEAVES the worktree.
  const worktreeExistedBefore = aWtCwd ? fs.existsSync(aWtCwd) : false
  await run(`(()=>{const st=${store};st.closeWorkspace((${wsA}).id)})()`)
  await sleep(500)
  const aGone = await run(`!${store}.liveWorkspaces.some(w=>w.defaultPath===${JSON.stringify(A)})`)
  const worktreeSurvives = aWtCwd ? fs.existsSync(aWtCwd) : false

  const ptyStable = !!ptyA && ptyA_afterOpenB === ptyA && ptyA_afterBack === ptyA
  const aAlive = aStatus && aStatus !== 'exited' && aStatus !== 'error'
  const twoLive = liveCount === 2
  const persisted = !!openSet && openSet.includes('spymaster-ws-A') && openSet.includes('spymaster-ws-B')
  // Ignore benign network noise (update-feed / feedback) — only real errors fail.
  const realErrors = errors.filter(
    (e) => !/update|feedback|net::|ERR_|Failed to fetch|ECONNREFUSED|getaddrinfo|favicon/i.test(e)
  )

  console.log('[ws] boot live workspaces     : ' + bootLive + ' (expect 0)')
  console.log('[ws] A pty spawned            : ' + !!ptyA + ' (' + ptyA + ')')
  console.log('[ws] two workspaces live      : ' + twoLive + ' (' + liveCount + ')')
  console.log('[ws] opening B activated B    : ' + activeIsB)
  console.log('[ws] opening B kept A pty     : ' + (ptyA_afterOpenB === ptyA))
  console.log('[ws] switch-back kept A pty   : ' + (ptyA_afterBack === ptyA))
  console.log('[ws] A agent still alive      : ' + aAlive + ' (' + aStatus + ')')
  console.log('[ws] open-set persisted both  : ' + persisted)
  console.log('[ws] worktree existed         : ' + worktreeExistedBefore)
  console.log('[ws] A detached (tab gone)    : ' + aGone)
  console.log('[ws] worktree survives close  : ' + worktreeSurvives + '  ' + aWtCwd)
  console.log('[ws] console errors           : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    bootLive === 0 &&
    !!ptyA &&
    twoLive &&
    activeIsB &&
    ptyStable &&
    aAlive &&
    persisted &&
    worktreeExistedBefore &&
    aGone &&
    worktreeSurvives &&
    realErrors.length === 0
  console.log('[ws] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  cleanup()
  clearTimeout(timer)
  // Exit via app.exit, and give teardown a beat first.
  //
  // process.exit raced Electron's own shutdown: on a loaded runner (two CI jobs
  // on one box) the process could die with code 1 BEFORE the requested code
  // landed, reporting a passing smoke as a CI failure.
  //
  // The delay matters where a PTY is live — exiting straight into node-pty's
  // native teardown segfaults (139) or hangs. 250ms lets it settle. app.exit
  // also closes every window, so the old win.destroy() beforehand isn't needed.
  setTimeout(() => app.exit(pass ? 0 : 2), 250)
}).catch((e) => {
  console.log('[ws] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  cleanup()
  app.exit(4)
})

const timer = setTimeout(() => {
  console.log('[ws] TIMEOUT')
  cleanup()
  app.exit(3)
}, 60000)
