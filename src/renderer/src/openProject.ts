import { useStore, toPersisted, activeWs, agentPath, uuid, MAX_LIVE_WORKSPACES } from './store'
import { RECENT_KEY, getRecent, removeRecent, type RecentProject } from './recent'
import { samePath } from './pathUtil'

export type { RecentProject }

// Surface a save failure once per "broken" streak — autosave fires every few
// hundred ms, so we must not toast on every attempt. Reset when a save succeeds.
let saveFailedNotified = false

/** Last path segment of a folder path (fallback display name). */
function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

/** The live workspace whose DEFAULT folder is this path, if any. Note this is no
 *  longer "the workspace using this folder" — agents can point anywhere, and
 *  several workspaces can share a default. Use agentsUsing() for ownership. */
function wsByPath(path: string): ReturnType<typeof activeWs> {
  return useStore.getState().liveWorkspaces.find((w) => samePath(w.defaultPath, path))
}

/**
 * Ids of every live agent running in a folder, ACROSS ALL WORKSPACES.
 *
 * Worktree cleanup hands this to the main process as the "don't touch these"
 * set. It used to be one workspace's agent list, which was complete only while
 * a folder could be open in exactly one workspace. Now that agents carry their
 * own folder, a repo can be in use by agents in several workspaces at once —
 * missing any of them would sweep a worktree that's alive and working.
 */
function agentsUsing(path: string): string[] {
  const ids: string[] = []
  for (const w of useStore.getState().liveWorkspaces) {
    for (const a of w.agents) {
      if (samePath(agentPath(w, a), path)) ids.push(a.id)
    }
  }
  return ids
}

/** Whether any live agent still runs in this folder — the guard for cleanup
 *  toasts that can outlive the workspace they were raised for. */
function pathStillLive(path: string): boolean {
  return (
    agentsUsing(path).length > 0 ||
    useStore.getState().liveWorkspaces.some((w) => samePath(w.defaultPath, path))
  )
}

function pushRecent(ref: RecentProject): void {
  try {
    const list = getRecent().filter((r) => r.path !== ref.path)
    list.unshift({ path: ref.path, name: ref.name })
    const trimmed = list.slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed))
    // Mirror into the store so the +/dropdown's recents list updates live.
    useStore.getState().setWorkspaces(trimmed)
  } catch {
    /* ignore */
  }
}

// --- workspace persistence (survives restart) ------------------------------
// Everything about the tab set — order, names, folders, agents, which was
// active — lives in ONE app-data file. It used to be split between a
// localStorage path list and a canvas.json inside each project folder, which
// stopped working once a workspace could exist without a folder.
//
// Legacy key, still read once to migrate users forward, never written again.
const LEGACY_OPEN_KEY = 'vectro.openWorkspaces'

// Gated until restoreWorkspaces has read the saved set — otherwise an early
// store mutation (e.g. shell detection landing) would write an EMPTY set and
// clobber the tabs we're about to restore.
let persistEnabled = false

type StoreState = ReturnType<typeof useStore.getState>

/** Snapshot the live tab set for disk. Runtime-only agent fields (ptyId, status,
 *  cwd, …) are stripped by toPersisted. Takes the state rather than reading it,
 *  so the same function can serve the writer (latest state) and the autosave's
 *  change signature (whatever state the subscription is being asked about). */
function snapshotOf(s: StoreState): PersistedWorkspaces {
  return {
    version: 1,
    activeId: s.activeWorkspaceId,
    workspaces: [
      ...s.liveWorkspaces.map((w) => ({
        id: w.id,
        name: w.name,
        defaultPath: w.defaultPath,
        layoutMode: w.layoutMode,
        agents: toPersisted(w.agents)
      })),
      // Anything the restore parked past MAX_LIVE_WORKSPACES rides along
      // unchanged. Without this the first autosave after a restore would write
      // the truncated set and permanently delete those tabs.
      ...s.parkedWorkspaces
    ]
  }
}

