import { app, ipcMain, dialog, BrowserWindow, Notification, shell, clipboard } from 'electron'
import { join, basename, isAbsolute } from 'path'
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const pexecFile = promisify(execFile)

// Terminal output is untrusted: a printed path renders as a clickable "file link",
// so opening one must never one-click-execute a binary/script. These extensions
// get revealed in the file manager instead of run.
const UNSAFE_OPEN =
  /\.(exe|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|jar|msi|msix|lnk|app|command|sh|bash|zsh|desktop|reg|hta|wsf|pif|gadget)$/i
import { PtyManager, type SpawnOptions } from './pty-manager'
import {
  getGitInfo,
  getRepoRootSafe,
  initRepo,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  findOrphanWorktrees,
  cleanOrphanWorktrees,
  getAgentDiff,
  mergeAgent,
  applyAgentFiles,
  getDirtyPaths,
  repoRelPrefix,
  filterDirty,
  friendlyGitError
} from './git'
import {
  listDir,
  readFile as readScopedFile,
  saveFile as saveScopedFile,
  createEntry,
  renameEntry,
  moveEntry,
  copyInto,
  deleteEntries,
  deleteEntriesPermanently,
  importFiles,
  snapshotEntry,
  restoreSnapshot,
  resolveWithinReal,
  type EntrySnapshot
} from './scoped-files'
import { createWorkspaceStore } from './workspace-store'
import { detectShells, detectAgents } from './shells'
import { whenPathReady } from './env-path'
import { checkForUpdate, initAutoUpdate } from './update'
import { sendFeedback, FEEDBACK_EMAIL, type FeedbackInput, type FeedbackCategory } from './feedback'

/** Per-project dir holding canvas.json. Legacy: still read for the one-time
 *  migration into the app-data store, and still written by older versions.
 *
 *  FROZEN at the old name through the Agent Master rename, deliberately. Nothing
 *  writes this any more (there is no project:save), so it is a pure read of what
 *  older builds left on disk — renaming it would point the migration at a folder
 *  that by definition can never exist, silently losing the canvas of every user
 *  upgrading from a pre-workspaces build. Same reasoning as the `vectro.`
 *  localStorage keys in the renderer. */
const CANVAS_DIR = '.monad'

/** The app-data file holding every workspace (folder-bound or not). Resolved
 *  lazily — app.getPath('userData') is only valid after the app is ready, and
 *  the integration smoke tests reassign it before registering handlers. */
