import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

type DataHandler = (data: string) => void
type ExitHandler = (code: number) => void

const dataListeners = new Map<string, Set<DataHandler>>()
const exitListeners = new Map<string, Set<ExitHandler>>()

ipcRenderer.on('pty:data', (_e, { id, data }: { id: string; data: string }) => {
  dataListeners.get(id)?.forEach((cb) => cb(data))
})

ipcRenderer.on('pty:exit', (_e, { id, code }: { id: string; code: number }) => {
  exitListeners.get(id)?.forEach((cb) => cb(code))
})

// `file:changed` is a single global channel (not keyed per-id like pty). Fan it
// out to every subscriber through one shared Set so many file-panel components
// can subscribe/unsubscribe independently without leaking ipcRenderer.on wiring.
type ChangedHandler = (p: { root: string }) => void
const changedListeners = new Set<ChangedHandler>()
ipcRenderer.on('file:changed', (_e, p: { root: string }) => {
  changedListeners.forEach((cb) => cb(p))
})

function subscribe<T>(map: Map<string, Set<T>>, id: string, cb: T): () => void {
  let set = map.get(id)
  if (!set) {
    set = new Set()
    map.set(id, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
    if (set && set.size === 0) map.delete(id)
  }
}

export interface PtySpawnOptions {
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
}

export interface ProjectRef {
  path: string
  name: string
}

export interface UpdateInfo {
  current: string
  latest: string
  url: string
}

/** In-place auto-update progress (Windows; other platforms never emit). */
export type UpdateState =
  | { status: 'downloading'; percent: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

export type FeedbackCategory = 'bug' | 'idea' | 'other'

export interface FeedbackInput {
  category: FeedbackCategory
  message: string
  email?: string
}

export interface FeedbackResult {
  ok: boolean
  error?: 'not-configured' | 'empty' | 'network' | 'rejected'
}

/** One entry in a single (non-recursive) directory listing. */
export interface FileEntry {
  name: string
  kind: 'dir' | 'file'
}

export interface FileTreeResult {
  entries: FileEntry[]
}

/** Result of reading one file. Exactly one of `content`/`dataUrl` is set for a
 *  readable text/image file; both absent when binary, too large, or missing. */
export interface FileReadResult {
  mtimeMs: number
  size: number
  /** Binary (a NUL byte in the first ~8KB) — not shown in the text editor. */
  isBinary: boolean
  /** Over the 2MB cap — not read. */
  tooLarge: boolean
  /** utf8 text (text files only). */
  content?: string
  /** `data:<mime>;base64,...` (image files only). */
  dataUrl?: string
}

export interface FileSaveResult {
  ok: boolean
  /** On-disk mtime changed vs. expectedMtimeMs — nothing was written. Re-send
   *  with expectedMtimeMs: 0 to override. */
  conflict?: boolean
  /** Current on-disk mtime — the new one after a write, or the conflicting one. */
  mtimeMs?: number
  error?: string
}

/** Outcome of a create/rename/move/copy. `rel` is where the entry actually
 *  landed, which differs from what was asked for when a paste auto-renamed. */
export interface FileOpResult {
  ok: boolean
  rel?: string
  /** Something is already at the destination — nothing was touched. */
  conflict?: boolean
  error?: string
}

export interface FileDeleteResult {
  ok: boolean
  /** Rel paths the OS refused to trash. */
  failed: string[]
  error?: string
}

/** Enough to recreate one deleted entry. `content` is base64 (binary-safe) and
 *  absent for folders or files over the undo cap — those aren't undoable. */
export interface EntrySnapshot {
  rel: string
  kind: 'file' | 'dir'
  content?: string
}

const api = {
  pty: {
    spawn: (opts: PtySpawnOptions): Promise<string> => ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:input', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    onData: (id: string, cb: DataHandler): (() => void) => subscribe(dataListeners, id, cb),
    onExit: (id: string, cb: ExitHandler): (() => void) => subscribe(exitListeners, id, cb)
  },
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    write: (text: string): void => ipcRenderer.send('clipboard:write', { text }),
    hasImage: (): Promise<boolean> => ipcRenderer.invoke('clipboard:hasImage'),
    readFiles: (): Promise<string[]> => ipcRenderer.invoke('clipboard:readFiles')
  },
  // Absolute path of a File dropped onto the window (drag & drop into a
  // terminal). Must run in the preload — the renderer can't see file paths.
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  // macOS Edit-menu commands (⌘C/⌘V/⌘A) forwarded from the main process so the
  // renderer can route them by focus (terminal vs. plain input). See menu.ts.
  menu: {
    onEdit: (cb: (action: 'copy' | 'paste' | 'selectAll') => void): (() => void) => {
      const handler = (_e: unknown, action: 'copy' | 'paste' | 'selectAll'): void => cb(action)
      ipcRenderer.on('menu:edit', handler)
      return () => ipcRenderer.removeListener('menu:edit', handler)
    }
  },
  shells: {
    list: (): Promise<unknown> => ipcRenderer.invoke('shells:list')
  },
  agents: {
    list: (): Promise<unknown> => ipcRenderer.invoke('agents:list')
  },
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('open:external', url),

  /** Frosted-desktop window backdrop. Off is cheaper — see WinState.translucent. */
  window: {
    getTranslucency: (): Promise<boolean> => ipcRenderer.invoke('window:get-translucency'),
    setTranslucency: (on: boolean): Promise<boolean> =>
      ipcRenderer.invoke('window:set-translucency', on)
  },
  file: {
    exists: (base: string, raw: string): Promise<boolean> =>
      ipcRenderer.invoke('path:exists', { base, raw }),
    open: (base: string, raw: string): Promise<boolean> =>
      ipcRenderer.invoke('path:open', { base, raw }),
    // File explorer / editor. `root` is a scope root (worktree/project path);
    // `rel` is always relative to it — the main process rejects any escape.
    tree: (root: string, rel: string): Promise<FileTreeResult> =>
      ipcRenderer.invoke('file:tree', { root, rel }),
    read: (root: string, rel: string): Promise<FileReadResult> =>
      ipcRenderer.invoke('file:read', { root, rel }),
    save: (
      root: string,
      rel: string,
      content: string,
      expectedMtimeMs: number
    ): Promise<FileSaveResult> =>
      ipcRenderer.invoke('file:save', { root, rel, content, expectedMtimeMs }),
    // Mutating operations. Each is scope-checked in the main process with the
    // strict guard (symlinks resolved, not just `..`) — see scoped-files.ts.
    create: (root: string, rel: string, kind: 'file' | 'dir'): Promise<FileOpResult> =>
      ipcRenderer.invoke('file:create', { root, rel, kind }),
    rename: (root: string, rel: string, name: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('file:rename', { root, rel, name }),
    move: (
      root: string,
      fromRel: string,
      toRel: string,
      opts?: { overwrite?: boolean; copy?: boolean }
    ): Promise<FileOpResult> =>
      ipcRenderer.invoke('file:move', {
        root,
        fromRel,
        toRel,
        overwrite: opts?.overwrite,
        copy: opts?.copy
      }),
    copyInto: (root: string, fromRel: string, destDirRel: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('file:copyInto', { root, fromRel, destDirRel }),
    /** Always the OS trash — recoverable. Never falls back to a hard delete. */
    remove: (root: string, rels: string[]): Promise<FileDeleteResult> =>
      ipcRenderer.invoke('file:delete', { root, rels }),
    /** Only after `remove` has already failed AND the user has confirmed. */
    removePermanently: (root: string, rels: string[]): Promise<FileDeleteResult> =>
      ipcRenderer.invoke('file:deletePermanently', { root, rels }),
    /** Copy files from outside the project in (a Finder drop). */
    import: (root: string, destDirRel: string, sources: string[]): Promise<FileOpResult[]> =>
      ipcRenderer.invoke('file:import', { root, destDirRel, sources }),
    snapshot: (root: string, rels: string[]): Promise<EntrySnapshot[]> =>
      ipcRenderer.invoke('file:snapshot', { root, rels }),
    restore: (root: string, snapshots: EntrySnapshot[]): Promise<FileOpResult[]> =>
      ipcRenderer.invoke('file:restore', { root, snapshots }),
    reveal: (root: string, rel: string): Promise<string | null> =>
      ipcRenderer.invoke('file:reveal', { root, rel }),
    absPath: (root: string, rel: string): Promise<string | null> =>
      ipcRenderer.invoke('file:absPath', { root, rel }),
    /** Subset of `rels` carrying uncommitted git work. */
    dirtyPaths: (root: string, rels: string[]): Promise<string[]> =>
      ipcRenderer.invoke('file:dirtyPaths', { root, rels }),
    watch: (root: string): void => ipcRenderer.send('file:watch', { root }),
    unwatch: (): void => ipcRenderer.send('file:unwatch'),
    onChanged: (cb: ChangedHandler): (() => void) => {
      changedListeners.add(cb)
      return () => {
        changedListeners.delete(cb)
      }
    }
  },
  update: {
    check: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),
    /** Restart into the downloaded version (no-op until state says 'ready'). */
    install: (): void => ipcRenderer.send('update:install'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, state: UpdateState): void => cb(state)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    }
  },
  feedback: {
    send: (input: FeedbackInput): Promise<FeedbackResult> =>
      ipcRenderer.invoke('feedback:send', input),
    // Opens the user's mail client, prefilled — the offline fallback for send().
    mailto: (input: FeedbackInput): Promise<boolean> =>
      ipcRenderer.invoke('feedback:mailto', input)
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  wallpaper: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('wallpaper:pick'),
    read: (path: string): Promise<string | null> => ipcRenderer.invoke('wallpaper:read', path)
  },
  zoom: {
    set: (factor: number): void => webFrame.setZoomFactor(factor)
  },
  notify: {
    agent: (payload: { id: string; title: string; body: string }): Promise<boolean> =>
      ipcRenderer.invoke('notify:agent', payload),
    onClick: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: unknown, { id }: { id: string }): void => cb(id)
      ipcRenderer.on('notify:click', handler)
      return () => ipcRenderer.removeListener('notify:click', handler)
    }
  },
  // How many agents currently need the user — drives the OS-level indicator
  // (taskbar flash / dock badge) in the main process.
  attention: {
    set: (count: number): void => ipcRenderer.send('attention:set', { count })
  },
  project: {
    pick: (): Promise<ProjectRef | null> => ipcRenderer.invoke('project:pick'),
    exists: (projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke('project:exists', projectPath),
    // load() is legacy-read-only (one-time canvas.json migration). There is no
    // save() — workspaces.json holds the whole tab set now.
    load: (projectPath: string): Promise<unknown> => ipcRenderer.invoke('project:load', projectPath)
  },
  // The whole tab set, in app data — workspaces outlived being folders.
  workspaces: {
    load: (): Promise<unknown> => ipcRenderer.invoke('workspaces:load'),
    save: (data: unknown): Promise<boolean> => ipcRenderer.invoke('workspaces:save', data)
  },
  git: {
    info: (projectPath: string): Promise<unknown> => ipcRenderer.invoke('git:info', projectPath),
    init: (projectPath: string): Promise<unknown> => ipcRenderer.invoke('git:init', projectPath),
    prune: (projectPath: string): Promise<boolean> => ipcRenderer.invoke('git:prune', projectPath),
    orphans: (projectPath: string, ownedAgentIds: string[]): Promise<unknown> =>
      ipcRenderer.invoke('git:orphans', { projectPath, ownedAgentIds }),
    // Takes agent ids, not worktree paths — the main process re-lists orphans
    // itself, so a stale/tampered path list can never reach the removal.
    cleanOrphans: (
      projectPath: string,
      ownedAgentIds: string[]
    ): Promise<{ removed: number; keptWithWork: number }> =>
      ipcRenderer.invoke('git:cleanOrphans', { projectPath, ownedAgentIds }),
    diff: (projectPath: string, agentId: string): Promise<unknown> =>
      ipcRenderer.invoke('git:diff', { projectPath, agentId }),
    merge: (projectPath: string, agentId: string, message: string): Promise<unknown> =>
      ipcRenderer.invoke('git:merge', { projectPath, agentId, message }),
    applyFiles: (
      projectPath: string,
      agentId: string,
      paths: string[],
      deletedPaths: string[],
      message: string
    ): Promise<unknown> =>
      ipcRenderer.invoke('git:applyFiles', { projectPath, agentId, paths, deletedPaths, message })
  },
  worktree: {
    create: (projectPath: string, agentId: string, isolation: string): Promise<unknown> =>
      ipcRenderer.invoke('worktree:create', { projectPath, agentId, isolation }),
    remove: (projectPath: string, agentId: string): Promise<boolean> =>
      ipcRenderer.invoke('worktree:remove', { projectPath, agentId })
  }
}

contextBridge.exposeInMainWorld('api', { ...api, platform: process.platform })

export type Api = typeof api
