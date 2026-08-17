import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useStore,
  agentPath,
  agentPathById,
  activeWs,
  wsById,
  wsOfAgent,
  displayBranch,
  toPersisted,
  toastIsSticky,
  MAX_AGENTS,
  MAX_LIVE_WORKSPACES,
  FILE_PANEL_MIN,
  FILE_PANEL_MAX,
  FILE_PANEL_DEFAULT,
  type AgentInstance,
  type WorkspaceSession
} from './store'

// The store is where features collide. Every mutator here is reachable from
// several unrelated bits of UI, so a change made for one feature lands on all
// the others — which is exactly the shape of the regressions this file exists
// to catch. Each test names the invariant it protects rather than the function
// it calls.

// Captured before any test mutates state. setState(_, true) REPLACES the whole
// object, actions included, so the snapshot has to carry them — every mutator
// is immutable, so re-using these array refs is safe.
const INITIAL = useStore.getState()

const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
/** The active workspace, asserted non-null so tests read cleanly. */
const ws = (): WorkspaceSession => {
  const w = activeWs(st())
  if (!w) throw new Error('no active workspace')
  return w
}
const agentIds = (): string[] => ws().agents.map((a) => a.id)

beforeEach(() => {
  useStore.setState(INITIAL, true)
})

describe('agentPath', () => {
  // THE answer to "where does this agent run". Worktree creation, the diff
  // view, the file panel and the spawn cwd all route through it; reading
  // ws.defaultPath directly is the bug it exists to prevent.
  const wsWith = (defaultPath: string | null): WorkspaceSession =>
    ({ defaultPath }) as WorkspaceSession
  const agentWith = (projectPath?: string): AgentInstance =>
    ({ projectPath }) as AgentInstance

  it('prefers the agent override over the workspace default', () => {
    expect(agentPath(wsWith('/ws'), agentWith('/agent'))).toBe('/agent')
  })

  it('falls back to the workspace default when the agent has no override', () => {
    expect(agentPath(wsWith('/ws'), agentWith(undefined))).toBe('/ws')
  })

  it('returns null when neither has a path', () => {
    expect(agentPath(wsWith(null), agentWith(undefined))).toBeNull()
  })

  it('treats an empty-string override as a real value, not a missing one', () => {
    // ?? not || — the distinction matters, since '' is falsy but present.
    expect(agentPath(wsWith('/ws'), agentWith(''))).toBe('')
  })

  it('tolerates a missing workspace or agent', () => {
    expect(agentPath(undefined, undefined)).toBeNull()
    expect(agentPath(undefined, agentWith('/a'))).toBe('/a')
    expect(agentPath(wsWith('/ws'), undefined)).toBe('/ws')
  })
})

describe('workspace and agent lookup', () => {
  it('activeWs returns undefined for a dangling active id', () => {
    useStore.setState({ liveWorkspaces: [], activeWorkspaceId: 'gone' })
    expect(activeWs(st())).toBeUndefined()
  })

  it('activeWs returns undefined when nothing is active', () => {
    expect(activeWs(st())).toBeUndefined()
  })

  it('wsById and wsOfAgent find the owning workspace', () => {
    st().createWorkspace('One')
    const first = ws().id
    st().addAgent()
    const agentId = agentIds()[0]
    st().createWorkspace('Two')

    expect(wsById(st(), first)?.name).toBe('One')
    expect(wsOfAgent(st(), agentId)?.id).toBe(first)
    expect(wsOfAgent(st(), 'nope')).toBeUndefined()
  })

  it('agentPathById resolves through the owning workspace', () => {
    st().createWorkspace('One')
    st().setWorkspacePath(
      ws().id,
      { path: '/repo', name: 'repo' },
      { isGit: false, repoRoot: null, branch: null }
    )
    st().addAgent()
    expect(agentPathById(st(), agentIds()[0])).toBe('/repo')
    expect(agentPathById(st(), 'nope')).toBeNull()
  })
})

describe('displayBranch', () => {
  // The canvas/ prefix is legacy branding that leaks into user-visible git
  // refs. Worktree removal is gated on it, so it can't be renamed — it can
  // only be hidden at the edge.
  it('strips the internal canvas/ prefix', () => {
    expect(displayBranch('canvas/a1b2c3')).toBe('a1b2c3')
  })

  it('leaves an unprefixed branch alone', () => {
    expect(displayBranch('main')).toBe('main')
  })

  it('only strips the prefix at the start, and only once', () => {
    expect(displayBranch('feat/canvas/x')).toBe('feat/canvas/x')
    expect(displayBranch('canvas/canvas/x')).toBe('canvas/x')
  })
})

