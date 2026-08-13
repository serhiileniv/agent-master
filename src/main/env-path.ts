import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * macOS/Linux GUI apps inherit launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
 * and never source the user's rc files. Homebrew, nvm/fnm/volta shims, ~/.local/bin
 * and ~/.claude/local are all invisible, so agent CLIs look "not installed" when
 * Agent Master is opened from Finder/Dock but work fine when opened from a terminal.
 *
 * We recover the real PATH by asking the login shell for it, then union in the
 * well-known install dirs as a backstop for when that fails or times out.
 *
 * ---
 *
 * Asking the login shell means booting the user's WHOLE rc chain (oh-my-zsh, nvm,
 * pyenv, conda…). That is routinely 1-3 seconds on a working Mac, and it used to
 * run synchronously, on the main thread, before the BrowserWindow was even
 * constructed — so every launch opened with that long as a blank screen.
 *
 * Two changes take it off the critical path:
 *
 *  - The harvest is async. prime() returns immediately having applied the best
 *    PATH it can produce without spawning anything (inherited + the well-known
 *    dirs that exist), and the shell answer refines it when it lands.
 *  - The answer is remembered on disk between launches. It essentially never
 *    changes, so every launch after the first starts with the REAL PATH already
 *    in hand and nothing waits at all — the refresh still runs, but only to
 *    catch a machine that has genuinely changed since.
 */

const SENTINEL = '__AGENTMASTER_PATH__'

/** Well-known agent-CLI install dirs, used when the shell harvest comes up short. */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin', // Homebrew on Apple Silicon
    '/opt/homebrew/sbin',
    '/usr/local/bin', // Homebrew on Intel, and most installer scripts
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.claude', 'local'), // Claude Code's own local installer
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.volta', 'bin'),
    '/usr/local/opt/node/bin'
  ]
}

/**
 * Ask the user's login shell what PATH it sets. Runs interactively (-i) because
 * zsh users overwhelmingly put PATH in .zshrc, which a non-interactive login
 * shell would skip. The sentinel lets us ignore anything the rc files print.
 *
 * Async: this is the slow part, and nothing on screen may wait for it.
 */
function harvestFromLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL
  if (!shell || !existsSync(shell)) return Promise.resolve(null)

  // fish doesn't accept a bundled -ilc; it also has no need for -i to see PATH.
  const isFish = shell.endsWith('/fish')
  const args = isFish ? ['-l', '-c', `echo ${SENTINEL}$PATH`] : ['-ilc', `echo ${SENTINEL}"$PATH"`]

  return new Promise((resolve) => {
    execFile(
      shell,
      args,
      {
        encoding: 'utf8',
        timeout: 3000,
        // A shell that decides it's interactive can block forever on stdin.
        // execFile has no stdio option, so close stdin explicitly below.
        maxBuffer: 1024 * 1024
      },
      (err, stdout) => {
        // Timed out, shell missing, rc file exited non-zero — fall back silently.
        // A non-zero exit can still have printed the sentinel first, so parse
        // stdout either way rather than bailing on `err` alone.
        const out = stdout || ''
        const line = out.split('\n').find((l) => l.includes(SENTINEL))
        if (!line) return resolve(null)
        const path = line.slice(line.indexOf(SENTINEL) + SENTINEL.length).trim()
        resolve(path || null)
      }
    ).stdin?.end()
  })
}

/**
 * Union the three PATH sources into one, preserving precedence and dropping
 * duplicates/empties. Pure and separated from the shell + filesystem probing
 * above so it can be tested on any platform.
 */
export function mergePath(shellPath: string | null, envPath: string, fallbacks: string[]): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  const add = (dir: string): void => {
    // Trailing slashes would otherwise let /usr/bin and /usr/bin/ both survive.
    const d = dir.trim().replace(/\/+$/, '')
    if (!d || seen.has(d)) return
    seen.add(d)
    dirs.push(d)
  }

  // Order matters: shell entries first, so a user's own PATH ordering decides
  // which of two installed copies of a binary wins. Fallbacks are last resort.
  for (const d of (shellPath || '').split(':')) add(d)
  for (const d of envPath.split(':')) add(d)
  for (const d of fallbacks) add(d)

  return dirs.join(':')
}

/** The remembered shell answer. Keyed by $SHELL so switching zsh→fish re-harvests
 *  instead of reusing an answer the new shell never gave. */
interface PathNote {
  shell: string
  path: string
}

