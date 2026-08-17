// File-panel OPERATIONS smoke test.
//
// file-smoke.cjs covers the read side (list, read, save, watch). This covers the
// write side added for create/rename/move/copy/delete, driven through the real
// preload bridge and the real IPC handlers:
//   1. window.api.file exposes create/rename/move/copyInto/remove/import/
//      snapshot/restore/absPath/dirtyPaths
//   2. create() makes a file, makes intermediate folders for a path with
//      slashes, and treats a trailing slash as "folder"
//   3. create() reports a conflict instead of truncating what is already there
//   4. rename() moves within the folder; move() moves between folders
//   5. move() onto an existing name reports a conflict and leaves BOTH files
//      intact; overwrite:true replaces
//   6. move() refuses to put a folder inside itself
//   7. copyInto() auto-renames to "name copy.ext" instead of clobbering
//   8. remove() goes through the OS trash (never fs.rm) and reports refusals
//   9. snapshot()/restore() round-trip a file's bytes, so a delete can be undone
//  10. dirtyPaths() reports uncommitted work under a git root
//  11. CONTAINMENT: every one of these refuses '..', an absolute path, and a
//      symlink pointing outside the root — asserted per operation, and asserted
//      by checking the outside file is still there afterwards
//
// SHAPE: this is a MODULE first and a standalone runner second.
//
// CI runs the file panel's coverage as one already-wired step
// (`run-smoke.cjs file`), and file-smoke.cjs drives the exports below on the
// same window so both halves report through a single RESULT line. Wiring a
// second workflow step would be the more obvious structure, but a smoke that is
// not in CI does not exist — and folding into the step that already runs is the
// way to be certain this one is. `npm run smoke:fileops` still runs it alone,
// which is what you want while iterating on it.
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')

/** Build the fixtures. BASE holds the scope root plus a sibling the tests try
 *  (and must fail) to reach — `outside.txt` living OUTSIDE the root is the
 *  whole point of the containment half. */
