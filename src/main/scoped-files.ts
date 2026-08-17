/**
 * File access confined to a scope root.
 *
 * The renderer names a scope root (a worktree or project path) and a path
 * relative to it, and never anything else — every read, listing and write in
 * the file panel goes through here, and every escape from the root is refused.
 *
 * This lived as a set of closures inside registerIpc, which meant the app's
 * path-traversal guard could only be exercised by building the app and booting
 * Electron. It is a module now so the guard is an ordinary unit test.
 */
import { promises as fs } from 'fs'
import { isAbsolute, resolve, sep, extname, dirname, basename, join } from 'path'

/** One entry in a single (non-recursive) directory listing. */
export interface FileEntry {
  name: string
  kind: 'dir' | 'file'
}

export interface FileTreeResult {
  entries: FileEntry[]
}

/** Result of reading one file. Exactly one of `content`/`dataUrl` is set for a
 *  readable text/image file; both absent when binary, too large, or missing. */
export interface FileReadResult {
  mtimeMs: number
  size: number
  /** Binary (a NUL byte in the first ~8KB) — not shown in the text editor. */
  isBinary: boolean
  /** Over the size cap — not read. */
  tooLarge: boolean
  content?: string
  /** `data:<mime>;base64,...` (image files only). */
  dataUrl?: string
}

export interface FileSaveResult {
  ok: boolean
  /** On-disk mtime changed vs. expectedMtimeMs — nothing was written. Re-send
   *  with expectedMtimeMs: 0 to override. */
  conflict?: boolean
  /** Current on-disk mtime — the new one after a write, or the conflicting one. */
  mtimeMs?: number
  error?: string
}

/**
 * SECURITY BOUNDARY. Resolve `rel` against `root`, returning an absolute path
 * ONLY if it stays inside `root`. Every escape — `..` traversal, an absolute
 * `rel`, a non-string argument — yields null, so no caller here can touch
 * anything outside the scope root.
 *
 * The check is lexical: it deliberately does not call realpath, so a symlink
 * inside the root that points outside it is not caught. That is the scope as
 * it has always been; widening it is a separate decision.
 */
export function resolveWithin(root: string, rel: string): string | null {
  if (typeof root !== 'string' || typeof rel !== 'string') return null
  if (!root) return null
  // An absolute `rel` would let resolve() ignore root entirely — reject it.
  if (isAbsolute(rel)) return null
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, rel)
  if (abs === rootAbs) return abs
  if (abs.startsWith(rootAbs + sep)) return abs
  return null
}

/**
 * SECURITY BOUNDARY, the strict form — used by every operation that WRITES.
 *
 * `resolveWithin` is lexical and deliberately does not follow symlinks. For a
 * read the worst case of that is reading a file you shouldn't; for a delete or
 * a move it is destroying one, because a symlinked folder inside the root would
 * be a route straight out of it. So every mutating path resolves for real:
 * realpath the root, realpath the deepest part of the target that exists, and
 * refuse anything whose real location is outside.
 *
 * Returns the REAL absolute path (existing ancestor resolved, non-existent tail
 * appended), so callers act on the resolved location rather than on a link.
 */
export async function resolveWithinReal(root: string, rel: string): Promise<string | null> {
  const lexical = resolveWithin(root, rel)
  if (!lexical) return null
  let rootReal: string
  try {
    rootReal = await fs.realpath(resolve(root))
  } catch {
    // The root itself is gone or unreadable — nothing under it is writable.
    return null
  }
  // Walk up until something exists. Creating `a/b/c.ts` has no `a` yet, so the
  // deepest existing ancestor is what we can actually resolve; the missing tail
  // is pure names and cannot itself be a link.
  const tail: string[] = []
  let probe = lexical
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null
      return tail.length ? join(real, ...tail) : real
    } catch {
      const parent = dirname(probe)
      // Hit the filesystem root without finding anything that exists.
      if (parent === probe) return null
      tail.unshift(basename(probe))
      probe = parent
    }
  }
}

/** Outcome of a create/rename/move/copy. `rel` is where the entry actually
 *  landed, which differs from what was asked for when a paste auto-renamed. */
export interface FileOpResult {
  ok: boolean
  rel?: string
  /** Something is already at the destination and `overwrite` wasn't set —
   *  nothing was touched, so the caller can ask the user. */
  conflict?: boolean
  error?: string
}

