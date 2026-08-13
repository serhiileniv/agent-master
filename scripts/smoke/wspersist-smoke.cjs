// Workspace persistence test (Phase B of "workspaces, not directories").
// The tab set now lives in ONE app-data file instead of a localStorage path
// list plus a canvas.json inside each project folder — because a workspace with
// no folder has nowhere to put a canvas.json. Invariants:
//   - the set (order, names, folders, agents, active tab) round-trips a restart
//   - a FOLDER-LESS workspace survives a restart, agents and all
//   - a workspace renamed by the user keeps its name across a restart
//   - upgrading users are migrated from the legacy localStorage + canvas.json
//   - a workspace whose folder was deleted while away is dropped, not restored
//     into a canvas of dead terminals
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()
const USERDATA = join(os.tmpdir(), 'agentmaster-wsp-ud-' + process.pid)
app.setPath('userData', USERDATA)

const A = join(os.tmpdir(), 'agentmaster-wsp-A-' + process.pid)
const GONE = join(os.tmpdir(), 'agentmaster-wsp-GONE-' + process.pid)
const WT_CONTAINER = join(os.tmpdir(), '.agentmaster-worktrees')
const STORE_FILE = join(USERDATA, 'workspaces.json')
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
  for (const p of [A, GONE, WT_CONTAINER, USERDATA]) {
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

/** Reload the renderer against the same userData. That's what a restart means
 *  for the code under test: the store, its module state, and restoreWorkspaces
 *  all start from scratch, while workspaces.json and localStorage persist.
 *  (Destroying and recreating the BrowserWindow races the main-process IPC
 *  registration, which is bound to the original window accessor.) */
async function relaunch() {
  const loaded = new Promise((res) => win.webContents.once('did-finish-load', res))
  win.webContents.reload()
  await loaded
  await sleep(1600) // boot + restoreWorkspaces (git info per folder)
}

app.whenReady().then(async () => {
  setupRepo(A)
  setupRepo(GONE)

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

  // --- Build a session: one folder workspace + one folder-less, renamed. -----
  const gitA = await run(`window.api.git.info(${JSON.stringify(A)})`)
  await run(`${store}.openWorkspace({path:${JSON.stringify(A)},name:'A'}, null, ${JSON.stringify(gitA)})`)
  await run(`${store}.addAgent()`)
  await run(`${store}.createWorkspace('Scratch')`)
  await sleep(300)
  const scratchId = await run(`${store}.liveWorkspaces[1].id`)
  await run(`${store}.addAgent()`) // lands in Scratch (createWorkspace made it active)
  await sleep(600)

  const before = await run(
    `${store}.liveWorkspaces.map(w=>({name:w.name,path:w.defaultPath,agents:w.agents.length}))`
  )
  const activeBefore = await run(`${store}.activeWorkspaceId`)
  // Autosave is debounced at 400ms — give it room to land on disk.
  await sleep(900)
  const fileWritten = fs.existsSync(STORE_FILE)
  const onDisk = fileWritten ? JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) : null
  const validJson = !!onDisk && onDisk.version === 1 && Array.isArray(onDisk.workspaces)

  // --- Restart: the whole set must come back. -------------------------------
  await relaunch()
  const after = await run(
    `${store}.liveWorkspaces.map(w=>({name:w.name,path:w.defaultPath,agents:w.agents.length}))`
  )
  const activeAfter = await run(`${store}.activeWorkspaceId`)
  const roundTripped = JSON.stringify(before) === JSON.stringify(after)
  const activeRestored = activeAfter === activeBefore
  const scratchIdStable = (await run(`${store}.liveWorkspaces[1].id`)) === scratchId
  // The folder-less one specifically: it has no canvas.json anywhere, so this
  // only works because the app-data store holds it.
  const scratch = after.find((w) => w.name === 'Scratch')
  const folderlessSurvived = !!scratch && scratch.path === null && scratch.agents === 1

  // --- A folder deleted while away is dropped, not restored dead. ------------
  await run(`${store}.openWorkspace({path:${JSON.stringify(GONE)},name:'GONE'}, null, ${JSON.stringify(await run(`window.api.git.info(${JSON.stringify(GONE)})`))})`)
  await sleep(900)
  fs.rmSync(GONE, { recursive: true, force: true })
  await relaunch()
  const goneDropped = !(await run(`${store}.liveWorkspaces.some(w=>w.defaultPath===${JSON.stringify(GONE)})`))
  const othersKept = (await run(`${store}.liveWorkspaces.length`)) === 2

  // --- Migration: no app-data file, but legacy localStorage + canvas.json. ---
  // Stop the renderer persisting first: relaunch() reloads the page, and the
  // app's flush-on-unload would otherwise rewrite the file we're about to delete
  // (correct app behaviour — it's how a quit keeps the last layout).
  await run('window.__agentmasterDisablePersist()')
  fs.rmSync(STORE_FILE, { force: true })
  await run(
    `localStorage.setItem('vectro.openWorkspaces', JSON.stringify({paths:[${JSON.stringify(A)}],active:${JSON.stringify(A)}}))`
  )
  // Seed a canvas.json the migration should pick the agents up from. Written
  // here rather than through the app: canvas.json is legacy read-only now (there
  // is no project.save), so an old build is exactly who would have left this.
  fs.mkdirSync(join(A, '.monad'), { recursive: true })
  fs.writeFileSync(
    join(A, '.monad', 'canvas.json'),
    JSON.stringify({
      layoutMode: 'grid',
      agents: [
        { id: 'mig-1', label: 'migrated', x: 0, y: 0, w: 520, h: 360, isolation: 'shared' }
      ]
    }),
    'utf8'
  )
  await relaunch()
  const migrated = await run(
    `${store}.liveWorkspaces.map(w=>({name:w.name,path:w.defaultPath,agents:w.agents.map(a=>a.label)}))`
  )
  const migratedOk =
    migrated.length === 1 && migrated[0].path === A && migrated[0].agents.includes('migrated')

  const realErrors = errors.filter(
    (e) => !/update|feedback|net::|ERR_|Failed to fetch|ECONNREFUSED|getaddrinfo|favicon/i.test(e)
  )

  console.log('[wsp] workspaces.json written  : ' + fileWritten)
  console.log('[wsp] valid v1 json            : ' + validJson)
  console.log('[wsp] set round-trips restart  : ' + roundTripped)
  console.log('[wsp]   before: ' + JSON.stringify(before))
  console.log('[wsp]   after : ' + JSON.stringify(after))
  console.log('[wsp] active tab restored      : ' + activeRestored)
  console.log('[wsp] workspace id stable      : ' + scratchIdStable)
  console.log('[wsp] folder-less survived     : ' + folderlessSurvived)
  console.log('[wsp] deleted folder dropped   : ' + goneDropped)
  console.log('[wsp] other tabs kept          : ' + othersKept)
  console.log('[wsp] legacy migration         : ' + migratedOk + ' ' + JSON.stringify(migrated))
  console.log('[wsp] console errors           : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    fileWritten &&
    validJson &&
    roundTripped &&
    activeRestored &&
    scratchIdStable &&
    folderlessSurvived &&
    goneDropped &&
    othersKept &&
    migratedOk &&
    realErrors.length === 0
  console.log('[wsp] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
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
  console.log('[wsp] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  cleanup()
  app.exit(4)
})

const timer = setTimeout(() => {
  console.log('[wsp] TIMEOUT')
  cleanup()
  app.exit(3)
}, 90000)