describe('toPersisted', () => {
  it('drops every runtime-only field', () => {
    // Runtime state must never reach disk — a persisted ptyId or status would
    // be restored as a lie about a process that no longer exists.
    const agent = {
      id: 'a', label: 'Robi', x: 0, y: 0, w: 10, h: 10, isolation: 'shared',
      ptyId: 'pty-1', branch: 'canvas/x', cwd: '/tmp', status: 'working',
      workingSince: 123, isolated: true, dropX: 1, dropY: 2, dropW: 3, dropH: 4
    } as unknown as AgentInstance

    const [out] = toPersisted([agent])
    for (const key of [
      'ptyId', 'branch', 'cwd', 'status', 'workingSince', 'isolated',
      'dropX', 'dropY', 'dropW', 'dropH'
    ]) {
      // `in`, not toBeUndefined() — an explicitly-undefined key would still be
      // written by JSON.stringify's object walk, so absence is the assertion.
      expect(key in out).toBe(false)
    }
    expect(out.id).toBe('a')
    expect(out.label).toBe('Robi')
    expect(out.isolation).toBe('shared')
  })
})

describe('caps', () => {
  it('refuses to add a tenth agent and says why', () => {
    st().createWorkspace('One')
    for (let i = 0; i < MAX_AGENTS; i++) st().addAgent()
    expect(ws().agents).toHaveLength(MAX_AGENTS)

    st().addAgent()
    expect(ws().agents).toHaveLength(MAX_AGENTS)
    // A silent refusal here reads as a broken button.
    expect(st().toasts.at(-1)?.text).toBe(`Maximum ${MAX_AGENTS} terminals on one stage`)
  })

  it('refuses to create a seventh live workspace', () => {
    for (let i = 0; i < MAX_LIVE_WORKSPACES; i++) st().createWorkspace()
    expect(st().liveWorkspaces).toHaveLength(MAX_LIVE_WORKSPACES)

    const activeBefore = st().activeWorkspaceId
    st().createWorkspace()
    expect(st().liveWorkspaces).toHaveLength(MAX_LIVE_WORKSPACES)
    expect(st().activeWorkspaceId).toBe(activeBefore)
  })
})

describe('createWorkspace / renameWorkspace', () => {
  it('reuses the lowest free auto-name so numbering does not drift', () => {
    st().createWorkspace()
    st().createWorkspace()
    st().createWorkspace()
    const second = st().liveWorkspaces[1]
    expect(second.name).toBe('Workspace 2')

    st().closeWorkspace(second.id)
    st().createWorkspace()
    expect(st().liveWorkspaces.map((w) => w.name)).toContain('Workspace 2')
  })

  // Regression: a workspace made this way starts with defaultPath === null, and
  // the UI used to hide every launch affordance behind that path — the rail
  // rendered empty and the stage was a blank rectangle, so a new workspace was
  // a dead end. The store never required a path; the gates were the bug. If the
  // empty-state/rail fix is reverted this still passes, so it guards the
  // contract those gates now rely on: a folderless workspace CAN hold agents.
  it('starts with no folder but still accepts terminals', () => {
    st().createWorkspace('Folderless')
    expect(ws().defaultPath).toBeNull()

    st().addAgent()
    expect(ws().agents).toHaveLength(1)
    // No folder → nothing to isolate into, so it must fall back to shared
    // rather than claiming a worktree it can't have.
    expect(ws().agents[0].isolation).toBe('shared')
    // Inherits the workspace default (null) rather than pinning a stray path.
    expect(ws().agents[0].projectPath).toBeUndefined()
  })

  it('trims a supplied name and ignores a blank one', () => {
    st().createWorkspace('  Padded  ')
    expect(ws().name).toBe('Padded')

    const id = ws().id
    st().renameWorkspace(id, '   ')
    // A whitespace rename would leave the tab visually nameless.
    expect(wsById(st(), id)?.name).toBe('Padded')

    st().renameWorkspace(id, '  Renamed ')
    expect(wsById(st(), id)?.name).toBe('Renamed')
  })

  it('adopts the folder name only for a still-unnamed, folder-less tab', () => {
    st().createWorkspace()
    const id = ws().id
    expect(ws().name).toMatch(/^Workspace \d+$/)

    st().setWorkspacePath(id, { path: '/repo', name: 'repo' },
      { isGit: false, repoRoot: null, branch: null })
    expect(wsById(st(), id)?.name).toBe('repo')

    // Once the user has named a tab, pointing it at a folder must not rename it.
    st().renameWorkspace(id, 'Mine')
    st().setWorkspacePath(id, { path: '/other', name: 'other' },
      { isGit: false, repoRoot: null, branch: null })
    expect(wsById(st(), id)?.name).toBe('Mine')
  })
})