function prepare() {
  const BASE = join(os.tmpdir(), 'agentmaster-fileops-smoke-' + process.pid)
  const ROOT_DIR = join(BASE, 'scope')
  fs.mkdirSync(join(ROOT_DIR, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(join(BASE, 'outside.txt'), 'MUST SURVIVE')
  fs.writeFileSync(join(ROOT_DIR, 'src', 'a.txt'), 'body-a')
  fs.writeFileSync(join(ROOT_DIR, 'src', 'b.txt'), 'body-b')
  fs.writeFileSync(join(ROOT_DIR, 'keep.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))

  // A symlink INSIDE the root pointing outside it. The lexical guard cannot see
  // this; the strict one used by every write operation must.
  let symlinkMade = false
  try {
    fs.symlinkSync(BASE, join(ROOT_DIR, 'escape-link'), 'dir')
    symlinkMade = true
  } catch {
    // Some CI filesystems refuse symlink creation — skip that assertion rather
    // than failing the whole smoke for an unrelated reason.
  }

  // A git repo so dirtyPaths() has something real to report.
  let gitReady = false
  try {
    const g = (...args) =>
      execFileSync('git', args, { cwd: ROOT_DIR, stdio: 'pipe', windowsHide: true })
    g('init', '-q')
    g('config', 'user.email', 'smoke@example.com')
    g('config', 'user.name', 'Smoke')
    g('add', 'src/a.txt')
    g('commit', '-qm', 'first')
    gitReady = true
  } catch {
    /* no git available — that assertion is skipped below */
  }

  return { BASE, ROOT_DIR, symlinkMade, gitReady }
}

/** The renderer-side half, as a string for executeJavaScript. */
function buildScript(ctx) {
  const ROOT = JSON.stringify(ctx.ROOT_DIR)
  const HAS_LINK = JSON.stringify(ctx.symlinkMade)
  return `(async () => {
    const f = window.api && window.api.file
    const hasApi = !!(f && f.create && f.rename && f.move && f.copyInto && f.remove &&
                      f.removePermanently && f.import && f.snapshot && f.restore &&
                      f.absPath && f.dirtyPaths)
    if (!hasApi) return { hasApi }

    const root = ${ROOT}
    const hasLink = ${HAS_LINK}
    const names = async (rel) => (await f.tree(root, rel)).entries.map(e => e.name)
    const kindOf = async (rel, name) =>
      ((await f.tree(root, rel)).entries.find(e => e.name === name) || {}).kind

    // --- create -----------------------------------------------------------
    const c1 = await f.create(root, 'made.txt', 'file')
    const createdOk = c1.ok && (await names('')).includes('made.txt')

    const c2 = await f.create(root, 'mk/deeper/leaf.txt', 'file')
    const intermediateOk = c2.ok && (await names('mk/deeper')).includes('leaf.txt')

    const c3 = await f.create(root, 'trailing/', 'file')
    const trailingSlashIsFolder = c3.ok && (await kindOf('', 'trailing')) === 'dir'

    // Must NOT truncate what is already there.
    const c4 = await f.create(root, 'src/a.txt', 'file')
    const conflictNoTruncate =
      c4.ok === false && c4.conflict === true &&
      (await f.read(root, 'src/a.txt')).content === 'body-a'

    // --- rename / move ----------------------------------------------------
    const r1 = await f.rename(root, 'made.txt', 'renamed.txt')
    const renameOk = r1.ok && r1.rel === 'renamed.txt' &&
      (await f.read(root, 'renamed.txt')).content === ''

    const m1 = await f.move(root, 'renamed.txt', 'src/deep/renamed.txt')
    const moveOk = m1.ok && (await names('src/deep')).includes('renamed.txt')

    // Onto an existing name: refuse, and leave BOTH sides untouched.
    const m2 = await f.move(root, 'src/b.txt', 'src/a.txt')
    const moveConflictOk =
      m2.ok === false && m2.conflict === true &&
      (await f.read(root, 'src/a.txt')).content === 'body-a' &&
      (await f.read(root, 'src/b.txt')).content === 'body-b'

    // …and replace only when explicitly told to.
    const m3 = await f.move(root, 'src/b.txt', 'src/a.txt', { overwrite: true })
    const overwriteOk = m3.ok && (await f.read(root, 'src/a.txt')).content === 'body-b'

    // A folder into its own descendant detaches the subtree on some platforms.
    const m4 = await f.move(root, 'src', 'src/deep/src')
    const selfNestBlocked = m4.ok === false && (await names('')).includes('src')

    // --- copy -------------------------------------------------------------
    await f.create(root, 'cp/one.txt', 'file')
    const cp1 = await f.copyInto(root, 'cp/one.txt', 'cp')
    const copyRenamesOk = cp1.ok && cp1.rel === 'cp/one copy.txt' &&
      (await names('cp')).includes('one.txt') && (await names('cp')).includes('one copy.txt')
    const cp2 = await f.copyInto(root, 'cp/one.txt', 'cp')
    const copySeriesOk = cp2.ok && cp2.rel === 'cp/one copy 2.txt'

    // --- snapshot / restore (what makes an undo possible) -----------------
    const snaps = await f.snapshot(root, ['keep.bin'])
    const snapshotOk = snaps.length === 1 && snaps[0].kind === 'file' && !!snaps[0].content
    // A folder yields no bytes — that is what marks a folder delete un-undoable.
    const dirSnaps = await f.snapshot(root, ['src'])
    const dirSnapshotEmpty = dirSnaps.length === 1 && dirSnaps[0].kind === 'dir' &&
      dirSnaps[0].content === undefined

    // --- delete (OS trash) ------------------------------------------------
    // A headless CI session may have no working trash. That is an environment
    // limitation, not a regression — so the assertion is the CONTRACT rather
    // than the outcome: either it succeeded and the file is gone, or it was
    // refused and the file is STILL THERE. What must never happen is a refusal
    // that quietly hard-deleted the file anyway.
    const d1 = await f.remove(root, ['cp/one copy.txt'])
    const stillThere = (await names('cp')).includes('one copy.txt')
    const trashOk = d1.ok ? !stillThere && d1.failed.length === 0 : stillThere
    const trashWorks = d1.ok

    // Restoring a snapshot puts the bytes back where they were. Only meaningful
    // if the delete actually happened.
    let restoreOk = true
    if (trashWorks) {
      await f.remove(root, ['keep.bin'])
      const gone = !(await names('')).includes('keep.bin')
      const restored = await f.restore(root, snaps)
      restoreOk = gone && restored[0].ok && (await names('')).includes('keep.bin')
    }

    // --- dirty paths ------------------------------------------------------
    // cp/one.txt was created by this smoke and never added → UNTRACKED, which
    // git reports deterministically. ghost.txt has never existed → git says
    // nothing about it, so this also proves the handler filters rather than
    // echoing its input back.
    //
    // Deliberately NOT asserting on the committed-then-modified src/a.txt: git's
    // racily-clean heuristic makes a file written in the same timestamp tick as
    // the index look unmodified, and that made this check pass on one CI run and
    // fail on the next for the identical commit. The prefix mapping this used to
    // be the only coverage for now lives in repoRelPrefix/filterDirty, unit
    // tested in git.test.ts where it is deterministic.
    const dirty = await f.dirtyPaths(root, ['cp/one.txt', 'ghost.txt'])

    // --- CONTAINMENT ------------------------------------------------------
    // Every write operation, against '..', an absolute path, and a symlink out.
    const escCreate = (await f.create(root, '../planted.txt', 'file')).ok === false
    const escCreateAbs = (await f.create(root, '/tmp/planted-abs.txt', 'file')).ok === false
    const escMoveOut = (await f.move(root, 'src/a.txt', '../stolen.txt')).ok === false
    const escMoveIn = (await f.move(root, '../outside.txt', 'src/taken.txt')).ok === false
    const escCopy = (await f.copyInto(root, '../outside.txt', 'src')).ok === false
    const escRestore = (await f.restore(root, [
      { rel: '../planted2.txt', kind: 'file', content: 'eA==' }
    ]))[0].ok === false
    const delEsc = await f.remove(root, ['../outside.txt'])
    const escDelete = delEsc.ok === false && delEsc.failed.length === 1
    // rel '' / '.' name the scope root itself — deleting the whole project.
    const delRoot = await f.remove(root, ['', '.'])
    const escDeleteRoot = delRoot.ok === false

    // The symlink case: lexically fine, actually outside.
    let escLinkDelete = true, escLinkCreate = true
    if (hasLink) {
      const l1 = await f.remove(root, ['escape-link/outside.txt'])
      escLinkDelete = l1.ok === false
      escLinkCreate = (await f.create(root, 'escape-link/planted3.txt', 'file')).ok === false
    }

    // absPath resolves inside and refuses outside.
    const absIn = await f.absPath(root, 'src/a.txt')
    const absOut = await f.absPath(root, '../outside.txt')
    const absPathOk = typeof absIn === 'string' && absIn.length > 0 && absOut === null

    return {
      hasApi, createdOk, intermediateOk, trailingSlashIsFolder, conflictNoTruncate,
      renameOk, moveOk, moveConflictOk, overwriteOk, selfNestBlocked,
      copyRenamesOk, copySeriesOk, snapshotOk, dirSnapshotEmpty,
      trashOk, trashWorks, restoreOk, dirty,
      escCreate, escCreateAbs, escMoveOut, escMoveIn, escCopy, escRestore,
      escDelete, escDeleteRoot, escLinkDelete, escLinkCreate, absPathOk
    }
  })()`
}

/** Turn the renderer's report into printable lines plus a verdict. */
function evaluate(r, ctx) {
  const { BASE, ROOT_DIR, symlinkMade, gitReady } = ctx
  const lines = []
  const line = (k, v) => lines.push([k, v])

  // The load-bearing assertions, made from OUTSIDE the renderer: after every
  // escape attempt, the file outside the root is byte-for-byte intact and
  // nothing new was planted next to it.
  const outsideIntact =
    fs.existsSync(join(BASE, 'outside.txt')) &&
    fs.readFileSync(join(BASE, 'outside.txt'), 'utf8') === 'MUST SURVIVE'
  const nothingPlanted =
    !fs.existsSync(join(BASE, 'planted.txt')) &&
    !fs.existsSync(join(BASE, 'planted2.txt')) &&
    !fs.existsSync(join(BASE, 'planted3.txt')) &&
    !fs.existsSync(join(BASE, 'stolen.txt')) &&
    !fs.existsSync('/tmp/planted-abs.txt')
  const rootStillThere = fs.existsSync(ROOT_DIR)

  const dirty = r.dirty || []
  const dirtyOk = !gitReady || (dirty.includes('cp/one.txt') && !dirty.includes('ghost.txt'))

  line('file ops api present', r.hasApi)
  if (r.hasApi) {
    line('create file', r.createdOk)
    line('create intermediate dirs', r.intermediateOk)
    line('trailing slash = folder', r.trailingSlashIsFolder)
    line('conflict, no truncate', r.conflictNoTruncate)
    line('rename', r.renameOk)
    line('move between folders', r.moveOk)
    line('move conflict inert', r.moveConflictOk)
    line('overwrite when told', r.overwriteOk)
    line('self-nest blocked', r.selfNestBlocked)
    line('copy auto-renames', r.copyRenamesOk)
    line('copy series (copy 2)', r.copySeriesOk)
    line('snapshot buffers bytes', r.snapshotOk)
    line('folder snapshot empty', r.dirSnapshotEmpty)
    line(
      'delete via trash',
      r.trashOk + (r.trashWorks ? '' : ' (no OS trash here; refusal was inert)')
    )
    line('restore from snapshot', r.trashWorks ? r.restoreOk : 'skipped (no OS trash)')
    // Print the VERDICT, not just the data. This line used to show only the
    // paths, so when the check failed every printed line still read `true` and
    // the RESULT: FAIL had no visible cause anywhere in the log.
    line(
      'dirty paths',
      gitReady ? `${dirtyOk} (${dirty.join(',') || 'none'})` : 'skipped (no git)'
    )
    line('block ../ create', r.escCreate)
    line('block absolute create', r.escCreateAbs)
    line('block ../ move out', r.escMoveOut)
    line('block ../ move in', r.escMoveIn)
    line('block ../ copy', r.escCopy)
    line('block ../ restore', r.escRestore)
    line('block ../ delete', r.escDelete)
    line('block delete of root', r.escDeleteRoot)
    line('block symlink delete', symlinkMade ? r.escLinkDelete : 'skipped (no symlink)')
    line('block symlink create', symlinkMade ? r.escLinkCreate : 'skipped (no symlink)')
    line('absPath in/out', r.absPathOk)
  }
  line('outside file intact', outsideIntact)
  line('nothing planted outside', nothingPlanted)
  line('scope root still there', rootStillThere)

  const pass = !!(
    r.hasApi &&
    r.createdOk &&
    r.intermediateOk &&
    r.trailingSlashIsFolder &&
    r.conflictNoTruncate &&
    r.renameOk &&
    r.moveOk &&
    r.moveConflictOk &&
    r.overwriteOk &&
    r.selfNestBlocked &&
    r.copyRenamesOk &&
    r.copySeriesOk &&
    r.snapshotOk &&
    r.dirSnapshotEmpty &&
    r.trashOk &&
    r.restoreOk &&
    dirtyOk &&
    r.escCreate &&
    r.escCreateAbs &&
    r.escMoveOut &&
    r.escMoveIn &&
    r.escCopy &&
    r.escRestore &&
    r.escDelete &&
    r.escDeleteRoot &&
    r.escLinkDelete &&
    r.escLinkCreate &&
    r.absPathOk &&
    outsideIntact &&
    nothingPlanted &&
    rootStillThere
  )
  return { lines, pass }
}

function cleanup(ctx) {
  try {
    fs.rmSync(ctx.BASE, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

module.exports = { prepare, buildScript, evaluate, cleanup }

// Standalone mode — `npm run smoke:fileops`, for iterating on this file alone.
// CI reaches the same assertions through file-smoke.cjs.
//
// NOT `require.main === module`: in Electron's MAIN process `require.main` is
// undefined, so that check is false even when this file IS the entry point —
// the block silently never runs and the smoke hangs with no output at all.
// argv is what actually distinguishes the two cases here.
const isEntry = process.argv.some((a) => a.endsWith('file-ops-smoke.cjs'))
if (isEntry) {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()

  const ctx = prepare()
  const errors = []

  app.whenReady().then(async () => {
    const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))
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

    let r
    try {
      r = await win.webContents.executeJavaScript(buildScript(ctx), true)
    } catch (e) {
      console.log('[fileops] executeJavaScript failed:', e.message)
      app.exit(5)
      return
    }

    const { lines, pass } = evaluate(r, ctx)
    for (const [k, v] of lines) console.log('[fileops] ' + k.padEnd(26) + ': ' + v)
    console.log('[fileops] console errors        : ' + (errors.length ? errors.join(' | ') : 'none'))
    cleanup(ctx)

    console.log('[fileops] RESULT: ' + (pass && errors.length === 0 ? 'PASS' : 'FAIL'))
    clearTimeout(timer)
    // app.exit, with a beat for teardown — same reasoning as file-smoke.cjs.
    setTimeout(() => app.exit(pass && errors.length === 0 ? 0 : 2), 250)
  })

  var timer = setTimeout(() => {
    console.log('[fileops] TIMEOUT')
    app.exit(3)
  }, 30000)
}
