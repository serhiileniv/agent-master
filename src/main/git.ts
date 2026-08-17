import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname, basename } from 'path'
import { existsSync, promises as fsp } from 'fs'

const pexec = promisify(execFile)

/**
 * How a git command actually gets run. Every git process this module starts
 * goes through one of these — there is no second path.
 *
 * Resolves with stdout; REJECTS on a non-zero exit, carrying git's stderr on
 * the error. The distinction is load-bearing: `orphanHasWork` reads a rejection
 * from `merge-base --is-ancestor` as "this branch has unmerged commits", and
 * several callers treat a rejection as "fail safe, keep the worktree".
 */
export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { maxBuffer?: number }
) => Promise<string>

const execFileRunner: GitRunner = async (cwd, args, opts) => {
  const { stdout } = await pexec('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024
  })
  return stdout
}

let runner: GitRunner = execFileRunner

/**
 * Swap the git runner, returning a function that puts the previous one back.
 *
 * This is the seam. The app never calls it — production always runs on
 * `execFileRunner`. It exists so the destructive paths here (applyAgentFiles
 * and its rollback, orphan removal, merge conflict handling) can be driven
 * against a scripted adapter in unit tests instead of needing a real repo and
 * a real Electron launch, which is why they went untested for so long.
 */
export function setGitRunner(next: GitRunner): () => void {
  const prev = runner
  runner = next
  return () => {
    runner = prev
  }
}

function git(cwd: string, args: string[], opts?: { maxBuffer?: number }): Promise<string> {
  return runner(cwd, args, opts)
}

export interface GitInfo {
  isGit: boolean
  repoRoot: string | null
  branch: string | null
}

/**
 * Which repo (if any) a directory belongs to.
 *
 * Cached, and it matters more than it looks. Nearly everything here starts by
 * asking this — every worktree create/remove, every prune, every orphan scan,
 * every diff and merge — and on launch that is once per workspace AND once per
 * agent, all at the same time. Uncached, restoring a few workspaces of agents
 * fired ~100 git processes in the first seconds of startup, which on macOS is a
 * large part of the launch spike.
 *
 * A directory's repo root does not change while the app is open. The one thing
 * that CAN change it is `git init` on a folder that wasn't a repo — which is why
 * initRepo() clears this. The TTL is belt-and-braces for the exotic rest
 * (someone deletes .git under us); a wrong answer there fails loudly in the git
 * command that follows rather than silently mis-isolating an agent.
 */
const REPO_ROOT_TTL_MS = 5 * 60_000
const repoRootCache = new Map<string, { at: number; root: string | null }>()

/** Cache key: same directory spelled two ways must not be two entries. */
function dirKey(dir: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? d.toLowerCase() : d
}

/** Forget cached repo roots. Called after `git init`, which is the one operation
 *  that turns a cached "not a repo" into a wrong answer — and a wrong answer
 *  there means agents silently keep sharing the folder instead of isolating. */
export function invalidateRepoRootCache(): void {
  repoRootCache.clear()
}

/**
 * The repo root for a directory, or null if it isn't in a work tree.
 *
 * ONE git process, not three: callers here only ever wanted the root, but this
 * used to go through getGitInfo and throw away the `--is-inside-work-tree` and
 * branch lookups it paid for. `--show-toplevel` already fails outside a work
 * tree (including in a bare repo or inside .git/), so it answers both questions.
 */
export async function getRepoRootSafe(dir: string): Promise<string | null> {
  const key = dirKey(dir)
  const hit = repoRootCache.get(key)
  if (hit && Date.now() - hit.at < REPO_ROOT_TTL_MS) return hit.root
  let root: string | null = null
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    root = null // not a git work tree
  }
  repoRootCache.set(key, { at: Date.now(), root })
  return root
}

/**
 * Repo root + current branch.
 *
 * The branch is deliberately NOT cached: it changes under us whenever the user
 * checks something out, and the project bar shows it. Only the root — the
 * expensive, stable half — comes from the cache, so a warm call is a single
 * `rev-parse --abbrev-ref HEAD` instead of three round trips.
 */
export async function getGitInfo(dir: string): Promise<GitInfo> {
  const repoRoot = await getRepoRootSafe(dir)
  if (!repoRoot) return { isGit: false, repoRoot: null, branch: null }
  let branch: string | null = null
  try {
    branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || null
  } catch {
    /* repo with no commits yet */
  }
  return { isGit: true, repoRoot, branch }
}