describe('closeWorkspace', () => {
  it('activates the tab that slid into the closed slot', () => {
    st().createWorkspace('A')
    st().createWorkspace('B')
    st().createWorkspace('C')
    const [a, b, c] = st().liveWorkspaces.map((w) => w.id)

    st().setActiveWorkspace(b)
    st().closeWorkspace(b)
    expect(st().activeWorkspaceId).toBe(c)

    st().closeWorkspace(c)
    expect(st().activeWorkspaceId).toBe(a)

    st().closeWorkspace(a)
    // Nothing left — Home, not a dangling id.
    expect(st().activeWorkspaceId).toBeNull()
  })

  it('leaves the active tab alone when a background tab closes', () => {
    st().createWorkspace('A')
    st().createWorkspace('B')
    const [a, b] = st().liveWorkspaces.map((w) => w.id)
    st().setActiveWorkspace(b)

    st().closeWorkspace(a)
    expect(st().activeWorkspaceId).toBe(b)
  })
})

describe('setActiveWorkspace', () => {
  it('ignores an unknown id', () => {
    st().createWorkspace('A')
    const a = ws().id
    st().setActiveWorkspace('nope')
    expect(st().activeWorkspaceId).toBe(a)
  })

  it('guarantees a selection when switching to a tab that had none', () => {
    st().createWorkspace('A')
    st().addAgent()
    const a = ws().id
    st().createWorkspace('B')
    const b = ws().id

    useStore.setState({
      liveWorkspaces: st().liveWorkspaces.map((w) =>
        w.id === a ? { ...w, selectedIds: [] } : w
      )
    })
    st().setActiveWorkspace(b)
    st().setActiveWorkspace(a)
    // Landing on a tab with no keyboard target strands the user.
    expect(ws().selectedIds).toHaveLength(1)
  })
})

describe('addAgent', () => {
  it('stores no override when the path equals the workspace default', () => {
    // Storing it would pin the agent to the old folder if the workspace moves.
    st().createWorkspace('A')
    const id = ws().id
    st().setWorkspacePath(id, { path: '/repo', name: 'repo' },
      { isGit: false, repoRoot: null, branch: null })

    st().addAgent({ projectPath: '/repo' })
    expect(ws().agents[0].projectPath).toBeUndefined()

    st().addAgent({ projectPath: '/elsewhere' })
    expect(ws().agents[1].projectPath).toBe('/elsewhere')
  })

  it('selects the new agent and clears any zoom', () => {
    st().createWorkspace('A')
    st().addAgent()
    st().focusTerminal(agentIds()[0])
    expect(ws().focusedId).not.toBeNull()

    st().addAgent()
    expect(ws().selectedIds).toEqual([agentIds()[1]])
    expect(ws().focusedId).toBeNull()
  })

  it('targets an explicit workspace over the active one', () => {
    st().createWorkspace('A')
    const a = ws().id
    st().createWorkspace('B')

    st().addAgent({ workspaceId: a })
    expect(wsById(st(), a)?.agents).toHaveLength(1)
    expect(ws().agents).toHaveLength(0)
  })

  it('does nothing when there is no workspace at all', () => {
    st().addAgent()
    expect(st().liveWorkspaces).toHaveLength(0)
  })
})

describe('focusTerminal vs revealAgent', () => {
  // Distinct concepts with distinct state: focus maximizes, reveal only brings
  // forward. Collapsing them makes every notification click zoom the stage.
  let a1: string
  let a2: string

  beforeEach(() => {
    st().createWorkspace('A')
    st().addAgent()
    st().addAgent()
    ;[a1, a2] = agentIds()
  })

  it('focusTerminal maximizes and selects', () => {
    st().focusTerminal(a1)
    expect(ws().focusedId).toBe(a1)
    expect(ws().selectedIds).toEqual([a1])
  })

  it('revealAgent selects without maximizing when nothing is zoomed', () => {
    st().revealAgent(a2)
    expect(ws().focusedId).toBeNull()
    expect(ws().selectedIds).toEqual([a2])
  })

  it('revealAgent retargets an existing zoom rather than dropping it', () => {
    st().focusTerminal(a1)
    st().revealAgent(a2)
    expect(ws().focusedId).toBe(a2)
    expect(ws().selectedIds).toEqual([a2])
  })

  it('revealAgent is a no-op on the already-focused agent', () => {
    st().focusTerminal(a1)
    const before = ws()
    st().revealAgent(a1)
    expect(ws()).toBe(before)
  })

  it('both bring the owning workspace forward', () => {
    const a = ws().id
    st().createWorkspace('B')
    expect(st().activeWorkspaceId).not.toBe(a)

    st().revealAgent(a1)
    expect(st().activeWorkspaceId).toBe(a)
  })
})

