import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setGitRunner,
  worktreeInfo,
  findOrphanWorktrees,
  removeOrphanWorktrees,
  cleanOrphanWorktrees,
  mergeAgent,
  applyAgentFiles,
  friendlyGitError,
  type GitRunner,
  type OrphanWorktree
} from './git'

// These are the paths that write to, and delete from, the user's real
// repository — and until the git runner became swappable none of them had a
// test at any level, unit or smoke. They are covered here through their real
// interfaces, with git itself scripted, so the decisions (what gets removed,
// what gets refused, what gets rolled back) are asserted rather than the
// plumbing.

interface Call {
  cwd: string
  args: string[]
}

/** A scripted git. The reply function sees each invocation and returns stdout,
 *  or an Error to reject with — git's own failure mode, which several callers
 *  read as a signal rather than a fault. */
function scripted(reply: (call: Call) => string | Error): { run: GitRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: GitRunner = async (cwd, args) => {
    calls.push({ cwd, args })
    const out = reply({ cwd, args })
    if (out instanceof Error) throw out
    return out
  }
  return { run, calls }
}

/** Did git ever run this subcommand? */
const ran = (calls: Call[], ...prefix: string[]): boolean =>
  calls.some((c) => prefix.every((p, i) => c.args[i] === p))

let restore: (() => void) | null = null
function use(run: GitRunner): void {
  restore?.()
  restore = setGitRunner(run)
}

afterEach(() => {
  restore?.()
  restore = null
})

// ---------------------------------------------------------------------------

