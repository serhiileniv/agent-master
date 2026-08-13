// Workspace-tab integration test (Phase A of "workspaces, not directories").
// The headline invariants:
//   - a workspace can exist with NO folder (created empty from the tab strip +)
//   - each tab renders a live agent count on its right, tracking add/remove
//   - a tab can be renamed, and the name survives switching away and back
//   - attaching a folder later adopts its name only if the user never renamed
//   - the MAX_LIVE_WORKSPACES cap still holds for empty workspaces
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()
// Isolate localStorage/userData so a real install's persisted tabs don't leak in.
app.setPath('userData', join(os.tmpdir(), 'agentmaster-tabs-ud-' + process.pid))

const A = join(os.tmpdir(), 'agentmaster-tabs-A-' + process.pid)
const WT_CONTAINER = join(os.tmpdir(), '.agentmaster-worktrees')
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
  for (const p of [A, WT_CONTAINER, app.getPath('userData')]) {
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
/** The rendered count badge text for the Nth tab, or null when absent. */
const countAt = (i) =>
  `(()=>{const t=document.querySelectorAll('.tab')[${i}];if(!t)return 'NO-TAB';const c=t.querySelector('.tab__count');return c?c.textContent:null})()`
const nameAt = (i) =>
  `(()=>{const t=document.querySelectorAll('.tab')[${i}];if(!t)return 'NO-TAB';const n=t.querySelector('.tab__name');return n?n.textContent:null})()`

app.whenReady().then(async () => {
  setupRepo(A)

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

  // --- 1. A folder-less workspace can be created and is named for you. -------
  await run(`${store}.createWorkspace()`)
  await sleep(250)
  const emptyWs = await run(
    `(()=>{const w=${store}.liveWorkspaces[0];return w?{name:w.name,path:w.defaultPath,agents:w.agents.length}:null})()`
  )
  const emptyCreated = !!emptyWs && emptyWs.path === null && emptyWs.name === 'Workspace 1'
  // No agents yet → no count badge at all (0 must not render as a "0" chip).
  const noBadgeWhenEmpty = (await run(countAt(0))) === null

  // --- 2. Rename sticks, and blank names are refused. ------------------------
  const wsId = await run(`${store}.liveWorkspaces[0].id`)
  await run(`${store}.renameWorkspace(${JSON.stringify(wsId)}, '  Renamed  ')`)
  await sleep(200)
  const renamed = (await run(nameAt(0))) === 'Renamed'
  await run(`${store}.renameWorkspace(${JSON.stringify(wsId)}, '   ')`)
  await sleep(150)
  const blankRefused = (await run(nameAt(0))) === 'Renamed'

  // --- 3. The count badge tracks agents in a real repo workspace. ------------
  await run(`${store}.setSetting('defaultIsolation','worktree')`)
  const gitA = await run(`window.api.git.info(${JSON.stringify(A)})`)
  await run(`${store}.openWorkspace({path:${JSON.stringify(A)},name:'A'}, null, ${JSON.stringify(gitA)})`)
  await sleep(250)
  await run(`${store}.addAgent()`)
  await run(`${store}.addAgent()`)
  await sleep(500)
  const countAfterTwo = await run(countAt(1))
  const stateAfterTwo = await run(`(${wsA}).agents.length`)

  // Removing one must drop the badge back to 1 (removeAgent is two-phase with a
  // ~180ms collapse animation, so give it room before reading).
  const firstAgentId = await run(`(${wsA}).agents[0].id`)
  await run(`${store}.removeAgent(${JSON.stringify(firstAgentId)})`)
  await sleep(900)
  const countAfterRemove = await run(countAt(1))

  // --- 4. The rename survives switching away and back. -----------------------
  await run(`${store}.setActiveWorkspace((${wsA}).id)`)
  await sleep(250)
  await run(`${store}.setActiveWorkspace(${JSON.stringify(wsId)})`)
  await sleep(250)
  const renameSurvivesSwitch = (await run(nameAt(0))) === 'Renamed'

  // --- 5. Attaching a folder keeps a user-chosen name. -----------------------
  await run(
    `${store}.setWorkspacePath(${JSON.stringify(wsId)}, {path:${JSON.stringify(A)},name:'A'}, ${JSON.stringify(gitA)})`
  )
  await sleep(200)
  const keptUserName = (await run(nameAt(0))) === 'Renamed'
  const pathAttached = (await run(`${store}.liveWorkspaces[0].defaultPath`)) === A

  // --- 6. The live-workspace cap still holds for empty workspaces. -----------
  for (let i = 0; i < 8; i++) await run(`${store}.createWorkspace()`)
  await sleep(300)
  const capHeld = (await run(`${store}.liveWorkspaces.length`)) === 6

  // Ignore benign network noise (update-feed / feedback) — only real errors fail.
  const realErrors = errors.filter(
    (e) => !/update|feedback|net::|ERR_|Failed to fetch|ECONNREFUSED|getaddrinfo|favicon/i.test(e)
  )

  console.log('[tabs] folder-less ws created  : ' + emptyCreated + ' ' + JSON.stringify(emptyWs))
  console.log('[tabs] no badge at 0 agents    : ' + noBadgeWhenEmpty)
  console.log('[tabs] rename applied+trimmed  : ' + renamed)
  console.log('[tabs] blank rename refused    : ' + blankRefused)
  console.log('[tabs] badge reads 2           : ' + (countAfterTwo === '2') + ' (badge=' + countAfterTwo + ', state=' + stateAfterTwo + ')')
  console.log('[tabs] badge reads 1 on remove : ' + (countAfterRemove === '1') + ' (' + countAfterRemove + ')')
  console.log('[tabs] rename survives switch  : ' + renameSurvivesSwitch)
  console.log('[tabs] folder kept user name   : ' + keptUserName)
  console.log('[tabs] folder attached         : ' + pathAttached)
  console.log('[tabs] cap held at 6           : ' + capHeld)
  console.log('[tabs] console errors          : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    emptyCreated &&
    noBadgeWhenEmpty &&
    renamed &&
    blankRefused &&
    countAfterTwo === '2' &&
    countAfterRemove === '1' &&
    renameSurvivesSwitch &&
    keptUserName &&
    pathAttached &&
    capHeld &&
    realErrors.length === 0
  console.log('[tabs] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
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
  console.log('[tabs] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  cleanup()
  app.exit(4)
})

const timer = setTimeout(() => {
  console.log('[tabs] TIMEOUT')
  cleanup()
  app.exit(3)
}, 60000)
