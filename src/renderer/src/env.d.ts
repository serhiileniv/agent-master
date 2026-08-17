/// <reference types="vite/client" />

type DataHandler = (data: string) => void
type ExitHandler = (code: number) => void

interface PtySpawnOptions {
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
}

interface ProjectRef {
  path: string
  name: string
}

interface ShellInfo {
  id: string
  label: string
  command: string
  args: string[]
}

interface AgentCli {
  id: string
  label: string
  command: string
}

interface GitInfo {
  isGit: boolean
  repoRoot: string | null
  branch: string | null
}

interface GitInitResult {
  ok: boolean
  error?: string
}

interface WorktreeResult {
  cwd: string
  branch: string | null
  isolated: boolean
  /** Why isolation was downgraded to the shared dir (when isolated is false). */
  reason?: string
}

/** A leftover canvas/* worktree from a crashed or force-quit session. */
interface OrphanWorktree {
  path: string
  /** Short branch name; null when the worktree is detached. */
  branch: string | null
  /** Removal could lose work (unmerged branch or dirty tree) — never cleaned up. */
  hasWork: boolean
}

interface DiffResult {
  branch: string
  base: string | null
  diff: string
  untracked: string[]
  hasChanges: boolean
  /** Set when the diff couldn't be produced (e.g. too large to buffer). */
  error?: string
}

interface MergeResult {
  ok: boolean
  error?: string
  /** The branch actually merged into (the main worktree's HEAD at merge time),
   *  which may differ from the base captured at project open. */
  mergedInto?: string
  /** Files that couldn't merge automatically (captured before the abort). */
  conflictFiles?: string[]
}

interface UpdateInfo {
  current: string
  latest: string
  url: string
}