/**
 * Signature of everything that reaches disk — the autosave's change trigger.
 *
 * Derived from the snapshot itself, so it covers exactly the fields that get
 * written and cannot fall behind them. This used to be a hand-written template
 * in App.tsx that listed each persisted field by name, and it had to be edited
 * in step with toPersisted; twice it wasn't, and `termTheme` and `projectPath`
 * silently reached disk only when some unrelated change happened to trigger a
 * save. Reading the snapshot means adding a field to toPersisted is enough.
 *
 * Still no runtime churn: toPersisted has already stripped status, ptyId, cwd
 * and branch, so a streaming agent flipping between working and idle produces
 * an identical signature and no write.
 *
 * Shaped as a store selector so nothing has to declare WHICH slices matter —
 * that list was the same maintenance hazard one level up.
 */
export function persistedSignature(s: StoreState): string {
  return JSON.stringify(snapshotOf(s))
}

/** The snapshot as of right now — what actually gets written. */
function snapshot(): PersistedWorkspaces {
  return snapshotOf(useStore.getState())
}

/** Single writer for the workspace store — shared by the debounced autosave in
 *  App and the flush-on-close below. No-ops until restore has run. */
export async function saveWorkspaces(): Promise<void> {
  if (!persistEnabled) return
  let ok = false
  try {
    ok = await window.api.workspaces.save(snapshot())
  } catch {
    ok = false
  }
  if (ok) {
    saveFailedNotified = false
  } else if (!saveFailedNotified) {
    saveFailedNotified = true
    useStore.getState().pushToast('Couldn’t save your workspaces.', 'error')
  }
}

// Diagnostics hook, alongside window.__agentStore. Smoke tests simulate a fresh
// install by deleting workspaces.json out from under a running renderer, then
// reloading — but the flush-on-unload would faithfully rewrite it and undo the
// setup. This lets a harness stop persistence first. Never called by the app.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__agentmasterDisablePersist = (): void => {
    persistEnabled = false
  }
}

/** Rebuild the old split persistence (localStorage path list + per-project
 *  canvas.json) into the app-data shape, once, for users upgrading. The
 *  canvas.json files are deliberately left on disk as a fallback. */
async function migrateLegacyWorkspaces(): Promise<PersistedWorkspace[]> {
  let paths: string[] = []
  try {
    const raw = localStorage.getItem(LEGACY_OPEN_KEY)
    const v = raw ? JSON.parse(raw) : null
    if (v && Array.isArray(v.paths)) {
      paths = v.paths.filter((p: unknown): p is string => typeof p === 'string')
    }
  } catch {
    /* unreadable legacy key — fall through to recents below */
  }
  // Pre-tabs users have no open-set at all; carry their most recent project over
  // so an upgrade never lands them on an empty Home.
  const recent = getRecent()
  if (paths.length === 0 && recent[0]) paths = [recent[0].path]
  if (paths.length === 0) return []

  const names = new Map(recent.map((r) => [r.path, r.name]))
  const out: PersistedWorkspace[] = []
  for (const path of paths.slice(0, MAX_LIVE_WORKSPACES)) {
    try {
      if (!(await window.api.project.exists(path))) continue
      const saved = await window.api.project.load(path)
      out.push({
        id: uuid(),
        name: names.get(path) ?? basename(path),
        defaultPath: path,
        layoutMode: saved?.layoutMode === 'columns' ? 'columns' : 'grid',
        agents: saved?.agents ?? []
      })
    } catch (e) {
      console.error('[agentmaster] migrate workspace failed:', path, e)
    }
  }
  return out
}

/** Run `git init` in a project folder, then refresh the store's git state so the
 *  non-git affordances (shared-mode chip, isolation default) update in place.
 *  Shared by the open-time toast action and the ProjectBar chip. Init alone
 *  doesn't create a commit, so worktree isolation still needs one — the follow-up
 *  toast says so (and the isolation-failure toast repeats it if they forget). */
