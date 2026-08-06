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
import { isAbsolute, resolve, sep, extname } from 'path'

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

/** Lazily list ONE directory (never recursive). Dirs first, then files, each
 *  alphabetical case-insensitive. `.git` is skipped entirely; `node_modules`
 *  shows as an entry but is only walked if the caller asks for it by name.
 *  Dotfiles are included. rel = '' lists the root itself. */
export async function listDir(root: string, rel: string): Promise<FileTreeResult> {
  const dir = resolveWithin(root, rel ?? '')
  if (!dir) return { entries: [] }
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const entries = dirents
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      })
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
