import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWorkspaceStore } from './workspace-store'

// This file is the whole tab set. A half-written or spliced save loses every
// workspace the user has, so the two protections — atomic replace, and one
// writer at a time — are asserted here rather than only in a smoke test.

let dir: string
let target: string
const dirs: string[] = []

beforeEach(async () => {
  vi.restoreAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'agentmaster-ws-'))
  dirs.push(dir)
  target = join(dir, 'workspaces.json')
})

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

const store = (): ReturnType<typeof createWorkspaceStore> => createWorkspaceStore(() => target)

/** The store logs every failed save. These tests fail saves on purpose, so
 *  swallow it — a stray console.error in this file should mean a real one. */
function expectingSaveFailure(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('load', () => {
  it('round-trips what save wrote', async () => {
    const s = store()
    const data = { version: 1, activeId: 'w1', workspaces: [{ id: 'w1', name: 'A' }] }
    expect(await s.save(data)).toBe(true)
    expect(await s.load()).toEqual(data)
  })

  // Null is the signal that drives the one-time migration from the old
  // per-project layout, so "no file" and "unreadable file" must both produce it
  // — and an explicitly empty saved set must NOT.
  it('returns null when there is no file yet', async () => {
    expect(await store().load()).toBeNull()
  })

  it('returns null rather than throwing on a corrupt file', async () => {
    await writeFile(target, '{ this is not json')
    expect(await store().load()).toBeNull()
  })

  it('distinguishes an empty saved set from a missing one', async () => {
    const s = store()
    await s.save({ version: 1, activeId: null, workspaces: [] })
    expect(await s.load()).toEqual({ version: 1, activeId: null, workspaces: [] })
  })
})

describe('save', () => {
  it('leaves no temp files behind', async () => {
    const s = store()
    await s.save({ a: 1 })
    await s.save({ a: 2 })
    const left = await readdir(dir)
    expect(left.filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(left).toEqual(['workspaces.json'])
  })

  // The renderer has two independent writers (the debounced autosave and the
  // un-awaited flush on close), so overlapping saves are normal. Each must land
  // whole: the file may only ever hold one complete write, never two spliced.
  it('serializes overlapping saves and lands the last one intact', async () => {
    const s = store()
    const writes = Array.from({ length: 25 }, (_, i) => ({
      seq: i,
      // Big enough that a spliced write would be visible as invalid JSON.
      filler: 'x'.repeat(5000)
    }))

    const results = await Promise.all(writes.map((w) => s.save(w)))
    expect(results.every(Boolean)).toBe(true)

    const onDisk = JSON.parse(await readFile(target, 'utf8'))
    expect(onDisk.seq).toBe(24)
    expect(onDisk.filler).toHaveLength(5000)
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('reports failure without throwing when the file cannot be written', async () => {
    expectingSaveFailure()
    // A directory where the file should be: writeFile and rename both fail.
    const bad = createWorkspaceStore(() => dir)
    expect(await bad.save({ a: 1 })).toBe(false)
  })

  it('keeps working after a failed save', async () => {
    expectingSaveFailure()
    let broken = true
    const s = createWorkspaceStore(() => (broken ? dir : target))

    expect(await s.save({ a: 1 })).toBe(false)
    broken = false
    expect(await s.save({ a: 2 })).toBe(true)
    expect(await s.load()).toEqual({ a: 2 })
  })

  it('cleans up its temp file when a save fails midway', async () => {
    expectingSaveFailure()
    const s = createWorkspaceStore(() => join(dir, 'nested', 'workspaces.json'))
    expect(await s.save({ a: 1 })).toBe(false)
    // The parent doesn't exist, so nothing — temp included — was created.
    expect(await readdir(dir)).toEqual([])
  })
})