export interface InitResult {
  ok: boolean
  error?: string
}

/** `git init` and nothing else — no add, no commit. Auto-committing a user's
 *  folder (possibly a node_modules jungle with no .gitignore yet) is not ours
 *  to do; the UI tells them to commit when they're ready. */
export async function initRepo(dir: string): Promise<InitResult> {
  try {
    await git(dir, ['init'])
    // This folder (and anything under it) just became a repo. A cached "not a
    // repo" here would keep every agent in it sharing the folder while the UI
    // says isolation is available — clear the lot rather than reason about which
    // entries are now stale.
    invalidateRepoRootCache()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: friendlyGitError(e) }
  }
}

// 12 chars of the (already-unique) agent UUID — long enough that two agents in a
// session can't collide onto the same branch/worktree, short enough to stay readable.
function shortId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
}

/** Sibling folder holding this repo's agent worktrees. */
const WORKTREE_DIR = '.agentmaster-worktrees'
/**
 * Where they lived under earlier names of the app, newest first. Still found,
 * still adopted, still cleaned — and never treated as an orphan while an agent
 * owns it. Git registers worktrees by absolute path inside the user's `.git`,
 * so a pre-rename checkout does not move just because the constant above
 * changed: an agent restored after a rename must be handed the folder it is
 * already in, or `worktree add` fails on a branch that is already checked out
 * and the agent's work is stranded.
 *
 * This is a list, not a single name, because the app has now been renamed twice
 * over the lifetime of this container — a user can hold worktrees from either
 * era. Every rename appends here; nothing is ever removed.
 */
const LEGACY_WORKTREE_DIRS = ['.spymaster-worktrees', '.monad-worktrees']

/** Every place an agent worktree for this repo may legitimately live, current
 *  first. The destructive paths whitelist exactly these and nothing else. */
export function worktreeContainers(repoRoot: string): string[] {
  const parent = dirname(repoRoot)
  return [WORKTREE_DIR, ...LEGACY_WORKTREE_DIRS].map((d) => join(parent, d))
}

/** Deterministic worktree location/branch for an agent, kept OUTSIDE the repo
 *  (sibling folder) so the agent never sees nested worktrees as untracked. */
export function worktreeInfo(
  repoRoot: string,
  agentId: string
): { path: string; branch: string; container: string; legacyPaths: string[] } {
  const short = shortId(agentId)
  const [container, ...legacyContainers] = worktreeContainers(repoRoot)
  const leaf = `${basename(repoRoot)}-${short}`
  return {
    container,
    path: join(container, leaf),
    legacyPaths: legacyContainers.map((c) => join(c, leaf)),
    branch: `canvas/${short}`
  }
}

/**
 * The worktree an agent ACTUALLY occupies. New agents get the current
 * container; ones created under an earlier name are adopted where they stand.
 * Every consumer — diff, merge, apply, remove — must ask rather than assume, or
 * it silently operates on a path that does not exist.
 */
export function agentWorktreePath(repoRoot: string, agentId: string): string {
  const { path, legacyPaths } = worktreeInfo(repoRoot, agentId)
  if (existsSync(path)) return path
  return legacyPaths.find((p) => existsSync(p)) ?? path
}

export interface WorktreeResult {
  path: string
  branch: string
  created: boolean
}

/** True only if `path` is a worktree git itself has registered for this repo.
 *  A bare existsSync() isn't enough: a leftover directory from a partial removal
 *  (or a user-deleted .git file) would be reused as-is and the agent would run
 *  in a plain folder while the UI reported `isolated: true` — every later diff
 *  and merge against it then fails or targets the wrong tree. */
async function isRegisteredWorktree(repoRoot: string, path: string): Promise<boolean> {
  try {
    const out = await git(repoRoot, ['worktree', 'list', '--porcelain'])
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(path)
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => norm(l.slice('worktree '.length).trim()) === target)
  } catch {
    return false
  }
}

/** Serializes worktree creation per repo. Every pane's mount effect calls this
 *  in parallel on restore, and concurrent `git worktree add` against one repo
 *  contends for .git/index.lock. The loser used to throw, get swallowed into
 *  `isolated: false`, and leave the agent writing to the user's REAL working
 *  tree while the UI still claimed isolation. */