/** In-place auto-update progress (Windows; other platforms never emit). */
type UpdateState =
  | { status: 'downloading'; percent: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

type FeedbackCategory = 'bug' | 'idea' | 'other'

interface FeedbackInput {
  category: FeedbackCategory
  message: string
  email?: string
}

interface FeedbackResult {
  ok: boolean
  error?: 'not-configured' | 'empty' | 'network' | 'rejected'
}

/** One entry in a single (non-recursive) directory listing. */
interface FileEntry {
  name: string
  kind: 'dir' | 'file'
}

interface FileTreeResult {
  entries: FileEntry[]
}

/** Result of reading one file. Exactly one of `content`/`dataUrl` is set for a
 *  readable text/image file; both absent when binary, too large, or missing. */
interface FileReadResult {
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

interface FileSaveResult {
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
interface FileOpResult {
  ok: boolean
  rel?: string
  /** Something is already at the destination — nothing was touched. */
  conflict?: boolean
  error?: string
}

interface FileDeleteResult {
  ok: boolean
  /** Rel paths the OS refused to trash. */
  failed: string[]
  error?: string
}

/** Enough to recreate one deleted entry. `content` is base64 (binary-safe) and
 *  absent for folders or files over the undo cap — those aren't undoable. */
interface EntrySnapshot {
  rel: string
  kind: 'file' | 'dir'
  content?: string
}

/** Shape of the per-project canvas file (.monad/canvas.json). */
interface PersistedCanvas {
  layoutMode?: 'grid' | 'columns' | 'preview' | 'free'
  previewUrl?: string
  agents: Array<{
    id: string
    label: string
    x: number
    y: number
    w: number
    h: number
    isolation: 'worktree' | 'shared'
    shellId?: string
    /** Double-weight tile (takes 2 shares of its row's width). */
    wide?: boolean
    /** Per-agent folder override; absent means inherit the workspace default. */
    projectPath?: string
  }>
}

/** One workspace as written to app data. `defaultPath` is null for a workspace
 *  created empty from the tab strip — it has an identity and agents but no
 *  folder — and is only a DEFAULT: an agent may carry its own projectPath. */
interface PersistedWorkspace {
  id: string
  name: string
  defaultPath: string | null
  /** Pre-per-agent-folders name for defaultPath. Read-only compatibility. */
  path?: string | null
  layoutMode?: 'grid' | 'columns'
  agents: PersistedCanvas['agents']
}

/** Shape of userData/workspaces.json — the whole tab set, in order. */
interface PersistedWorkspaces {
  version: number
  activeId: string | null
  workspaces: PersistedWorkspace[]
}

interface Window {
  api: {
    pty: {
      spawn: (opts: PtySpawnOptions) => Promise<string>
      write: (id: string, data: string) => void
      resize: (id: string, cols: number, rows: number) => void
      kill: (id: string) => void
      onData: (id: string, cb: DataHandler) => () => void
      onExit: (id: string, cb: ExitHandler) => () => void
    }
    clipboard: {
      read: () => Promise<string>
      write: (text: string) => void
      hasImage: () => Promise<boolean>
      readFiles: () => Promise<string[]>
    }
    getPathForFile: (file: File) => string
    menu: {
      onEdit: (cb: (action: 'copy' | 'paste' | 'selectAll') => void) => () => void
    }
    shells: {
      list: () => Promise<ShellInfo[]>
    }
    agents: {
      list: () => Promise<AgentCli[]>
    }
    openExternal: (url: string) => Promise<boolean>
    window: {
      getTranslucency: () => Promise<boolean>
      setTranslucency: (on: boolean) => Promise<boolean>
    }
    file: {
      exists: (base: string, raw: string) => Promise<boolean>
      open: (base: string, raw: string) => Promise<boolean>
      tree: (root: string, rel: string) => Promise<FileTreeResult>
      read: (root: string, rel: string) => Promise<FileReadResult>
      save: (
        root: string,
        rel: string,
        content: string,
        expectedMtimeMs: number
      ) => Promise<FileSaveResult>
      create: (root: string, rel: string, kind: 'file' | 'dir') => Promise<FileOpResult>
      rename: (root: string, rel: string, name: string) => Promise<FileOpResult>
      move: (
        root: string,
        fromRel: string,
        toRel: string,
        opts?: { overwrite?: boolean; copy?: boolean }
      ) => Promise<FileOpResult>
      copyInto: (root: string, fromRel: string, destDirRel: string) => Promise<FileOpResult>
      remove: (root: string, rels: string[]) => Promise<FileDeleteResult>
      removePermanently: (root: string, rels: string[]) => Promise<FileDeleteResult>
      import: (root: string, destDirRel: string, sources: string[]) => Promise<FileOpResult[]>
      snapshot: (root: string, rels: string[]) => Promise<EntrySnapshot[]>
      restore: (root: string, snapshots: EntrySnapshot[]) => Promise<FileOpResult[]>
      reveal: (root: string, rel: string) => Promise<string | null>
      absPath: (root: string, rel: string) => Promise<string | null>
      dirtyPaths: (root: string, rels: string[]) => Promise<string[]>
      watch: (root: string) => void
      unwatch: () => void
      onChanged: (cb: (p: { root: string }) => void) => () => void
    }
    update: {
      check: () => Promise<UpdateInfo | null>
      install: () => void
      onState: (cb: (state: UpdateState) => void) => () => void
    }
    feedback: {
      send: (input: FeedbackInput) => Promise<FeedbackResult>
      mailto: (input: FeedbackInput) => Promise<boolean>
    }
    app: {
      version: () => Promise<string>
    }
    wallpaper: {
      pick: () => Promise<string | null>
      read: (path: string) => Promise<string | null>
    }
    zoom: {
      set: (factor: number) => void
    }
    notify: {
      agent: (payload: { id: string; title: string; body: string }) => Promise<boolean>
      onClick: (cb: (id: string) => void) => () => void
    }
    attention: {
      set: (count: number) => void
    }
    project: {
      pick: () => Promise<ProjectRef | null>
      exists: (projectPath: string) => Promise<boolean>
      /** Legacy read-only: the one-time canvas.json migration. Never written. */
      load: (projectPath: string) => Promise<PersistedCanvas | null>
    }
    workspaces: {
      load: () => Promise<PersistedWorkspaces | null>
      save: (data: PersistedWorkspaces) => Promise<boolean>
    }
    git: {
      info: (projectPath: string) => Promise<GitInfo>
      init: (projectPath: string) => Promise<GitInitResult>
      prune: (projectPath: string) => Promise<boolean>
      orphans: (projectPath: string, ownedAgentIds: string[]) => Promise<OrphanWorktree[]>
      cleanOrphans: (
        projectPath: string,
        ownedAgentIds: string[]
      ) => Promise<{ removed: number; keptWithWork: number }>
      diff: (projectPath: string, agentId: string) => Promise<DiffResult>
      merge: (projectPath: string, agentId: string, message: string) => Promise<MergeResult>
      applyFiles: (
        projectPath: string,
        agentId: string,
        paths: string[],
        deletedPaths: string[],
        message: string
      ) => Promise<MergeResult>
    }
    worktree: {
      create: (projectPath: string, agentId: string, isolation: string) => Promise<WorktreeResult>
      remove: (projectPath: string, agentId: string) => Promise<boolean>
    }
    platform: string
  }
}
