import { create } from 'zustand'
import { getRecent, type RecentProject } from './recent'
import { sanitizeTheme, type ThemePreference } from './theme'
import { samePath } from './pathUtil'

export type Isolation = 'worktree' | 'shared'
export type LayoutMode = 'grid' | 'columns'
export type SettingsTab = 'terminal' | 'appearance' | 'workspace' | 'notifications' | 'shortcuts'
/** The one dropdown menu allowed open at a time (rail "new", project switcher,
 *  the tab strip's + menu). */
export type MenuId = 'rail-new' | 'project' | 'tabbar-add'

/** A recently-opened project folder — the switcher's recents list.
 *  (Was `Workspace`; "workspace" now means a *live* session — see WorkspaceSession.) */
export type Workspace = RecentProject

export interface Toast {
  id: string
  text: string
  kind: 'info' | 'success' | 'error'
  /** Optional action button (e.g. "Download"); a toast with one never auto-dismisses. */
  actionLabel?: string
  onAction?: () => void
  /** Optional lower-emphasis second action (e.g. "Skip this version"). */
  secondaryLabel?: string
  onSecondary?: () => void
  /** Explicit stickiness override — `false` auto-dismisses even with an action
   *  (used when a persistent surface elsewhere carries the same affordance). */
  sticky?: boolean
  /** Auto-dismiss delay in ms (default 3400). */
  timeoutMs?: number
  /**
   * Bumped when a duplicate push refreshes this toast instead of stacking a
   * twin — Toasts.tsx keys its auto-dismiss timer on it so the toast gets a
   * fresh 3.4s from the latest trigger.
   */
  refresh?: number
}

/** Visible toast cap — a 6th pushes the oldest (non-sticky first) off the stack. */
const MAX_TOASTS = 5

/** Sticky toasts never auto-dismiss: errors and anything with an action to lose.
 *  An explicit `sticky` on the toast overrides that inference. */
export function toastIsSticky(
  t: Pick<Toast, 'kind' | 'actionLabel' | 'secondaryLabel' | 'sticky'>
): boolean {
  if (t.sticky !== undefined) return t.sticky
  return !!t.actionLabel || !!t.secondaryLabel || t.kind === 'error'
}

/** Hard cap — more than this on one stage is unreadable. */
export const MAX_AGENTS = 9

/** Hard cap on simultaneously-live workspaces — kept low so the top-bar tabs
 *  always fit without scrolling (and to bound the live agent-process count).
 *  Opening past it is refused with a nudge to close a tab first. */
export const MAX_LIVE_WORKSPACES = 6

/**
 * Lifecycle of a terminal's agent, surfaced at a glance across the stage:
 *  - starting   spawning the shell / creating the worktree
 *  - working    producing output right now
 *  - idle       alive, quiet, ready
 *  - attention  quiet but the last output looks like it's waiting on you
 *  - exited     the process finished cleanly
 *  - error      the process exited non-zero, or the shell failed to spawn
 */
export type AgentStatus = 'starting' | 'working' | 'idle' | 'attention' | 'exited' | 'error'

/** Statuses that should pull the user in (badge, edge-marker, notification). */
export const NEEDS_ATTENTION: AgentStatus[] = ['attention', 'error', 'exited']

export interface AgentInstance {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  isolation: Isolation
  /** Which detected shell this terminal runs (undefined = platform default). */
  shellId?: string
  /** Command auto-run once when the terminal spawns (runtime only). */
  startupCommand?: string
  /** Friendly name of the agent launched here (e.g. "Claude Code"), shown as a tag. */
  agentLabel?: string
  /** Id of the launched agent (claude/codex/gemini/…) → drives its icon. */
  agentId?: string
  /**
   * Folder this agent runs against, overriding its workspace's default.
   * Undefined means "inherit" — which is what every agent created before
   * per-agent folders existed does, so there's nothing to migrate.
   * Read via agentPath(), never directly.
   */
  projectPath?: string
  /** Double-weight tile: takes 2 shares of its row's width instead of 1. */
  wide?: boolean
  /** Terminal interior theme: follow the app ('auto'/undefined) or pin it. */
  termTheme?: 'auto' | 'dark' | 'light'
  // --- runtime only (never persisted) ---
  ptyId?: string
  branch?: string | null
  cwd?: string
  status?: AgentStatus
  /** When the current working burst started — drives the header's elapsed timer. */
  workingSince?: number
  /** False when an isolated terminal silently fell back to the shared dir. */
  isolated?: boolean
  /** While this card is the one being dragged: the slot it will drop into. */
  dropX?: number
  dropY?: number
  dropW?: number
  dropH?: number
}

/** Snapshot of the most recently closed terminal, for reopen. */
export interface LastClosed {
  label: string
  shellId?: string
  isolation: Isolation
  startupCommand?: string
  agentLabel?: string
  agentId?: string
}

/**
 * What the file panel is rooted at: the project folder itself ('root'), or one
 * agent's worktree ('agent' + its id). Phase 3 resolves this to an absolute base
 * path via the main-process file API; the panel's openPath is always RELATIVE to it.
 */
export type FileScope = { kind: 'root' } | { kind: 'agent'; agentId: string }

/** Per-workspace state of the right-docked file explorer/editor panel. Runtime
 *  UI only — never persisted to canvas.json (like selectedIds / diffAgentId). */
export interface FilePanelState {
  open: boolean
  scope: FileScope
  /** Path RELATIVE to the scope root of the file open in the editor, or null. */
  openPath: string | null
  /** The open file has unsaved edits (Phase 3 sets this from the editor). */
  dirty: boolean
}

/** Deep-equal for two FileScopes — drives "same scope" keep-vs-clear decisions. */
function sameScope(a: FileScope, b: FileScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId
  return true
}

/** The default file-panel state stamped onto every new/restored workspace. */
const DEFAULT_FILE_PANEL: FilePanelState = {
  open: false,
  scope: { kind: 'root' },
  openPath: null,
  dirty: false
}

/**
 * A live workspace — one open project folder with its own stage of agents,
 * kept running in the background even when another workspace is on screen. This
 * is what the top-bar tabs switch between. Everything that used to be a single
 * global "the open project" now lives per-session here; exactly one session is
 * `activeWorkspaceId` at a time (visible + interactive), the rest stay mounted
 * but hidden so their PTYs keep streaming.
 */
export interface WorkspaceSession {
  /** Stable per live tab (not the folder path — lets the same folder theory be
   *  guarded against, and survives renames). */
  id: string
  /**
   * The folder new agents in this workspace inherit, or null for a workspace
   * that doesn't have one (created empty from the tab strip's +). This is a
   * DEFAULT, not the workspace's folder — an agent may override it, so never
   * read this to answer "where does this agent run"; use agentPath() for that.
   */
  defaultPath: string | null
  /** User-facing label. Seeded from the folder basename when opened from disk,
   *  but owned by the user after that — renaming a tab never touches the folder. */
  name: string
  isGit: boolean
  baseBranch: string | null
  agents: AgentInstance[]
  layoutMode: LayoutMode
  selectedIds: string[]
  focusedId: string | null
  closingIds: string[]
  draggingId: string | null
  pendingCloseId: string | null
  bulkCloseIds: string[] | null
  diffAgentId: string | null
  filePanel: FilePanelState
  lastClosed: LastClosed | null
}