export async function initGitForProject(path: string): Promise<void> {
  try {
    const res = await window.api.git.init(path)
    if (!res.ok) {
      useStore.getState().pushToast(res.error ?? 'Couldn’t initialize git here.', 'error')
      return
    }
    const git = await window.api.git.info(path)
    // The user may have switched workspaces while init ran — only stamp git state
    // when the inited folder is still the one on screen.
    if (activeWs(useStore.getState())?.defaultPath === path) useStore.getState().setGitInfo(git)
    useStore
      .getState()
      .pushToast(
        'Git initialized. Commit your files to enable isolated agents (each gets its own branch + worktree).',
        'info'
      )
  } catch (e) {
    console.error('[agentmaster] git init failed:', e)
    useStore.getState().pushToast('Couldn’t initialize git here.', 'error')
  }
}

/** Attach a folder to an existing workspace tab (one created empty, or one being
 *  repointed). Unlike openProjectInteractive this never creates a tab — the
 *  workspace, its name, and its agents all survive the change. */
export async function pickFolderForWorkspace(id: string): Promise<void> {
  try {
    const ref = await window.api.project.pick()
    if (!ref) return
    // The tab may have been closed while the OS dialog was up.
    if (!useStore.getState().liveWorkspaces.some((w) => w.id === id)) return
    const git = await window.api.git.info(ref.path)
    useStore.getState().setWorkspacePath(id, ref, git)
    pushRecent(ref)
  } catch (e) {
    console.error('[agentmaster] pick folder for workspace failed:', e)
    useStore.getState().pushToast('Couldn’t open that folder.', 'error')
  }
}

/** Remove the work-free orphaned worktrees the open-time check found. The main
 *  process re-lists at cleanup time (no path list round-trips through here) and
 *  never removes an orphan with unmerged/uncommitted work. */
async function cleanOrphanWorktrees(path: string): Promise<void> {
  try {
    // The toast can outlive a workspace close — never sweep against a folder
    // nothing is using any more.
    if (!pathStillLive(path)) return
    // Owned ids are read at CLICK time, not from the toast's closure: agents
    // added since the toast appeared own fresh worktrees that must never sweep.
    const owned = agentsUsing(path)
    const { removed } = await window.api.git.cleanOrphans(path, owned)
    if (!pathStillLive(path)) return
    if (removed > 0) {
      useStore
        .getState()
        .pushToast(`Removed ${removed} worktree${removed === 1 ? '' : 's'}`, 'success')
    }
  } catch (e) {
    console.error('[agentmaster] worktree cleanup failed:', e)
    useStore.getState().pushToast('Couldn’t clean up the leftover worktrees.', 'error')
  }
}

/** Fire-and-forget after a git workspace opens: stale canvas/* worktrees from
 *  crashed/force-quit sessions are still registered (so `worktree prune` skips
 *  them) and otherwise invisible — surface them with a cleanup offer. Orphans
 *  with work (kept-on-close worktrees, unmerged branches, dirty trees) are only
 *  mentioned, never offered a destructive action — "Keep" promised no loss. */
async function checkOrphanWorktrees(path: string): Promise<void> {
  try {
    // Read the agent list NOW (post-open, post-default-agent) so every live
    // agent's worktree — including ones being created this instant — is owned.
    const owned = agentsUsing(path)
    const orphans = await window.api.git.orphans(path, owned)
    // The user may have closed this workspace while the check ran — this toast
    // (and its action) belongs to that folder only.
    if (!pathStillLive(path)) return
    if (orphans.length === 0) return
    const removable = orphans.filter((o) => !o.hasWork).length
    const kept = orphans.length - removable
    const keptNote =
      kept > 0 ? `${kept} kept worktree${kept === 1 ? '' : 's'} with unmerged work left untouched` : ''
    if (removable > 0) {
      useStore
        .getState()
        .pushToast(
          `${removable} leftover agent worktree${removable === 1 ? '' : 's'} from previous sessions` +
            (keptNote ? ` — ${keptNote}` : ''),
          'info',
          { actionLabel: 'Clean up', onAction: () => void cleanOrphanWorktrees(path) }
        )
    } else if (kept > 0) {
      useStore.getState().pushToast(keptNote, 'info')
    }
  } catch {
    /* best-effort — never block or fail a workspace open over this */
  }
}