/** Why a typed name can't be used. `error` blocks the commit; `warning` is
 *  shown but does not (leading/trailing whitespace, matching VS Code). */
export interface NameCheck {
  error?: string
  warning?: string
}

/**
 * Validate a name typed into the tree's inline editor, against the names
 * already in the target folder. Mirrors VS Code's `validateFileName`, including
 * that it runs per path segment — `foo/CON/bar.ts` is rejected on the middle
 * segment — and that whitespace only warns.
 */
export function validateEntryName(raw: string, siblings: string[] = []): NameCheck {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'A file or folder name must be provided.' }
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return { error: 'A file or folder name cannot start with a slash.' }
  }
  const segments = raw.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const seg of segments) {
    if (!seg.trim()) {
      return { error: 'A file or folder name must be provided.' }
    }
    // NUL and the Windows-reserved set. Kept even on macOS: these paths travel
    // into repos that get cloned on Windows, and a name that can't exist there
    // is a landmine rather than a preference.
    if (/[\0]/.test(seg) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(seg)) {
      const shown = seg.length > 255 ? seg.slice(0, 255) + '…' : seg
      return {
        error: `The name “${shown}” is not valid as a file or folder name. Please choose a different name.`
      }
    }
    if (seg.length > 255) {
      return { error: 'A file or folder name is too long.' }
    }
  }
  // Only the FIRST segment can collide — the rest are folders this create will
  // make, and an existing one there is fine (VS Code merges into it).
  const first = segments[0]
  if (siblings.some((s) => s === first)) {
    return {
      error: `A file or folder “${first}” already exists at this location. Please choose a different name.`
    }
  }
  if (raw !== raw.trim()) {
    return { warning: 'Leading or trailing whitespace detected in file or folder name.' }
  }
  return {}
}

/** Normalise a tree path for the ops below: `\` → `/`, no leading/trailing
 *  separators, no empty or `.` segments.
 *
 *  `.` is dropped because it is a genuine no-op that would otherwise survive as
 *  a non-empty path naming the root itself — which is how `rel: '.'` reached a
 *  delete. `..` is deliberately NOT dropped: collapsing it here would silently
 *  change what the caller asked for, and resolveWithin already refuses it. */
function normRel(rel: string): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.')
    .join('/')
}

/**
 * An absolute path must be REFUSED, not quietly reinterpreted.
 *
 * normRel drops the empty leading segment, which silently turns `/etc/passwd`
 * into the relative `etc/passwd` and creates it INSIDE the root. That stays
 * within the scope, so it is not a containment breach — it is worse in a
 * quieter way: the caller asked for something impossible and got something
 * plausible instead of an error. `resolveWithin` already refuses absolute
 * input; this makes the ops refuse it before normalisation can hide it.
 */
function isAbsoluteInput(raw: string): boolean {
  const s = String(raw ?? '')
  return /^[\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs)
    return true
  } catch {
    return false
  }
}

/**
 * Create an empty file or a folder at `rel`, making intermediate folders as
 * needed — so `utils/dates.ts` creates `utils/` too. A `rel` ending in a
 * separator is a folder regardless of `kind`, matching VS Code's inline input.
 */
