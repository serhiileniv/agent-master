export interface RecentProject {
  path: string
  name: string
}

// Legacy 'vectro.' prefix kept deliberately: the app was renamed to Spy Master, but
// changing the key would orphan every user's recent-projects list.
export const RECENT_KEY = 'vectro.recent'

/** Most-recently-opened projects (newest first), persisted in localStorage. The
 *  single reader shared by the store's workspace switcher and openProject.
 *  Tolerates a corrupt/legacy value — anything that isn't a well-formed array of
 *  {path,name} is treated as empty rather than crashing the whole renderer. */
export function getRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is RecentProject =>
        !!r && typeof r.path === 'string' && typeof r.name === 'string'
    )
  } catch {
    return []
  }
}

/** Drop a project from the recents list (e.g. its folder no longer exists). */
export function removeRecent(path: string): RecentProject[] {
  const next = getRecent().filter((r) => r.path !== path)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}