/**
 * Decide whether a note read off disk may be trusted. Separated out (and
 * exported) because "we silently reused a stale note" is the one way this cache
 * could reintroduce the missing-agents bug it exists to avoid.
 */
export function noteIsUsable(note: unknown, currentShell: string | undefined): note is PathNote {
  if (!note || typeof note !== 'object') return false
  const n = note as Partial<PathNote>
  if (typeof n.path !== 'string' || !n.path.trim()) return false
  if (typeof n.shell !== 'string') return false
  // A different login shell than the one that produced this answer means the
  // answer is about someone else's environment.
  return n.shell === (currentShell ?? '')
}

/** PATH as inherited from launchd/the parent, snapshotted before we mutate it. */
let inheritedPath = ''
/** Best PATH known right now. Null until primed (or lazily computed below). */
let cached: string | null = null
/** Where the harvested answer is remembered. Null = don't persist (tests/smokes). */
let noteFile: string | null = null
/** Resolves once the PATH is as good as it is going to get for this launch. */
let readyPromise: Promise<void> | null = null

/** Inherited + well-known dirs, with no subprocess. Instant, and enough on its
 *  own for a Homebrew/`~/.local/bin` install — the shell harvest only adds the
 *  exotic cases (nvm shims, custom prefixes). */
function fastPath(shellPath: string | null): string {
  return mergePath(
    shellPath,
    inheritedPath,
    fallbackDirs().filter((d) => existsSync(d))
  )
}

function apply(next: string): void {
  cached = next
  process.env.PATH = next
}

function readNote(): PathNote | null {
  if (!noteFile) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(noteFile, 'utf8'))
    return noteIsUsable(parsed, process.env.SHELL) ? parsed : null
  } catch {
    return null // absent on first run, or unreadable/corrupt — just re-harvest
  }
}

function writeNote(path: string): void {
  if (!noteFile) return
  try {
    writeFileSync(noteFile, JSON.stringify({ shell: process.env.SHELL ?? '', path }), 'utf8')
  } catch {
    /* a read-only or full userData dir must not break launch — we just re-harvest
       next time, which is exactly the pre-cache behaviour */
  }
}

/**
 * Start PATH resolution WITHOUT blocking. Call once, as early as possible in
 * app startup; `noteFilePath` is where the harvested answer is remembered
 * between launches (omit to disable persistence).
 *
 * Returns immediately, having already applied the best PATH available without
 * spawning anything. Await `whenPathReady()` before answering a question whose
 * answer depends on the full PATH (which shells/agent CLIs are installed).
 */
export function primeResolvedPath(noteFilePath?: string): void {
  if (readyPromise) return // already primed; a second call must not re-harvest
  inheritedPath = process.env.PATH || ''

  if (process.platform === 'win32') {
    // Windows GUI apps inherit the real PATH; there is nothing to recover.
    cached = inheritedPath
    readyPromise = Promise.resolve()
    return
  }

  noteFile = noteFilePath ?? null
  const note = readNote()
  // Whatever we know right now goes in immediately, so any child spawned before
  // the harvest lands still gets a usable PATH.
  apply(fastPath(note?.path ?? null))

  const harvest = harvestFromLoginShell().then((shellPath) => {
    if (shellPath) {
      apply(fastPath(shellPath))
      writeNote(shellPath)
    }
  })

  // With a usable note we are ALREADY correct — callers must not wait on the
  // refresh. Without one, the harvest is the only thing that can find an nvm or
  // custom-prefix install, so the first launch does wait for it.
  readyPromise = note ? Promise.resolve() : harvest
}

/**
 * Resolves when PATH is good enough to answer "what is installed on this
 * machine". Immediate on every launch after the first.
 */
export function whenPathReady(): Promise<void> {
  return readyPromise ?? Promise.resolve()
}

/**
 * The PATH agent detection and PTY spawns should use, as currently known.
 *
 * Never blocks. If prime() has not run (the integration smokes register the IPC
 * handlers directly, without index.ts), this falls back to the no-subprocess
 * path so callers still get Homebrew et al. rather than launchd's four dirs.
 */
export function resolvedPath(): string {
  if (cached !== null) return cached
  if (process.platform === 'win32') {
    cached = process.env.PATH || ''
    return cached
  }
  inheritedPath = inheritedPath || process.env.PATH || ''
  cached = fastPath(null)
  return cached
}

/** Test seam: forget everything primed so far. Not used by the app. */
export function __resetPathForTests(): void {
  cached = null
  noteFile = null
  readyPromise = null
  inheritedPath = ''
}
