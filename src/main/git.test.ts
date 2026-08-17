import { describe, it, expect } from 'vitest'
import {
  unquoteGitPath,
  worktreeInfo,
  worktreeContainers,
  getDirtyPaths,
  repoRelPrefix,
  filterDirty,
  setGitRunner
} from './git'

// git quotes any path with non-ASCII or control characters in C style. Decoding
// it wrong means the diff panel shows mojibake and, worse, "apply selected
// files" targets a path that doesn't exist.
describe('unquoteGitPath', () => {
  it('passes through an unquoted path unchanged', () => {
    expect(unquoteGitPath('src/main/git.ts')).toBe('src/main/git.ts')
    // A quote that isn't a wrapping pair is data, not quoting.
    expect(unquoteGitPath('say"hi".txt')).toBe('say"hi".txt')
  })

  it('decodes octal escapes as UTF-8 bytes, not characters', () => {
    // "é" is two bytes (C3 A9); decoding per-byte would yield "Ã©".
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe('café.txt')
    expect(unquoteGitPath('"\\320\\237\\321\\200\\320\\270.md"')).toBe('При.md')
  })

  it('decodes the named escapes', () => {
    expect(unquoteGitPath('"a\\tb.txt"')).toBe('a\tb.txt')
    expect(unquoteGitPath('"a\\nb.txt"')).toBe('a\nb.txt')
    expect(unquoteGitPath('"say \\"hi\\".txt"')).toBe('say "hi".txt')
    expect(unquoteGitPath('"back\\\\slash.txt"')).toBe('back\\slash.txt')
  })

  it('stops cleanly on a malformed trailing backslash', () => {
    expect(() => unquoteGitPath('"broken\\"')).not.toThrow()
  })
})

// The worktree layout is a contract: change it and existing worktrees orphan.
describe('worktreeInfo', () => {
  it('places the worktree in a sibling container, never inside the repo', () => {
    const info = worktreeInfo('/home/u/proj', 'abcdef01-2345-6789-abcd-ef0123456789')
    // Nested worktrees would show up as untracked files to the agent itself.
    expect(info.path.startsWith('/home/u/proj')).toBe(false)
    expect(info.container.replace(/\\/g, '/')).toBe('/home/u/.agentmaster-worktrees')
  })

  it('derives branch and path from the same 12-char id, stripped of dashes', () => {
    const info = worktreeInfo('/home/u/proj', 'abcdef01-2345-6789')
    expect(info.branch).toBe('canvas/abcdef012345')
    expect(info.path.replace(/\\/g, '/')).toBe('/home/u/.agentmaster-worktrees/proj-abcdef012345')
  })

  it('is deterministic — the same agent always resolves to the same worktree', () => {
    const a = worktreeInfo('/home/u/proj', 'agent-1')
    const b = worktreeInfo('/home/u/proj', 'agent-1')
    expect(a).toEqual(b)
  })

  it('gives two agents in one repo distinct worktrees and branches', () => {
    const a = worktreeInfo('/home/u/proj', 'aaaaaaaaaaaaaa')
    const b = worktreeInfo('/home/u/proj', 'bbbbbbbbbbbbbb')
    expect(a.path).not.toBe(b.path)
    expect(a.branch).not.toBe(b.branch)
  })

  // Pre-rename worktrees are registered in the user's .git under the OLD path.
  // Forget them and a restored agent can neither find its checkout nor create a
  // new one (the branch is already checked out), and cleanup stops recognising
  // its own leftovers. This is the test that fails if legacy support is dropped.
  // The app has been renamed twice over the life of this container, so there is
  // one legacy path per earlier name — not just the most recent one.
  it('still knows every pre-rename container, each a distinct path', () => {
    const info = worktreeInfo('/home/u/proj', 'abcdef01-2345-6789')
    expect(info.legacyPaths.map((p) => p.replace(/\\/g, '/'))).toEqual([
      '/home/u/.spymaster-worktrees/proj-abcdef012345',
      '/home/u/.monad-worktrees/proj-abcdef012345'
    ])
    for (const legacy of info.legacyPaths) {
      expect(legacy).not.toBe(info.path)
      // Same leaf name throughout, so one agent maps onto exactly one folder
      // in whichever container it happens to live.
      expect(legacy.split(/[\\/]/).pop()).toBe(info.path.split(/[\\/]/).pop())
    }
  })
})

// The destructive paths (orphan detection and removal) are gated on this list.
// It must cover every legacy container — or pre-rename leftovers become
// uncollectable — and must never grow beyond the known containers.
describe('worktreeContainers', () => {
  it('covers exactly the current and pre-rename containers, as siblings of the repo', () => {
    const got = worktreeContainers('/home/u/proj').map((c) => c.replace(/\\/g, '/'))
    expect(got).toEqual([
      '/home/u/.agentmaster-worktrees',
      '/home/u/.spymaster-worktrees',
      '/home/u/.monad-worktrees'
    ])
  })

  it('never returns a path inside the repo itself', () => {
    for (const c of worktreeContainers('/home/u/proj')) {
      expect(c.replace(/\\/g, '/').startsWith('/home/u/proj')).toBe(false)
    }
  })
})

