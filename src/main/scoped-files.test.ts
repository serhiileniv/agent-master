import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  resolveWithin,
  resolveWithinReal,
  listDir,
  readFile,
  saveFile,
  createEntry,
  renameEntry,
  moveEntry,
  copyInto,
  deleteEntries,
  snapshotEntry,
  restoreSnapshot,
  incrementalName,
  validateEntryName,
  compareEntries,
  MAX_FILE_BYTES,
  MAX_UNDO_BYTES
} from './scoped-files'

// The file panel hands the main process a scope root and a relative path. This
// is the only thing standing between an agent's output and the rest of the
// user's disk, and until it became a module its only coverage was a smoke test
// that needed a full Electron build to run.

let root: string
let outside: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'agentmaster-files-'))
  root = join(base, 'scope')
  outside = base
  await mkdir(root)
})

afterAll(async () => {
  await rm(outside, { recursive: true, force: true })
})

describe('resolveWithin', () => {
  it('refuses to climb out of the root', () => {
    expect(resolveWithin(root, '../secret.txt')).toBeNull()
    expect(resolveWithin(root, '..')).toBeNull()
    expect(resolveWithin(root, 'a/../../secret.txt')).toBeNull()
    expect(resolveWithin(root, '../../../../../../etc/passwd')).toBeNull()
  })

  it('refuses an absolute rel, which would make the root irrelevant', () => {
    expect(resolveWithin(root, resolve(outside, 'secret.txt'))).toBeNull()
    expect(resolveWithin(root, '/etc/passwd')).toBeNull()
  })

  // `/a/root` must not admit `/a/rootsecrets` — a prefix match without the
  // separator would.
  it('refuses a sibling whose name merely starts with the root', () => {
    expect(resolveWithin(root, '../scope-secrets/f.txt')).toBeNull()
    expect(resolveWithin(root, '../scopesecrets')).toBeNull()
  })

  it('refuses anything that is not a pair of strings', () => {
    expect(resolveWithin('', 'a.txt')).toBeNull()
    expect(resolveWithin(root, null as unknown as string)).toBeNull()
    expect(resolveWithin(null as unknown as string, 'a.txt')).toBeNull()
    expect(resolveWithin(root, 42 as unknown as string)).toBeNull()
  })

  it('allows the root itself and anything genuinely under it', () => {
    expect(resolveWithin(root, '')).toBe(resolve(root))
    expect(resolveWithin(root, 'a.txt')).toBe(resolve(root, 'a.txt'))
    expect(resolveWithin(root, 'deep/nested/a.txt')).toBe(resolve(root, 'deep/nested/a.txt'))
    // Climbing and coming back is fine — it lands inside.
    expect(resolveWithin(root, 'deep/../a.txt')).toBe(resolve(root, 'a.txt'))
  })
})

describe('listDir', () => {
  beforeAll(async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'Zebra.ts'), '')
    await writeFile(join(root, 'apple.ts'), '')
    await writeFile(join(root, '.env'), '')
    await writeFile(join(outside, 'secret.txt'), 'do not read me')
  })

  it('puts directories first, then files, each case-insensitively sorted', async () => {
    const { entries } = await listDir(root, '')
    const names = entries.map((e) => e.name)
    expect(names.filter((n) => n === 'node_modules' || n === 'src')).toEqual([
      'node_modules',
      'src'
    ])
    // apple before Zebra despite the capital.
    expect(names.indexOf('apple.ts')).toBeLessThan(names.indexOf('Zebra.ts'))
    // Every dir precedes every file.
    const kinds = entries.map((e) => e.kind)
    expect(kinds.lastIndexOf('dir')).toBeLessThan(kinds.indexOf('file'))
  })

  it('hides .git but keeps node_modules and dotfiles', async () => {
    const names = (await listDir(root, '')).entries.map((e) => e.name)
    expect(names).not.toContain('.git')
    expect(names).toContain('node_modules')
    expect(names).toContain('.env')
  })

  it('lists nothing for a path outside the root', async () => {
    expect(await listDir(root, '..')).toEqual({ entries: [] })
    expect(await listDir(root, '../')).toEqual({ entries: [] })
  })

  it('lists nothing rather than throwing for a missing directory', async () => {
    expect(await listDir(root, 'no/such/dir')).toEqual({ entries: [] })
  })
})