// Set while an open is in flight. Opening is async (stage load + git info) and
// the Home card/button stay clickable meanwhile, so a second click (or a stray
// double-click) would spawn a duplicate stage + a second set of shells.
let opening = false

/** Load a folder's saved stage + git info, prune stale worktrees, and open it
 *  as a live workspace tab. If it's already open, just bring its tab forward. */
export async function openProjectByPath(ref: RecentProject): Promise<void> {
  const store = useStore.getState()
  // Already live → focus its tab (never a second copy, never respawn its agents).
  // samePath, not ===: D:\repo and D:/repo must not open as two tabs racing over
  // the same worktree container.
  const already = store.liveWorkspaces.find((w) => samePath(w.defaultPath, ref.path))
  if (already) {
    store.setActiveWorkspace(already.id)
    return
  }
  if (opening) return
  opening = true
  try {
    // A recent card may point at a folder that's since been moved or deleted.
    // Opening it would spawn a stage full of dead terminals — refuse and prune.
    const exists = await window.api.project.exists(ref.path)
    if (!exists) {
      store.setWorkspaces(removeRecent(ref.path))
      store.pushToast(`“${ref.name}” no longer exists at that location`, 'error')
      return
    }

    // Hard cap so the tab strip always fits the screen — refuse rather than
    // overflow. (An already-open folder was focused above; this only blocks NEW ones.)
    if (useStore.getState().liveWorkspaces.length >= MAX_LIVE_WORKSPACES) {
      store.pushToast(
        `Up to ${MAX_LIVE_WORKSPACES} workspaces can be open at once — close one first.`,
        'info'
      )
      return
    }
    // Opening a folder always starts a fresh workspace. canvas.json is no longer
    // consulted here: it hasn't been written since workspaces became folder-less,
    // so reading it would restore a layout from some much older build. It's still
    // read once by migrateLegacyWorkspaces for users upgrading.
    const git = await window.api.git.info(ref.path)
    void window.api.git.prune(ref.path)
    pushRecent(ref)
    useStore.getState().openWorkspace(ref, null, git)
    // A non-git folder silently loses the headline feature (per-agent worktree
    // isolation) — say so instead of quietly downgrading to a shared dir, and
    // offer the fix in place. Deliberately transient (7s): the amber
    // "no isolation" chip in the project bar persists with the same
    // click-to-init action, so nothing is lost when the toast fades — and the
    // corner can't accumulate permanent toasts (e.g. next to an update nudge).
    if (!git.isGit) {
      useStore
        .getState()
        .pushToast('Not a git repo — agents will share this folder without isolation.', 'info', {
          actionLabel: 'Initialize git',
          onAction: () => void initGitForProject(ref.path),
          sticky: false,
          timeoutMs: 7000
        })
    }
    // Always land on at least one terminal so a freshly-opened workspace isn't a
    // bare stage. openWorkspace made it active, so addAgent targets it.
    if ((wsByPath(ref.path)?.agents.length ?? 0) === 0) useStore.getState().addAgent()
    // After the stage (and its default agent) exists, look for worktrees left
    // by crashed sessions — must run after addAgent so the fresh agent's ids
    // are in the owned set.
    if (git.isGit) void checkOrphanWorktrees(ref.path)
  } catch (e) {
    console.error('[agentmaster] open project failed:', e)
    useStore.getState().pushToast(`Couldn’t open “${ref.name}”`, 'error')
  } finally {
    opening = false
  }
}