// Drives the extra warning the file panel shows before trashing something with
// uncommitted work. A committed file is recoverable from git AND the Trash; one
// with uncommitted changes only from the Trash, and that is worth saying out
// loud. Getting this wrong in the "reports nothing" direction silently removes
// the warning, which is why the failure cases are asserted too.
describe('getDirtyPaths', () => {
  const withStatus = async (stdout: string): Promise<Set<string>> => {
    const restore = setGitRunner(async () => stdout)
    try {
      return await getDirtyPaths('/repo')
    } finally {
      restore()
    }
  }

  it('reports modified, staged and untracked paths', async () => {
    const dirty = await withStatus(
      ' M src/a.ts\0M  src/b.ts\0?? src/new.ts\0A  src/added.ts\0'
    )
    expect([...dirty].sort()).toEqual(['src/a.ts', 'src/added.ts', 'src/b.ts', 'src/new.ts'])
  })

  it('is empty for a clean tree', async () => {
    expect((await withStatus('')).size).toBe(0)
  })

  // A rename record carries its ORIGIN path in the next NUL-separated field.
  // Reading that field as its own record would produce a bogus entry and skip
  // a real one.
  it('consumes both halves of a rename record', async () => {
    const dirty = await withStatus('R  src/new.ts\0src/old.ts\0 M src/other.ts\0')
    expect([...dirty].sort()).toEqual(['src/new.ts', 'src/old.ts', 'src/other.ts'])
  })

  it('handles a path containing a space', async () => {
    expect([...(await withStatus(' M src/two words.ts\0'))]).toEqual(['src/two words.ts'])
  })

  // The warning is an extra. A broken git call must never be able to block a
  // delete, so this fails open rather than throwing.
  it('reports nothing rather than throwing when git fails', async () => {
    const restore = setGitRunner(async () => {
      throw new Error('not a repository')
    })
    try {
      expect((await getDirtyPaths('/repo')).size).toBe(0)
    } finally {
      restore()
    }
  })
})

// git names paths from the REPO root; the file panel names them from its SCOPE
// root, and an agent can point at a subdirectory. This mapping was inline in the
// IPC handler and therefore only reachable through a full Electron smoke — which
// then failed on Windows and passed on macOS for the same commit. Pure and
// tested here instead.
describe('repoRelPrefix', () => {
  it('is empty when the scope root IS the repo root', () => {
    expect(repoRelPrefix('/repo', '/repo')).toBe('')
  })

  it('is the subpath when the scope root is inside the repo', () => {
    expect(repoRelPrefix('/repo', '/repo/packages/app')).toBe('packages/app/')
  })

  it('is null when the scope root is outside the repo', () => {
    expect(repoRelPrefix('/repo', '/elsewhere')).toBeNull()
    expect(repoRelPrefix('/repo/packages', '/repo')).toBeNull()
  })

  // `/repo2` is not inside `/repo`, despite the prefix.
  it('does not treat a name-prefix as containment', () => {
    expect(repoRelPrefix('/repo', '/repo2')).toBeNull()
  })

  // git answers with forward slashes on every platform; the scope root arrives
  // with the platform separator. The prefix has to speak git's dialect.
  it('normalises separators to git style', () => {
    const prefix = repoRelPrefix('/repo', '/repo/a/b')
    expect(prefix).not.toContain('\\')
    expect(prefix).toBe('a/b/')
  })
})

describe('filterDirty', () => {
  const dirty = new Set(['src/a.ts', 'src/nested/deep.ts', 'README.md'])

  it('keeps only the paths git reported', () => {
    expect(filterDirty(['src/a.ts', 'src/clean.ts'], dirty, '')).toEqual(['src/a.ts'])
  })

  // Deleting a folder should warn when a single file inside it has uncommitted
  // work — the folder itself never appears in git status.
  it('counts a folder as dirty when something under it is', () => {
    expect(filterDirty(['src/nested'], dirty, '')).toEqual(['src/nested'])
    expect(filterDirty(['src'], dirty, '')).toEqual(['src'])
  })

  it('does not treat a name-prefix as containment', () => {
    expect(filterDirty(['src/nes'], dirty, '')).toEqual([])
  })

  // The scope root is a subdirectory: the caller says 'a.ts', git said 'src/a.ts'.
  it('applies the prefix before comparing', () => {
    expect(filterDirty(['a.ts', 'clean.ts'], dirty, 'src/')).toEqual(['a.ts'])
    // …and without the prefix the same call would find nothing, which is the
    // exact way this went silently empty before.
    expect(filterDirty(['a.ts'], dirty, '')).toEqual([])
  })

  it('reports nothing when git reported nothing', () => {
    expect(filterDirty(['src/a.ts'], new Set(), '')).toEqual([])
  })

  it('accepts backslash-separated input from the renderer', () => {
    expect(filterDirty(['src\\a.ts'], dirty, '')).toEqual(['src\\a.ts'])
  })
})
