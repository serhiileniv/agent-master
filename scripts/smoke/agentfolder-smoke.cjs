// Per-agent folder test (Phase C of "workspaces, not directories").
// The headline claim: ONE workspace can hold agents working in DIFFERENT repos.
// Invariants:
//   - an agent with no override inherits the workspace default
//   - an agent with an override spawns in its OWN repo and gets its worktree
//     under that repo, not the workspace default's
//   - the override round-trips a restart
//   - a folder-less workspace can still host an agent pointed at a real repo
//   - worktree ownership is computed across ALL workspaces, so cleanup can't
//     sweep a live agent's worktree in a repo another workspace also uses
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()
const USERDATA = join(os.tmpdir(), 'spymaster-af-ud-' + process.pid)
app.setPath('userData', USERDATA)

const A = join(os.tmpdir(), 'spymaster-af-A-' + process.pid)
const B = join(os.tmpdir(), 'spymaster-af-B-' + process.pid)
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
  for (const p of [A, B, WT_CONTAINER, USERDATA]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
/** Path-compare the way the app does (separators + case). */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

let win
const run = (code) => win.webContents.executeJavaScript(code, true)
const sleep = (ms) => run(`new Promise(r=>setTimeout(r,${ms}))`)
const store = 'window.__agentStore.getState()'
/** Wait until an agent has a live pty + resolved cwd (React mount + spawn). */
const waitCwd = (idx) =>
  run(
    `new Promise((res)=>{const t0=Date.now();const iv=setInterval(()=>{const w=${store}.liveWorkspaces[0];const a=w&&w.agents[${idx}];if(a&&a.ptyId&&a.cwd){clearInterval(iv);res({cwd:a.cwd,branch:a.branch,isolated:a.isolated,projectPath:a.projectPath})}else if(Date.now()-t0>15000){clearInterval(iv);res(null)}},100)})`
  )

async function relaunch() {
  const loaded = new Promise((res) => win.webContents.once('did-finish-load', res))
  win.webContents.reload()
  await loaded
  await sleep(1600)
}

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
  await sleep(700)

  await run(`${store}.setSetting('defaultIsolation','worktree')`)
  const gitA = await run(`window.api.git.info(${JSON.stringify(A)})`)
  const gitB = await run(`window.api.git.info(${JSON.stringify(B)})`)

  // Workspace defaults to repo A. Agent 0 inherits; agent 1 overrides to repo B.
  await run(`${store}.openWorkspace({path:${JSON.stringify(A)},name:'A'}, null, ${JSON.stringify(gitA)})`)
  await sleep(300)
  await run(`${store}.addAgent()`)
  const inherited = await waitCwd(0)
  await run(`${store}.addAgent({projectPath:${JSON.stringify(B)}, isGit:true})`)
  const overridden = await waitCwd(1)

  // The inheriting agent stores no override (so moving the default moves it).
  const inheritStaysUndefined = !!inherited && inherited.projectPath === undefined
  // Worktrees are named <repoBasename>-<shortId>, so the cwd proves which repo
  // the worktree was cut from even though both live in one sibling container.
  const inheritedInA = !!inherited && norm(inherited.cwd).includes(norm(A).split('/').pop())
  const overriddenInB = !!overridden && norm(overridden.cwd).includes(norm(B).split('/').pop())
  const overriddenIsolated = !!overridden && overridden.isolated === true
  const twoReposOneWorkspace = inheritedInA && overriddenInB

  // The override must survive a restart.
  await sleep(900)
  await relaunch()
  const afterRestart = await run(
    `${store}.liveWorkspaces[0].agents.map(a=>a.projectPath ?? null)`
  )
  const overridePersisted =
    Array.isArray(afterRestart) &&
    afterRestart.length === 2 &&
    afterRestart[0] === null &&
    norm(afterRestart[1] || '') === norm(B)

  // Ownership is cross-workspace: open a SECOND workspace defaulting to repo B
  // and confirm the agent in workspace 1 that lives in B is counted as an owner.
  await run(`${store}.openWorkspace({path:${JSON.stringify(B)},name:'B'}, null, ${JSON.stringify(gitB)})`)
  await sleep(1200)
  // Ask git for B's orphans while passing ONLY workspace-2's agent ids — the
  // worktree owned by workspace-1's overridden agent must show up as an orphan
  // here, which is exactly what the app must NOT do when it cleans.
  const ws2Ids = await run(`${store}.liveWorkspaces[1].agents.map(a=>a.id)`)
  const orphansIfScopedToOneWs = await run(
    `window.api.git.orphans(${JSON.stringify(B)}, ${JSON.stringify(ws2Ids)})`
  )
  // ...and with the app's real cross-workspace owner set, it must not.
  const allIdsInB = await run(
    `(()=>{const ids=[];for(const w of ${store}.liveWorkspaces){for(const a of w.agents){const p=(a.projectPath ?? w.defaultPath ?? '').replace(/\\\\/g,'/').replace(/\\/+$/,'').toLowerCase();if(p===${JSON.stringify(norm(B))})ids.push(a.id)}}return ids})()`
  )
  const orphansWithRealOwners = await run(
    `window.api.git.orphans(${JSON.stringify(B)}, ${JSON.stringify(allIdsInB)})`
  )
  const narrowScopeWouldSweep = (orphansIfScopedToOneWs?.length ?? 0) > 0
  const realOwnersProtect = (orphansWithRealOwners?.length ?? 0) === 0
  const ownershipIsCrossWorkspace = narrowScopeWouldSweep && realOwnersProtect

  const realErrors = errors.filter(
    (e) => !/update|feedback|net::|ERR_|Failed to fetch|ECONNREFUSED|getaddrinfo|favicon/i.test(e)
  )

  console.log('[af] inherited agent cwd      : ' + (inherited && inherited.cwd))
  console.log('[af] overridden agent cwd     : ' + (overridden && overridden.cwd))
  console.log('[af] inherit stores no override: ' + inheritStaysUndefined)
  console.log('[af] inherited landed in A    : ' + inheritedInA)
  console.log('[af] overridden landed in B   : ' + overriddenInB)
  console.log('[af] overridden got worktree  : ' + overriddenIsolated)
  console.log('[af] TWO REPOS, ONE WORKSPACE : ' + twoReposOneWorkspace)
  console.log('[af] override survives restart: ' + overridePersisted + ' ' + JSON.stringify(afterRestart))
  console.log('[af] narrow scope would sweep : ' + narrowScopeWouldSweep)
  console.log('[af] real owner set protects  : ' + realOwnersProtect)
  console.log('[af] ownership cross-workspace: ' + ownershipIsCrossWorkspace)
  console.log('[af] console errors           : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    inheritStaysUndefined &&
    twoReposOneWorkspace &&
    overriddenIsolated &&
    overridePersisted &&
    ownershipIsCrossWorkspace &&
    realErrors.length === 0
  console.log('[af] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
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
  console.log('[af] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  cleanup()
  app.exit(4)
})

const timer = setTimeout(() => {
  console.log('[af] TIMEOUT')
  cleanup()
  app.exit(3)
}, 90000)