describe('readFile', () => {
  const empty = { mtimeMs: 0, size: 0, isBinary: false, tooLarge: false }

  beforeAll(async () => {
    await writeFile(join(root, 'text.ts'), 'const a = 1\n')
    await writeFile(join(root, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]))
    await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(root, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  })

  it('reads text as content', async () => {
    const r = await readFile(root, 'text.ts')
    expect(r.content).toBe('const a = 1\n')
    expect(r.isBinary).toBe(false)
    expect(r.mtimeMs).toBeGreaterThan(0)
  })

  it('flags a NUL-bearing file as binary and does not return its bytes', async () => {
    const r = await readFile(root, 'binary.bin')
    expect(r.isBinary).toBe(true)
    expect(r.content).toBeUndefined()
    expect(r.dataUrl).toBeUndefined()
  })

  it('returns an image as a data URL', async () => {
    const r = await readFile(root, 'pic.png')
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(r.content).toBeUndefined()
  })

  it('refuses to buffer a file over the cap', async () => {
    const r = await readFile(root, 'big.txt')
    expect(r.tooLarge).toBe(true)
    expect(r.content).toBeUndefined()
  })

  // The one that matters: traversal must not read, whatever the file is.
  it('reads nothing outside the root', async () => {
    expect(await readFile(root, '../secret.txt')).toEqual(empty)
    expect(await readFile(root, resolve(outside, 'secret.txt'))).toEqual(empty)
  })

  it('returns empty for a directory or a missing file', async () => {
    expect(await readFile(root, 'src')).toEqual(empty)
    expect(await readFile(root, 'nope.ts')).toEqual(empty)
  })
})

