// Clipboard-routing smoke.
//
// On macOS the Edit menu owns ⌘C/⌘V/⌘A — AppKit consumes the keystroke before
// the page sees it — so Chromium's own editing never runs and the renderer has
// to decide where each command goes. Surfaces that aren't <input> (the file
// editor's contenteditable, a plain selection in the diff) are handed BACK to
// Chromium over `edit:native`. Before that they fell through to the "nothing is
// focused" branch and landed on a TERMINAL: ⌘V typed the clipboard onto a
// running agent's command line and ⌘C replaced the clipboard with scrollback.
//
// handleMenuEdit's routing is unit-tested. What no unit test can cover is the
// half this fix leans on: that webContents.copy/paste/selectAll actually reach
// those surfaces. That's Chromium behaviour, so it needs the real thing —
// the real preload, the real IPC registration, the real renderer bundle.
//
//   1. paste     — clipboard text is inserted into a focused contenteditable
//   2. copy      — a plain DOM selection reaches the OS clipboard verbatim
//   3. selectAll — selects the focused editable, not the whole document
//
// Deliberately platform-agnostic: the trigger is macOS-only but the mechanism
// is Blink's, and CI runs on Windows.
const { app, BrowserWindow, clipboard } = require('electron')
const { join } = require('path')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

app.disableHardwareAcceleration()

const PASTE_TEXT = 'CB_PASTED_FROM_CLIPBOARD'
const COPY_TEXT = 'CB_SELECTED_IN_THE_DIFF'
const SENTINEL = 'CB_NOTHING_HAPPENED'
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

  // Blink's editing commands act on the focused element of the focused frame.
  // A never-shown window can leave the frame unfocused, which would fail the
  // legs below for a reason that has nothing to do with the routing.
  win.showInactive()
  win.webContents.focus()

  let pass = true
  const check = (name, ok, detail) => {
    console.log('[cb] ' + name.padEnd(24) + ': ' + (ok ? 'ok' : 'FAILED') + (detail ? ' — ' + detail : ''))
    if (!ok) pass = false
  }

  // ---- 1. paste reaches a contenteditable (the file editor) ----------------
  clipboard.writeText(PASTE_TEXT)
  const pasted = await win.webContents.executeJavaScript(
    `(async () => {
      const cm = document.createElement('div')
      cm.id = 'cb-editor'
      cm.className = 'cm-content'
      cm.setAttribute('contenteditable', 'true')
      cm.tabIndex = 0
      cm.textContent = ''
      document.body.appendChild(cm)
      cm.focus()
      if (document.activeElement !== cm) return 'NOT_FOCUSED'
      window.api.menu.nativeEdit('paste')
      // The IPC is fire-and-forget and the insertion lands a tick later.
      for (let i = 0; i < 60; i++) {
        if (cm.textContent) break
        await new Promise((r) => setTimeout(r, 50))
      }
      return cm.textContent
    })()`,
    true
  )
  check('paste → file editor', pasted === PASTE_TEXT, 'got ' + JSON.stringify(pasted))

  // ---- 2. copy takes a plain DOM selection ---------------------------------
  // The sentinel is what a broken route leaves behind: if copy never happens,
  // the clipboard still reads back the value nothing overwrote.
  clipboard.writeText(SENTINEL)
  const selected = await win.webContents.executeJavaScript(
    `(async () => {
      // Real class: the stylesheet opts .diff__body back into user-select, and a
      // user-select:none region would copy nothing however correct the routing.
      const diff = document.createElement('div')
      diff.className = 'diff__body'
      diff.textContent = ${JSON.stringify(COPY_TEXT)}
      document.body.appendChild(diff)
      document.getElementById('cb-editor')?.blur()
      const range = document.createRange()
      range.selectNodeContents(diff)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      window.api.menu.nativeEdit('copy')
      await new Promise((r) => setTimeout(r, 400))
      return String(sel)
    })()`,
    true
  )
  // Poll: the copy crosses two process boundaries before the OS clipboard has it.
  let copied = ''
  for (let i = 0; i < 40; i++) {
    copied = clipboard.readText()
    if (copied !== SENTINEL) break
    await new Promise((r) => setTimeout(r, 50))
  }
  check('DOM selection was made', selected === COPY_TEXT, 'got ' + JSON.stringify(selected))
  check('copy → OS clipboard', copied === COPY_TEXT, 'got ' + JSON.stringify(copied))

  // ---- 3. selectAll lands on the focused editable --------------------------
  const selectedAll = await win.webContents.executeJavaScript(
    `(async () => {
      const cm = document.getElementById('cb-editor')
      window.getSelection().removeAllRanges()
      cm.focus()
      window.api.menu.nativeEdit('selectAll')
      for (let i = 0; i < 60; i++) {
        if (String(window.getSelection())) break
        await new Promise((r) => setTimeout(r, 50))
      }
      return String(window.getSelection())
    })()`,
    true
  )
  // Equality, not containment: selecting the whole DOCUMENT would also contain
  // the editor's text, and that is a different (wrong) outcome.
  check('selectAll → file editor', selectedAll === PASTE_TEXT, 'got ' + JSON.stringify(selectedAll))

  console.log('[cb] console errors        : ' + (errors.length ? errors.join(' | ') : 'none'))
  if (errors.length) pass = false
  console.log('[cb] RESULT: ' + (pass ? 'PASS' : 'FAIL'))
  clearTimeout(timer)
  setTimeout(() => app.exit(pass ? 0 : 2), 250)
})

const timer = setTimeout(() => {
  console.log('[cb] TIMEOUT')
  app.exit(3)
}, 45000)