function workspacesFile(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

/** Atomic, serialized read/write of the tab set. Created at module scope so the
 *  save chain is shared by every handler registration in this process. */
const workspaceStore = createWorkspaceStore(workspacesFile)

/**
 * Registers every main-process IPC handler against a window accessor.
 * Extracted from index.ts so the same wiring can be driven by integration
 * tests, and so Phase 2's git/worktree handlers slot in alongside these.
 * Returns the PtyManager so the caller can kill sessions on quit.
 */
/**
 * Window-backdrop plumbing, supplied by index.ts, which owns the persisted
 * value because it needs it before any renderer exists. Optional so the smoke
 * scripts — which call registerIpc directly, without index.ts — still get a
 * working handler instead of an unhandled-invoke crash.
 */
export interface TranslucencyHooks {
  get: () => boolean
  set: (on: boolean) => void
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  translucency?: TranslucencyHooks
): PtyManager {
  // Fallback state for the no-hooks case, so the channel always answers.
  let localTranslucent = false
  const readTranslucent = (): boolean => translucency?.get() ?? localTranslucent
  const writeTranslucent = (on: boolean): void => {
    localTranslucent = on
    translucency?.set(on)
  }

  // Applied live so the backdrop can be A/B'd against its power cost without a
  // restart; index.ts persists it for the next launch.
  ipcMain.handle('window:get-translucency', () => readTranslucent())
  ipcMain.handle('window:set-translucency', (_e, on: boolean) => {
    writeTranslucent(!!on)
    return readTranslucent()
  })

  // Guard against a destroyed window: a PTY can still emit during teardown,
  // and webContents.send on a destroyed object throws "Object has been destroyed".
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.send(channel, payload)
    }
  }
  // Coalesce PTY output before it crosses IPC: agents stream many tiny chunks,
  // and a webContents.send per chunk costs a renderer wakeup + parse for each.
  // Buffer per session for up to 8ms (under a frame), flushing early if a
  // buffer grows large. Exit flushes first so the final output always lands
  // before the renderer prints its "[process exited]" line.
  const ptyBuffers = new Map<string, string>()
  let ptyFlushTimer: NodeJS.Timeout | null = null
  const flushPtyBuffers = (): void => {
    if (ptyFlushTimer) {
      clearTimeout(ptyFlushTimer)
      ptyFlushTimer = null
    }
    for (const [id, data] of ptyBuffers) send('pty:data', { id, data })
    ptyBuffers.clear()
  }
  const ptyManager = new PtyManager(
    (id, data) => {
      const buf = (ptyBuffers.get(id) ?? '') + data
      ptyBuffers.set(id, buf)
      if (buf.length >= 256 * 1024) flushPtyBuffers()
      else if (!ptyFlushTimer) ptyFlushTimer = setTimeout(flushPtyBuffers, 8)
    },
    (id, code, signal) => {
      flushPtyBuffers()
      send('pty:exit', { id, code, signal })
    }
  )

  ipcMain.handle('pty:spawn', (_e, opts: SpawnOptions) => ptyManager.spawn(opts ?? {}))
  ipcMain.on('pty:input', (_e, { id, data }: { id: string; data: string }) =>
    ptyManager.write(id, data)
  )
  ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
    ptyManager.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, { id }: { id: string }) => ptyManager.kill(id))

  // Clipboard via the main process: the renderer's navigator.clipboard.* is
  // gated on window focus and permissions and rejects intermittently ("Document
  // is not focused"), which surfaced as paste silently failing. The main-process
  // clipboard module is synchronous and has no such gating.
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, { text }: { text: string }) => clipboard.writeText(text))
  // Whether the clipboard holds an image (e.g. a screenshot). Paste can't
  // transmit pixels through a pty — instead the renderer forwards the raw
  // Ctrl+V byte so TUIs that read the OS clipboard themselves (Claude Code
  // image paste) still get their keystroke.
  ipcMain.handle('clipboard:hasImage', () =>
    clipboard.availableFormats().some((f) => f.startsWith('image/'))
  )
  // Files copied in Explorer/Finder: a normal terminal pastes their paths.
  // Formats are per-platform; every read is defensive (formats lie, buffers
  // vary) and failure just means "no files".
  ipcMain.handle('clipboard:readFiles', async (): Promise<string[]> => {
    if (process.platform === 'darwin') {
      try {
        // XML plist with every copied path.
        const plist = clipboard.read('NSFilenamesPboardType')
        const paths = [...plist.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
          m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        )
        if (paths.length) return paths
      } catch {
        /* fall through */
      }
      try {
        const url = clipboard.read('public.file-url')
        if (url) return [decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, ''))]
      } catch {
        /* no files */
      }
      return []
    }
    if (process.platform === 'win32') {
      // Electron can't read the predefined CF_HDROP format directly (only
      // registered format names). FileNameW is the cheap presence probe (it
      // yields just the FIRST file, in short 8.3 form); when it hits, ask the
      // OS for the full long-path list via PowerShell. The spawn (~200ms) only
      // happens when files are actually on the clipboard.
      let first = ''
      try {
        first = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '')
      } catch {
        /* no files */
      }
      if (!first) return []
      try {
        // FileDropList yields FileInfo objects (a formatted table if printed
        // raw) — emit one FullName per line. Async so the ~200ms PowerShell spawn
        // never blocks the main process (all IPC + pty forwarding) on a paste.
        const { stdout } = await pexecFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-Clipboard -Format FileDropList | ForEach-Object { if ($_.FullName) { $_.FullName } else { [string]$_ } }'
          ],
          { encoding: 'utf8', timeout: 3000, windowsHide: true }
        )
        const paths = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        if (paths.length) return paths
      } catch {
        /* fall back to the single short-form path */
      }
      return [first]
    }
    try {
      const uris = clipboard.read('text/uri-list')
      return uris
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('file://'))
        .map((s) => decodeURIComponent(s.replace(/^file:\/\//, '')))
    } catch {
      return []
    }
  })

  // Both answer "what is installed on this machine", so both need the recovered
  // PATH rather than launchd's four dirs. whenPathReady() is instant on every
  // launch after the first (the answer is remembered on disk); only a genuine
  // first run waits here — and it waits with the window already on screen,
  // which is the whole point of not resolving PATH before createWindow.
  ipcMain.handle('shells:list', async () => {
    await whenPathReady()
    return detectShells()
  })
  ipcMain.handle('agents:list', async () => {
    await whenPathReady()
    return detectAgents()
  })

  // App version for display (Settings). app.getVersion() reads package.json in
  // dev and the packaged app metadata in production — same source the update
  // check compares against, so the two can never disagree.
  ipcMain.handle('app:version', () => app.getVersion())

  // Newer-release check against this repo's release feed (null = up to date
  // or the check failed; the renderer surfaces a banner only on a real update).
  // On packaged Windows the check also starts the in-place background download;
  // initAutoUpdate streams its progress to the renderer over `update:state` and
  // handles `update:install` (restart into the downloaded version).
  ipcMain.handle('update:check', () => checkForUpdate())
  initAutoUpdate(getWindow)

  // --- Feedback (bugs / ideas / comments) → maintainer inbox ---
  // The POST runs here (strict renderer CSP can't reach the relay); version and
  // platform are stamped in feedback.ts, not trusted from the renderer.
  ipcMain.handle('feedback:send', (_e, input: FeedbackInput) => sendFeedback(input))

  // Offline fallback: compose a prefilled message in the user's mail client,
  // addressed to the fixed maintainer inbox. Built in main so the mailto target
  // can never be redirected from the renderer.
  ipcMain.handle('feedback:mailto', (_e, input: FeedbackInput) => {
    const cat: FeedbackCategory =
      input?.category === 'bug' || input?.category === 'idea' ? input.category : 'other'
    const label = cat === 'bug' ? 'Bug' : cat === 'idea' ? 'Idea' : 'Comment'
    const version = app.getVersion()
    const bodyLines = [
      (input?.message ?? '').trim(),
      '',
      `— app: Agent Master v${version}`,
      `— platform: ${process.platform} ${process.arch}`
    ]
    if (input?.email) bodyLines.splice(1, 0, `— from: ${input.email}`)
    const url =
      `mailto:${FEEDBACK_EMAIL}` +
      `?subject=${encodeURIComponent(`Agent Master feedback — ${label} (v${version})`)}` +
      `&body=${encodeURIComponent(bodyLines.join('\n'))}`
    void shell.openExternal(url)
    return true
  })

  // --- Wallpaper: pick an image, and read it as a data URL (CSP-safe) ---
  ipcMain.handle('wallpaper:pick', async () => {
    const win = getWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('wallpaper:read', async (_e, p: string) => {
    try {
      const st = await fs.stat(p)
      // Cap so a huge or non-image file can't OOM the main process — the whole
      // file is buffered and base64-inflated (~1.33×) into a data URL.
      if (!st.isFile() || st.size > 40 * 1024 * 1024) return null
      const ext = p.split('.').pop()?.toLowerCase()
      const mime =
        ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'avif'
                ? 'image/avif'
                : 'image/png'
      const buf = await fs.readFile(p)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // Open a URL from a terminal (web-links addon) in the user's real browser.
  ipcMain.handle('open:external', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  // --- File links in terminal output ---
  // Agents constantly print paths ("edited src/foo.ts:42"). The renderer's link
  // provider asks here whether a path-looking token resolves to a real file
  // (relative to the pane's cwd) and opens it in the default editor on click.
  const resolveFileTarget = async (base: string, raw: string): Promise<string | null> => {
    try {
      const cleaned = raw
        .replace(/(?::\d+){1,2}$/, '') // trailing :line(:col)
        .replace(/^['"(<[]+|['")>\],.;]+$/g, '')
      if (!cleaned) return null
      const abs = isAbsolute(cleaned) ? cleaned : join(base, cleaned)
      const st = await fs.stat(abs)
      return st.isFile() ? abs : null
    } catch {
      return null
    }
  }
  ipcMain.handle('path:exists', async (_e, { base, raw }: { base: string; raw: string }) => {
    return (await resolveFileTarget(base, raw)) !== null
  })
  ipcMain.handle('path:open', async (_e, { base, raw }: { base: string; raw: string }) => {
    const abs = await resolveFileTarget(base, raw)
    if (!abs) return false
    // A clickable path from untrusted agent output must not launch an executable
    // or script — reveal it in the file manager instead of running it.
    if (UNSAFE_OPEN.test(abs)) {
      shell.showItemInFolder(abs)
      return true
    }
    void shell.openPath(abs)
    return true
  })

  // --- File explorer / editor (right-side file panel) ---
  // The renderer passes a scope root (a worktree/project path) plus a path
  // relative to it. Containment, the size cap, binary detection and the
  // save-conflict check all live in scoped-files.ts — see the SECURITY BOUNDARY
  // note on resolveWithin there.
  ipcMain.handle('file:tree', (_e, { root, rel }: { root: string; rel: string }) =>
    listDir(root, rel)
  )
  ipcMain.handle('file:read', (_e, { root, rel }: { root: string; rel: string }) =>
    readScopedFile(root, rel)
  )
  ipcMain.handle(
    'file:save',
    (
      _e,
      {
        root,
        rel,
        content,
        expectedMtimeMs
      }: { root: string; rel: string; content: string; expectedMtimeMs: number }
    ) => saveScopedFile(root, rel, content, expectedMtimeMs)
  )

  // --- File operations (create / rename / move / copy / delete / import) ---
  // Every one of these resolves symlinks before acting (resolveWithinReal), not
  // just `..` — a link inside the project must not become a route to write or
  // destroy something outside it. Deleting always means the OS trash: the
  // permanent path is a separate channel the renderer only reaches after the
  // trash has already refused and the user has said so.
  ipcMain.handle(
    'file:create',
    (_e, { root, rel, kind }: { root: string; rel: string; kind: 'file' | 'dir' }) =>
      createEntry(root, rel, kind)
  )
  ipcMain.handle(
    'file:rename',
    (_e, { root, rel, name }: { root: string; rel: string; name: string }) =>
      renameEntry(root, rel, name)
  )
  ipcMain.handle(
    'file:move',
    (
      _e,
      {
        root,
        fromRel,
        toRel,
        overwrite,
        copy
      }: { root: string; fromRel: string; toRel: string; overwrite?: boolean; copy?: boolean }
    ) => moveEntry(root, fromRel, toRel, { overwrite, copy })
  )
  ipcMain.handle(
    'file:copyInto',
    (_e, { root, fromRel, destDirRel }: { root: string; fromRel: string; destDirRel: string }) =>
      copyInto(root, fromRel, destDirRel)
  )
  ipcMain.handle('file:delete', (_e, { root, rels }: { root: string; rels: string[] }) =>
    // shell.trashItem is injected rather than imported by scoped-files so that
    // module stays electron-free and unit-testable. It resolves void and throws
    // on refusal, which is exactly the contract deleteEntries expects.
    deleteEntries(root, rels, async (abs) => shell.trashItem(abs))
  )
  ipcMain.handle('file:deletePermanently', (_e, { root, rels }: { root: string; rels: string[] }) =>
    deleteEntriesPermanently(root, rels)
  )
  ipcMain.handle(
    'file:import',
    (_e, { root, destDirRel, sources }: { root: string; destDirRel: string; sources: string[] }) =>
      importFiles(root, destDirRel, sources)
  )
  ipcMain.handle('file:snapshot', (_e, { root, rels }: { root: string; rels: string[] }) =>
    Promise.all((rels ?? []).map((rel) => snapshotEntry(root, rel))).then((snaps) =>
      snaps.filter((s): s is EntrySnapshot => s !== null)
    )
  )
  ipcMain.handle(
    'file:restore',
    (_e, { root, snapshots }: { root: string; snapshots: EntrySnapshot[] }) =>
      Promise.all((snapshots ?? []).map((s) => restoreSnapshot(root, s)))
  )
  // Absolute path of a rel, for Copy Path / Reveal in Finder. Goes through the
  // same strict guard so the menu can't be used to name something outside.
  ipcMain.handle('file:reveal', async (_e, { root, rel }: { root: string; rel: string }) => {
    const abs = await resolveWithinReal(root, rel)
    if (!abs) return null
    shell.showItemInFolder(abs)
    return abs
  })
  ipcMain.handle('file:absPath', (_e, { root, rel }: { root: string; rel: string }) =>
    resolveWithinReal(root, rel)
  )
  // Which of `rels` have uncommitted work. Drives the extra warning on delete —
  // a committed file is recoverable from git AND the Trash, one with
  // uncommitted changes only from the Trash.
  ipcMain.handle('file:dirtyPaths', async (_e, { root, rels }: { root: string; rels: string[] }) => {
    if (!Array.isArray(rels) || rels.length === 0) return []
    const repoRoot = await getRepoRootSafe(root)
    if (!repoRoot) return []
    const dirty = await getDirtyPaths(repoRoot)
    if (dirty.size === 0) return []
    // Both sides go through realpath before being compared — see repoRelPrefix,
    // where the reasoning and the platform cases live.
    let prefix: string | null = null
    try {
      const [realRoot, realRepo] = await Promise.all([fs.realpath(root), fs.realpath(repoRoot)])
      prefix = repoRelPrefix(realRepo, realRoot)
    } catch {
      return []
    }
    if (prefix === null) return []
    return filterDirty(rels, dirty, prefix)
  })

  // Recursive fs.watch on the scope root, debounced, emitting `file:changed`.
  // ONE watcher per window: a new watch closes the previous one. Recursive watch
  // throws on some platforms (Linux) — on any failure we just no-op.
  let fileWatcher: FSWatcher | null = null
  let fileWatchDebounce: NodeJS.Timeout | null = null
  const closeFileWatcher = (): void => {
    if (fileWatchDebounce) {
      clearTimeout(fileWatchDebounce)
      fileWatchDebounce = null
    }
    if (fileWatcher) {
      try {
        fileWatcher.close()
      } catch {
        /* already closed */
      }
      fileWatcher = null
    }
  }
  ipcMain.on('file:watch', (_e, { root }: { root: string }) => {
    closeFileWatcher()
    if (typeof root !== 'string' || !root) return
    try {
      fileWatcher = fsWatch(root, { recursive: true }, (_event, filename) => {
        // Ignore churn inside .git / node_modules (agents write there constantly).
        const name = filename == null ? '' : filename.toString()
        if (/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(name)) return
        if (fileWatchDebounce) clearTimeout(fileWatchDebounce)
        fileWatchDebounce = setTimeout(() => {
          fileWatchDebounce = null
          send('file:changed', { root })
        }, 300)
      })
      // An FSWatcher can emit 'error' asynchronously long after a successful
      // create (watched path deleted, network share dropped, Windows handle
      // exhaustion). EventEmitter THROWS an unhandled 'error' event, which only
      // the global uncaughtException guard would catch — and would leave
      // fileWatcher pointing at a dead watcher for file:unwatch to close.
      fileWatcher.on('error', (err) => {
        console.error('[agentmaster] file watcher error:', err)
        closeFileWatcher()
      })
    } catch {
      // Recursive watch unsupported / path gone — degrade to no live updates.
      fileWatcher = null
    }
  })
  ipcMain.on('file:unwatch', () => closeFileWatcher())

  // --- Project / canvas persistence (one canvas per project) ---
  ipcMain.handle('project:pick', async () => {
    const win = getWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return { path: r.filePaths[0], name: basename(r.filePaths[0]) }
  })

  ipcMain.handle('project:exists', async (_e, projectPath: string) => {
    try {
      const st = await fs.stat(projectPath)
      return st.isDirectory()
    } catch {
      return false
    }
  })

  ipcMain.handle('project:load', async (_e, projectPath: string) => {
    try {
      const txt = await fs.readFile(join(projectPath, CANVAS_DIR, 'canvas.json'), 'utf8')
      return JSON.parse(txt)
    } catch {
      return null
    }
  })

  // NOTE: there is deliberately no `project:save`. canvas.json is read-only
  // legacy now — workspaces.json is the single source of truth, and a workspace
  // with no folder has nowhere to put a per-project file. The old handler had no
  // callers at all, so canvas.json was being read but never written.

  // --- App-data workspace store ---
  // Single source of truth for the whole tab set since workspaces stopped being
  // folders: one with no folder has no .monad/canvas.json to live in, so the
  // per-project file can't hold the set any more.
  ipcMain.handle('workspaces:load', () => workspaceStore.load())

  ipcMain.handle('workspaces:save', (_e, data: unknown) => workspaceStore.save(data))

  // --- Git / per-agent worktree isolation ---
  ipcMain.handle('git:info', (_e, projectPath: string) => getGitInfo(projectPath))

  // `git init` only (see initRepo) — offered when a non-git folder is opened so
  // the user can unlock worktree isolation without leaving the app.
  ipcMain.handle('git:init', (_e, projectPath: string) => initRepo(projectPath))

  ipcMain.handle('git:prune', async (_e, projectPath: string) => {
    const repoRoot = await getRepoRootSafe(projectPath)
    if (repoRoot) await pruneWorktrees(repoRoot)
    return true
  })

  // Leftover canvas/* worktrees from crashed or force-quit sessions — prune
  // can't remove them (still registered), so the renderer offers a cleanup.
  ipcMain.handle(
    'git:orphans',
    async (
      _e,
      { projectPath, ownedAgentIds }: { projectPath: string; ownedAgentIds: string[] }
    ) => {
      const repoRoot = await getRepoRootSafe(projectPath)
      if (!repoRoot) return []
      return findOrphanWorktrees(repoRoot, Array.isArray(ownedAgentIds) ? ownedAgentIds : [])
    }
  )

  // List→filter→remove happens atomically in here (reusing findOrphanWorktrees):
  // the renderer only ever sends its OWN agent ids, never a path list to act on —
  // nothing untrusted to re-validate, no TOCTOU between listing and removing.
  // Orphans whose removal could lose work (hasWork) are never deleted.
  ipcMain.handle(
    'git:cleanOrphans',
    async (
      _e,
      { projectPath, ownedAgentIds }: { projectPath: string; ownedAgentIds: string[] }
    ) => {
      const repoRoot = await getRepoRootSafe(projectPath)
      if (!repoRoot) return { removed: 0, keptWithWork: 0 }
      return cleanOrphanWorktrees(repoRoot, Array.isArray(ownedAgentIds) ? ownedAgentIds : [])
    }
  )

  // Resolve an agent's working dir: a git worktree when isolated, else the
  // shared project dir. Falls back to shared on any git failure.
  ipcMain.handle(
    'worktree:create',
    async (
      _e,
      { projectPath, agentId, isolation }: { projectPath: string; agentId: string; isolation: string }
    ) => {
      if (isolation !== 'worktree') {
        return { cwd: projectPath, branch: null, isolated: false }
      }
      const repoRoot = await getRepoRootSafe(projectPath)
      if (!repoRoot) {
        return { cwd: projectPath, branch: null, isolated: false, reason: 'Not a git repository' }
      }
      try {
        const wt = await createWorktree(repoRoot, agentId)
        return { cwd: wt.path, branch: wt.branch, isolated: true }
      } catch (e) {
        return {
          cwd: projectPath,
          branch: null,
          isolated: false,
          reason: friendlyGitError(e)
        }
      }
    }
  )

  // Desktop notification when a backgrounded agent needs the user. Clicking it
  // surfaces the window and tells the renderer which terminal to focus.
  ipcMain.handle(
    'notify:agent',
    (_e, { id, title, body }: { id: string; title: string; body: string }) => {
      if (!Notification.isSupported()) return false
      const n = new Notification({ title: title || 'Agent Master', body })
      n.on('click', () => {
        const w = getWindow()
        if (w && !w.isDestroyed()) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        }
        send('notify:click', { id })
      })
      n.show()
      return true
    }
  )

  // OS-level "agents need you" indicator. The renderer reports how many agents
  // are waiting (attention/error/exited); while the window is unfocused the
  // taskbar flashes (Windows/Linux) or the dock badges + bounces (macOS).
  // Flash/bounce only on a rising edge — re-triggering on every report would
  // restart the blink forever while the count sits unchanged. The window's
  // 'focus' handler (index.ts) stops the flash; the dock badge stays until the
  // count actually returns to 0, since it's a passive count, not a nag.
  let attentionCount = 0
  ipcMain.on('attention:set', (_e, { count }: { count: number }) => {
    const prev = attentionCount
    attentionCount = Math.max(0, Math.floor(count) || 0)
    const w = getWindow()
    if (!w || w.isDestroyed()) return
    if (process.platform === 'darwin') {
      app.dock?.setBadge(attentionCount > 0 ? String(attentionCount) : '')
      if (attentionCount > prev && !w.isFocused()) app.dock?.bounce('informational')
    } else if (attentionCount === 0) {
      w.flashFrame(false)
    } else if (attentionCount > prev && !w.isFocused()) {
      w.flashFrame(true)
    }
  })

  ipcMain.handle(
    'worktree:remove',
    async (_e, { projectPath, agentId }: { projectPath: string; agentId: string }) => {
      const repoRoot = await getRepoRootSafe(projectPath)
      if (repoRoot) await removeWorktree(repoRoot, agentId)
      return true
    }
  )

  // --- Diff / merge (review an agent's work) ---
  ipcMain.handle(
    'git:diff',
    async (_e, { projectPath, agentId }: { projectPath: string; agentId: string }) => {
      const info = await getGitInfo(projectPath)
      if (!info.repoRoot) return { branch: '', base: null, diff: '', untracked: [], hasChanges: false }
      return getAgentDiff(info.repoRoot, agentId, info.branch)
    }
  )

  ipcMain.handle(
    'git:merge',
    async (
      _e,
      { projectPath, agentId, message }: { projectPath: string; agentId: string; message: string }
    ) => {
      const info = await getGitInfo(projectPath)
      if (!info.repoRoot) return { ok: false, error: 'Not a git repository' }
      return mergeAgent(info.repoRoot, agentId, message)
    }
  )

  // Partial apply: take the agent's version of selected files onto the current
  // branch as a plain commit (no merge — the branch stays unmerged).
  ipcMain.handle(
    'git:applyFiles',
    async (
      _e,
      {
        projectPath,
        agentId,
        paths,
        deletedPaths,
        message
      }: {
        projectPath: string
        agentId: string
        paths: string[]
        deletedPaths: string[]
        message: string
      }
    ) => {
      const info = await getGitInfo(projectPath)
      if (!info.repoRoot) return { ok: false, error: 'Not a git repository' }
      return applyAgentFiles(info.repoRoot, agentId, paths, deletedPaths, message)
    }
  )

  return ptyManager
}
