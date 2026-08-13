// File-panel integration smoke test. Loads the BUILT renderer in a hidden window
// and drives the real preload bridge for the file:* API added for the right-side
// file explorer/editor:
//   1. window.api.file exists with tree/read/save/watch/unwatch/onChanged
//   2. tree() lists one dir, dirs-first, includes dotfiles + node_modules (not walked)
//   3. read() classifies text / image(dataUrl) / binary(NUL) / tooLarge(>2MB)
//   4. resolveWithin blocks '..' traversal (read/tree outside root => empty)
//   5. save() writes; a stale mtime => {conflict}; override via expectedMtimeMs:0
//   6. watch()+onChanged() fires when a file under root changes on disk
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()

const TMP = join(os.tmpdir(), 'agentmaster-file-smoke-' + process.pid)
fs.mkdirSync(join(TMP, 'sub'), { recursive: true })
fs.mkdirSync(join(TMP, 'node_modules'), { recursive: true })

// Fixtures.
fs.writeFileSync(join(TMP, 'a.txt'), 'hello world')
fs.writeFileSync(join(TMP, '.dotfile'), 'secret')
fs.writeFileSync(join(TMP, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 16, 0x61)) // >2MB of 'a'
fs.writeFileSync(join(TMP, 'bin.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43])) // has NUL
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
fs.writeFileSync(join(TMP, 'img.png'), PNG)
fs.writeFileSync(join(TMP, 'sub', 'nested.txt'), 'nested')
fs.writeFileSync(join(TMP, 'node_modules', 'junk.js'), 'module.exports={}')

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

  const ROOT = JSON.stringify(TMP)
  const script = `(async () => {
    const f = window.api && window.api.file
    const hasApi = !!(f && f.tree && f.read && f.save && f.watch && f.unwatch && f.onChanged)
    if (!hasApi) return { hasApi }

    const root = ${ROOT}

    // tree(root, '')
    const top = await f.tree(root, '')
    const names = top.entries.map(e => e.name)
    const dirsFirst = (() => {
      const kinds = top.entries.map(e => e.kind)
      const lastDir = kinds.lastIndexOf('dir')
      const firstFile = kinds.indexOf('file')
      return firstFile === -1 || lastDir === -1 || lastDir < firstFile
    })()
    const hasDot = names.includes('.dotfile')
    const hasNodeModules = names.includes('node_modules')
    const sub = await f.tree(root, 'sub')
    const subOk = sub.entries.length === 1 && sub.entries[0].name === 'nested.txt'

    // read classifications
    const txt = await f.read(root, 'a.txt')
    const txtOk = txt.content === 'hello world' && !txt.isBinary && !txt.tooLarge && txt.mtimeMs > 0
    const big = await f.read(root, 'big.txt')
    const bigOk = big.tooLarge === true && big.content === undefined
    const bin = await f.read(root, 'bin.dat')
    const binOk = bin.isBinary === true && bin.content === undefined
    const img = await f.read(root, 'img.png')
    const imgOk = typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/png;base64,')

    // containment: '..' must not escape
    const escRead = await f.read(root, '../a.txt')
    const escReadBlocked = !escRead.content && escRead.mtimeMs === 0
    const escTree = await f.tree(root, '..')
    const escTreeBlocked = Array.isArray(escTree.entries) && escTree.entries.length === 0

    // save happy path + conflict + override
    const before = await f.read(root, 'a.txt')
    const s1 = await f.save(root, 'a.txt', 'v2 content', before.mtimeMs)
    const s1Ok = s1.ok === true && s1.mtimeMs > 0
    // stale mtime (use the ORIGINAL mtime again though file just changed) => conflict
    const s2 = await f.save(root, 'a.txt', 'v3 stale', before.mtimeMs)
    const conflictOk = s2.ok === false && s2.conflict === true
    // override
    const s3 = await f.save(root, 'a.txt', 'v3 override', 0)
    const overrideOk = s3.ok === true

    // watch + onChanged
    const watched = await new Promise((resolve) => {
      let done = false
      const off = f.onChanged((p) => {
        if (!done && p && p.root === root) { done = true; off(); f.unwatch(); resolve(true) }
      })
      f.watch(root)
      // signal the node side that the watcher is armed
      console.log('SMOKE_WATCH_ARMED')
      setTimeout(() => { if (!done) { off(); f.unwatch(); resolve(false) } }, 6000)
    })

    return { hasApi, names, dirsFirst, hasDot, hasNodeModules, subOk,
      txtOk, bigOk, binOk, imgOk, escReadBlocked, escTreeBlocked,
      s1Ok, conflictOk, overrideOk, watched, savedContent: (await f.read(root,'a.txt')).content }
  })()`

  // When the renderer logs SMOKE_WATCH_ARMED, mutate a file so onChanged fires.
  win.webContents.on('console-message', (_e, _l, message) => {
    if (message.includes('SMOKE_WATCH_ARMED')) {
      setTimeout(() => {
        try {
          fs.writeFileSync(join(TMP, 'a.txt'), 'changed on disk ' + Date.now())
        } catch {
          /* ignore */
        }
      }, 400)
    }
  })

  let r
  try {
    r = await win.webContents.executeJavaScript(script, true)
  } catch (e) {
    console.log('[file] executeJavaScript failed:', e.message)
    app.exit(5)
    return
  }

  const disk = fs.existsSync(join(TMP, 'a.txt')) ? fs.readFileSync(join(TMP, 'a.txt'), 'utf8') : ''

  const line = (k, v) => console.log('[file] ' + k.padEnd(24) + ': ' + v)
  line('file api present', r.hasApi)
  if (r.hasApi) {
    line('tree entries', (r.names || []).join(','))
    line('dirs-first', r.dirsFirst)
    line('dotfile listed', r.hasDot)
    line('node_modules listed', r.hasNodeModules)
    line('subdir lazy list', r.subOk)
    line('read text', r.txtOk)
    line('read >2MB tooLarge', r.bigOk)
    line('read binary (NUL)', r.binOk)
    line('read image dataUrl', r.imgOk)
    line('block ../ read', r.escReadBlocked)
    line('block ../ tree', r.escTreeBlocked)
    line('save ok', r.s1Ok)
    line('stale => conflict', r.conflictOk)
    line('override (mtime 0)', r.overrideOk)
    line('watch onChanged fired', r.watched)
  }
  line('console errors', errors.length ? errors.join(' | ') : 'none')

  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  const pass =
    r.hasApi &&
    r.dirsFirst &&
    r.hasDot &&
    r.hasNodeModules &&
    r.subOk &&
    r.txtOk &&
    r.bigOk &&
    r.binOk &&
    r.imgOk &&
    r.escReadBlocked &&
    r.escTreeBlocked &&
    r.s1Ok &&
    r.conflictOk &&
    r.overrideOk &&
    r.watched &&
    errors.length === 0
  console.log('[file] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
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

const timer = setTimeout(() => {
  console.log('[file] TIMEOUT')
  app.exit(3)
}, 30000)