describe('findOrphanWorktrees', () => {
  const repo = join('/home/u', 'proj')
  const mine = worktreeInfo(repo, 'aaaaaaaaaaaa')
  const leftover = worktreeInfo(repo, 'bbbbbbbbbbbb')
  // One per pre-rename container, so dropping any of them fails a test.
  const legacyLeftovers = ['cccccccccccc', 'eeeeeeeeeeee']
    .map((id) => worktreeInfo(repo, id))
    .map((i, n) => ({ path: i.legacyPaths[n], branch: i.branch }))

  /** Porcelain block for one registered worktree. */
  const block = (path: string, branch: string | null): string =>
    `worktree ${path}\nHEAD 0000\n${branch ? `branch refs/heads/${branch}` : 'detached'}\n`

  const listing = (...blocks: string[]): string => blocks.join('\n')

  it('spares worktrees owned by a live agent, in any container', () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree' && args[1] === 'list')
        return listing(
          block(repo, 'main'),
          block(mine.path, mine.branch),
          ...mine.legacyPaths.map((p) => block(p, mine.branch))
        )
      return ''
    })
    use(run)
    return findOrphanWorktrees(repo, ['aaaaaaaaaaaa']).then((orphans) => {
      expect(orphans).toEqual([])
    })
  })

  it('ignores worktrees belonging to another repo sharing the container', () => {
    const other = join(mine.container, 'someotherrepo-ddddddddddd')
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree' && args[1] === 'list')
        return listing(block(repo, 'main'), block(other, 'canvas/ddddddddddd'))
      return ''
    })
    use(run)
    return findOrphanWorktrees(repo, []).then((orphans) => {
      expect(orphans).toEqual([])
    })
  })

  it('finds leftovers in the current container and every pre-rename one', () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree' && args[1] === 'list')
        return listing(
          block(repo, 'main'),
          block(leftover.path, leftover.branch),
          ...legacyLeftovers.map((l) => block(l.path, l.branch))
        )
      if (args[0] === 'merge-base') return '' // merged
      if (args[0] === 'status') return '' // clean
      return ''
    })
    use(run)
    return findOrphanWorktrees(repo, []).then((orphans) => {
      expect(orphans.map((o) => o.branch).sort()).toEqual(
        [leftover.branch, ...legacyLeftovers.map((l) => l.branch)].sort()
      )
      expect(orphans.every((o) => o.hasWork)).toBe(false)
    })
  })

  // hasWork is the safety predicate the destructive path is gated on. Every one
  // of these must answer "yes, there is work" — including the failures.
  it('flags unmerged commits as work', async () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree') return listing(block(leftover.path, leftover.branch))
      if (args[0] === 'merge-base') return new Error('not an ancestor')
      return ''
    })
    use(run)
    const [orphan] = await findOrphanWorktrees(repo, [])
    expect(orphan.hasWork).toBe(true)
  })

  it('flags a dirty working tree as work', async () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree') return listing(block(leftover.path, leftover.branch))
      if (args[0] === 'merge-base') return ''
      if (args[0] === 'status') return ' M src/main.ts\n'
      return ''
    })
    use(run)
    const [orphan] = await findOrphanWorktrees(repo, [])
    expect(orphan.hasWork).toBe(true)
  })

  it('fails safe when the status check itself errors', async () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree') return listing(block(leftover.path, leftover.branch))
      if (args[0] === 'merge-base') return ''
      if (args[0] === 'status') return new Error('folder unreadable')
      return ''
    })
    use(run)
    const [orphan] = await findOrphanWorktrees(repo, [])
    expect(orphan.hasWork).toBe(true)
  })

  it('fails safe on a detached worktree, which has no branch to test', async () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'worktree') return listing(block(leftover.path, null))
      return ''
    })
    use(run)
    const [orphan] = await findOrphanWorktrees(repo, [])
    expect(orphan.hasWork).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('removeOrphanWorktrees', () => {
  const repo = join('/home/u', 'proj')
  const inside = worktreeInfo(repo, 'bbbbbbbbbbbb')

  const orphan = (over: Partial<OrphanWorktree> = {}): OrphanWorktree => ({
    path: inside.path,
    branch: inside.branch,
    hasWork: false,
    ...over
  })

  it('never touches a path outside the two known containers', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    const removed = await removeOrphanWorktrees(repo, [
      orphan({ path: join('/home/u', 'proj', 'src') }),
      orphan({ path: join('/home/u', 'somewhere-else') }),
      orphan({ path: repo })
    ])
    expect(removed).toBe(0)
    expect(ran(calls, 'worktree', 'remove')).toBe(false)
    expect(ran(calls, 'branch', '-D')).toBe(false)
  })

  // The caller already filters these out. This asserts the second gate: no
  // caller mistake, and no stale flag, may reach the destructive path.
  it('refuses an orphan flagged as having work, even when handed one directly', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    const removed = await removeOrphanWorktrees(repo, [orphan({ hasWork: true })])
    expect(removed).toBe(0)
    expect(ran(calls, 'worktree', 'remove')).toBe(false)
    expect(ran(calls, 'branch', '-D')).toBe(false)
  })

  it('deletes only canvas/ branches, so a user branch is never force-deleted', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    await removeOrphanWorktrees(repo, [orphan({ branch: 'main' })])
    expect(ran(calls, 'worktree', 'remove')).toBe(true)
    expect(ran(calls, 'branch', '-D')).toBe(false)
  })

  it('removes the worktree and its branch, then prunes', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    const removed = await removeOrphanWorktrees(repo, [orphan()])
    expect(removed).toBe(1)
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'worktree remove',
      'branch -D',
      'worktree prune'
    ])
  })

  it('still counts a removal when only the branch delete succeeded', async () => {
    const { run } = scripted(({ args }) =>
      args[0] === 'worktree' && args[1] === 'remove' ? new Error('not registered') : ''
    )
    use(run)
    expect(await removeOrphanWorktrees(repo, [orphan()])).toBe(1)
  })
})

