// PATH-resolution smoke test.
//
// Recovering the user's real PATH means booting their whole login-shell rc chain
// (oh-my-zsh, nvm, pyenv…) — seconds on a loaded Mac. That used to run
// SYNCHRONOUSLY before the BrowserWindow was constructed, so every launch opened
// with that long as a blank screen. It is now async + remembered on disk, and
// the two handlers that genuinely need the full PATH await whenPathReady().
//
// That refactor has exactly one catastrophic failure mode: if whenPathReady()
// never settles, `shells:list` and `agents:list` never answer — and the renderer
// holds EVERY terminal spawn on shells:list resolving (TerminalPane's
// shellsLoaded guard). The app would open to a stage of permanently dead panes.
// A hang here is therefore not a slow test, it is the regression; the timeout
// below is the assertion.
//
// Checks:
//   1. primeResolvedPath() RETURNS without blocking on the shell harvest
//   2. shells:list resolves, with at least the platform default shell
//   3. agents:list resolves (an empty list is legitimate — CI has no agent CLIs)
//   4. both still resolve on a second call (the cache path, incl. detectAgents'
//      PATH-keyed invalidation)
//   5. POSIX only: the harvested PATH is written to the note file, which is what
//      makes every later launch instant. Skipped on win32, where the inherited
//      PATH is already correct and prime() short-circuits by design.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))
const { primeResolvedPath, resolvedPath } = require(join(__dirname, '..', '..', 'out', 'main', 'env-path.js'))

app.disableHardwareAcceleration()

const TMP = join(os.tmpdir(), 'monad-envpath-smoke-' + process.pid)
fs.mkdirSync(TMP, { recursive: true })
const NOTE = join(TMP, 'env-path.json')

const isWin = process.platform === 'win32'
const errors = []

// --- 1. prime() must not block on the login shell -------------------------
// The whole point of the change. A synchronous harvest parks the main thread
// here for as long as the user's rc chain takes; async returns immediately.
// 500ms is deliberately loose — it is not a benchmark, it is "did this spawn a
// login shell and wait for it". The old sync path exceeded this routinely.
const t0 = Date.now()
primeResolvedPath(NOTE)
const primeMs = Date.now() - t0
const primeNonBlocking = primeMs < 500

// PATH must already be usable the instant prime() returns — anything spawned
// before the harvest lands still needs to find its binaries.
const pathUsableImmediately = typeof resolvedPath() === 'string' && resolvedPath().length > 0

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
    if (level >= 3) errors.push(message) // 3=error only
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-gone: ' + d.reason))

  registerIpc(() => win)

  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))

  // Each invoke is raced against a timer: an unsettled promise must surface as a
  // failed check, not as a wedged process the runner kills with no verdict.
  const script = `(async () => {
    const withTimeout = (p, ms) => Promise.race([
      p.then((v) => ({ ok: true, v })),
      new Promise((r) => setTimeout(() => r({ ok: false, v: null }), ms))
    ])
    const shells1 = await withTimeout(window.api.shells.list(), 15000)
    const agents1 = await withTimeout(window.api.agents.list(), 15000)
    const shells2 = await withTimeout(window.api.shells.list(), 15000)
    const agents2 = await withTimeout(window.api.agents.list(), 15000)
    return {
      shellsResolved: shells1.ok && shells2.ok,
      agentsResolved: agents1.ok && agents2.ok,
      shellCount: Array.isArray(shells1.v) ? shells1.v.length : -1,
      agentsIsArray: Array.isArray(agents1.v),
      // A shell entry the renderer can actually spawn from.
      shellUsable: Array.isArray(shells1.v) && shells1.v.every(
        (s) => s && typeof s.id === 'string' && typeof s.command === 'string' && s.command.length > 0
      ),
      // The second call must agree with the first — a cache that answers
      // differently means panes and the + menu disagree about what exists.
      stable: JSON.stringify(shells1.v) === JSON.stringify(shells2.v)
        && JSON.stringify(agents1.v) === JSON.stringify(agents2.v)
    }
  })()`

  let result
  try {
    result = await win.webContents.executeJavaScript(script, true)
  } catch (e) {
    console.log('[envpath] executeJavaScript failed:', e.message)
    app.exit(5)
    return
  }

  // 5. The remembered answer. Only meaningful where a harvest actually runs.
  let noteOk = true
  let noteDetail = 'skipped (win32 inherits a correct PATH)'
  if (!isWin) {
    // The handlers above already awaited whenPathReady(), so on a first run the
    // harvest has settled by now. It can legitimately fail (no $SHELL, an rc
    // file that hangs) — in which case there is nothing to remember and the
    // fallback dirs carry the launch, so an absent note is not a failure.
    if (fs.existsSync(NOTE)) {
      try {
        const note = JSON.parse(fs.readFileSync(NOTE, 'utf8'))
        noteOk = typeof note.path === 'string' && note.path.length > 0 && typeof note.shell === 'string'
        noteDetail = noteOk ? 'written (' + note.path.split(':').length + ' dirs)' : 'malformed'
      } catch (e) {
        noteOk = false
        noteDetail = 'unreadable: ' + e.message
      }
    } else {
      noteDetail = 'absent (harvest found nothing — fallback dirs in use)'
    }
  }

  console.log('[envpath] prime() non-blocking : ' + primeNonBlocking + ' (' + primeMs + 'ms)')
  console.log('[envpath] PATH usable at once  : ' + pathUsableImmediately)
  console.log('[envpath] shells:list resolved : ' + result.shellsResolved)
  console.log('[envpath] shells usable        : ' + result.shellUsable + ' (' + result.shellCount + ' found)')
  console.log('[envpath] agents:list resolved : ' + result.agentsResolved)
  console.log('[envpath] agents is array      : ' + result.agentsIsArray)
  console.log('[envpath] repeat call stable   : ' + result.stable)
  console.log('[envpath] remembered PATH note : ' + noteDetail)
  console.log('[envpath] console errors       : ' + (errors.length ? errors.join(' | ') : 'none'))

  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  const pass =
    primeNonBlocking &&
    pathUsableImmediately &&
    result.shellsResolved &&
    result.agentsResolved &&
    result.shellUsable &&
    result.shellCount > 0 &&
    result.agentsIsArray &&
    result.stable &&
    noteOk &&
    errors.length === 0
  console.log('[envpath] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  clearTimeout(timer)
  // See phase1-smoke for why this is app.exit on a delay rather than process.exit.
  setTimeout(() => app.exit(pass ? 0 : 2), 250)
})

const timer = setTimeout(() => {
  console.log('[envpath] TIMEOUT')
  app.exit(3)
}, 60000)