describe('setSelected', () => {
  it('refuses to clear the selection while agents exist', () => {
    st().createWorkspace('A')
    st().addAgent()
    const id = agentIds()[0]

    st().setSelected([])
    // No selection means no keyboard target — the stage goes inert.
    expect(ws().selectedIds).toEqual([id])
  })

  it('allows an empty selection when there are no agents', () => {
    st().createWorkspace('A')
    st().setSelected([])
    expect(ws().selectedIds).toEqual([])
  })
})

describe('hydrateWorkspaces', () => {
  const rec = (id: string, extra: Record<string, unknown> = {}): never =>
    ({ id, name: id, agents: [], ...extra }) as never

  it('reads the legacy path field when defaultPath is absent', () => {
    // `path` predates per-agent folders. Dropping the fallback would silently
    // orphan every workspace saved by an older build.
    st().hydrateWorkspaces(
      [
        rec('a', { defaultPath: '/new' }),
        rec('b', { path: '/legacy' }),
        rec('c', { defaultPath: null, path: '/legacy-wins' }),
        rec('d')
      ],
      null
    )
    expect(st().liveWorkspaces.map((w) => w.defaultPath)).toEqual([
      '/new', '/legacy', '/legacy-wins', null
    ])
  })

  it('coerces every unknown layout mode to grid', () => {
    st().hydrateWorkspaces(
      [
        rec('a', { layoutMode: 'columns' }),
        rec('b', { layoutMode: 'grid' }),
        rec('c', { layoutMode: 'preview' }), // dead legacy mode
        rec('d', { layoutMode: 'free' }),    // dead legacy mode
        rec('e')
      ],
      null
    )
    expect(st().liveWorkspaces.map((w) => w.layoutMode)).toEqual([
      'columns', 'grid', 'grid', 'grid', 'grid'
    ])
  })

  it('parks the overflow instead of discarding it', () => {
    const records = Array.from({ length: 8 }, (_, i) => rec(`w${i}`))
    st().hydrateWorkspaces(records, null)

    expect(st().liveWorkspaces).toHaveLength(MAX_LIVE_WORKSPACES)
    // Discarding would permanently delete tabs on the next autosave.
    expect(st().parkedWorkspaces).toHaveLength(8 - MAX_LIVE_WORKSPACES)
  })

  it('keeps the tab the user was last looking at when the set overflows', () => {
    const records = Array.from({ length: 8 }, (_, i) => rec(`w${i}`))
    st().hydrateWorkspaces(records, 'w6')

    const live = st().liveWorkspaces.map((w) => w.id)
    expect(live).toHaveLength(MAX_LIVE_WORKSPACES)
    expect(live).toContain('w6')
    expect(st().activeWorkspaceId).toBe('w6')
    // It takes the last live slot; the record it displaced is parked.
    expect(live.at(-1)).toBe('w6')
    expect(st().parkedWorkspaces.map((r) => r.id)).toEqual(['w5', 'w7'])
  })

  it('falls back to the first tab when the saved active id is gone', () => {
    st().hydrateWorkspaces([rec('a'), rec('b')], 'vanished')
    expect(st().activeWorkspaceId).toBe('a')
  })

  it('leaves nothing active for an empty set', () => {
    st().hydrateWorkspaces([], null)
    expect(st().activeWorkspaceId).toBeNull()
  })

  it('preserves workspace ids so tabs keep their identity', () => {
    st().hydrateWorkspaces([rec('stable-id')], 'stable-id')
    expect(st().liveWorkspaces[0].id).toBe('stable-id')
  })

  it('truncates a saved agent list to the cap and defaults isolation', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`, label: `L${i}`, x: 0, y: 0, w: 10, h: 10
    }))
    st().hydrateWorkspaces([rec('a', { agents })], 'a')

    expect(st().liveWorkspaces[0].agents).toHaveLength(MAX_AGENTS)
    expect(st().liveWorkspaces[0].agents.every((a) => a.isolation === 'shared')).toBe(true)
  })

  it('replaces purely-numeric legacy labels but keeps custom ones', () => {
    st().hydrateWorkspaces(
      [
        rec('a', {
          agents: [
            { id: 'x', label: '1', x: 0, y: 0, w: 10, h: 10 },
            { id: 'y', label: 'Robi', x: 0, y: 0, w: 10, h: 10 },
            { id: 'z', label: '', x: 0, y: 0, w: 10, h: 10 }
          ]
        })
      ],
      'a'
    )
    const labels = st().liveWorkspaces[0].agents.map((a) => a.label)
    expect(labels[0]).not.toBe('1')
    expect(labels[1]).toBe('Robi')
    expect(labels[2]).not.toBe('')
    expect(new Set(labels).size).toBe(3)
  })
})

describe('reopenLast', () => {
  it('restores the last closed agent and then stops', () => {
    vi.useFakeTimers()
    st().createWorkspace('A')
    st().addAgent({ agentLabel: 'Claude Code', agentId: 'claude' })
    st().removeAgent(agentIds()[0])
    vi.advanceTimersByTime(200)
    expect(ws().agents).toHaveLength(0)

    st().reopenLast()
    expect(ws().agents).toHaveLength(1)
    expect(ws().agents[0].agentLabel).toBe('Claude Code')

    // lastClosed is consumed — a second reopen must not duplicate it.
    st().reopenLast()
    expect(ws().agents).toHaveLength(1)
    vi.useRealTimers()
  })
})

describe('removeAgent', () => {
  const remove = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    remove.mockReset().mockResolvedValue(undefined)
    ;(window as unknown as { api: unknown }).api = { worktree: { remove } }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Force worktree isolation, which addAgent only picks in a git workspace. */
  const isolate = (id: string): void => {
    useStore.setState({
      liveWorkspaces: st().liveWorkspaces.map((w) => ({
        ...w,
        agents: w.agents.map((a) => (a.id === id ? { ...a, isolation: 'worktree' } : a))
      }))
    })
  }

  it('ignores a repeated close of the same agent', () => {
    st().createWorkspace('A')
    st().addAgent()
    st().addAgent()
    const [a1] = agentIds()

    st().removeAgent(a1)
    st().removeAgent(a1)
    vi.advanceTimersByTime(200)
    // A double-fire would remove a second, innocent agent.
    expect(ws().agents).toHaveLength(1)
  })

  it("tears down the worktree at the agent's own folder, not the workspace default", () => {
    st().createWorkspace('A')
    const id = ws().id
    st().setWorkspacePath(id, { path: '/ws-default', name: 'ws' },
      { isGit: true, repoRoot: '/ws-default', branch: 'main' })
    st().addAgent({ projectPath: '/agent-repo' })
    const a1 = agentIds()[0]
    isolate(a1)

    st().removeAgent(a1)
    vi.advanceTimersByTime(200)
    // Passing the workspace default here would tear down the wrong worktree.
    expect(remove).toHaveBeenCalledWith('/agent-repo', a1)
  })

  it('skips teardown when asked to keep the worktree', () => {
    st().createWorkspace('A')
    st().setWorkspacePath(ws().id, { path: '/repo', name: 'repo' },
      { isGit: true, repoRoot: '/repo', branch: 'main' })
    st().addAgent()
    const a1 = agentIds()[0]
    isolate(a1)

    st().removeAgent(a1, { keepWorktree: true })
    vi.advanceTimersByTime(200)
    expect(remove).not.toHaveBeenCalled()
  })

  it('does not touch worktrees for a shared agent', () => {
    st().createWorkspace('A')
    st().setWorkspacePath(ws().id, { path: '/repo', name: 'repo' },
      { isGit: false, repoRoot: null, branch: null })
    st().addAgent()

    st().removeAgent(agentIds()[0])
    vi.advanceTimersByTime(200)
    expect(remove).not.toHaveBeenCalled()
  })

  it('moves the selection to a surviving neighbour', () => {
    st().createWorkspace('A')
    st().addAgent()
    st().addAgent()
    st().addAgent()
    const [, a2, a3] = agentIds()

    st().setSelected([a2])
    st().removeAgent(a2)
    vi.advanceTimersByTime(200)

    expect(ws().selectedIds).toHaveLength(1)
    expect(ws().selectedIds[0]).toBe(a3)
  })

  it('clears the zoom when the focused agent goes away', () => {
    st().createWorkspace('A')
    st().addAgent()
    st().addAgent()
    const [a1] = agentIds()

    st().focusTerminal(a1)
    st().removeAgent(a1)
    vi.advanceTimersByTime(200)
    // A stale focusedId leaves the stage zoomed on nothing.
    expect(ws().focusedId).toBeNull()
  })
})

describe('pushToast', () => {
  it('collapses a repeat instead of stacking it', () => {
    st().pushToast('Same', 'info')
    st().pushToast('Same', 'info')
    expect(st().toasts).toHaveLength(1)
  })

  it('treats a different kind as a different toast', () => {
    st().pushToast('Same', 'info')
    st().pushToast('Same', 'error')
    expect(st().toasts).toHaveLength(2)
  })

  it('evicts the oldest dismissible toast at the cap', () => {
    for (let i = 0; i < 6; i++) st().pushToast(`t${i}`, 'info')
    const texts = st().toasts.map((t) => t.text)
    expect(st().toasts).toHaveLength(5)
    expect(texts).not.toContain('t0')
    expect(texts).toContain('t5')
  })

  it('keeps a sticky toast and drops a dismissible one instead', () => {
    // Errors and actionable toasts are the ones the user most needs to see.
    st().pushToast('sticky', 'error')
    for (let i = 0; i < 5; i++) st().pushToast(`t${i}`, 'info')
    expect(st().toasts.map((t) => t.text)).toContain('sticky')
  })

  it('dismissToast removes only the named toast', () => {
    st().pushToast('a', 'info')
    st().pushToast('b', 'info')
    st().dismissToast(st().toasts[0].id)
    expect(st().toasts.map((t) => t.text)).toEqual(['b'])
  })
})

describe('toastIsSticky', () => {
  it('lets an explicit flag win over every heuristic', () => {
    expect(toastIsSticky({ kind: 'error', sticky: false })).toBe(false)
    expect(toastIsSticky({ kind: 'info', sticky: true })).toBe(true)
  })

  it('treats errors and actionable toasts as sticky by default', () => {
    expect(toastIsSticky({ kind: 'error' })).toBe(true)
    expect(toastIsSticky({ kind: 'info', actionLabel: 'Undo' })).toBe(true)
    expect(toastIsSticky({ kind: 'info', secondaryLabel: 'Later' })).toBe(true)
    expect(toastIsSticky({ kind: 'info' })).toBe(false)
  })
})

describe('file panel', () => {
  beforeEach(() => {
    st().createWorkspace('A')
  })

  it('keeps the open file when reopening the same scope', () => {
    st().openFilePanel({ kind: 'root' })
    st().openFile('src/index.ts')
    st().setFileDirty(true)

    st().openFilePanel({ kind: 'root' })
    expect(ws().filePanel.openPath).toBe('src/index.ts')
    expect(ws().filePanel.dirty).toBe(true)
  })

  it('clears the open file when the scope changes', () => {
    st().openFilePanel({ kind: 'root' })
    st().openFile('src/index.ts')
    st().setFileDirty(true)

    st().openFilePanel({ kind: 'agent', agentId: 'a1' })
    // Keeping the path would show one scope's file under another's root.
    expect(ws().filePanel.openPath).toBeNull()
    expect(ws().filePanel.dirty).toBe(false)
  })

  it('closing keeps the scope so reopening returns to the same place', () => {
    st().openFilePanel({ kind: 'agent', agentId: 'a1' })
    st().openFile('README.md')
    st().closeFilePanel()

    expect(ws().filePanel.open).toBe(false)
    expect(ws().filePanel.scope).toEqual({ kind: 'agent', agentId: 'a1' })
    expect(ws().filePanel.openPath).toBe('README.md')
  })

  it('falls back to root when reopening onto an agent that is gone', () => {
    st().addAgent()
    const id = agentIds()[0]
    st().openFilePanel({ kind: 'agent', agentId: id })
    st().toggleFilePanel() // closed

    useStore.setState({
      liveWorkspaces: st().liveWorkspaces.map((w) => ({ ...w, agents: [] }))
    })
    st().toggleFilePanel() // reopened onto a dead scope

    expect(ws().filePanel.scope).toEqual({ kind: 'root' })
    expect(ws().filePanel.openPath).toBeNull()
  })

  it('clamps the panel width into its usable range', () => {
    st().setFilePanelWidth(10)
    expect(st().filePanelWidth).toBe(FILE_PANEL_MIN)

    st().setFilePanelWidth(9999)
    expect(st().filePanelWidth).toBe(FILE_PANEL_MAX)

    st().setFilePanelWidth(Number.NaN)
    expect(st().filePanelWidth).toBe(FILE_PANEL_DEFAULT)

    st().setFilePanelWidth(400)
    expect(st().filePanelWidth).toBe(400)
  })
})

// The file panel can now create, rename, move and delete real files. These are
// the two ways an operation on disk has to be reflected in the editor showing
// one of them — get either wrong and the editor is left pointing at a path that
// no longer exists, or silently loses unsaved work.
describe('file panel: the editor follows the file', () => {
  beforeEach(() => {
    st().createWorkspace('A')
    st().openFilePanel({ kind: 'root' })
  })

  it('retitles the open file when it is renamed', () => {
    st().openFile('src/index.ts')
    st().fileRenamed('src/index.ts', 'src/main.ts')
    expect(ws().filePanel.openPath).toBe('src/main.ts')
  })

  // Dragging `src/` somewhere would otherwise orphan the open `src/index.ts`.
  it('re-roots the open file when an ancestor folder moves', () => {
    st().openFile('src/index.ts')
    st().fileRenamed('src', 'app/src')
    expect(ws().filePanel.openPath).toBe('app/src/index.ts')
  })

  it('leaves an unrelated open file alone', () => {
    st().openFile('README.md')
    st().fileRenamed('src/index.ts', 'src/main.ts')
    expect(ws().filePanel.openPath).toBe('README.md')
  })

  // `src2` is not inside `src`, despite the prefix.
  it('does not re-root a file whose path merely shares a prefix', () => {
    st().openFile('src2/index.ts')
    st().fileRenamed('src', 'app/src')
    expect(ws().filePanel.openPath).toBe('src2/index.ts')
  })

  it('closes the editor when the file it shows is deleted', () => {
    st().openFile('src/index.ts')
    st().fileDeleted(['src/index.ts'])
    expect(ws().filePanel.openPath).toBeNull()
  })

  it('closes the editor when a folder containing the open file is deleted', () => {
    st().openFile('src/index.ts')
    st().fileDeleted(['src'])
    expect(ws().filePanel.openPath).toBeNull()
  })

  // The buffer is the only remaining copy of work that was never written —
  // closing it would destroy exactly what the user still has.
  it('never closes an editor with unsaved edits', () => {
    st().openFile('src/index.ts')
    st().setFileDirty(true)
    st().fileDeleted(['src/index.ts'])
    expect(ws().filePanel.openPath).toBe('src/index.ts')
    expect(ws().filePanel.dirty).toBe(true)
  })

  it('leaves the editor alone when something else is deleted', () => {
    st().openFile('README.md')
    st().fileDeleted(['src/index.ts'])
    expect(ws().filePanel.openPath).toBe('README.md')
  })
})

// Both confirmations carry a "Don't ask me again" checkbox. Ticking it has to
// survive a restart, or the user re-suppresses it every session.
//
// This environment's jsdom ships no localStorage, so the store's own guards
// make every write a silent no-op here — which would let a broken persistence
// path pass unnoticed. Hence a real fake, and a genuine module reload to stand
// in for the restart.
describe('file panel: confirmation preferences', () => {
  let backing: Record<string, string>

  beforeEach(() => {
    backing = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in backing ? backing[k] : null),
      setItem: (k: string, v: string) => {
        backing[k] = String(v)
      },
      removeItem: (k: string) => {
        delete backing[k]
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('defaults to asking', () => {
    expect(st().confirmDelete).toBe(true)
    expect(st().confirmMove).toBe(true)
  })

  it('writes a suppression out under its own key', () => {
    st().setConfirmDelete(false)
    expect(st().confirmDelete).toBe(false)
    expect(backing['vectro.confirmDelete']).toBe('false')

    st().setConfirmMove(false)
    expect(st().confirmMove).toBe(false)
    expect(backing['vectro.confirmDragAndDrop']).toBe('false')
  })

  it('can be turned back on', () => {
    st().setConfirmDelete(false)
    st().setConfirmDelete(true)
    expect(st().confirmDelete).toBe(true)
    expect(backing['vectro.confirmDelete']).toBe('true')
  })

  // The restart: a fresh module registry reads initial state from storage again.
  it('reads a stored suppression back on a fresh start', async () => {
    backing['vectro.confirmDelete'] = 'false'
    backing['vectro.confirmDragAndDrop'] = 'false'
    vi.resetModules()
    const fresh = await import('./store')
    expect(fresh.useStore.getState().confirmDelete).toBe(false)
    expect(fresh.useStore.getState().confirmMove).toBe(false)
  })

  it('still asks when storage holds something unparseable', async () => {
    backing['vectro.confirmDelete'] = 'not json'
    vi.resetModules()
    const fresh = await import('./store')
    expect(fresh.useStore.getState().confirmDelete).toBe(true)
  })
})

describe('setUpdate', () => {
  it('keeps the dismissal for the same version', () => {
    st().setUpdate({ current: '1.0.0', latest: '1.1.0', url: 'u' })
    st().dismissUpdate()
    st().setUpdate({ current: '1.0.0', latest: '1.1.0', url: 'u' })
    // Re-nagging on every poll for a version the user already dismissed.
    expect(st().updateDismissed).toBe(true)
  })

  it('re-surfaces for a newer version', () => {
    st().setUpdate({ current: '1.0.0', latest: '1.1.0', url: 'u' })
    st().dismissUpdate()
    st().setUpdate({ current: '1.0.0', latest: '1.2.0', url: 'u' })
    expect(st().updateDismissed).toBe(false)
  })
})

describe('setStageSize', () => {
  it('applies the first measurement even when it matches the default', () => {
    // stageReady starts false, so the guard must not swallow the first call —
    // panes wait on it before spawning.
    const { stageW, stageH } = st()
    expect(st().stageReady).toBe(false)
    st().setStageSize(stageW, stageH)
    expect(st().stageReady).toBe(true)
  })

  it('re-tiles every live workspace, not just the active one', () => {
    st().createWorkspace('A')
    st().addAgent()
    const a = ws().id
    st().createWorkspace('B')
    st().addAgent()

    st().setStageSize(1600, 1000)
    const background = wsById(st(), a)
    expect(background).toBeDefined()
    // A background tab left at the old size renders wrong the moment it shows.
    const tile = background!.agents[0]
    expect(tile.w).toBeGreaterThan(0)
    expect(tile.x + tile.w).toBeLessThanOrEqual(1600)
  })

  it('leaves an unaffected workspace object identical across a resize', () => {
    // An agent-less workspace has nothing to re-tile — laidOut returns the very
    // same array for it — so its session object must survive a resize
    // untouched. Cloning it regardless gave every live workspace a new identity
    // on each resize frame (a rAF-driven stream of them), re-rendering each
    // Stage's Moveable and Selecto for a layout that never moved.
    st().createWorkspace('empty')
    const emptyId = ws().id
    st().createWorkspace('busy')
    st().addAgent()
    st().setStageSize(1400, 900)

    const emptyBefore = wsById(st(), emptyId)
    const busyBefore = wsById(st(), ws().id)

    st().setStageSize(1600, 1000)

    expect(wsById(st(), emptyId)).toBe(emptyBefore)
    // The workspace that DID re-tile must still be rebuilt.
    expect(wsById(st(), busyBefore!.id)).not.toBe(busyBefore)
  })
})

// These mutators fire constantly — TerminalPane re-asserts status at the end of
// every output burst — and mapWs mints a new outer liveWorkspaces array on each
// call. Without an equality guard a no-op write still re-renders App and, with
// it, every live workspace's Stage.
describe('no-op status writes', () => {
  beforeEach(() => {
    st().createWorkspace('A')
  })

  it('setStatus with the current status changes nothing', () => {
    st().addAgent()
    const id = agentIds()[0]
    st().setStatus(id, 'working')
    const before = st().liveWorkspaces

    st().setStatus(id, 'working')
    expect(st().liveWorkspaces).toBe(before)
  })

  it('setStatus with a different status still applies', () => {
    st().addAgent()
    const id = agentIds()[0]
    st().setStatus(id, 'working')
    st().setStatus(id, 'idle')
    expect(ws().agents[0].status).toBe('idle')
  })

  it('setAgentRuntime with identical values changes nothing', () => {
    st().addAgent()
    const id = agentIds()[0]
    st().setAgentRuntime(id, { cwd: '/tmp' })
    const before = st().liveWorkspaces

    st().setAgentRuntime(id, { cwd: '/tmp' })
    expect(st().liveWorkspaces).toBe(before)
  })

  it('setAgentRuntime still applies a partial change', () => {
    st().addAgent()
    const id = agentIds()[0]
    st().setAgentRuntime(id, { cwd: '/tmp', branch: 'canvas/x' })
    st().setAgentRuntime(id, { cwd: '/tmp', branch: 'canvas/y' })
    expect(ws().agents[0].branch).toBe('canvas/y')
    expect(ws().agents[0].cwd).toBe('/tmp')
  })
})
