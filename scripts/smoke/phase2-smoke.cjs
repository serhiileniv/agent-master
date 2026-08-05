// Phase 2 integration test: drives the real IPC against a real temp git repo.
//   1. git:info detects the repo + base branch
//   2. worktree:create makes an isolated worktree+branch; an agent PTY runs IN it
//   3. `git worktree list` reflects the new worktree
//   4. worktree:remove tears the worktree+branch back down
//   6. a worktree left in the PRE-RENAME container is adopted, never duplicated
const { app, BrowserWindow } = require('electron')
const { join, basename } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()

const REPO = join(os.tmpdir(), 'spymaster-p2-' + process.pid)
// A folder that starts life as a NON-repo, for the `git init` cache-invalidation
// case at the end (check 5).
const PLAIN = join(os.tmpdir(), 'spymaster-p2-plain-' + process.pid)
const errors = []

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
}
function worktreeCount() {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length
}
// Windows hands back D:\x and D:/x for one folder; compare canonically.
function norm(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function setupRepo() {
  fs.mkdirSync(REPO, { recursive: true })
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  fs.writeFileSync(join(REPO, 'README.md'), '# test\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
}

const AGENT_ID = 'agent-aaaaaaaa'

app.whenReady().then(async () => {
  setupRepo()

  const win = new BrowserWindow({
    show: false,
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

  const createScript = `(async () => {
    // Non-interactive spawn => no PSReadLine echo/ANSI; clean cwd proof.
    const runArgs = (cwd, psCommand, marker, t=15000) => new Promise((resolve) => {
      let buf = ''
      window.api.pty.spawn({ shell: 'powershell.exe', args: ['-NoProfile','-NoLogo','-Command', psCommand], cwd, cols: 120, rows: 30 }).then((pid) => {
        const off = window.api.pty.onData(pid, (d) => {
          buf += d
          if (buf.includes(marker)) { off(); window.api.pty.kill(pid); resolve({ seen: true, buf }) }
        })
        setTimeout(() => { off(); window.api.pty.kill(pid); resolve({ seen: buf.includes(marker), buf }) }, t)
      })
    })
    const info = await window.api.git.info(${JSON.stringify(REPO)})
    const wt = await window.api.worktree.create(${JSON.stringify(REPO)}, ${JSON.stringify(AGENT_ID)}, 'worktree')
    const wtRun = await runArgs(wt.cwd, 'Write-Output ("CWD=" + (Get-Location).Path); New-Item -ItemType File marker.txt -Force > $null; Write-Output DONE_WT', 'DONE_WT', 20000)
    // Product mechanism: INTERACTIVE shell + Set-Location enforcement. Detect
    // via the filesystem only (interactive PSReadLine echoes the command, which
    // would race any stdout marker). Fire, wait, then main checks marker2.
    const fireAndWait = (cwd, cmd, ms=7000) => new Promise((resolve) => {
      window.api.pty.spawn({ cwd, cols: 120, rows: 30 }).then((pid) => {
        window.api.pty.write(pid, cmd + '\\r')
        setTimeout(() => { window.api.pty.kill(pid); resolve(true) }, ms)
      })
    })
    const cdCmd = "Set-Location -LiteralPath '" + wt.cwd.replace(/'/g, "''") + "'"
    await fireAndWait(wt.cwd, cdCmd + '; New-Item -ItemType File marker2.txt -Force > $null')
    const cwdLine = (wtRun.buf.match(/CWD=([^\\r\\n]+)/) || [])[1] || ''
    return { info, wt, ranInWorktree: wtRun.seen, reportedCwd: cwdLine.trim() }
  })()`

  let r
  try {
    r = await win.webContents.executeJavaScript(createScript, true)
  } catch (e) {
    console.log('[p2] executeJavaScript failed:', e.message)
    cleanup()
    app.exit(5)
  }

  const wtCountAfterCreate = worktreeCount()
  const markerExists = fs.existsSync(join(r.wt.cwd, 'marker.txt'))
  const marker2Exists = fs.existsSync(join(r.wt.cwd, 'marker2.txt'))

  // Now remove the worktree via the real IPC.
  await win.webContents.executeJavaScript(
    `window.api.worktree.remove(${JSON.stringify(REPO)}, ${JSON.stringify(AGENT_ID)})`,
    true
  )
  const wtCountAfterRemove = worktreeCount()
  const branchGone =
    git(['branch', '--list', r.wt.branch]).trim() === '' // empty => branch deleted

  // --- 5. git init on a NON-repo folder must take effect immediately ---------
  // getRepoRootSafe caches "which repo does this dir belong to", including the
  // negative answer, because it is asked once per workspace AND once per agent
  // on launch (~100 git processes uncached). `git init` is the one operation
  // that turns a cached "not a repo" into a WRONG answer, and wrong here is the
  // bad kind: worktree:create silently falls back to `isolated: false` and every
  // agent writes straight into the user's real folder while the UI says
  // otherwise. initRepo() clears the cache; this proves it.
  fs.mkdirSync(PLAIN, { recursive: true })
  fs.writeFileSync(join(PLAIN, 'file.txt'), 'hello\n')
  const INIT_AGENT = 'agent-bbbbbbbb'
  let initFlow
  try {
    initFlow = await win.webContents.executeJavaScript(
      `(async () => {
        const P = ${JSON.stringify(PLAIN)}
        // Ask FIRST, so the "not a repo" answer is cached before git init runs.
        const before = await window.api.git.info(P)
        await window.api.git.init(P)
        const after = await window.api.git.info(P)
        // A repo with no commits can't host a worktree, so make one the way the
        // app's own toast tells the user to.
        return { wasGit: before.isGit, isGitAfterInit: after.isGit }
      })()`,
      true
    )
    if (initFlow.isGitAfterInit) {
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: PLAIN })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: PLAIN })
      execFileSync('git', ['add', '.'], { cwd: PLAIN })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: PLAIN })
      const wt = await win.webContents.executeJavaScript(
        `window.api.worktree.create(${JSON.stringify(PLAIN)}, ${JSON.stringify(INIT_AGENT)}, 'worktree')`,
        true
      )
      initFlow.isolatedAfterInit = !!wt.isolated
      initFlow.cwdOutsideProject = !!wt.cwd && !wt.cwd.startsWith(PLAIN)
    } else {
      initFlow.isolatedAfterInit = false
      initFlow.cwdOutsideProject = false
    }
  } catch (e) {
    errors.push('init-flow: ' + e.message)
    initFlow = { wasGit: true, isGitAfterInit: false, isolatedAfterInit: false, cwdOutsideProject: false }
  }

  // --- 6. A pre-rename worktree must be ADOPTED, not duplicated -------------
  // Git registers worktrees by absolute path inside .git, so renaming the
  // container in code moves nothing that already exists. If create() ignored the
  // legacy location it would try to add a second worktree on a branch that is
  // already checked out; that fails, worktree:create falls back to
  // isolated:false, and the agent lands in the user's REAL working tree with its
  // previous work stranded in a folder nothing points at any more.
  const LEGACY_AGENT = 'agent-cccccccc'
  const legacyShort = LEGACY_AGENT.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
  const leaf = basename(REPO) + '-' + legacyShort
  const legacyPath = join(os.tmpdir(), '.monad-worktrees', leaf)
  const modernPath = join(os.tmpdir(), '.spymaster-worktrees', leaf)
  let adopted = { cwd: '', isolated: false }
  let countBeforeAdopt = 0
  try {
    fs.mkdirSync(join(os.tmpdir(), '.monad-worktrees'), { recursive: true })
    // Stand in for a worktree an older build left behind.
    git(['worktree', 'add', legacyPath, '-b', 'canvas/' + legacyShort])
    countBeforeAdopt = worktreeCount()
    adopted = await win.webContents.executeJavaScript(
      `window.api.worktree.create(${JSON.stringify(REPO)}, ${JSON.stringify(LEGACY_AGENT)}, 'worktree')`,
      true
    )
  } catch (e) {
    errors.push('legacy-adopt: ' + e.message)
  }
  // Compared by suffix, not by full path: os.tmpdir() returns the 8.3 short form
  // on Windows (ADMINI~1) while the app resolves the long one, so a whole-path
  // equality check fails on two spellings of the same folder. What matters is
  // that it landed in the LEGACY container under this agent's leaf name.
  const adoptedInPlace = norm(adopted.cwd).endsWith('/.monad-worktrees/' + leaf.toLowerCase())
  const noDuplicate = worktreeCount() === countBeforeAdopt && !fs.existsSync(modernPath)
  // And removal has to reach the adopted location too, or it leaks forever.
  await win.webContents
    .executeJavaScript(
      `window.api.worktree.remove(${JSON.stringify(REPO)}, ${JSON.stringify(LEGACY_AGENT)})`,
      true
    )
    .catch((e) => errors.push('legacy-remove: ' + e.message))
  const legacyRemoved = !fs.existsSync(legacyPath)

  console.log('[p2] git detected         : ' + r.info.isGit + ' (branch ' + r.info.branch + ')')
  console.log('[p2] worktree isolated    : ' + r.wt.isolated + ' branch=' + r.wt.branch)
  console.log('[p2] agent cmd completed   : ' + r.ranInWorktree)
  console.log('[p2] expected worktree cwd : ' + r.wt.cwd)
  console.log('[p2] shell reported cwd    : ' + r.reportedCwd)
  console.log('[p2] marker file in worktree: ' + markerExists)
  console.log('[p2] interactive+cd lands  : ' + marker2Exists)
  console.log('[p2] worktree list = 2    : ' + (wtCountAfterCreate === 2) + ' (' + wtCountAfterCreate + ')')
  console.log('[p2] worktree removed     : ' + (wtCountAfterRemove === 1) + ' (' + wtCountAfterRemove + ')')
  console.log('[p2] branch deleted       : ' + branchGone)
  console.log('[p2] plain dir not a repo : ' + (initFlow.wasGit === false))
  console.log('[p2] git init takes effect: ' + initFlow.isGitAfterInit)
  console.log('[p2] isolated after init  : ' + initFlow.isolatedAfterInit)
  console.log('[p2] worktree outside proj: ' + initFlow.cwdOutsideProject)
  console.log('[p2] legacy wt adopted    : ' + adoptedInPlace + ' (' + adopted.cwd + ')')
  console.log('[p2] legacy wt isolated   : ' + !!adopted.isolated)
  console.log('[p2] no duplicate created : ' + noDuplicate)
  console.log('[p2] legacy wt removable  : ' + legacyRemoved)
  console.log('[p2] console errors       : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    initFlow.wasGit === false &&
    initFlow.isGitAfterInit &&
    initFlow.isolatedAfterInit &&
    initFlow.cwdOutsideProject &&
    r.info.isGit &&
    r.wt.isolated &&
    r.wt.branch.startsWith('canvas/') &&
    r.ranInWorktree &&
    markerExists &&
    marker2Exists &&
    wtCountAfterCreate === 2 &&
    wtCountAfterRemove === 1 &&
    branchGone &&
    adoptedInPlace &&
    !!adopted.isolated &&
    noDuplicate &&
    legacyRemoved &&
    errors.length === 0
  console.log('[p2] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
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
})

function cleanup() {
  try {
    fs.rmSync(REPO, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(PLAIN, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  for (const dir of ['.spymaster-worktrees', '.monad-worktrees']) {
    try {
      fs.rmSync(join(os.tmpdir(), dir), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

const timer = setTimeout(() => {
  console.log('[p2] TIMEOUT')
  cleanup()
  app.exit(3)
}, 40000)
