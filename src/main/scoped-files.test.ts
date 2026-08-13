import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { resolveWithin, listDir, readFile, saveFile, MAX_FILE_BYTES } from './scoped-files'

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
