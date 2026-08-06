// Off-screen pane buffering — the safety net for the drawing-cost pass.
//
// A pane that cannot be seen stops feeding xterm and buffers its agent's output
// instead: the DOM renderer otherwise pays a full ANSI parse plus DOM mutation
// for every write into a subtree the compositor skips entirely. Two states
// qualify (see src/renderer/src/paneVisibility.ts):
//
//   - the pane sits behind a MAXIMIZED sibling
//   - the pane's workspace is a BACKGROUND tab
//
// The invariant this guards is the dangerous half: the buffer used to drain on a
// 400ms timer, so even a broken flush path still ended up on screen eventually.
// That timer is gone — coming back on screen is now the ONLY route from buffer
// to glass. If App's flush-on-activation ever stops firing, a background agent's
// output would appear frozen with no error anywhere. That is precisely the kind
// of silent regression this repo cannot afford, so it is asserted end-to-end:
//
//   1. output written while off-screen does NOT reach the rendered rows
//      (fails if the buffering is removed)
//   2. it DOES reach them once the pane is on screen again
//      (fails if the flush registry or the App effect driving it breaks)
//
// The agents themselves never stop: this only ever defers PAINTING.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()
app.setPath('userData', join(os.tmpdir(), 'spymaster-offscreen-ud-' + process.pid))

const A = join(os.tmpdir(), 'spymaster-offscreen-A-' + process.pid)
const B = join(os.tmpdir(), 'spymaster-offscreen-B-' + process.pid)
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

/**
 * Text in the pane's xterm BUFFER — what has actually been WRITTEN to the
 * terminal. Every assertion here reads this rather than the rendered DOM rows,
 * for two reasons:
 *
 *  - The DOM cannot tell the two worlds apart. A subtree with
 *    content-visibility:hidden renders nothing whether the write happened or
 *    not, so a DOM probe reads empty either way and would pass with the
 *    buffering removed — testing nothing.
 *  - Painting is Chromium's business, not this app's. xterm renders through a
 *    requestAnimationFrame debouncer, and a window that is hidden, minimized or
 *    merely occluded stops producing frames, leaving a queued callback pending
 *    indefinitely. Asserting on pixels would make this smoke flap on window
 *    occlusion — a condition no user can be in while switching workspaces.
 *
 * The contract this app owns is "off-screen output reaches the terminal, whole
 * and in order, the moment the pane is back". That is exactly what the buffer
 * records.
 */
const bufferText = (id) => `window.__spymasterTerminalText(${JSON.stringify(id)})`

/**
 * Poll `check` until it returns truthy, or give up after `ms`.
 *
 * The positive assertions must not ride on fixed sleeps: a loaded CI runner can
 * take far longer to resolve a cwd, spawn two shells and boot PowerShell than a
 * developer's machine, and a smoke that fails a green change is worse than no
 * smoke at all. Absence cannot be polled for, so the "held back" checks keep a
 * generous fixed wait — but they are self-validating, because the matching
 * "replayed" assertion right after them fails if the output never arrived.
 */
/**
 * Budget for a replay assertion, and it must stay SHORT.
 *
 * The flush is a React effect off a store change: it lands in tens of
 * milliseconds, and nothing about it waits on a frame. But the buffer is also
 * drained incidentally by ANY output that arrives while the pane is on screen
 * (the on-screen branch flushes before writing), and stray pty output — a
 * prompt redraw after the refit's resize — shows up a second or two later. Give
 * this assertion a generous deadline and it stops testing the flush at all: it
 * passed with flushAgents() commented out entirely.
 *
 * A second cleanly separates the two. The genuinely slow things here (spawning
 * two shells) get their own long budgets; this one must not borrow them.
 */
const REPLAY_MS = 1000