const worktreeLocks = new Map<string, Promise<unknown>>()

function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = repoRoot.replace(/\\/g, '/').toLowerCase()
  const prev = worktreeLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Keep the chain alive on failure, and drop the entry once it's the tail so
  // the map doesn't grow for the life of the process.
  worktreeLocks.set(
    key,
    next.catch(() => undefined)
  )
  void next.catch(() => undefined).then(() => {
    if (worktreeLocks.get(key) === next) worktreeLocks.delete(key)
  })
  return next
}

/** Create (or reuse) a git worktree + branch for an agent. Branches off the
 *  repo's current HEAD. Throws if the repo has no commits yet. */
export async function createWorktree(repoRoot: string, agentId: string): Promise<WorktreeResult> {
  const { path, legacyPaths, branch } = worktreeInfo(repoRoot, agentId)
  return withRepoLock(repoRoot, async () => {
    // Pre-rename agent: its checkout is registered under one of the legacy
    // containers. Adopt it in place — relocating would need git surgery, and
    // adding a second worktree on the same branch simply fails, stranding the
    // agent's work.
    for (const legacyPath of legacyPaths) {
      if (existsSync(legacyPath) && (await isRegisteredWorktree(repoRoot, legacyPath))) {
        return { path: legacyPath, branch, created: false }
      }
    }
    if (existsSync(path)) {
      if (await isRegisteredWorktree(repoRoot, path)) return { path, branch, created: false }
      // Stale directory squatting on the path — clear git's view of it and let
      // the add below recreate it properly.
      await git(repoRoot, ['worktree', 'prune']).catch(() => undefined)
      await fsp.rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
    try {
      await git(repoRoot, ['worktree', 'add', path, '-b', branch])
    } catch {
      // Branch already exists from a previous session — attach to it.
      await git(repoRoot, ['worktree', 'add', path, branch])
    }
    return { path, branch, created: true }
  })
}

export async function removeWorktree(repoRoot: string, agentId: string): Promise<void> {
  const { path, legacyPaths, branch } = worktreeInfo(repoRoot, agentId)
  // Same lock as createWorktree — a remove landing between another agent's
  // `worktree add` and its metadata write would corrupt git's worktree list.
  await withRepoLock(repoRoot, async () => {
    // Every location: the agent may have been adopted from a legacy container.
    for (const p of [path, ...legacyPaths]) {
      try {
        await git(repoRoot, ['worktree', 'remove', '--force', p])
      } catch {
        /* not registered / already gone */
      }
    }
    try {
      await git(repoRoot, ['branch', '-D', branch])
    } catch {
      /* branch already deleted */
    }
    try {
      await git(repoRoot, ['worktree', 'prune'])
    } catch {
      /* ignore */
    }
  })
}

export async function listWorktrees(repoRoot: string): Promise<string[]> {
  try {
    const out = await git(repoRoot, ['worktree', 'list', '--porcelain'])
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
  } catch {
    return []
  }
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  try {
    await git(repoRoot, ['worktree', 'prune'])
  } catch {
    /* ignore */
  }
}

export interface OrphanWorktree {
  path: string
  /** Short branch name (refs/heads/ stripped); null for a detached worktree. */
  branch: string | null
  /** True when deleting this worktree could lose work: its branch isn't fully
   *  merged into the repo's current HEAD, its working tree is dirty, or we
   *  couldn't tell (fail-safe). Cleanup must never remove these. */
  hasWork: boolean
}

/** Case-fold + slash-normalize for path identity checks — git prints forward
 *  slashes even on Windows, while worktreeInfo builds native paths. */
function normPath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/**
 * Worktrees left behind by crashed / force-quit sessions. `worktree prune` at
 * project open can't help — these are still registered, with live folders and
 * branches. Detection is deliberately narrow: only entries inside THIS repo's
 * worktree containers that follow this repo's `<repoName>-<short>`
 * naming, minus the ones owned by current agents (derived via the exact same
 * worktreeInfo the app creates worktrees with, so a live agent can never match).
 */
export async function findOrphanWorktrees(
  repoRoot: string,
  ownedAgentIds: string[]
): Promise<OrphanWorktree[]> {
  let out = ''
  try {
    out = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }
  // Porcelain blocks: `worktree <path>` then `HEAD …` / `branch refs/heads/…`
  // (or `detached`) lines. Take the branch from here — the folder name only
  // encodes the short id, not what's actually checked out.
  const entries: Array<{ path: string; branch: string | null }> = []
  let cur: { path: string; branch: string | null } | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur)
      cur = { path: line.slice('worktree '.length).trim(), branch: null }
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  if (cur) entries.push(cur)

  // container/naming don't depend on the agent id — any id yields them. Every
  // container is scanned: leftovers from before a rename are still orphans and
  // still worth cleaning.
  const containers = worktreeContainers(repoRoot).map((c) => normPath(c) + '/')
  const namePrefix = normPath(`${basename(repoRoot)}-`)
  // An owned agent may sit in ANY container (adopted ones stay in the legacy
  // one they were created under), so all of its candidate paths are excluded.
  // Miss this and a live agent's worktree reads as a leftover and becomes
  // eligible for deletion.
  const owned = new Set(
    ownedAgentIds.flatMap((id) => {
      const i = worktreeInfo(repoRoot, id)
      return [normPath(i.path), ...i.legacyPaths.map(normPath)]
    })
  )
  const candidates = entries.filter((e) => {
    const n = normPath(e.path)
    const container = containers.find((c) => n.startsWith(c))
    if (!container) return false
    const name = n.slice(container.length)
    // Direct child of the container, named for THIS repo, ending in a shortId-
    // shaped suffix — another repo's worktrees share the container, skip them.
    if (name.includes('/')) return false
    if (!name.startsWith(namePrefix)) return false
    if (!/^[a-z0-9]+$/i.test(name.slice(namePrefix.length))) return false
    return !owned.has(n)
  })

  // "Not owned by this canvas" is NOT the same as "safe to delete": worktrees
  // the user chose to KEEP on close, and live agent worktrees of the SAME repo
  // opened as a different project, both land here. Flag whether removal would
  // lose anything so cleanup can spare them.
  //
  // Residual edge we can't disambiguate: with the same repo open as two
  // projects, a just-merged, clean, still-live agent worktree of the OTHER
  // window looks identical to a leftover. hasWork is what keeps the destructive
  // path safe regardless — anything with unmerged commits or uncommitted edits
  // is flagged and never auto-removed; removing a merged+clean one loses no
  // work (worst case, the other window's terminal finds its folder gone).
  const result: OrphanWorktree[] = []
  for (const e of candidates) {
    result.push({ ...e, hasWork: await orphanHasWork(repoRoot, e) })
  }
  return result
}