describe('saveFile', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'save.txt'), 'original')
  })

  it('writes and reports the new mtime', async () => {
    const r = await saveFile(root, 'save.txt', 'updated', 0)
    expect(r.ok).toBe(true)
    expect(r.mtimeMs).toBeGreaterThan(0)
    expect((await readFile(root, 'save.txt')).content).toBe('updated')
  })

  it('refuses without writing when the file changed underneath', async () => {
    const stale = 12345 // nowhere near the real mtime
    const r = await saveFile(root, 'save.txt', 'clobbered', stale)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    // The refusal must be inert.
    expect((await readFile(root, 'save.txt')).content).toBe('original')
  })

  it('writes anyway when the caller overrides with 0', async () => {
    expect((await saveFile(root, 'save.txt', 'forced', 0)).ok).toBe(true)
    expect((await readFile(root, 'save.txt')).content).toBe('forced')
  })

  it('saves a new file, which has no mtime to conflict with', async () => {
    const r = await saveFile(root, 'brand-new.txt', 'hello', 123456)
    expect(r.ok).toBe(true)
    expect((await readFile(root, 'brand-new.txt')).content).toBe('hello')
  })

  it('writes nothing outside the root', async () => {
    const target = join(outside, 'secret.txt')
    const before = await stat(target)
    const r = await saveFile(root, '../secret.txt', 'overwritten', 0)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid path')
    const after = await stat(target)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

// --- Write operations -------------------------------------------------------
//
// These widen the file panel from "read anything in the root, write one file"
// to create/rename/move/copy/delete. That is a much bigger blast radius against
// the user's REAL project folder, so containment is asserted for every one of
// them individually rather than trusted to a shared helper.

describe('resolveWithinReal', () => {
  it('resolves a path that stays inside the root', async () => {
    const abs = await resolveWithinReal(root, 'deep/nested/a.txt')
    expect(abs).not.toBeNull()
    expect(abs).toContain('deep')
  })

  it('resolves a target that does not exist yet, so create can use it', async () => {
    const abs = await resolveWithinReal(root, 'not/there/yet.txt')
    expect(abs).not.toBeNull()
    expect(abs?.endsWith(join('not', 'there', 'yet.txt'))).toBe(true)
  })

  it('refuses the same escapes the lexical guard does', async () => {
    expect(await resolveWithinReal(root, '../secret.txt')).toBeNull()
    expect(await resolveWithinReal(root, '..')).toBeNull()
    expect(await resolveWithinReal(root, '/etc/passwd')).toBeNull()
  })

  // The reason this function exists. `resolveWithin` is lexical and would happily
  // hand back root/link/x — which is somewhere else entirely.
  it('refuses a symlink pointing outside the root, which the lexical guard allows', async () => {
    const linkPath = join(root, 'escape-link')
    await rm(linkPath, { force: true })
    await symlink(outside, linkPath, 'dir')
    // Lexical guard: looks fine.
    expect(resolveWithin(root, 'escape-link/secret.txt')).not.toBeNull()
    // Strict guard: refuses.
    expect(await resolveWithinReal(root, 'escape-link/secret.txt')).toBeNull()
    expect(await resolveWithinReal(root, 'escape-link')).toBeNull()
    await rm(linkPath, { force: true })
  })
})

describe('validateEntryName', () => {
  it('requires a name', () => {
    expect(validateEntryName('').error).toBeTruthy()
    expect(validateEntryName('   ').error).toBeTruthy()
  })

  it('refuses a leading slash', () => {
    expect(validateEntryName('/foo.ts').error).toMatch(/cannot start with a slash/)
    expect(validateEntryName('\\foo.ts').error).toMatch(/cannot start with a slash/)
  })

  it('refuses a name already taken in the folder', () => {
    expect(validateEntryName('a.txt', ['a.txt']).error).toMatch(/already exists/)
    expect(validateEntryName('a.txt', ['b.txt']).error).toBeUndefined()
  })

  // Only the FIRST segment can collide; the rest are folders the create makes,
  // and merging into an existing one is fine.
  it('only checks the first segment for a collision', () => {
    expect(validateEntryName('utils/dates.ts', ['utils']).error).toMatch(/already exists/)
    expect(validateEntryName('fresh/dates.ts', ['utils']).error).toBeUndefined()
  })

  it('warns about surrounding whitespace without blocking it', () => {
    const r = validateEntryName(' spaced.ts ')
    expect(r.error).toBeUndefined()
    expect(r.warning).toMatch(/whitespace/)
  })

  it('refuses names that cannot exist on Windows, wherever it runs', () => {
    expect(validateEntryName('CON').error).toBeTruthy()
    expect(validateEntryName('nul.txt').error).toBeTruthy()
    expect(validateEntryName('foo/CON/bar.ts').error).toBeTruthy()
  })
})

describe('createEntry', () => {
  it('creates an empty file', async () => {
    const r = await createEntry(root, 'made.txt', 'file')
    expect(r.ok).toBe(true)
    expect((await readFile(root, 'made.txt')).content).toBe('')
  })

  it('creates intermediate folders for a name with slashes', async () => {
    const r = await createEntry(root, 'mk/deeper/leaf.txt', 'file')
    expect(r.ok).toBe(true)
    expect((await listDir(root, 'mk/deeper')).entries.map((e) => e.name)).toEqual(['leaf.txt'])
  })

  it('creates a folder when the name ends in a slash, even from the file button', async () => {
    const r = await createEntry(root, 'trailing/', 'file')
    expect(r.ok).toBe(true)
    const entry = (await listDir(root, '')).entries.find((e) => e.name === 'trailing')
    expect(entry?.kind).toBe('dir')
  })

  it('reports a conflict rather than truncating what is already there', async () => {
    await writeFile(join(root, 'taken.txt'), 'keep me')
    const r = await createEntry(root, 'taken.txt', 'file')
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    expect((await readFile(root, 'taken.txt')).content).toBe('keep me')
  })

  it('creates nothing outside the root', async () => {
    const r = await createEntry(root, '../escaped.txt', 'file')
    expect(r.ok).toBe(false)
    await expect(stat(join(outside, 'escaped.txt'))).rejects.toThrow()
  })

  // Path normalisation drops the empty leading segment, which silently turned
  // `/etc/passwd` into the relative `etc/passwd` and created it INSIDE the root.
  // Contained, but wrong in a quiet way: the caller asked for something
  // impossible and got something plausible instead of an error.
  it('refuses an absolute path rather than reinterpreting it as relative', async () => {
    const r = await createEntry(root, '/abs/planted.txt', 'file')
    expect(r.ok).toBe(false)
    expect((await listDir(root, '')).entries.map((e) => e.name)).not.toContain('abs')
    expect((await createEntry(root, 'C:\\abs\\planted.txt', 'file')).ok).toBe(false)
  })
})

describe('absolute input is refused by every write operation', () => {
  // Each of these would otherwise normalise into a path inside the root.
  it('refuses across move, rename, copy, snapshot, restore and delete', async () => {
    await writeFile(join(root, 'abs-src.txt'), 'x')
    expect((await moveEntry(root, '/abs/a.txt', 'b.txt')).ok).toBe(false)
    expect((await moveEntry(root, 'abs-src.txt', '/abs/b.txt')).ok).toBe(false)
    expect((await renameEntry(root, 'abs-src.txt', '/abs/b.txt')).ok).toBe(false)
    expect((await copyInto(root, '/abs/a.txt', '')).ok).toBe(false)
    expect(await snapshotEntry(root, '/abs/a.txt')).toBeNull()
    expect((await restoreSnapshot(root, { rel: '/abs/a.txt', kind: 'file', content: 'eA==' })).ok).toBe(
      false
    )
    const trashed: string[] = []
    const d = await deleteEntries(root, ['/abs/a.txt'], async (abs) => {
      trashed.push(abs)
    })
    expect(d.ok).toBe(false)
    expect(trashed).toEqual([])
    // Nothing was quietly created under the root by any of them.
    expect((await listDir(root, '')).entries.map((e) => e.name)).not.toContain('abs')
  })
})

describe('renameEntry / moveEntry', () => {
  beforeEach(async () => {
    await rm(join(root, 'mv'), { recursive: true, force: true })
    await mkdir(join(root, 'mv/sub'), { recursive: true })
    await writeFile(join(root, 'mv/one.txt'), 'one')
  })

  it('renames in place, keeping the file in its folder', async () => {
    const r = await renameEntry(root, 'mv/one.txt', 'two.txt')
    expect(r.ok).toBe(true)
    expect(r.rel).toBe('mv/two.txt')
    expect((await readFile(root, 'mv/two.txt')).content).toBe('one')
  })

  it('moves into another folder', async () => {
    const r = await moveEntry(root, 'mv/one.txt', 'mv/sub/one.txt')
    expect(r.ok).toBe(true)
    expect((await readFile(root, 'mv/sub/one.txt')).content).toBe('one')
  })

  it('copies instead of moving when asked, leaving the original', async () => {
    const r = await moveEntry(root, 'mv/one.txt', 'mv/sub/one.txt', { copy: true })
    expect(r.ok).toBe(true)
    expect((await readFile(root, 'mv/one.txt')).content).toBe('one')
    expect((await readFile(root, 'mv/sub/one.txt')).content).toBe('one')
  })

  // Silently overwriting is the failure mode that loses work without a trace.
  it('reports a conflict instead of overwriting, and leaves the target intact', async () => {
    await writeFile(join(root, 'mv/sub/one.txt'), 'existing')
    const r = await moveEntry(root, 'mv/one.txt', 'mv/sub/one.txt')
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    expect((await readFile(root, 'mv/sub/one.txt')).content).toBe('existing')
    expect((await readFile(root, 'mv/one.txt')).content).toBe('one')
  })

  it('overwrites only when explicitly told to', async () => {
    await writeFile(join(root, 'mv/sub/one.txt'), 'existing')
    const r = await moveEntry(root, 'mv/one.txt', 'mv/sub/one.txt', { overwrite: true })
    expect(r.ok).toBe(true)
    expect((await readFile(root, 'mv/sub/one.txt')).content).toBe('one')
  })

  // rename() on some platforms reports success here and detaches the subtree.
  it('refuses to move a folder into its own descendant', async () => {
    const r = await moveEntry(root, 'mv', 'mv/sub/mv')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/into itself/)
    expect((await listDir(root, 'mv')).entries.length).toBeGreaterThan(0)
  })

  it('moves nothing outside the root, in either direction', async () => {
    expect((await moveEntry(root, 'mv/one.txt', '../stolen.txt')).ok).toBe(false)
    expect((await moveEntry(root, '../secret.txt', 'mv/taken.txt')).ok).toBe(false)
    await expect(stat(join(outside, 'stolen.txt'))).rejects.toThrow()
    expect((await readFile(root, 'mv/one.txt')).content).toBe('one')
  })
})

describe('incrementalName', () => {
  it('leaves a free name alone', () => {
    expect(incrementalName('a.ts', ['b.ts'])).toBe('a.ts')
  })

  it('appends "copy", then numbers, rather than overwriting', () => {
    expect(incrementalName('a.ts', ['a.ts'])).toBe('a copy.ts')
    expect(incrementalName('a.ts', ['a.ts', 'a copy.ts'])).toBe('a copy 2.ts')
    expect(incrementalName('a.ts', ['a.ts', 'a copy.ts', 'a copy 2.ts'])).toBe('a copy 3.ts')
  })

  // Otherwise re-pasting a copy gives "a copy copy.ts".
  it('continues the series instead of nesting when copying a copy', () => {
    expect(incrementalName('a copy.ts', ['a copy.ts'])).toBe('a copy 2.ts')
  })

  it('handles a name with no extension', () => {
    expect(incrementalName('LICENSE', ['LICENSE'])).toBe('LICENSE copy')
  })
})

describe('copyInto', () => {
  it('auto-renames rather than clobbering when pasting into the same folder', async () => {
    await rm(join(root, 'cp'), { recursive: true, force: true })
    await mkdir(join(root, 'cp'), { recursive: true })
    await writeFile(join(root, 'cp/a.txt'), 'body')
    const r = await copyInto(root, 'cp/a.txt', 'cp')
    expect(r.ok).toBe(true)
    expect(r.rel).toBe('cp/a copy.txt')
    expect((await readFile(root, 'cp/a.txt')).content).toBe('body')
    expect((await readFile(root, 'cp/a copy.txt')).content).toBe('body')
  })
})

describe('deleteEntries', () => {
  beforeEach(async () => {
    await rm(join(root, 'del'), { recursive: true, force: true })
    await mkdir(join(root, 'del'), { recursive: true })
    await writeFile(join(root, 'del/gone.txt'), 'x')
  })

  it('hands each resolved path to the injected trash function', async () => {
    const trashed: string[] = []
    const r = await deleteEntries(root, ['del/gone.txt'], async (abs) => {
      trashed.push(abs)
    })
    expect(r.ok).toBe(true)
    expect(r.failed).toEqual([])
    expect(trashed).toHaveLength(1)
    expect(trashed[0].endsWith(join('del', 'gone.txt'))).toBe(true)
  })

  // A trash failure must surface, never quietly become a permanent delete.
  it('reports a refusal instead of falling back to a hard delete', async () => {
    const r = await deleteEntries(root, ['del/gone.txt'], async () => {
      throw new Error('nope')
    })
    expect(r.ok).toBe(false)
    expect(r.failed).toEqual(['del/gone.txt'])
    // Still on disk — the refusal was inert.
    expect((await readFile(root, 'del/gone.txt')).content).toBe('x')
  })

  it('never calls trash for a path outside the root', async () => {
    const trashed: string[] = []
    const r = await deleteEntries(root, ['../secret.txt'], async (abs) => {
      trashed.push(abs)
    })
    expect(r.ok).toBe(false)
    expect(trashed).toEqual([])
    await expect(stat(join(outside, 'secret.txt'))).resolves.toBeTruthy()
  })

  // rel '' resolves to the root itself — deleting the user's whole project.
  it('refuses to delete the scope root itself', async () => {
    const trashed: string[] = []
    const r = await deleteEntries(root, ['', '.'], async (abs) => {
      trashed.push(abs)
    })
    expect(r.ok).toBe(false)
    expect(trashed).toEqual([])
  })
})

describe('snapshotEntry / restoreSnapshot', () => {
  it('round-trips a file so a delete can be undone', async () => {
    await writeFile(join(root, 'snap.bin'), Buffer.from([0, 1, 2, 255]))
    const snap = await snapshotEntry(root, 'snap.bin')
    expect(snap?.kind).toBe('file')
    expect(snap?.content).toBeTruthy()
    await rm(join(root, 'snap.bin'))
    const r = await restoreSnapshot(root, snap!)
    expect(r.ok).toBe(true)
    const st = await stat(join(root, 'snap.bin'))
    expect(st.size).toBe(4)
  })

  // What makes a folder delete report itself as un-undoable, up front.
  it('buffers no bytes for a folder', async () => {
    await mkdir(join(root, 'snapdir'), { recursive: true })
    const snap = await snapshotEntry(root, 'snapdir')
    expect(snap?.kind).toBe('dir')
    expect(snap?.content).toBeUndefined()
  })

  it('buffers no bytes past the undo cap', async () => {
    await writeFile(join(root, 'huge.bin'), Buffer.alloc(MAX_UNDO_BYTES + 1))
    const snap = await snapshotEntry(root, 'huge.bin')
    expect(snap?.kind).toBe('file')
    expect(snap?.content).toBeUndefined()
    await rm(join(root, 'huge.bin'))
  })

  it('restores nothing outside the root', async () => {
    const r = await restoreSnapshot(root, { rel: '../planted.txt', kind: 'file', content: 'eA==' })
    expect(r.ok).toBe(false)
    await expect(stat(join(outside, 'planted.txt'))).rejects.toThrow()
  })
})

describe('compareEntries', () => {
  it('puts folders before files', () => {
    expect(compareEntries({ name: 'z', kind: 'dir' }, { name: 'a', kind: 'file' })).toBeLessThan(0)
  })

  // A plain localeCompare gets this pair backwards, which is the most visible
  // way a file tree reads as subtly not-like-VS-Code.
  it('orders file2 before file10', () => {
    const files = [
      { name: 'file10.ts', kind: 'file' as const },
      { name: 'file2.ts', kind: 'file' as const },
      { name: 'file1.ts', kind: 'file' as const }
    ]
    expect(files.sort(compareEntries).map((f) => f.name)).toEqual([
      'file1.ts',
      'file2.ts',
      'file10.ts'
    ])
  })
})