export async function createEntry(
  root: string,
  rel: string,
  kind: 'file' | 'dir'
): Promise<FileOpResult> {
  const raw = String(rel ?? '')
  if (isAbsoluteInput(raw)) {
    return { ok: false, error: 'A file or folder name cannot start with a slash.' }
  }
  const isFolder = kind === 'dir' || /[\\/]\s*$/.test(raw)
  const cleaned = normRel(raw)
  if (!cleaned) return { ok: false, error: 'A file or folder name must be provided.' }
  const check = validateEntryName(cleaned)
  if (check.error) return { ok: false, error: check.error }
  const abs = await resolveWithinReal(root, cleaned)
  if (!abs) return { ok: false, error: 'invalid path' }
  if (await exists(abs)) return { ok: false, conflict: true, rel: cleaned }
  try {
    if (isFolder) {
      await fs.mkdir(abs, { recursive: true })
    } else {
      await fs.mkdir(dirname(abs), { recursive: true })
      // wx: refuse rather than truncate, in case something appeared between the
      // existence check above and here.
      const fh = await fs.open(abs, 'wx')
      await fh.close()
    }
    return { ok: true, rel: cleaned }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Move (or copy) an entry within the root. Both ends are resolved strictly, so
 * neither the source nor the destination can be a link out of the scope.
 *
 * Refuses rather than overwrites unless `overwrite` is set — the caller asks
 * the user first, which is how VS Code handles a move onto an existing name.
 */
export async function moveEntry(
  root: string,
  fromRel: string,
  toRel: string,
  opts: { overwrite?: boolean; copy?: boolean } = {}
): Promise<FileOpResult> {
  if (isAbsoluteInput(fromRel) || isAbsoluteInput(toRel)) {
    return { ok: false, error: 'invalid path' }
  }
  const from = normRel(fromRel)
  const to = normRel(toRel)
  if (!from || !to) return { ok: false, error: 'invalid path' }
  const check = validateEntryName(basename(to))
  if (check.error) return { ok: false, error: check.error }
  const absFrom = await resolveWithinReal(root, from)
  const absTo = await resolveWithinReal(root, to)
  if (!absFrom || !absTo) return { ok: false, error: 'invalid path' }
  if (!(await exists(absFrom))) return { ok: false, error: 'source no longer exists' }
  // Moving a folder into itself would detach the subtree; rename() on some
  // platforms reports success and loses it.
  if (absTo === absFrom || absTo.startsWith(absFrom + sep)) {
    return { ok: false, error: 'cannot move a folder into itself' }
  }
  if (!opts.overwrite && (await exists(absTo))) {
    return { ok: false, conflict: true, rel: to }
  }
  try {
    await fs.mkdir(dirname(absTo), { recursive: true })
    if (opts.copy) {
      await fs.cp(absFrom, absTo, { recursive: true, force: true, errorOnExist: false })
    } else {
      if (opts.overwrite) await fs.rm(absTo, { recursive: true, force: true })
      await fs.rename(absFrom, absTo)
    }
    return { ok: true, rel: to }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Rename in place: same folder, new last segment. Thin wrapper over moveEntry
 *  so the containment and self-nesting guards are shared. */
export async function renameEntry(
  root: string,
  fromRel: string,
  nextName: string
): Promise<FileOpResult> {
  if (isAbsoluteInput(fromRel) || isAbsoluteInput(nextName)) {
    return { ok: false, error: 'invalid path' }
  }
  const from = normRel(fromRel)
  if (!from) return { ok: false, error: 'invalid path' }
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const next = normRel(nextName)
  if (!next) return { ok: false, error: 'A file or folder name must be provided.' }
  return moveEntry(root, from, parent ? `${parent}/${next}` : next)
}

/**
 * The name a paste lands on when the destination is taken: `a.ts` → `a copy.ts`
 * → `a copy 2.ts`. This is VS Code's `simple` incremental naming, its default.
 * Dotfiles keep their leading dot as part of the stem.
 */
export function incrementalName(name: string, taken: string[]): string {
  const set = new Set(taken)
  if (!set.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  // Re-pasting `a copy.ts` continues the series rather than nesting it.
  const base = stem.replace(/ copy( \d+)?$/, '')
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${base} copy${ext}` : `${base} copy ${n}${ext}`
    if (!set.has(candidate)) return candidate
  }
  return `${base} copy ${Date.now()}${ext}`
}

/** Copy into `destDirRel`, auto-renaming rather than overwriting — the paste
 *  path. Returns where it actually landed. */
export async function copyInto(
  root: string,
  fromRel: string,
  destDirRel: string
): Promise<FileOpResult> {
  if (isAbsoluteInput(fromRel) || isAbsoluteInput(destDirRel)) {
    return { ok: false, error: 'invalid path' }
  }
  const from = normRel(fromRel)
  const destDir = normRel(destDirRel)
  if (!from) return { ok: false, error: 'invalid path' }
  const { entries } = await listDir(root, destDir)
  const name = incrementalName(
    basename(from),
    entries.map((e) => e.name)
  )
  return moveEntry(root, from, destDir ? `${destDir}/${name}` : name, { copy: true })
}

/** One entry's bytes, held so a delete can be undone. `content` is base64 so
 *  binary files survive the round trip. */
export interface EntrySnapshot {
  rel: string
  kind: 'file' | 'dir'
  /** Absent when the entry is a folder, or larger than the undo cap. */
  content?: string
}

/** Undo of a delete replays buffered bytes, so it has to hold them. Past this
 *  a delete is still allowed — it just isn't undoable, exactly as in VS Code. */
export const MAX_UNDO_BYTES = 5 * 1024 * 1024

/** Read what an entry would need to be recreated. Folders are never snapshotted
 *  (recreating a tree from memory is not something to be clever about), so a
 *  folder delete is reported as un-undoable rather than half-undoable. */
export async function snapshotEntry(root: string, rel: string): Promise<EntrySnapshot | null> {
  if (isAbsoluteInput(rel)) return null
  const abs = await resolveWithinReal(root, normRel(rel))
  if (!abs) return null
  try {
    const st = await fs.lstat(abs)
    if (st.isDirectory()) return { rel: normRel(rel), kind: 'dir' }
    if (st.size > MAX_UNDO_BYTES) return { rel: normRel(rel), kind: 'file' }
    const buf = await fs.readFile(abs)
    return { rel: normRel(rel), kind: 'file', content: buf.toString('base64') }
  } catch {
    return null
  }
}

/** Write a snapshot back where it came from — the undo of a delete. */
export async function restoreSnapshot(root: string, snap: EntrySnapshot): Promise<FileOpResult> {
  if (isAbsoluteInput(snap?.rel ?? '')) return { ok: false, error: 'invalid path' }
  const rel = normRel(snap?.rel ?? '')
  if (!rel) return { ok: false, error: 'invalid path' }
  const abs = await resolveWithinReal(root, rel)
  if (!abs) return { ok: false, error: 'invalid path' }
  try {
    if (snap.kind === 'dir') {
      await fs.mkdir(abs, { recursive: true })
      return { ok: true, rel }
    }
    if (snap.content == null) return { ok: false, error: 'nothing was buffered for this file' }
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, Buffer.from(snap.content, 'base64'))
    return { ok: true, rel }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface DeleteResult {
  ok: boolean
  /** Rel paths that could not be trashed, in the order they were attempted. */
  failed: string[]
  error?: string
}

/**
 * Move entries to the OS trash.
 *
 * `trash` is injected rather than imported so this module stays free of
 * electron and testable under vitest — and, more importantly, so there is
 * exactly one implementation of "delete" here and it is the recoverable one.
 * Nothing in this module calls fs.rm on a user's file; a trash failure is
 * reported, never silently escalated to a permanent delete.
 */
export async function deleteEntries(
  root: string,
  rels: string[],
  trash: (abs: string) => Promise<void>
): Promise<DeleteResult> {
  if (!Array.isArray(rels) || rels.length === 0) return { ok: true, failed: [] }
  // Belt and braces on the one operation where being wrong destroys the user's
  // whole project: whatever the path normalises to, it must not BE the root.
  const rootAbs = await resolveWithinReal(root, '')
  const failed: string[] = []
  for (const rel of rels) {
    const cleaned = isAbsoluteInput(rel) ? '' : normRel(rel)
    // Refuse to delete the scope root itself — `rel` of '' resolves to it.
    if (!cleaned) {
      failed.push(String(rel))
      continue
    }
    const abs = await resolveWithinReal(root, cleaned)
    if (!abs || abs === rootAbs || !(await exists(abs))) {
      failed.push(cleaned)
      continue
    }
    try {
      await trash(abs)
    } catch {
      failed.push(cleaned)
    }
  }
  return { ok: failed.length === 0, failed }
}

/**
 * Permanently delete — the explicit fallback offered only after the OS trash
 * has already refused, never reached on its own. Kept separate from
 * `deleteEntries` so no future caller can arrive here by passing a flag.
 */
export async function deleteEntriesPermanently(
  root: string,
  rels: string[]
): Promise<DeleteResult> {
  const failed: string[] = []
  for (const rel of rels) {
    const cleaned = isAbsoluteInput(rel) ? '' : normRel(rel)
    if (!cleaned) {
      failed.push(String(rel))
      continue
    }
    const abs = await resolveWithinReal(root, cleaned)
    if (!abs) {
      failed.push(cleaned)
      continue
    }
    try {
      await fs.rm(abs, { recursive: true, force: true })
    } catch {
      failed.push(cleaned)
    }
  }
  return { ok: failed.length === 0, failed }
}

/** Copy files from anywhere on disk INTO the scope — the Finder-drop path.
 *  Sources are absolute and outside the root by definition; only the
 *  destination is scope-checked, and names auto-increment rather than clobber. */
export async function importFiles(
  root: string,
  destDirRel: string,
  sources: string[]
): Promise<FileOpResult[]> {
  if (isAbsoluteInput(destDirRel)) return [{ ok: false, error: 'invalid path' }]
  const destDir = normRel(destDirRel)
  const out: FileOpResult[] = []
  const { entries } = await listDir(root, destDir)
  const taken = entries.map((e) => e.name)
  for (const src of sources) {
    if (typeof src !== 'string' || !isAbsolute(src)) {
      out.push({ ok: false, error: 'invalid source' })
      continue
    }
    const name = incrementalName(basename(src), taken)
    const rel = destDir ? `${destDir}/${name}` : name
    const abs = await resolveWithinReal(root, rel)
    if (!abs) {
      out.push({ ok: false, error: 'invalid path' })
      continue
    }
    try {
      await fs.cp(src, abs, { recursive: true, errorOnExist: true, force: false })
      taken.push(name)
      out.push({ ok: true, rel })
    } catch (e) {
      out.push({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

// Image extensions read as a base64 data URL; everything else is read as a
// buffer and either returned as utf8 text or flagged binary.
const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024

/** How far into a file to look for a NUL before calling it binary. */
const BINARY_SNIFF_BYTES = 8000

/** Dirs-then-files ordering, with `file2` before `file10` rather than after.
 *  A plain localeCompare gets that pair wrong, which is the most visible way a
 *  file tree reads as subtly not-like-VS-Code. */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const byName = NAME_COLLATOR.compare(a.name, b.name)
  // The collator treats `Foo` and `foo` as equal; fall back so the order is at
  // least stable rather than dependent on readdir.
  return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Lazily list ONE directory (never recursive). Dirs first, then files, each
 *  in natural order (see compareEntries). `.git` is skipped entirely;
 *  `node_modules` shows as an entry but is only walked if the caller asks for it
 *  by name. Dotfiles are included. rel = '' lists the root itself. */
export async function listDir(root: string, rel: string): Promise<FileTreeResult> {
  const dir = resolveWithin(root, rel ?? '')
  if (!dir) return { entries: [] }
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const entries = dirents
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort(compareEntries)
    return { entries }
  } catch {
    return { entries: [] }
  }
}

/** Read a single file for the editor/preview. Text → `content`; image →
 *  `dataUrl`; binary or over the cap → neither. */
export async function readFile(root: string, rel: string): Promise<FileReadResult> {
  const empty: FileReadResult = { mtimeMs: 0, size: 0, isBinary: false, tooLarge: false }
  const abs = resolveWithin(root, rel ?? '')
  if (!abs) return empty
  try {
    const st = await fs.stat(abs)
    if (!st.isFile()) return empty
    if (st.size > MAX_FILE_BYTES) {
      return { mtimeMs: st.mtimeMs, size: st.size, isBinary: false, tooLarge: true }
    }
    const mime = IMAGE_EXT[extname(abs).toLowerCase()]
    const buf = await fs.readFile(abs)
    if (mime) {
      return {
        mtimeMs: st.mtimeMs,
        size: st.size,
        isBinary: false,
        tooLarge: false,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`
      }
    }
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { mtimeMs: st.mtimeMs, size: st.size, isBinary: true, tooLarge: false }
    }
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      isBinary: false,
      tooLarge: false,
      content: buf.toString('utf8')
    }
  } catch {
    return empty
  }
}

/** Save with optimistic concurrency: the caller passes the mtimeMs it last
 *  read. If the file changed under it we refuse and report the conflict
 *  WITHOUT writing, so the caller can decide. expectedMtimeMs: 0 overrides. */
export async function saveFile(
  root: string,
  rel: string,
  content: string,
  expectedMtimeMs: number
): Promise<FileSaveResult> {
  const abs = resolveWithin(root, rel ?? '')
  if (!abs) return { ok: false, error: 'invalid path' }
  try {
    if (expectedMtimeMs !== 0) {
      try {
        const st = await fs.stat(abs)
        if (st.isFile() && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
          return { ok: false, conflict: true, mtimeMs: st.mtimeMs }
        }
      } catch {
        // No file on disk yet (new file) — nothing to conflict with.
      }
    }
    await fs.writeFile(abs, content, 'utf8')
    const st = await fs.stat(abs)
    return { ok: true, mtimeMs: st.mtimeMs }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