describe('cleanOrphanWorktrees', () => {
  const repo = join('/home/u', 'proj')
  const clean = worktreeInfo(repo, 'bbbbbbbbbbbb')
  const dirty = worktreeInfo(repo, 'cccccccccccc')

  it('removes the clean leftover and reports the one it kept', async () => {
    const { run, calls } = scripted(({ cwd, args }) => {
      if (args[0] === 'worktree' && args[1] === 'list')
        return [
          `worktree ${clean.path}\nbranch refs/heads/${clean.branch}\n`,
          `worktree ${dirty.path}\nbranch refs/heads/${dirty.branch}\n`
        ].join('\n')
      if (args[0] === 'merge-base') return ''
      if (args[0] === 'status') return cwd === dirty.path ? ' M a.txt\n' : ''
      return ''
    })
    use(run)
    expect(await cleanOrphanWorktrees(repo, [])).toEqual({ removed: 1, keptWithWork: 1 })
    // The one with work was never handed to a remove.
    expect(calls.some((c) => c.args.includes(dirty.path))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('mergeAgent', () => {
  const repo = join('/home/u', 'proj')

  it('reports the branch it actually merged into, not the one assumed', async () => {
    const { run } = scripted(({ args }) => {
      if (args[0] === 'rev-parse') return 'release-2.0\n'
      return ''
    })
    use(run)
    expect(await mergeAgent(repo, 'aaaaaaaaaaaa', 'msg')).toEqual({
      ok: true,
      mergedInto: 'release-2.0'
    })
  })

  it('captures conflicting files before aborting, and aborts', async () => {
    const order: string[] = []
    const { run } = scripted(({ args }) => {
      order.push(args.join(' '))
      if (args[0] === 'merge' && args[1] === '--no-ff') return new Error('CONFLICT in src/a.ts')
      if (args[0] === 'diff') return 'src/a.ts\n"caf\\303\\251.ts"\n'
      return ''
    })
    use(run)
    const res = await mergeAgent(repo, 'aaaaaaaaaaaa', 'msg')
    expect(res.ok).toBe(false)
    expect(res.conflictFiles).toEqual(['src/a.ts', 'café.ts'])
    // Reading the conflicts after the abort would return nothing.
    expect(order.indexOf('diff --name-only --diff-filter=U')).toBeLessThan(
      order.indexOf('merge --abort')
    )
  })

  it('does not commit in the worktree when there is nothing staged', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    await mergeAgent(repo, 'aaaaaaaaaaaa', 'msg')
    expect(ran(calls, 'commit')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyAgentFiles writes into the user's real working tree and its rollback
// deletes files, so these run against a real temp directory: any filesystem
// call that escapes the script is contained rather than pointed at a real repo.

describe('applyAgentFiles', () => {
  let repo: string

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'agentmaster-apply-'))
  })
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  const agent = 'aaaaaaaaaaaa'

  it('refuses when a selected path has uncommitted changes, changing nothing', async () => {
    const { run, calls } = scripted(({ args }) => {
      if (args[0] === 'status') return ' M src/a.ts\n'
      return ''
    })
    use(run)
    const res = await applyAgentFiles(repo, agent, ['src/a.ts'], [], 'msg')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/uncommitted changes/i)
    // The gate is first precisely so a refusal is inert.
    expect(ran(calls, 'checkout')).toBe(false)
    expect(ran(calls, 'commit')).toBe(false)
    expect(ran(calls, 'add')).toBe(false)
  })

  it('refuses an empty selection', async () => {
    const { run, calls } = scripted(() => '')
    use(run)
    expect((await applyAgentFiles(repo, agent, [], [], 'msg')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('commits only the selected paths, leaving the rest of the index alone', async () => {
    let statusCalls = 0
    const { run, calls } = scripted(({ args }) => {
      if (args[0] === 'status') {
        statusCalls++
        // 1: the dirty gate (clean). 2: worktree staging (has work).
        // 3: did the checkout change anything (yes).
        if (statusCalls === 2) return ' M src/a.ts\n'
        if (statusCalls === 3) return 'M  src/a.ts\n'
        return ''
      }
      if (args[0] === 'rev-parse') return 'main\n'
      return ''
    })
    use(run)
    const res = await applyAgentFiles(repo, agent, ['src/a.ts'], ['src/gone.ts'], 'take these')
    expect(res).toEqual({ ok: true, mergedInto: 'main' })

    const commit = calls.find((c) => c.args[0] === 'commit' && c.cwd === repo)
    expect(commit?.args).toEqual([
      'commit',
      '-m',
      'take these',
      '--',
      'src/a.ts',
      'src/gone.ts'
    ])
    // Deleted files can't arrive via checkout — they are git rm'd.
    expect(ran(calls, 'rm')).toBe(true)
  })

  it('reports nothing to do when the selection already matches', async () => {
    let statusCalls = 0
    const { run } = scripted(({ args }) => {
      if (args[0] === 'status') {
        statusCalls++
        if (statusCalls === 2) return ' M src/a.ts\n'
        return '' // 3rd call: checkout changed nothing
      }
      return ''
    })
    use(run)
    const res = await applyAgentFiles(repo, agent, ['src/a.ts'], [], 'msg')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/already match/i)
  })

  // A pre-commit hook rejecting the commit is the realistic trigger. The user's
  // working tree must come back exactly as it was.
  it('rolls back per path when the commit fails', async () => {
    let statusCalls = 0
    const { run, calls } = scripted(({ args }) => {
      if (args[0] === 'status') {
        statusCalls++
        if (statusCalls === 2) return ' M src/a.ts\n'
        if (statusCalls === 3) return 'M  src/a.ts\n'
        return ''
      }
      if (args[0] === 'commit' && args.includes('--')) return new Error('pre-commit hook failed')
      return ''
    })
    use(run)
    const res = await applyAgentFiles(repo, agent, ['src/a.ts', 'src/b.ts'], [], 'msg')
    expect(res.ok).toBe(false)

    const restores = calls.filter((c) => c.args[0] === 'checkout' && c.args[1] === 'HEAD')
    // Per path, never one bulk checkout: a bulk pathspec aborts entirely as soon
    // as one path isn't in HEAD, restoring nothing.
    expect(restores.map((c) => c.args[3])).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('removes a file the apply materialised when HEAD has no version of it', async () => {
    const brandNew = 'brand-new.ts'
    await writeFile(join(repo, brandNew), 'from the agent')

    let statusCalls = 0
    const { run, calls } = scripted(({ args }) => {
      if (args[0] === 'status') {
        statusCalls++
        if (statusCalls === 2) return ' M x\n'
        if (statusCalls === 3) return 'A  brand-new.ts\n'
        return ''
      }
      if (args[0] === 'commit' && args.includes('--')) return new Error('hook rejected')
      // Not in HEAD — this is what sends the rollback down the delete path.
      if (args[0] === 'checkout' && args[1] === 'HEAD') return new Error('pathspec did not match')
      return ''
    })
    use(run)
    await applyAgentFiles(repo, agent, [brandNew], [], 'msg')

    expect(ran(calls, 'reset')).toBe(true)
    // The dirty gate guarantees nothing of the user's lived here beforehand.
    expect(existsSync(join(repo, brandNew))).toBe(false)
    expect(await readdir(repo)).not.toContain(brandNew)
  })
})

// ---------------------------------------------------------------------------

describe('friendlyGitError', () => {
  it('names the real fix when git is missing', () => {
    expect(friendlyGitError({ code: 'ENOENT', message: 'spawn git ENOENT' })).toMatch(
      /isn’t installed|isn’t on your PATH/
    )
    expect(friendlyGitError({ stderr: "'git' is not recognized" })).toMatch(/isn’t installed/)
  })

  it('turns an empty repository into the action that unblocks it', () => {
    expect(friendlyGitError({ stderr: "fatal: ambiguous argument 'HEAD'" })).toMatch(
      /no commits yet/
    )
    expect(friendlyGitError({ stderr: 'does not have any commits yet' })).toMatch(/initial commit/)
  })

  it('explains a branch already checked out elsewhere', () => {
    expect(friendlyGitError({ stderr: "fatal: 'canvas/x' is already checked out" })).toMatch(
      /already checked out in another worktree/
    )
  })

  it('tells the user to stash rather than showing git plumbing', () => {
    expect(
      friendlyGitError({ stderr: 'error: Your local changes would be overwritten by merge' })
    ).toMatch(/commit or stash/)
  })

  it('falls back to git’s first line, without the fatal: prefix', () => {
    expect(friendlyGitError({ stderr: 'fatal: something specific\nmore detail' })).toBe(
      'something specific'
    )
    expect(friendlyGitError({ stderr: '   ' })).toBe('Git command failed.')
  })

  // A thrown value with nothing readable on it used to stringify straight
  // through, so the user got "[object Object]" as the explanation for a failed
  // merge. Nothing in this module throws such a value today — this is about
  // what happens the first time something does.
  it('says something useful for a thrown value with nothing to read', () => {
    expect(friendlyGitError({})).toBe('Git command failed.')
    expect(friendlyGitError(null)).toBe('Git command failed.')
    expect(friendlyGitError(undefined)).toBe('Git command failed.')
    expect(friendlyGitError([])).toBe('Git command failed.')
  })

  it('still shows a thrown string or number, which does carry information', () => {
    expect(friendlyGitError('fatal: bad revision')).toBe('bad revision')
    expect(friendlyGitError(128)).toBe('128')
  })
})