const waitFor = async (check, ms) => {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

/** Type a line into a pane's pty, exactly as the pane itself would. */
const emit = (ptyId, text) =>
  run(`window.api.pty.write(${JSON.stringify(ptyId)}, ${JSON.stringify(text + '\r')})`)

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
  await sleep(900) // boot + shell detection (panes hold their spawn until it lands)

  // Two agents in one repo workspace. Shared dir, not worktrees: this test is
  // about painting, and a worktree per agent only adds git latency.
  const gitA = await run(`window.api.git.info(${JSON.stringify(A)})`)
  await run(`${store}.setSetting('defaultIsolation','shared')`)
  await run(
    `${store}.openWorkspace({path:${JSON.stringify(A)},name:'A'}, null, ${JSON.stringify(gitA)})`
  )
  await sleep(400)
  await run(`${store}.addAgent()`)
  await run(`${store}.addAgent()`)
  // Wait for BOTH ptys to exist rather than guessing a duration: cwd resolution,
  // two spawns and the quiet-boot reveal (whose own safety net is 2.5s) all have
  // to land first, and that is much slower on a loaded runner.
  const spawned = await waitFor(
    async () => {
      const p = await run(`(${wsA}).agents.map(a=>a.ptyId)`)
      return p.length === 2 && p.every(Boolean)
    },
    30000
  )
  // The reveal clears the screen (term.reset), so let it happen before writing —
  // otherwise the baseline marker is wiped by the boot sequence that follows it.
  await sleep(1500)

  const ids = await run(`(${wsA}).agents.map(a=>a.id)`)
  const ptyIds = await run(`(${wsA}).agents.map(a=>a.ptyId)`)

  // --- Baseline: a visible pane paints as it always did. --------------------
  await emit(ptyIds[1], 'echo VISIBLEMARK')
  const visibleWritten = await waitFor(
    async () => (await run(bufferText(ids[1]))).includes('VISIBLEMARK'),
    15000
  )

  // --- 1. Behind a maximized sibling: buffered, then replayed. --------------
  await run(`${store}.focusTerminal(${JSON.stringify(ids[0])})`)
  await sleep(500)
  await emit(ptyIds[1], 'echo HIDDENBYMAX')
  // Far longer than the 400ms timer that used to drain this — if buffering has
  // been removed (or never applied to the maximize case) the text is on screen
  // well before this returns.
  await sleep(1800)
  // Not written to xterm at all — the optimisation itself. Reading the BUFFER
  // (not the DOM) is what makes this fail if the buffering is removed.
  const maxHeldBack = !(await run(bufferText(ids[1]))).includes('HIDDENBYMAX')

  await run(`${store}.clearFocus()`)
  // Correctness check, NOT a guard on the flush: releasing a maximize really
  // does resize this pane, the shell redraws, and that output drains the buffer
  // on its own — so this stays true even with flushAgents() removed. The TAB
  // case below is the one that actually guards the flush path, because a tab
  // switch resizes nothing and so produces no output to piggyback on.
  // DELIBERATELY TIGHT (see REPLAY_MS) all the same.
  const maxReplayed = await waitFor(
    async () => (await run(bufferText(ids[1]))).includes('HIDDENBYMAX'),
    REPLAY_MS
  )

  // --- 2. In a background workspace: buffered, then replayed. ---------------
  const gitB = await run(`window.api.git.info(${JSON.stringify(B)})`)
  await run(
    `${store}.openWorkspace({path:${JSON.stringify(B)},name:'B'}, null, ${JSON.stringify(gitB)})`
  )
  await sleep(700)
  const wsSwitched = (await run(`${store}.activeWorkspaceId`)) !== (await run(`(${wsA}).id`))

  await emit(ptyIds[1], 'echo HIDDENBYTAB')
  await sleep(1800)
  const tabHeldBack = !(await run(bufferText(ids[1]))).includes('HIDDENBYTAB')

  await run(`${store}.setActiveWorkspace((${wsA}).id)`)
  const tabReplayed = await waitFor(
    async () => (await run(bufferText(ids[1]))).includes('HIDDENBYTAB'),
    REPLAY_MS
  )

  // The agent kept running the whole time — everything it printed while
  // off-screen is present, in order, once it comes back.
  const finalText = await run(bufferText(ids[1]))
  const nothingLost =
    finalText.includes('VISIBLEMARK') &&
    finalText.includes('HIDDENBYMAX') &&
    finalText.includes('HIDDENBYTAB') &&
    finalText.indexOf('HIDDENBYMAX') < finalText.indexOf('HIDDENBYTAB')

  const realErrors = errors.filter(
    (e) => !/update|feedback|net::|ERR_|Failed to fetch|ECONNREFUSED|getaddrinfo|favicon/i.test(e)
  )

  console.log('[offscreen] two agents spawned    : ' + spawned)
  console.log('[offscreen] visible pane writes   : ' + visibleWritten)
  console.log('[offscreen] behind maximize held  : ' + maxHeldBack)
  console.log('[offscreen] replays on un-maximize: ' + maxReplayed)
  console.log('[offscreen] workspace switched    : ' + wsSwitched)
  console.log('[offscreen] background tab held   : ' + tabHeldBack)
  console.log('[offscreen] replays on tab return : ' + tabReplayed)
  console.log('[offscreen] nothing lost, in order: ' + nothingLost)
  console.log('[offscreen] console errors        : ' + (errors.length ? errors.join(' | ') : 'none'))

  const pass =
    spawned &&
    visibleWritten &&
    maxHeldBack &&
    maxReplayed &&
    wsSwitched &&
    tabHeldBack &&
    tabReplayed &&
    nothingLost &&
    realErrors.length === 0
  console.log('[offscreen] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  cleanup()
  clearTimeout(timer)
  // Live PTYs: let node-pty's native teardown settle before exiting, or the
  // process segfaults (139) and a passing smoke reports as a CI failure.
  setTimeout(() => app.exit(pass ? 0 : 2), 250)
}).catch((e) => {
  console.log('[offscreen] EXCEPTION: ' + (e && e.stack ? e.stack : e))
  cleanup()
  app.exit(4)
})

const timer = setTimeout(() => {
  console.log('[offscreen] TIMEOUT')
  cleanup()
  app.exit(3)
}, 90000)