/** Close a live workspace tab. Detach only — worktrees/branches stay on disk
 *  (reopen restores them). The save happens AFTER the close so the removed tab
 *  is actually gone from the snapshot; the debounced autosave would get there
 *  too, but flushing here means a quit right after a close can't lose it. */
export function closeWorkspaceById(id: string): void {
  useStore.getState().closeWorkspace(id)
  void saveWorkspaces()
}

/** Ask to close the workspace currently on screen (⌘ affordances / palette) —
 *  routes through the same confirm modal as the tab ×. */
export function closeCurrentProject(): void {
  const ws = activeWs(useStore.getState())
  if (ws) useStore.getState().requestWorkspaceClose(ws.id)
}

/** Pick a folder via the OS dialog, then open it as a tab. */
export async function openProjectInteractive(): Promise<void> {
  try {
    const ref = await window.api.project.pick()
    if (!ref) return
    await openProjectByPath(ref)
  } catch (e) {
    console.error('[agentmaster] open folder failed:', e)
    useStore.getState().pushToast('Couldn’t open that folder', 'error')
  }
}

/** On launch, reopen every live workspace from last session (spawning all their
 *  agents) and restore which one was active. Falls back to the most-recent
 *  project for existing users with no persisted live set. */
export async function restoreWorkspaces(): Promise<void> {
  if (useStore.getState().liveWorkspaces.length > 0) {
    persistEnabled = true
    return
  }

  let saved: PersistedWorkspaces | null = null
  try {
    saved = await window.api.workspaces.load()
  } catch (e) {
    console.error('[agentmaster] workspaces:load failed:', e)
  }
  // No app-data store yet → either a first run or an upgrade from the old split
  // persistence. Migrating writes the new file on the first save below.
  const records = saved?.workspaces?.length
    ? saved.workspaces
    : saved
      ? [] // an explicitly-empty saved set means the user closed everything
      : await migrateLegacyWorkspaces()

  // Drop folders that have since been moved or deleted — restoring one would
  // spawn a stage full of dead terminals. Folder-less workspaces always survive.
  const alive: PersistedWorkspace[] = []
  for (const r of records) {
    try {
      const rp = r.defaultPath ?? r.path ?? null
      if (rp && !(await window.api.project.exists(rp))) continue
      alive.push(r)
    } catch {
      /* an unreadable path is treated as gone */
    }
  }

  if (alive.length === 0) {
    persistEnabled = true
    return
  }

  // Paint every tab at once, then fill in the slower per-folder git state.
  useStore.getState().hydrateWorkspaces(alive, saved?.activeId ?? null)

  for (const r of alive) {
    // `defaultPath` is what snapshot() writes; `path` is the pre-per-agent-folders
    // field kept only for reading older saves. Guarding on `path` alone silently
    // skipped EVERY workspace written by the current version — no git info meant
    // isolation quietly downgraded to 'shared' on every restart.
    const path = r.defaultPath ?? r.path
    if (!path) continue
    try {
      const git = await window.api.git.info(path)
      useStore.getState().setWorkspaceGit(r.id, git)
      void window.api.git.prune(path)
      if (git.isGit) void checkOrphanWorktrees(path)
    } catch (e) {
      console.error('[agentmaster] restore git info failed:', path, e)
    }
  }

  // Never restore a workspace to a bare stage — but only for folder-bound ones.
  // An empty folder-less workspace is a deliberate state (you just made it).
  for (const r of alive) {
    const ws = useStore.getState().liveWorkspaces.find((w) => w.id === r.id)
    if (ws && ws.defaultPath && ws.agents.length === 0)
      useStore.getState().addAgent({ workspaceId: ws.id })
  }

  // Saved set is fully restored — from here, mirror every change to disk.
  persistEnabled = true
}