/** Would deleting this worktree (+ `branch -D`) lose anything? Every failure
 *  answers "yes" — when in doubt, keep it. */
async function orphanHasWork(
  repoRoot: string,
  o: { path: string; branch: string | null }
): Promise<boolean> {
  // Unmerged branch ⇒ `branch -D` would drop commits. `merge-base --is-ancestor`
  // exits non-zero (throws here) both when the branch isn't merged into the
  // repo's current HEAD and when the ref can't be resolved — treat either as
  // work. A detached worktree has no branch to test — fail-safe to hasWork.
  if (!o.branch) return true
  try {
    await git(repoRoot, ['merge-base', '--is-ancestor', o.branch, 'HEAD'])
  } catch {
    return true
  }
  // Dirty working tree ⇒ `worktree remove --force` would drop uncommitted
  // edits. If status itself fails (folder unreadable?), assume dirty.
  try {
    const status = await git(o.path, ['status', '--porcelain'])
    return status.trim() !== ''
  } catch {
    return true
  }
}

/** Remove orphans found by findOrphanWorktrees: worktree + its canvas branch,
 *  each best-effort, then one prune for any leftover registrations. Returns how
 *  many orphans were actually cleaned (at least one of the two steps worked). */
export async function removeOrphanWorktrees(
  repoRoot: string,
  orphans: OrphanWorktree[]
): Promise<number> {
  // Containment re-check stays even though the list is produced in-process now
  // (cleanOrphanWorktrees) — this must never remove a path outside the repo's
  // worktree containers, no matter who calls it. The whitelist is exactly the
  // known containers; it never widens to "any path".
  const containers = worktreeContainers(repoRoot).map((c) => normPath(c) + '/')
  const contained = (p: string): boolean => containers.some((c) => normPath(p).startsWith(c))
  let removed = 0
  for (const o of orphans) {
    // hasWork orphans are filtered HERE, not just by callers: no caller mistake
    // (or stale/forged flag from a future refactor) may reach the destructive
    // path for a worktree whose removal could lose work.
    if (!o?.path || o.hasWork || !contained(o.path)) continue
    let ok = false
    try {
      await git(repoRoot, ['worktree', 'remove', '--force', o.path])
      ok = true
    } catch {
      /* folder already gone / not registered — the branch delete below still counts */
    }
    if (o.branch && o.branch.startsWith('canvas/')) {
      try {
        await git(repoRoot, ['branch', '-D', o.branch])
        ok = true
      } catch {
        /* branch already deleted */
      }
    }
    if (ok) removed++
  }
  try {
    await git(repoRoot, ['worktree', 'prune'])
  } catch {
    /* ignore */
  }
  return removed
}