/** Fields written to .monad/canvas.json (runtime fields stripped). */
export interface PersistedAgent {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  isolation: Isolation
  shellId?: string
  /** Re-run when the terminal respawns on reopen, so the agent (e.g. Claude)
   *  comes back up — not just a bare shell. */
  startupCommand?: string
  agentLabel?: string
  agentId?: string
  wide?: boolean
  termTheme?: 'auto' | 'dark' | 'light'
  /** Per-agent folder override; absent means it inherits the workspace default. */
  projectPath?: string
}

interface AppState {
  /** Live workspaces (open tabs), in tab order. Each keeps its agents running. */
  liveWorkspaces: WorkspaceSession[]
  /** The workspace currently on screen (visible + interactive), or null (Home). */
  activeWorkspaceId: string | null
  /** Saved workspaces beyond MAX_LIVE_WORKSPACES, held verbatim and never
   *  rendered. They exist purely so the next autosave writes them back: the
   *  restore used to slice() them off, and the following save then persisted the
   *  truncated set — permanently deleting tabs the user still had. */
  parkedWorkspaces: PersistedWorkspace[]
  /** Recently-opened folders, newest first — the +/dropdown's recents list. */
  workspaces: Workspace[]
  stageW: number
  stageH: number
  /** True once the stage has been measured at least once (real viewport size). */
  stageReady: boolean
  shells: ShellInfo[]
  /** True once shells:list has resolved (even to an empty list). Panes wait for
   *  this before spawning: detection is async, but restored panes mount as soon
   *  as hydrateWorkspaces lands, so `shells` was often still [] and the agent's
   *  chosen shell (Git Bash, WSL, pwsh) silently fell back to the platform
   *  default with no error shown. */
  shellsLoaded: boolean
  agentClis: AgentCli[]
  /** True once detectAgents has returned — gates the "no CLIs" first-run hint so
   *  it never flashes during the initial async detect. */
  agentClisLoaded: boolean
  settings: AppSettings
  settingsOpen: boolean
  /** Which Settings tab to show — also how ⌘/ deep-links to the Shortcuts tab. */
  settingsTab: SettingsTab
  /** Which single dropdown menu is open, if any — enforces one-popup-at-a-time. */
  openMenu: MenuId | null
  paletteOpen: boolean
  /** Feedback (bugs / ideas / comments) modal. */
  feedbackOpen: boolean
  /** A newer release, once detected — drives the persistent update banner. */
  update: UpdateInfo | null
  /** True once the user hides the update banner this session (returns next launch). */
  updateDismissed: boolean
  /** In-place download progress (Windows auto-updater); null = no download /
   *  not supported / errored — the banner then links to the download site. */
  updateState: UpdateState | null
  /** Workspace tab awaiting close confirmation — the modal in App.tsx owns the UI. */
  confirmWorkspaceCloseId: string | null
  panX: number
  panY: number
  zoom: number
  toasts: Toast[]
  /** Width (px) of the right-docked file panel — global, shared by every
   *  workspace, persisted across restart. */
  filePanelWidth: number

  /** Open a folder as a new live workspace tab (or focus it if already open). */
  openWorkspace: (ref: ProjectRef, saved: PersistedCanvas | null, git: GitInfo) => void
  /** Rebuild the live tab set from app data on launch, preserving each
   *  workspace's id and user-chosen name. Replaces the whole set — only ever
   *  called once, before anything else can open a tab. Git state is filled in
   *  afterwards per workspace (see setWorkspaceGit) so tabs paint immediately
   *  instead of waiting on a git call per folder. */
  hydrateWorkspaces: (records: PersistedWorkspace[], activeId: string | null) => void
  /** Stamp git state onto one workspace by id (restore fills these in async). */
  setWorkspaceGit: (id: string, git: GitInfo) => void
  /** Create an empty, folder-less workspace tab and focus it. Returns nothing —
   *  read `activeWorkspaceId` afterwards if you need the new id. */
  createWorkspace: (name?: string) => void
  /** Rename a workspace tab. Blank/whitespace names are rejected (kept as-is). */
  renameWorkspace: (id: string, name: string) => void
  /** Attach a folder to a workspace that doesn't have one (or change it). */
  setWorkspacePath: (id: string, ref: ProjectRef, git: GitInfo) => void
  /** Close a live workspace tab (detach: kills its PTYs, keeps worktrees on disk). */
  closeWorkspace: (id: string) => void
  /** Bring a live workspace to the foreground. */
  setActiveWorkspace: (id: string) => void
  /** Refresh the active workspace's git state in place (e.g. after "Initialize git")
   *  without re-opening — keeps the shared-mode chip and isolation default live. */
  setGitInfo: (git: GitInfo) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  setStageSize: (w: number, h: number) => void
  setShells: (shells: ShellInfo[]) => void
  setAgentClis: (agentClis: AgentCli[]) => void
  setSelected: (ids: string[]) => void
  setSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsTab: (tab: SettingsTab) => void
  /** Open a dropdown menu (closing any other), or pass null to close. */
  setOpenMenu: (menu: MenuId | null) => void
  setPaletteOpen: (open: boolean) => void
  setFeedbackOpen: (open: boolean) => void
  /** Record a detected release (or clear it); resets the session dismiss. */
  setUpdate: (update: UpdateInfo | null) => void
  setUpdateState: (updateState: UpdateState | null) => void
  /** Hide the update banner for this session (it returns on next launch). */
  dismissUpdate: () => void
  setDiffAgentId: (id: string | null) => void
  /** Open the file panel on the active workspace at a scope. Same scope keeps the
   *  open file + dirty flag; a new scope clears both. */
  openFilePanel: (scope: FileScope) => void
  /** Re-root the (already-open) panel; clears the open file + dirty flag. */
  setFilePanelScope: (scope: FileScope) => void
  /** Set (or clear, with null) the file open in the editor — scope untouched. */
  openFile: (relPath: string | null) => void
  /** Mark the open file dirty / clean (editor buffer state). */
  setFileDirty: (dirty: boolean) => void
  /** Hide the panel (keeps scope + open file for a later re-open). */
  closeFilePanel: () => void
  /** Flip the panel's visibility; defaults to root scope when opening fresh. */
  toggleFilePanel: () => void
  /** Set the global panel width (px); clamps to [260, 820] and persists. */
  setFilePanelWidth: (px: number) => void
  requestClose: (id: string) => void
  clearPendingClose: () => void
  requestBulkClose: (ids: string[]) => void
  clearBulkClose: () => void
  /** Ask to close a workspace tab (confirmed by the modal in App.tsx). */
  requestWorkspaceClose: (id: string) => void
  clearWorkspaceClose: () => void
  addAgent: (opts?: {
    command?: string
    shellId?: string
    agentLabel?: string
    agentId?: string
    /** Target a specific workspace instead of the active one. */
    workspaceId?: string
    /** Run this agent in a folder other than the workspace default. */
    projectPath?: string
    /** Whether `projectPath` is a git repo — decides if isolation is available.
     *  Caller supplies it because git state can't be resolved synchronously;
     *  omitted means "use the workspace's". */
    isGit?: boolean
  }) => void
  removeAgent: (id: string, opts?: { keepWorktree?: boolean }) => void
  reopenLast: () => void
  renameAgent: (id: string, label: string) => void
  toggleWide: (id: string) => void
  setLayoutMode: (mode: LayoutMode) => void
  setDraggingId: (id: string | null) => void
  reorderAgent: (id: string, toIndex: number) => void
  relayout: () => void
  focusTerminal: (id: string) => void
  revealAgent: (id: string) => void
  clearFocus: () => void
  setAgentRuntime: (id: string, rt: Partial<AgentInstance>) => void
  setStatus: (id: string, status: AgentStatus) => void
  pushToast: (
    text: string,
    kind?: Toast['kind'],
    action?: Pick<
      Toast,
      'actionLabel' | 'onAction' | 'secondaryLabel' | 'onSecondary' | 'sticky' | 'timeoutMs'
    >
  ) => void
  dismissToast: (id: string) => void
}

