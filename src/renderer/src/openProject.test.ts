import { describe, it, expect, beforeEach } from 'vitest'
import { persistedSignature } from './openProject'
import { useStore, toPersisted, activeWs, type PersistedAgent, type WorkspaceSession } from './store'

// The autosave fires only when this signature changes, so a persisted field the
// signature can't see is a field that reaches disk by luck — whenever something
// else happens to change. That has already shipped twice (termTheme, then
// projectPath), each time as "my setting doesn't survive restart".
//
// These tests are deliberately generic over toPersisted's own output rather
// than listing fields. A hand-written list here would be the same bug one level
// down: it could fall behind toPersisted exactly like the old template in
// App.tsx did.

const INITIAL = useStore.getState()
const st = (): ReturnType<typeof useStore.getState> => useStore.getState()
const ws = (): WorkspaceSession => {
  const w = activeWs(st())
  if (!w) throw new Error('no active workspace')
  return w
}

beforeEach(() => {
  useStore.setState(INITIAL, true)
  st().createWorkspace('A')
  st().addAgent()
})

/** A different value of the same shape — enough to move the signature. */
function bump(v: unknown): unknown {
  if (typeof v === 'number') return v + 7
  if (typeof v === 'boolean') return !v
  if (typeof v === 'string') return `${v}-changed`
  return 'was-undefined'
}

/** Patch one field on the single agent, leaving everything else alone. */
function patchAgent(key: string, value: unknown): void {
  useStore.setState({
    liveWorkspaces: st().liveWorkspaces.map((w) => ({
      ...w,
      agents: w.agents.map((a, i) => (i === 0 ? { ...a, [key]: value } : a))
    }))
  })
}

describe('persistedSignature', () => {
  it('covers every field toPersisted writes', () => {
    const persisted = toPersisted(ws().agents)[0]
    const keys = Object.keys(persisted) as (keyof PersistedAgent)[]
    // Guard against the whole test silently passing on an empty object.
    expect(keys.length).toBeGreaterThan(5)

    for (const key of keys) {
      useStore.setState(INITIAL, true)
      st().createWorkspace('A')
      st().addAgent()

      const before = persistedSignature(st())
      patchAgent(key, bump(toPersisted(ws().agents)[0][key]))
      expect(persistedSignature(st()), `${key} does not reach the signature`).not.toBe(before)
    }
  })

  it('ignores runtime churn — a streaming agent must not trigger writes', () => {
    const id = ws().agents[0].id
    const before = persistedSignature(st())

    st().setStatus(id, 'working')
    st().setAgentRuntime(id, {
      ptyId: 'pty-1',
      cwd: '/tmp/wt',
      branch: 'canvas/abc',
      isolated: true
    })
    st().setStatus(id, 'attention')

    expect(persistedSignature(st())).toBe(before)
  })

  it('tracks the active tab and workspace-level fields', () => {
    const before = persistedSignature(st())
    st().renameWorkspace(ws().id, 'Renamed')
    expect(persistedSignature(st())).not.toBe(before)

    const afterRename = persistedSignature(st())
    st().createWorkspace('B')
    expect(persistedSignature(st())).not.toBe(afterRename)
  })

  it('sees parked workspaces, so overflow tabs cannot be dropped silently', () => {
    const before = persistedSignature(st())
    useStore.setState({
      parkedWorkspaces: [
        { id: 'parked-1', name: 'Parked', defaultPath: null, layoutMode: 'grid', agents: [] }
      ]
    })
    expect(persistedSignature(st())).not.toBe(before)
    expect(persistedSignature(st())).toContain('parked-1')
  })
})