/** One-shot list→filter→remove for the renderer's cleanup action. Detection and
 *  removal happen inside a single main-process call, so no path list ever
 *  round-trips through the renderer (nothing untrusted to re-validate, and no
 *  window between listing and removing for the set to go stale in). */
export async function cleanOrphanWorktrees(
  repoRoot: string,
  ownedAgentIds: string[]
): Promise<{ removed: number; keptWithWork: number }> {
  const orphans = await findOrphanWorktrees(repoRoot, ownedAgentIds)
  const keptWithWork = orphans.filter((o) => o.hasWork).length
  const removed = await removeOrphanWorktrees(repoRoot, orphans)
  return { removed, keptWithWork }
}

/**
 * Repo-relative paths with uncommitted work — modified, staged, or untracked.
 *
 * The file panel deletes into the user's real project, and this is the one
 * question worth asking before it does: a committed file is recoverable from
 * both git and the Trash, while a file with uncommitted changes has only the
 * Trash. That distinction is worth naming in the confirmation rather than
 * leaving the user to find out.
 *
 * Fails open — an empty set on any error — because the warning is an extra, and
 * a broken git call must never be able to block a delete.
 */
export async function getDirtyPaths(dir: string): Promise<Set<string>> {
  try {
    const out = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all'], {
      maxBuffer: 8 * 1024 * 1024
    })
    const dirty = new Set<string>()
    // -z is NUL-separated with no quoting; a rename record is followed by its
    // second path as its own NUL-terminated field.
    const fields = out.split('\0').filter(Boolean)
    for (let i = 0; i < fields.length; i++) {
      const rec = fields[i]
      if (rec.length < 4) continue
      const status = rec.slice(0, 2)
      dirty.add(rec.slice(3))
      // R/C carry the origin path in the NEXT field — consume it too.
      if (status[0] === 'R' || status[0] === 'C') {
        i++
        if (fields[i]) dirty.add(fields[i])
      }
    }
    return dirty
  } catch {
    return new Set()
  }
}

export interface DiffResult {
  branch: string
  base: string | null
  diff: string
  untracked: string[]
  hasChanges: boolean
  /** Set when the diff couldn't be produced (e.g. too large to buffer), so the
   *  UI can say so instead of silently showing "No changes". */
  error?: string
}

/** Git's porcelain output wraps paths containing spaces/quotes/non-ASCII in
 *  double quotes with C-style escapes (\", \\, \t, \303\251 …). Decode them —
 *  octal escapes are UTF-8 bytes, so collect bytes and decode once at the end. */
/** Exported for unit tests. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
  const inner = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b)
      continue
    }
    const n = inner[++i]
    if (n === undefined) break // malformed (trailing backslash) — stop cleanly
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(inner.slice(i, i + 3), 8))
      i += 2
    } else {
      const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }
      for (const b of Buffer.from(esc[n] ?? n, 'utf8')) bytes.push(b)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// Untracked-file rendering caps: big enough for any hand-reviewable file, small
// enough that a stray node_modules/build artifact can't balloon the IPC payload.
const UNTRACKED_FILE_CAP = 400 * 1024
const UNTRACKED_TOTAL_CAP = 4 * 1024 * 1024

/** Untracked files never appear in `git diff`, so the review used to show them
 *  as bare names. Synthesize a real "new file" section per file so the panel
 *  renders (and counts) them exactly like tracked additions. */