const DEFAULT_W = 520
const DEFAULT_H = 360
// Hard minimum so a card can never shrink into an ungrabbable micro-window.
export const MIN_W = 300
export const MIN_H = 190

export interface AppSettings {
  defaultShellId: string | null
  defaultIsolation: Isolation
  fontSize: number
  fontFamily: string
  scrollback: number
  /** Selecting text with the mouse copies it immediately (iTerm-style). */
  copyOnSelect: boolean
  confirmClose: boolean
  zoomFactor: number
  /** UI theme — 'system' follows the OS light/dark setting live. */
  theme: ThemePreference
  /** Accent colour (hex) — drives the whole UI palette. */
  accent: string
  /** Desktop notification when a backgrounded/off-screen agent needs you. */
  notifications: boolean
  /**
   * Alert when a long-running agent finishes (working → idle / clean exit).
   * Independent master switch for the finish event; `notifications` gates the
   * desktop popup and `sounds` gates the chime.
   */
  notifyOnDone: boolean
  /** Soft chime when an agent needs you / finishes / errors. */
  sounds: boolean
  /** Absolute path to a background image, or null for the default dark scene. */
  wallpaper: string | null
  /** Terminal background opacity 0.4–1 (lower reveals the wallpaper behind). */
  terminalOpacity: number
  /**
   * Let the desktop show through the window (macOS vibrancy / Windows mica).
   *
   * Off by default because it is the app's most expensive single effect: the OS
   * re-blurs whatever sits behind the window continuously, at the display's
   * backing resolution, below the web contents where no CSS or idle-pausing can
   * reach it. Mirrored into the main process, which needs it at window
   * construction — see WinState.translucent.
   */
  windowTranslucency: boolean
}

/** Monospace stacks offered in Settings (first that's installed wins). */
export const FONT_FAMILIES: { id: string; label: string; stack: string }[] = [
  { id: 'cascadia', label: 'Cascadia Code', stack: 'Cascadia Code, Consolas, monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: 'JetBrains Mono, Consolas, monospace' },
  { id: 'fira', label: 'Fira Code', stack: 'Fira Code, Consolas, monospace' },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, monospace' },
  { id: 'menlo', label: 'Menlo / Monaco', stack: 'Menlo, Monaco, monospace' },
  { id: 'system', label: 'System monospace', stack: 'ui-monospace, monospace' }
]

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  defaultIsolation: 'shared',
  fontSize: 14,
  fontFamily: 'Cascadia Code, Consolas, monospace',
  scrollback: 2000,
  copyOnSelect: true,
  confirmClose: true,
  zoomFactor: 1.0,
  // Vestigial: the app has one designed look now and no theme control. The
  // field stays so an existing user's persisted settings still parse.
  theme: 'dark',
  accent: '#d97a68', // Ember — must match --accent-rgb in styles.css
  notifications: true,
  notifyOnDone: true,
  sounds: false,
  wallpaper: null,
  terminalOpacity: 0.55,
  windowTranslucency: false
}

function clampNum(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : dflt
  return Math.min(hi, Math.max(lo, v))
}

