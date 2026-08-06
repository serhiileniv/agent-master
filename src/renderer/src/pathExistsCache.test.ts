import { describe, it, expect, vi } from 'vitest'
import {
  createPathExistsCache,
  MAX_ENTRIES,
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS
} from './pathExistsCache'

/** A cache over a counting stub, with a clock the test drives by hand. */
function harness(answers: (cwd: string, token: string) => boolean = () => true) {
  let clock = 1_000
  const lookup = vi.fn((cwd: string, token: string) => Promise.resolve(answers(cwd, token)))
  const cache = createPathExistsCache({ lookup, now: () => clock })
  return {
    cache,
    lookup,
    advance: (ms: number): void => {
      clock += ms
    }
  }
}

describe('createPathExistsCache', () => {
  it('answers correctly on a miss and passes the check through', async () => {
    const { cache, lookup } = harness(() => true)
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledWith('/repo', 'src/a.ts')
  })

  // The regression this whole module exists to prevent: xterm re-scans a row on
  // every pointer entry, so an uncached provider restats the same file forever.
  it('does not re-check a path it has already resolved', async () => {
    const { cache, lookup } = harness()
    await cache.exists('/repo', 'src/a.ts')
    await cache.exists('/repo', 'src/a.ts')
    await cache.exists('/repo', 'src/a.ts')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('keys on the pane cwd, so two worktrees never share an answer', async () => {
    const { cache, lookup } = harness((cwd) => cwd === '/repo')
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(true)
    await expect(cache.exists('/other', 'src/a.ts')).resolves.toBe(false)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  // An agent writing the file a moment later must still get a working link, so
  // a "no" is only allowed to stick briefly.
  it('re-checks a negative answer soon after', async () => {
    let present = false
    const { cache, lookup, advance } = harness(() => present)
    await expect(cache.exists('/repo', 'new.ts')).resolves.toBe(false)
    present = true
    advance(NEGATIVE_TTL_MS + 1)
    await expect(cache.exists('/repo', 'new.ts')).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('holds a negative for its full window before re-checking', async () => {
    const { cache, lookup, advance } = harness(() => false)
    await cache.exists('/repo', 'new.ts')
    advance(NEGATIVE_TTL_MS - 1)
    await cache.exists('/repo', 'new.ts')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('eventually re-checks a positive, so a deleted file stops linking', async () => {
    let present = true
    const { cache, advance } = harness(() => present)
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(true)
    present = false
    advance(POSITIVE_TTL_MS + 1)
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(false)
  })

  // A row mentioning the same file twice, or re-scanned before the first answer
  // lands, must not fire two round-trips.
  it('shares one lookup between concurrent callers', async () => {
    let release: (v: boolean) => void = () => {}
    const lookup = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          release = res
        })
    )
    const cache = createPathExistsCache({ lookup })
    const a = cache.exists('/repo', 'src/a.ts')
    const b = cache.exists('/repo', 'src/a.ts')
    release(true)
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('stays bounded under a flood of distinct paths', async () => {
    const { cache } = harness()
    for (let i = 0; i < MAX_ENTRIES * 2; i++) await cache.exists('/repo', `f${i}.ts`)
    expect(cache.size()).toBeLessThanOrEqual(MAX_ENTRIES)
  })

  // A failed check (IPC torn down mid-hover) is not evidence the file is
  // missing — it must not be remembered as a "no".
  it('does not cache a failed check', async () => {
    let fail = true
    const lookup = vi.fn(() => (fail ? Promise.reject(new Error('gone')) : Promise.resolve(true)))
    const cache = createPathExistsCache({ lookup })
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(false)
    fail = false
    await expect(cache.exists('/repo', 'src/a.ts')).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('forgets everything on clear', async () => {
    const { cache, lookup } = harness()
    await cache.exists('/repo', 'src/a.ts')
    cache.clear()
    await cache.exists('/repo', 'src/a.ts')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