async function synthesizeUntrackedDiff(worktree: string, files: string[]): Promise<string> {
  let out = ''
  let total = 0
  for (const rel of files) {
    // Emit the path unquoted even if it has spaces — the renderer's parser reads
    // everything after " b/" as the path, which is exactly what we want here.
    const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`
    // A path we can't render must still be VISIBLE: mergeAgent's `git add -A`
    // will commit it regardless, so silently dropping it here would land
    // unreviewed content on the base branch. Same shape as the binary
    // placeholder, so it renders as a normal "A" entry and takes part in
    // per-file selection.
    const unreadable =
      header +
      `Unreadable or non-regular file (symlink?) — contents not shown; it WILL be included in a merge\n`
    try {
      const abs = join(worktree, rel)
      const stat = await fsp.lstat(abs)
      if (!stat.isFile()) {
        out += unreadable
        continue
      }
      if (stat.size > UNTRACKED_FILE_CAP || total + stat.size > UNTRACKED_TOTAL_CAP) {
        out += header + `(file too large to display — ${Math.ceil(stat.size / 1024)} KB)\n`
        continue
      }
      const buf = await fsp.readFile(abs)
      total += buf.length
      // Binary sniff: a NUL in the first 8KB (same heuristic git uses).
      if (buf.subarray(0, 8192).includes(0)) {
        out += header + `Binary file ${rel} added\n`
        continue
      }
      // Split on \n only so a CRLF file keeps its \r with each line — rendering
      // is unaffected and the content isn't silently rewritten.
      const lines = buf.toString('utf8').split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      if (lines.length === 0) {
        out += header // empty file: header alone still renders an "A" entry
        continue
      }
      out += header + `@@ -0,0 +1,${lines.length} @@\n`
      for (const l of lines) out += '+' + l + '\n'
    } catch {
      // Vanished mid-read or unreadable (permissions) — never fail the diff,
      // but never hide the entry either (see `unreadable` above).
      out += unreadable
    }
  }
  return out
}

/** An agent's changes (committed + uncommitted in its worktree) vs the base branch. */
export async function getAgentDiff(
  repoRoot: string,
  agentId: string,
  baseBranch: string | null
): Promise<DiffResult> {
  const { branch } = worktreeInfo(repoRoot, agentId)
  // Resolved, not assumed: a pre-rename agent is adopted in the legacy container.
  const path = agentWorktreePath(repoRoot, agentId)
  let diff = ''
  let error: string | undefined
  let untracked: string[] = []
  try {
    const args = ['--no-pager', 'diff']
    if (baseBranch) {
      // Diff from where this branch FORKED (merge-base), not the moving base tip.
      // Plain `git diff <base>` (two-dot) turns any commits the user later adds to
      // base into spurious reverse-deletions — inflating the close/merge change
      // count and making the review unreadable. merge-base..worktree shows only
      // this branch's own work (committed AND uncommitted).
      let from = baseBranch
      try {
        const mb = (await git(path, ['merge-base', baseBranch, 'HEAD'])).trim()
        if (mb) from = mb
      } catch {
        /* no common ancestor (fresh/unborn branch) — fall back to the base ref */
      }
      args.push(from)
    }
    // 64MB — a generous ceiling so normal feature-sized diffs always render;
    // beyond it we surface a clear message rather than a false "No changes".
    diff = await git(path, args, { maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    // Only a buffer overflow is actionable to the user; other failures (base
    // ref missing on a fresh repo, worktree gone) stay quiet and fall through
    // to the untracked-file listing below.
    if (/maxBuffer/i.test(errText(e))) {
      error = 'This change set is too large to display here — review it in your editor or terminal.'
    }
  }
  try {
    // -uall so brand-new directories enumerate their files instead of showing
    // up as a single "dir/" entry we couldn't read a diff for.
    const status = await git(path, ['status', '--porcelain', '-uall'])
    untracked = status
      .split('\n')
      .filter((l) => l.startsWith('??'))
      .map((l) => unquoteGitPath(l.slice(3).trim()))
      .filter(Boolean)
  } catch {
    /* ignore */
  }
  if (untracked.length > 0) {
    diff += await synthesizeUntrackedDiff(path, untracked)
  }
  return {
    branch,
    base: baseBranch,
    diff,
    untracked,
    hasChanges: diff.trim() !== '' || untracked.length > 0,
    error
  }
}

export interface MergeResult {
  ok: boolean
  error?: string
  /** The branch actually merged into — the main worktree's HEAD at merge time. */
  mergedInto?: string
  /** Files that couldn't merge automatically (captured before the abort). */
  conflictFiles?: string[]
}

/** Commit any pending work in the agent's worktree, then merge its branch into
 *  the base branch in the main worktree. Aborts cleanly on conflict. */
export async function mergeAgent(
  repoRoot: string,
  agentId: string,
  message: string
): Promise<MergeResult> {
  const { branch } = worktreeInfo(repoRoot, agentId)
  // Resolved, not assumed: a pre-rename agent is adopted in the legacy container.
  const path = agentWorktreePath(repoRoot, agentId)
  try {
    await git(path, ['add', '-A'])
    const staged = await git(path, ['status', '--porcelain'])
    if (staged.trim() !== '') {
      await git(path, ['commit', '-m', message || `Work from ${branch}`])
    }
  } catch (e) {
    return { ok: false, error: friendlyGitError(e) }
  }
  try {
    // The user's message names the merge commit too — it's the commit they'll
    // actually see on the base branch, so their words belong on it.
    await git(repoRoot, ['merge', '--no-ff', branch, '-m', message || `Merge ${branch}`])
    // Report the branch we actually merged into. `git merge` targets whatever is
    // checked out in the main worktree NOW, which may differ from the base the UI
    // captured at project open (the user could have switched branches since).
    let mergedInto: string | undefined
    try {
      mergedInto = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined
    } catch {
      /* detached HEAD / unusual state — leave undefined */
    }
    return { ok: true, mergedInto }
  } catch (e) {
    // Which files collided — must be read BEFORE the abort wipes the merge state.
    let conflictFiles: string[] | undefined
    try {
      const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U'])
      const files = out.split('\n').map((l) => unquoteGitPath(l.trim())).filter(Boolean)
      if (files.length > 0) conflictFiles = files
    } catch {
      /* best-effort — fall back to the plain error message */
    }
    try {
      await git(repoRoot, ['merge', '--abort'])
    } catch {
      /* nothing to abort */
    }
    return { ok: false, error: friendlyGitError(e), conflictFiles }
  }
}

/** Take the agent's version of SPECIFIC files onto the current branch as a
 *  plain commit — no merge, so the agent's branch stays unmerged and it can
 *  keep working. Deleted files can't come via `checkout <branch> --` (the
 *  branch has no blob for them), so those are `git rm`'d here instead. */
export async function applyAgentFiles(
  repoRoot: string,
  agentId: string,
  paths: string[],
  deletedPaths: string[],
  message: string
): Promise<MergeResult> {
  const { branch } = worktreeInfo(repoRoot, agentId)
  // Resolved, not assumed: a pre-rename agent is adopted in the legacy container.
  const path = agentWorktreePath(repoRoot, agentId)
  const touched = [...paths, ...deletedPaths]
  if (touched.length === 0) return { ok: false, error: 'No files selected.' }
  // `checkout <branch> -- <paths>` (and `git rm`) write straight into the
  // user's main worktree with no safety net of their own — refuse up front if
  // any selected path has uncommitted (staged, unstaged, or untracked) changes
  // there, mirroring `git merge`'s refusal semantics. Checked FIRST so a
  // refused apply changes nothing at all. This also underwrites the rollback
  // below: after this gate, every touched path either matches HEAD or doesn't
  // exist in the main worktree.
  try {
    const dirty = (
      await git(repoRoot, ['status', '--porcelain', '-uall', '--', ...touched])
    )
      .split('\n')
      .filter((l) => l.trim() !== '')
    if (dirty.length > 0) {
      const n = dirty.length
      return {
        ok: false,
        error:
          touched.length === 1
            ? 'You have uncommitted changes to the selected file — commit or stash it first.'
            : `You have uncommitted changes to ${n} of the selected files — commit or stash them first.`
      }
    }
  } catch (e) {
    return { ok: false, error: friendlyGitError(e) }
  }
  // Same first step as mergeAgent: the branch tip must include pending work,
  // or `checkout <branch> -- <file>` would apply a stale version of the file.
  try {
    await git(path, ['add', '-A'])
    const staged = await git(path, ['status', '--porcelain'])
    if (staged.trim() !== '') {
      await git(path, ['commit', '-m', message || `Work from ${branch}`])
    }
  } catch (e) {
    return { ok: false, error: friendlyGitError(e) }
  }
  try {
    if (paths.length > 0) await git(repoRoot, ['checkout', branch, '--', ...paths])
    if (deletedPaths.length > 0)
      await git(repoRoot, ['rm', '-q', '--ignore-unmatch', '--', ...deletedPaths])
    const pending = await git(repoRoot, ['status', '--porcelain', '--', ...touched])
    if (pending.trim() === '') {
      return { ok: false, error: 'The selected files already match the current branch — nothing to apply.' }
    }
    // Pathspec commit: records ONLY the touched paths, so anything the user had
    // staged in the main worktree for their own next commit stays staged.
    await git(repoRoot, ['commit', '-m', message || `Apply files from ${branch}`, '--', ...touched])
    let mergedInto: string | undefined
    try {
      mergedInto = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined
    } catch {
      /* detached HEAD / unusual state — leave undefined */
    }
    return { ok: true, mergedInto }
  } catch (e) {
    // Rollback so a failed apply (e.g. a pre-commit hook rejection) leaves the
    // main worktree exactly as before it started. Must be per-path: one bulk
    // `checkout HEAD -- <touched>` aborts ENTIRELY ("pathspec did not match")
    // as soon as any touched path doesn't exist in HEAD, restoring nothing.
    for (const p of touched) {
      try {
        // Restores index AND working tree from HEAD — covers files our
        // checkout overwrote and files our `git rm` deleted.
        await git(repoRoot, ['checkout', 'HEAD', '--', p])
      } catch {
        // Not in HEAD ⇒ the file was materialized by our checkout from the
        // agent's branch. Unstage it and remove it from disk — the dirty gate
        // above guarantees nothing of the user's lived at this path before.
        try {
          await git(repoRoot, ['reset', '-q', 'HEAD', '--', p])
        } catch {
          /* ignore */
        }
        try {
          await fsp.rm(join(repoRoot, p), { force: true })
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: false, error: friendlyGitError(e) }
  }
}

function errText(e: unknown): string {
  const err = e as { stderr?: string; message?: string } | null | undefined
  const raw = err?.stderr || err?.message
  if (raw) return raw.trim()
  // Nothing readable on it. String() would give "[object Object]" for a plain
  // object and "null" for null, and friendlyGitError surfaces this text
  // verbatim — so say nothing and let it fall back to its own wording. Only a
  // thrown string or number stringifies into something worth showing.
  return typeof e === 'string' || typeof e === 'number' ? String(e).trim() : ''
}

/** Map a raw git failure to a message a non-expert can act on. Falls back to the
 *  first line of git's own output. */
export function friendlyGitError(e: unknown): string {
  // Optional: this runs inside catch blocks, so it has to survive whatever was
  // thrown. A bare `throw null` used to make the error handler itself throw.
  const err = e as { code?: string; stderr?: string; message?: string } | null | undefined
  const raw = errText(e)
  // execFile couldn't find the git binary at all.
  if (err?.code === 'ENOENT' || /\bENOENT\b/.test(raw) || /is not recognized|not found/i.test(raw)) {
    return 'Git isn’t installed or isn’t on your PATH. Install Git, then reopen this project.'
  }
  if (/does not have any commits yet|ambiguous argument 'HEAD'|invalid reference: HEAD|unknown revision/i.test(raw)) {
    return 'This repository has no commits yet — make an initial commit, then add an isolated agent.'
  }
  if (/is already checked out|already used by worktree/i.test(raw)) {
    return 'That branch is already checked out in another worktree.'
  }
  if (/your local changes|would be overwritten|not something we can merge/i.test(raw)) {
    return 'Couldn’t merge cleanly into your working tree — commit or stash your changes first.'
  }
  // Otherwise surface git's own first line, trimmed of the noisy "fatal: " prefix.
  return raw.split('\n')[0].replace(/^fatal:\s*/i, '').trim() || 'Git command failed.'
}