function loadSettings(): AppSettings {
  try {
    // Legacy 'vectro.' prefix kept for data continuity across the Agent Master rename.
    const raw = localStorage.getItem('vectro.settings')
    const merged = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
    // A corrupt / hand-edited store must not be able to brick the app (zoom 8×,
    // fontSize 999, a half-gig scrollback ring buffer). Clamp numerics to the same
    // ranges the Settings sliders enforce for new input.
    return {
      ...merged,
      fontSize: clampNum(merged.fontSize, 9, 22, DEFAULT_SETTINGS.fontSize),
      scrollback: clampNum(merged.scrollback, 500, 20000, DEFAULT_SETTINGS.scrollback),
      zoomFactor: clampNum(merged.zoomFactor, 0.7, 1.8, DEFAULT_SETTINGS.zoomFactor),
      terminalOpacity: clampNum(merged.terminalOpacity, 0.4, 1, DEFAULT_SETTINGS.terminalOpacity),
      theme: sanitizeTheme(merged.theme)
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem('vectro.settings', JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

// --- file-panel width (global, persisted across restart) -------------------
// A single width shared by every workspace's panel — not a per-stage concern,
// so it lives at the top level with its own key rather than in a WorkspaceSession
// or the user-facing settings blob. Legacy 'vectro.' prefix like the other keys.
export const FILE_PANEL_MIN = 260
export const FILE_PANEL_MAX = 820
export const FILE_PANEL_DEFAULT = 380
const FILE_PANEL_WIDTH_KEY = 'vectro.filePanelWidth'

function loadFilePanelWidth(): number {
  try {
    const raw = localStorage.getItem(FILE_PANEL_WIDTH_KEY)
    if (raw === null) return FILE_PANEL_DEFAULT
    return clampNum(JSON.parse(raw), FILE_PANEL_MIN, FILE_PANEL_MAX, FILE_PANEL_DEFAULT)
  } catch {
    return FILE_PANEL_DEFAULT
  }
}

function saveFilePanelWidth(px: number): void {
  try {
    localStorage.setItem(FILE_PANEL_WIDTH_KEY, JSON.stringify(px))
  } catch {
    /* ignore */
  }
}

/** crypto.randomUUID requires a secure context (not guaranteed under file://). */
export function uuid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

const GAP = 12
export const RAIL_INSET = 84 // room for the floating dock on the left (max adaptive width)
export const PAD = 14
const BOTTOM_INSET = 14 // bottom margin for the tiled panes (symmetric with the top PAD)

/**
 * Tile every terminal into the viewport at **zoom 1** (font stays fixed). Array
 * ORDER is the layout order. Every row is stretched to the FULL width, so an odd
 * count never leaves an awkward hole — e.g. 3 → row of 2 + a full-width row of 1,
 * 5 → 3 over 2. Columns mode is just a single full-height row.
 */
// Exported for unit tests — the tiling math is the most invariant-heavy pure
// function in the app and nothing else should call it from outside.
export function laidOut(
  agents: AgentInstance[],
  mode: LayoutMode,
  W: number,
  H: number,
  skipId?: string | null
): AgentInstance[] {
  const n = agents.length
  if (!n) return agents
  const availW = Math.max(1, W - RAIL_INSET - PAD)
  const availH = Math.max(1, H - PAD - BOTTOM_INSET)

  // How many rows, and how many cells per row (as even as possible).
  const rows = mode === 'columns' ? 1 : Math.max(1, Math.round(Math.sqrt(n)))
  const base = Math.floor(n / rows)
  const extra = n % rows
  const perRow: number[] = []
  for (let r = 0; r < rows; r++) perRow.push(base + (r < extra ? 1 : 0))

  // Integer pixel geometry: fractional tile coords put the terminal between
  // device pixels and the compositor resamples it — text and borders go soft.
  // Clamped: with a viewport smaller than the insets + gaps (a stage tiled
  // before its first real measurement lands), the gap subtraction went negative
  // and panes got negative width/height, which CSS renders as a collapsed card.
  const ch = Math.max(1, Math.round((availH - GAP * (rows - 1)) / rows))
  const out: AgentInstance[] = []
  let i = 0
  for (let r = 0; r < rows; r++) {
    const cols = perRow[r]
    // Widths within a row are allocated by weight (wide = 2, normal = 1) rather
    // than equally; which cards land in which row stays purely count-based above.
    const rowAgents = agents.slice(i, i + cols)
    const totalWeight = rowAgents.reduce((sum, a) => sum + (a.wide ? 2 : 1), 0)
    const inner = Math.max(cols, availW - GAP * (cols - 1))
    let x = RAIL_INSET
    let used = 0
    for (let c = 0; c < cols; c++) {
      const a = agents[i++]
      // Integer widths (crisp glyphs, see above); the LAST card in a row absorbs
      // the rounding remainder so every row still fills the full width exactly.
      const cw = Math.max(
        1,
        c === cols - 1 ? inner - used : Math.round((inner * (a.wide ? 2 : 1)) / totalWeight)
      )
      const y = Math.round(PAD + r * (ch + GAP))
      // The dragged card keeps its position constant so React never fights
      // Moveable for its transform — it follows the cursor; its slot stays an
      // empty gap that the other cards reflow around. We stash that slot in
      // drop* so the stage can draw a placeholder there.
      if (skipId && a.id === skipId) {
        // Same identity rule as the branch below: a fresh object each relayout
        // re-rendered the pane the user is holding — the worst one to churn,
        // because its xterm work lands mid-gesture and the card stutters.
        const same =
          a.dropX === x && a.dropY === y && a.dropW === cw && a.dropH === ch
        out.push(same ? a : { ...a, dropX: x, dropY: y, dropW: cw, dropH: ch })
      } else {
        // Reuse the SAME object when its slot is unchanged — a fresh `{...a}` every
        // relayout would give each pane a new identity and defeat TerminalPane's
        // memo, re-rendering every xterm on each drag-cross / resize tick.
        const unchanged =
          a.x === x && a.y === y && a.w === cw && a.h === ch &&
          a.dropX === undefined && a.dropY === undefined &&
          a.dropW === undefined && a.dropH === undefined
        if (unchanged) out.push(a)
        else out.push({ ...a, x, y, w: cw, h: ch, dropX: undefined, dropY: undefined, dropW: undefined, dropH: undefined })
      }
      used += cw
      x += cw + GAP
    }
  }
  return out
}

// Soft consonants + vowels → short, pronounceable names like "Robi", "Dan",
// "Rori" (alternating C/V so they always read aloud cleanly).
const CONSONANTS = 'bdfgjklmnprstvz'
const VOWELS = 'aeiou'

function pronounceable(): string {
  const len = 3 + Math.floor(Math.random() * 2) // 3–4 letters
  let name = ''
  for (let i = 0; i < len; i++) {
    const pool = i % 2 === 0 ? CONSONANTS : VOWELS
    name += pool[Math.floor(Math.random() * pool.length)]
  }
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A short, pronounceable terminal name unique among `agents`. */
function uniqueName(agents: AgentInstance[]): string {
  const taken = new Set(agents.map((a) => a.label.toLowerCase()))
  for (let attempt = 0; attempt < 60; attempt++) {
    const name = pronounceable()
    if (!taken.has(name.toLowerCase())) return name
  }
  return 'Term' + (agents.length + 1)
}

/** A worktree branch as shown to the user — drop the internal `canvas/` prefix. */
export function displayBranch(branch: string): string {
  return branch.replace(/^canvas\//, '')
}

export function toPersisted(agents: AgentInstance[]): PersistedAgent[] {
  return agents.map((a) => ({
    id: a.id,
    label: a.label,
    x: a.x,
    y: a.y,
    w: a.w,
    h: a.h,
    isolation: a.isolation,
    shellId: a.shellId,
    startupCommand: a.startupCommand,
    agentLabel: a.agentLabel,
    agentId: a.agentId,
    wide: a.wide,
    termTheme: a.termTheme,
    projectPath: a.projectPath
  }))
}

// --- workspace selectors -------------------------------------------------
// The scoped state (agents/selection/layout/…) lives per live workspace. These
// resolve "the active one" and "the one owning agent X" so components and the
// id-addressed mutators don't each re-implement the lookup. Stable EMPTY refs so
// a `?? EMPTY` fallback never returns a fresh array (which would thrash React).

const EMPTY_AGENTS: AgentInstance[] = []
const EMPTY_IDS: string[] = []

/** The workspace currently on screen, or undefined (Home / none open). */
export function activeWs(s: AppState): WorkspaceSession | undefined {
  return s.activeWorkspaceId ? s.liveWorkspaces.find((w) => w.id === s.activeWorkspaceId) : undefined
}
/** A live workspace by its id. */
export function wsById(s: AppState, id: string): WorkspaceSession | undefined {
  return s.liveWorkspaces.find((w) => w.id === id)
}
/** The live workspace that owns a given agent id (agent ids are globally unique). */
export function wsOfAgent(s: AppState, agentId: string): WorkspaceSession | undefined {
  return s.liveWorkspaces.find((w) => w.agents.some((a) => a.id === agentId))
}

/**
 * The folder an agent actually runs in: its own override if it has one, else
 * its workspace's default, else null (spawns wherever the shell starts).
 *
 * THE single answer to "where does this agent work" — worktree creation, the
 * diff view, the file panel and the spawn cwd must all agree, and they only do
 * so by going through here. Reading ws.defaultPath directly is the bug this
 * function exists to prevent.
 */
export function agentPath(
  ws: WorkspaceSession | undefined,
  agent: AgentInstance | undefined
): string | null {
  return agent?.projectPath ?? ws?.defaultPath ?? null
}

/** agentPath by agent id, resolving the owning workspace too. */
export function agentPathById(s: AppState, agentId: string): string | null {
  const ws = wsOfAgent(s, agentId)
  return agentPath(ws, ws?.agents.find((a) => a.id === agentId))
}

/** Convenience hooks for components that only care about the active workspace. */
export const useActiveAgents = (): AgentInstance[] =>
  useStore((s) => activeWs(s)?.agents ?? EMPTY_AGENTS)
export const useActiveSelectedIds = (): string[] =>
  useStore((s) => activeWs(s)?.selectedIds ?? EMPTY_IDS)
export const useActiveLayoutMode = (): LayoutMode =>
  useStore((s) => activeWs(s)?.layoutMode ?? 'grid')
export const useActiveProjectPath = (): string | null =>
  useStore((s) => activeWs(s)?.defaultPath ?? null)
export const useActiveProjectName = (): string | null =>
  useStore((s) => activeWs(s)?.name ?? null)
export const useActiveIsGit = (): boolean => useStore((s) => activeWs(s)?.isGit ?? false)

/** Replace one live workspace immutably, leaving every other session's object
 *  reference intact (so only that workspace's Stage/panes re-render). */
function mapWs(
  list: WorkspaceSession[],
  id: string,
  fn: (w: WorkspaceSession) => WorkspaceSession
): WorkspaceSession[] {
  return list.map((w) => (w.id === id ? fn(w) : w))
}

/** Matches the auto-assigned "Workspace N" label — used to tell a name the user
 *  chose from one we made up, so attaching a folder can replace ours but never theirs. */
const DEFAULT_NAME_RE = /^Workspace \d+$/

/** Lowest unused "Workspace N", so closing #2 of 3 and adding one reuses 2. */
function nextWorkspaceName(list: WorkspaceSession[]): string {
  const taken = new Set(list.map((w) => w.name))
  for (let n = 1; ; n++) {
    const name = `Workspace ${n}`
    if (!taken.has(name)) return name
  }
}

/** Turn persisted agent records back into live AgentInstances, capped at
 *  MAX_AGENTS. Shared by open-a-folder and launch-time hydration so both apply
 *  the same label migration and isolation default. */
function hydrateAgents(persisted: PersistedCanvas['agents'] | undefined): AgentInstance[] {
  const loaded: AgentInstance[] = []
  for (const p of (persisted ?? []).slice(0, MAX_AGENTS)) {
    // Migrate old numeric auto-names (and blanks) to short random names;
    // preserve any custom rename the user made.
    const label = !p.label || /^\d+$/.test(p.label.trim()) ? uniqueName(loaded) : p.label
    loaded.push({ ...p, label, isolation: p.isolation ?? 'shared' })
  }
  return loaded
}

/** Build a WorkspaceSession, defaulting every per-session UI field. Both entry
 *  points (open-a-folder and create-empty) go through here so a new field added
 *  to WorkspaceSession can't be forgotten by one of them. */
function newSession(init: Partial<WorkspaceSession> & { name: string }): WorkspaceSession {
  return {
    id: uuid(),
    defaultPath: null,
    isGit: false,
    baseBranch: null,
    agents: EMPTY_AGENTS,
    layoutMode: 'grid',
    selectedIds: EMPTY_IDS,
    focusedId: null,
    closingIds: [],
    draggingId: null,
    pendingCloseId: null,
    bulkCloseIds: null,
    diffAgentId: null,
    filePanel: DEFAULT_FILE_PANEL,
    lastClosed: null,
    ...init
  }
}

export const useStore = create<AppState>((set, get) => ({
  liveWorkspaces: [],
  activeWorkspaceId: null,
  parkedWorkspaces: [],
  workspaces: getRecent(),
  stageW: 1200,
  stageH: 800,
  stageReady: false,
  shells: [],
  shellsLoaded: false,
  agentClis: [],
  agentClisLoaded: false,
  settings: loadSettings(),
  settingsOpen: false,
  settingsTab: 'terminal',
  openMenu: null,
  paletteOpen: false,
  feedbackOpen: false,
  update: null,
  updateDismissed: false,
  updateState: null,
  confirmWorkspaceCloseId: null,
  toasts: [],
  panX: 0,
  panY: 0,
  zoom: 1,
  filePanelWidth: loadFilePanelWidth(),

  openWorkspace: (ref, saved, git) =>
    set((s) => {
      // Same folder already live → just bring its tab forward (never duplicate).
      // Compared with samePath so separator/case variants of one folder can't
      // slip through as two tabs sharing a worktree container.
      const existing = s.liveWorkspaces.find((w) => samePath(w.defaultPath, ref.path))
      if (existing) return { activeWorkspaceId: existing.id }

      const loaded = hydrateAgents(saved?.agents)
      const mode: LayoutMode = saved?.layoutMode === 'columns' ? 'columns' : 'grid'
      const session = newSession({
        defaultPath: ref.path,
        name: ref.name,
        isGit: git.isGit,
        baseBranch: git.branch,
        // Start with the first terminal active so you can type immediately.
        agents: laidOut(loaded, mode, s.stageW, s.stageH),
        layoutMode: mode,
        selectedIds: loaded[0] ? [loaded[0].id] : []
      })
      return {
        liveWorkspaces: [...s.liveWorkspaces, session],
        activeWorkspaceId: session.id
      }
    }),

  hydrateWorkspaces: (records, activeId) =>
    set((s) => {
      // If the saved set exceeds the cap, keep the one the user was last looking
      // at rather than blindly taking the first N — otherwise restoring drops
      // you into a tab you didn't leave open.
      const ordered = [...records]
      const activeIdx = activeId ? ordered.findIndex((r) => r.id === activeId) : -1
      if (activeIdx >= MAX_LIVE_WORKSPACES) {
        ordered.splice(MAX_LIVE_WORKSPACES - 1, 0, ...ordered.splice(activeIdx, 1))
      }
      // The overflow is parked, not discarded (see parkedWorkspaces).
      const parkedWorkspaces = ordered.slice(MAX_LIVE_WORKSPACES)
      const liveWorkspaces = ordered.slice(0, MAX_LIVE_WORKSPACES).map((r) => {
        const loaded = hydrateAgents(r.agents)
        const mode: LayoutMode = r.layoutMode === 'columns' ? 'columns' : 'grid'
        return newSession({
          id: r.id,
          name: r.name,
          defaultPath: r.defaultPath ?? r.path ?? null,
          agents: laidOut(loaded, mode, s.stageW, s.stageH),
          layoutMode: mode,
          selectedIds: loaded[0] ? [loaded[0].id] : []
        })
      })
      return {
        liveWorkspaces,
        parkedWorkspaces,
        // Fall back to the first tab if the saved active id is gone (e.g. it was
        // past the cap) — never leave a non-empty set with nothing on screen.
        activeWorkspaceId:
          (activeId && liveWorkspaces.some((w) => w.id === activeId) ? activeId : null) ??
          liveWorkspaces[0]?.id ??
          null
      }
    }),

  setWorkspaceGit: (id, git) =>
    set((s) => ({
      liveWorkspaces: mapWs(s.liveWorkspaces, id, (w) => ({
        ...w,
        isGit: git.isGit,
        baseBranch: git.branch
      }))
    })),

  createWorkspace: (name) =>
    set((s) => {
      if (s.liveWorkspaces.length >= MAX_LIVE_WORKSPACES) return {}
      const session = newSession({ name: name?.trim() || nextWorkspaceName(s.liveWorkspaces) })
      return {
        liveWorkspaces: [...s.liveWorkspaces, session],
        activeWorkspaceId: session.id
      }
    }),

  renameWorkspace: (id, name) =>
    set((s) => {
      const next = name.trim()
      // A blank name would leave an unclickable-looking tab; keep the old one.
      if (!next) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, id, (w) => ({ ...w, name: next })) }
    }),

  setWorkspacePath: (id, ref, git) =>
    set((s) => {
      const w = s.liveWorkspaces.find((x) => x.id === id)
      if (!w) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, id, (x) => ({
          ...x,
          defaultPath: ref.path,
          isGit: git.isGit,
          baseBranch: git.branch,
          // Only adopt the folder's name if the user never named this tab themselves.
          name: x.defaultPath === null && DEFAULT_NAME_RE.test(x.name) ? ref.name : x.name
        }))
      }
    }),

  closeWorkspace: (id) =>
    set((s) => {
      const idx = s.liveWorkspaces.findIndex((w) => w.id === id)
      if (idx === -1) return {}
      // Detach only: dropping the session unmounts its Stage → panes unmount →
      // PTYs die. Worktrees/branches survive (worktree.remove lives in
      // removeAgent, which we deliberately do NOT call here).
      const liveWorkspaces = s.liveWorkspaces.filter((w) => w.id !== id)
      let activeWorkspaceId = s.activeWorkspaceId
      if (s.activeWorkspaceId === id) {
        // Hand the foreground to the neighbour that slid into this slot (else the
        // previous one, else nothing → Home).
        const neighbour = liveWorkspaces[idx] ?? liveWorkspaces[idx - 1] ?? null
        activeWorkspaceId = neighbour ? neighbour.id : null
      }
      return { liveWorkspaces, activeWorkspaceId }
    }),

  setActiveWorkspace: (id) =>
    set((s) => {
      if (id === s.activeWorkspaceId || !s.liveWorkspaces.some((w) => w.id === id)) return {}
      // Re-tile the incoming workspace to the current viewport (the window may
      // have resized while it was hidden) and make sure it has a live selection
      // so keyboard input lands the instant it shows.
      const liveWorkspaces = mapWs(s.liveWorkspaces, id, (w) => {
        const agents = laidOut(w.agents, w.layoutMode, s.stageW, s.stageH)
        const selectedIds =
          w.selectedIds.length > 0 ? w.selectedIds : agents[0] ? [agents[0].id] : []
        return agents === w.agents && selectedIds === w.selectedIds
          ? w
          : { ...w, agents, selectedIds }
      })
      return { activeWorkspaceId: id, liveWorkspaces }
    }),

  setGitInfo: (git) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, isGit: git.isGit, baseBranch: git.branch })) }
    }),

  setWorkspaces: (workspaces) => set({ workspaces }),

  // Re-tile EVERY live workspace to the new viewport — they all share this one
  // window's stage box, so a resize must reflow the hidden ones too (their panes
  // are laid out even while hidden, ready to show crisp on switch).
  setStageSize: (w, h) =>
    set((s) => {
      if (s.stageReady && w === s.stageW && h === s.stageH) return {}
      return {
        stageW: w,
        stageH: h,
        stageReady: true,
        // `laidOut` deliberately returns the SAME array when no slot moved
        // (see its comment) — spreading unconditionally threw that away and
        // gave all six workspaces new identities on every resize frame.
        // setActiveWorkspace already preserves identity this way.
        liveWorkspaces: s.liveWorkspaces.map((ws) => {
          const agents = laidOut(ws.agents, ws.layoutMode, w, h)
          return agents === ws.agents ? ws : { ...ws, agents }
        })
      }
    }),

  setShells: (shells) =>
    set((s) => {
      if (!s.settings.defaultShellId && shells[0]) {
        const settings = { ...s.settings, defaultShellId: shells[0].id }
        saveSettings(settings)
        return { shells, settings, shellsLoaded: true }
      }
      return { shells, shellsLoaded: true }
    }),

  setAgentClis: (agentClis) => set({ agentClis, agentClisLoaded: true }),

  setSelected: (ids) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      // Invariant: while any terminal exists, one is always selected (and so
      // keyboard-focused). Clicking empty stage / rubber-banding nothing must
      // never leave the stage with no active terminal to type into — keep the
      // current selection, or fall back to the first terminal.
      let selectedIds = ids
      if (ids.length === 0 && ws.agents.length > 0) {
        if (ws.selectedIds.length > 0) return {}
        selectedIds = [ws.agents[0].id]
      }
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, selectedIds })) }
    }),

  setSetting: (key, value) =>
    set((s) => {
      const settings = { ...s.settings, [key]: value }
      saveSettings(settings)
      return { settings }
    }),

  // Opening any overlay also closes an open dropdown menu — one popup at a time.
  setSettingsOpen: (open) => set(open ? { settingsOpen: true, openMenu: null } : { settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setOpenMenu: (menu) => set({ openMenu: menu }),

  setPaletteOpen: (open) => set(open ? { paletteOpen: true, openMenu: null } : { paletteOpen: false }),

  setFeedbackOpen: (open) => set(open ? { feedbackOpen: true, openMenu: null } : { feedbackOpen: false }),

  // A fresh detection re-shows the banner even if a prior version was dismissed
  // this session — clearing updateDismissed on a real change is the "continuous"
  // guarantee. Re-detecting the SAME version keeps the current dismiss state.
  setUpdate: (update) =>
    set((s) => {
      if (update && s.update && update.latest === s.update.latest) return { update }
      return { update, updateDismissed: false }
    }),

  // A ready download un-dismisses the banner: "restart to update" is a one-click
  // finish the user almost certainly wants to see, unlike another download nag.
  setUpdateState: (updateState) =>
    set((s) => ({
      updateState,
      updateDismissed: updateState?.status === 'ready' ? false : s.updateDismissed
    })),

  dismissUpdate: () => set({ updateDismissed: true }),

  setDiffAgentId: (id) =>
    set((s) => {
      // A diff review always belongs to the workspace on screen.
      const ws = activeWs(s)
      if (!ws) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, diffAgentId: id })) }
    }),

  // The file panel always belongs to the workspace on screen. Re-opening at the
  // SAME scope preserves the open file + dirty flag (so toggling it shut and back
  // resumes where you were); switching scope clears both — a different root's
  // relative path is meaningless.
  openFilePanel: (scope) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => {
          const same = sameScope(w.filePanel.scope, scope)
          return {
            ...w,
            filePanel: {
              open: true,
              scope,
              openPath: same ? w.filePanel.openPath : null,
              dirty: same ? w.filePanel.dirty : false
            }
          }
        })
      }
    }),

  setFilePanelScope: (scope) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          filePanel: { ...w.filePanel, scope, openPath: null, dirty: false }
        }))
      }
    }),

  openFile: (relPath) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          filePanel: { ...w.filePanel, openPath: relPath }
        }))
      }
    }),

  setFileDirty: (dirty) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          filePanel: { ...w.filePanel, dirty }
        }))
      }
    }),

  closeFilePanel: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          filePanel: { ...w.filePanel, open: false }
        }))
      }
    }),

  toggleFilePanel: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => {
          const open = !w.filePanel.open
          // Turning ON: if the remembered scope points at an agent that's since
          // been closed, it's no longer meaningful — fall back to the project root.
          const staleAgent =
            open &&
            w.filePanel.scope.kind === 'agent' &&
            !w.agents.some((a) => a.id === (w.filePanel.scope as { agentId: string }).agentId)
          return {
            ...w,
            filePanel: {
              ...w.filePanel,
              open,
              ...(staleAgent ? { scope: { kind: 'root' as const }, openPath: null, dirty: false } : {})
            }
          }
        })
      }
    }),

  setFilePanelWidth: (px) => {
    const filePanelWidth = clampNum(px, FILE_PANEL_MIN, FILE_PANEL_MAX, FILE_PANEL_DEFAULT)
    saveFilePanelWidth(filePanelWidth)
    set({ filePanelWidth })
  },

  // The pane owning `id` runs the guarded close (dirty-check + confirm); these
  // just hand the request to it (on its own workspace) and clear it once picked up.
  requestClose: (id) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, pendingCloseId: id })) }
    }),
  clearPendingClose: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws || ws.pendingCloseId === null) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, pendingCloseId: null })) }
    }),

  // Bulk close is confirmed (and executed) by the modal in App.tsx; the store
  // only carries the request (on the active workspace) so both ⌘W and the palette
  // can raise it.
  requestBulkClose: (ids) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, bulkCloseIds: ids })) }
    }),
  clearBulkClose: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws || ws.bulkCloseIds === null) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, bulkCloseIds: null })) }
    }),

  // Closing a workspace tab kills every PTY in it, so the tab × and the palette
  // both route through this app-level request; the modal in App.tsx confirms and
  // runs the actual close (closeWorkspaceById).
  requestWorkspaceClose: (id) => set({ confirmWorkspaceCloseId: id }),
  clearWorkspaceClose: () => set({ confirmWorkspaceCloseId: null }),

  addAgent: (opts) => {
    // Defaults to the workspace on screen; restore passes an explicit id so it
    // can seed background tabs without yanking the foreground around.
    const ws = opts?.workspaceId ? wsById(get(), opts.workspaceId) : activeWs(get())
    if (!ws) return
    // Tell the user why nothing happened at the cap — the ⌘T / reopen keyboard
    // paths otherwise no-op silently (the Rail button + palette already hide/disable
    // themselves, but a keystroke gave no feedback and read as a broken shortcut).
    if (ws.agents.length >= MAX_AGENTS) {
      get().pushToast(`Maximum ${MAX_AGENTS} terminals on one stage`, 'info')
      return
    }
    set((s) => {
      const cur = wsById(s, ws.id)
      if (!cur) return {}
      // Isolation follows the folder this agent will actually run in — an agent
      // pointed at a non-git folder can't have a worktree even if its workspace
      // default is a repo (and vice versa).
      const isGit = opts?.isGit ?? cur.isGit
      const isolation: Isolation =
        isGit && s.settings.defaultIsolation === 'worktree' ? 'worktree' : 'shared'
      const shellId = opts?.shellId ?? s.settings.defaultShellId ?? undefined
      const agent: AgentInstance = {
        id: uuid(),
        label: uniqueName(cur.agents),
        x: 0,
        y: 0,
        w: DEFAULT_W,
        h: DEFAULT_H,
        isolation,
        shellId,
        startupCommand: opts?.command,
        agentLabel: opts?.agentLabel,
        agentId: opts?.agentId,
        // Only stored when it differs from the default — an agent that just
        // inherits stays undefined so moving the workspace's folder moves it too.
        projectPath:
          opts?.projectPath && opts.projectPath !== cur.defaultPath ? opts.projectPath : undefined
      }
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, cur.id, (w) => ({
          ...w,
          agents: laidOut([...w.agents, agent], w.layoutMode, s.stageW, s.stageH),
          selectedIds: [agent.id],
          focusedId: null
        }))
      }
    })
  },

  removeAgent: (id, opts) => {
    // Two-phase: flag the pane so it plays its collapse animation, then do the
    // real removal (and worktree cleanup) once that's had time to finish. Guard
    // against double-calls so a second close can't double-remove the worktree.
    const ws = wsOfAgent(get(), id)
    if (!ws) return
    if (ws.closingIds.includes(id) || !ws.agents.some((a) => a.id === id)) return
    // Resolve the cleanup target NOW, not inside the timeout. If the owning
    // workspace is closed during the 180ms collapse animation, wsById() below
    // returns undefined and the worktree removal used to be skipped entirely —
    // leaking the worktree to the orphan sweeper.
    const closingAgent = ws.agents.find((a) => a.id === id)
    const closingRepo = closingAgent ? agentPath(ws, closingAgent) : null
    // keepWorktree leaves the branch + worktree on disk (recoverable work).
    // Must remove from the agent's OWN repo — with per-agent folders the
    // workspace default may be a different repo entirely, and removing
    // there would silently fail to clean up (or hit the wrong worktree).
    const cleanupWorktree = (): void => {
      if (!opts?.keepWorktree && closingAgent?.isolation === 'worktree' && closingRepo) {
        void window.api.worktree.remove(closingRepo, id)
      }
    }
    set((s) => ({
      liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
        ...w,
        closingIds: [...w.closingIds, id]
      }))
    }))
    setTimeout(() => {
      let removed = false
      set((s) => {
        const w = wsById(s, ws.id)
        if (!w) return {}
        const agent = w.agents.find((a) => a.id === id)
        const closingIds = w.closingIds.filter((c) => c !== id)
        if (!agent) return { liveWorkspaces: mapWs(s.liveWorkspaces, w.id, (x) => ({ ...x, closingIds })) }
        removed = true
        cleanupWorktree()
        const rest = w.agents.filter((a) => a.id !== id)
        let selectedIds = w.selectedIds.filter((sid) => sid !== id)
        // Closing the active terminal shouldn't leave the stage inert — hand
        // selection (and thus keyboard focus) to the nearest surviving neighbour.
        if (selectedIds.length === 0 && rest.length > 0) {
          const idx = w.agents.findIndex((a) => a.id === id)
          selectedIds = [rest[Math.min(idx, rest.length - 1)].id]
        }
        return {
          liveWorkspaces: mapWs(s.liveWorkspaces, w.id, (x) => ({
            ...x,
            agents: laidOut(rest, x.layoutMode, s.stageW, s.stageH),
            selectedIds,
            closingIds,
            focusedId: x.focusedId === id ? null : x.focusedId,
            pendingCloseId: x.pendingCloseId === id ? null : x.pendingCloseId,
            lastClosed: {
              label: agent.label,
              shellId: agent.shellId,
              isolation: agent.isolation,
              startupCommand: agent.startupCommand,
              agentLabel: agent.agentLabel,
              agentId: agent.agentId
            }
          }))
        }
      })
      // The workspace (or the agent) vanished mid-animation, so the updater
      // above bailed before cleaning up. Do it here — the worktree is on disk
      // either way and nothing else will remove it.
      if (!removed) cleanupWorktree()
    }, 180)
  },

  reopenLast: () => {
    const ws = activeWs(get())
    if (!ws) return
    if (ws.agents.length >= MAX_AGENTS) {
      get().pushToast(`Maximum ${MAX_AGENTS} terminals on one stage`, 'info')
      return
    }
    set((s) => {
      const w = wsById(s, ws.id)
      if (!w) return {}
      const lc = w.lastClosed
      if (!lc) return {}
      const taken = new Set(w.agents.map((a) => a.label.toLowerCase()))
      const agent: AgentInstance = {
        id: uuid(),
        label: taken.has(lc.label.toLowerCase()) ? uniqueName(w.agents) : lc.label,
        x: 0,
        y: 0,
        w: DEFAULT_W,
        h: DEFAULT_H,
        isolation: lc.isolation,
        shellId: lc.shellId,
        startupCommand: lc.startupCommand,
        agentLabel: lc.agentLabel,
        agentId: lc.agentId
      }
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, w.id, (x) => ({
          ...x,
          agents: laidOut([...x.agents, agent], x.layoutMode, s.stageW, s.stageH),
          selectedIds: [agent.id],
          focusedId: null,
          lastClosed: null
        }))
      }
    })
  },

  renameAgent: (id, label) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          agents: w.agents.map((a) => (a.id === id ? { ...a, label: label || a.label } : a))
        }))
      }
    }),

  // Toggle a card's wide (double-weight) tile and re-tile.
  toggleWide: (id) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          agents: laidOut(
            w.agents.map((a) => (a.id === id ? { ...a, wide: !a.wide } : a)),
            w.layoutMode,
            s.stageW,
            s.stageH
          )
        }))
      }
    }),

  // Switch the active workspace's persistent layout and re-tile immediately.
  setLayoutMode: (mode) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          layoutMode: mode,
          focusedId: null,
          agents: laidOut(w.agents, mode, s.stageW, s.stageH)
        }))
      }
    }),

  setDraggingId: (id) =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, draggingId: id })) }
    }),

  // Live reorder while dragging: move it in the order, re-tile the OTHERS (the
  // dragged one is skipped so it keeps following the cursor, leaving a gap).
  reorderAgent: (id, toIndex) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => {
          const from = w.agents.findIndex((a) => a.id === id)
          if (from < 0) return w
          const arr = [...w.agents]
          const [moved] = arr.splice(from, 1)
          arr.splice(Math.max(0, Math.min(arr.length, toIndex)), 0, moved)
          return { ...w, agents: laidOut(arr, w.layoutMode, s.stageW, s.stageH, w.draggingId) }
        })
      }
    }),

  // Re-tile the active workspace to the viewport (skips the dragged card if held).
  relayout: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          agents: laidOut(w.agents, w.layoutMode, s.stageW, s.stageH, w.draggingId)
        }))
      }
    }),

  // Focus: the pane expands to fill the viewport (tmux-style zoom) rather than
  // scaling the camera. A CSS scale() breaks xterm's mouse math — its cell
  // hit-testing doesn't compensate for transforms, so selection landed on the
  // wrong characters — and scaled glyphs blur. Maximizing refits the terminal
  // instead: crisp text, MORE rows/cols, and pixel-perfect selection.
  // Jumping to an agent in a BACKGROUND workspace also brings that workspace
  // forward (so "Jump to"/notification targets always land somewhere visible).
  focusTerminal: (id) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return {
        activeWorkspaceId: ws.id,
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          focusedId: id,
          selectedIds: [id]
        }))
      }
    }),

  // Bring an agent to the foreground so you can act on it — the shared target of
  // the rail's attention bell and a clicked desktop notification. Brings its
  // workspace forward (it may be a background one), then NEVER force-maximizes:
  // if a pane is already maximized we retarget that maximize to this agent (so it
  // doesn't stay hidden behind the zoomed one), otherwise we just select it —
  // which hands over keyboard focus. (Contrast focusTerminal, the tmux-style zoom.)
  revealAgent: (id) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      return {
        activeWorkspaceId: ws.id,
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) =>
          w.focusedId
            ? w.focusedId === id
              ? w
              : { ...w, focusedId: id, selectedIds: [id] }
            : { ...w, selectedIds: [id] }
        )
      }
    }),

  clearFocus: () =>
    set((s) => {
      const ws = activeWs(s)
      if (!ws || ws.focusedId === null) return {}
      return { liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({ ...w, focusedId: null })) }
    }),

  // Runtime + status updates come from EVERY live workspace's panes (background
  // ones stream too), so locate the owning workspace by agent id rather than
  // assuming the active one. Only the owning session's object changes.
  setAgentRuntime: (id, rt) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      // A write that changes nothing must not allocate. mapWs mints a new outer
      // array every call, so a no-op here still re-renders App and, through it,
      // every live workspace's Stage — Moveable and Selecto included.
      const cur = ws.agents.find((a) => a.id === id)
      if (cur && (Object.keys(rt) as Array<keyof AgentInstance>).every((k) => cur[k] === rt[k])) {
        return {}
      }
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          agents: w.agents.map((a) => (a.id === id ? { ...a, ...rt } : a))
        }))
      }
    }),

  setStatus: (id, status) =>
    set((s) => {
      const ws = wsOfAgent(s, id)
      if (!ws) return {}
      // `evaluateIdle` re-asserts 'idle' at the end of every output burst, so
      // idle→idle is the common case, not an edge one.
      if (ws.agents.find((a) => a.id === id)?.status === status) return {}
      return {
        liveWorkspaces: mapWs(s.liveWorkspaces, ws.id, (w) => ({
          ...w,
          agents: w.agents.map((a) => (a.id === id ? { ...a, status } : a))
        }))
      }
    }),

  pushToast: (text, kind = 'info', action) =>
    set((s) => {
      // De-dupe: the same message firing again (e.g. a burst of merge/CLI errors)
      // must not wallpaper the corner with twins. Refresh the live one instead —
      // move it to the top of the stack and bump `refresh` so its timer restarts.
      const dup = s.toasts.find((t) => t.text === text && t.kind === kind)
      if (dup) {
        // Keep the id, but take THIS call's action fields — keeping the old
        // object would keep a stale closure (e.g. "Initialize git" still bound
        // to a previously opened project's path). Actions are overwritten even
        // when the new push has none: the caller's latest intent wins.
        const fresh: Toast = {
          id: dup.id,
          text,
          kind,
          actionLabel: action?.actionLabel,
          onAction: action?.onAction,
          secondaryLabel: action?.secondaryLabel,
          onSecondary: action?.onSecondary,
          sticky: action?.sticky,
          timeoutMs: action?.timeoutMs,
          refresh: (dup.refresh ?? 0) + 1
        }
        return { toasts: [...s.toasts.filter((t) => t !== dup), fresh] }
      }
      let toasts: Toast[] = [...s.toasts, { id: uuid(), text, kind, ...action }]
      // Cap the stack: evict the OLDEST, preferring non-sticky (sticky ones carry
      // an action or an error the user must see). Never drop the newest — the
      // user just triggered it.
      if (toasts.length > MAX_TOASTS) {
        const victim = toasts.find((t) => !toastIsSticky(t)) ?? toasts[0]
        toasts = toasts.filter((t) => t !== victim)
      }
      return { toasts }
    }),

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

// Exposed for diagnostics / debugging from the main process.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__agentStore = useStore
}
