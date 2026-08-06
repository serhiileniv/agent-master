/**
 * Memo for "does this path-looking token resolve to a real file?".
 *
 * Agent output is dense with paths, and xterm asks its link provider to re-scan
 * a row every time the pointer enters it. Each candidate on that row used to
 * cost an IPC round-trip and an `fs.stat` in the main process, uncached — so
 * dragging the mouse across a build log restatted the same handful of files
 * over and over, for as long as the mouse kept moving.
 *
 * Two things fix that, and both live here rather than in TerminalPane because
 * `vitest.config.ts` only collects `src/**\/*.test.ts` — logic in a `.tsx` is
 * silently never run.
 *
 *  - **Result cache.** Bounded and time-limited. Positives are stable enough to
 *    hold for a while; negatives expire quickly, because an agent creating the
 *    file a second later must still get a working link.
 *  - **In-flight de-duplication.** The same token appearing twice on a row (or a
 *    row re-scanned before the first answer lands) shares one lookup instead of
 *    racing a second one.
 *
 * Purely an optimisation: every miss falls through to the real check, so the
 * set of links that light up is unchanged.
 */

/** Positives are re-checked this often — a deleted file stops linking. */
export const POSITIVE_TTL_MS = 60_000
/** Negatives expire fast: agents create files constantly while you watch. */
export const NEGATIVE_TTL_MS = 5_000
/** Entry ceiling. A busy log has tens of distinct paths, not hundreds. */
export const MAX_ENTRIES = 500

interface Entry {
  ok: boolean
  /** When this answer stops being trusted. */
  expires: number
}

export interface PathExistsCacheOptions {
  /** The real check — one IPC round-trip per call. */
  lookup: (cwd: string, token: string) => Promise<boolean>
  /** Injectable clock, so the tests don't have to sleep. */
  now?: () => number
}

export interface PathExistsCache {
  /** Cached answer for `token` relative to `cwd`. */
  exists: (cwd: string, token: string) => Promise<boolean>
  /** Drop everything (a pane pointing somewhere new). */
  clear: () => void
  /** Live entry count — for the tests, and for eyeballing the ceiling. */
  size: () => number
}

export function createPathExistsCache(opts: PathExistsCacheOptions): PathExistsCache {
  const now = opts.now ?? Date.now
  // Map preserves insertion order, which is all an LRU needs: re-inserting on
  // read moves an entry to the back, so the front is always the coldest.
  const entries = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<boolean>>()

  // A NUL can't occur in either half, so it can't be forged by a token that
  // happens to contain the separator.
  const keyOf = (cwd: string, token: string): string => cwd + '\0' + token

  const remember = (key: string, ok: boolean): void => {
    entries.delete(key)
    entries.set(key, { ok, expires: now() + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
    // Evict from the front (coldest) until back under the ceiling.
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  return {
    exists: (cwd, token) => {
      const key = keyOf(cwd, token)
      const hit = entries.get(key)
      if (hit && hit.expires > now()) {
        // Touch: re-insert so a path the user keeps hovering stays warm.
        entries.delete(key)
        entries.set(key, hit)
        return Promise.resolve(hit.ok)
      }
      if (hit) entries.delete(key) // expired
      const pending = inFlight.get(key)
      if (pending) return pending
      const p = opts
        .lookup(cwd, token)
        .then((ok) => {
          remember(key, ok)
          return ok
        })
        .catch(() => {
          // A failed check is not a cacheable "no" — the next hover retries.
          return false
        })
        .finally(() => {
          inFlight.delete(key)
        })
      inFlight.set(key, p)
      return p
    },
    clear: () => {
      entries.clear()
      inFlight.clear()
    },
    size: () => entries.size
  }
}
