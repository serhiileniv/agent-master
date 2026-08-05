// The update reminder is deliberately *persistent*: once a newer release exists,
// the banner returns on every launch (and the check re-runs periodically while
// the app is open) until the user actually updates. Its tone escalates the
// longer a version sits un-updated — gentle for the first couple of days, then
// firmer. "How long behind" is measured from the moment THIS install first saw
// the new version, persisted here so it survives restarts.

const FIRST_SEEN_PREFIX = 'vectro.update.firstSeen.' // legacy prefix kept (Spy Master rename)

export type UpdateLevel = 'info' | 'recommended' | 'urgent'

export interface ReminderTone {
  level: UpdateLevel
  /** Days since this install first saw `version` (0 on the first sighting). */
  daysBehind: number
}

/**
 * Record (once) when this install first noticed `version`, and return how long
 * it's been behind plus the escalation level. Reading also seeds the timestamp,
 * so the very first check starts the clock.
 */
export function reminderTone(version: string, now: number = Date.now()): ReminderTone {
  const key = FIRST_SEEN_PREFIX + version
  let first = now
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? Number(raw) : NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      first = parsed
    } else {
      localStorage.setItem(key, String(now))
    }
  } catch {
    /* storage unavailable — treat as first sighting, no escalation */
  }
  const daysBehind = Math.max(0, Math.floor((now - first) / 86_400_000))
  const level: UpdateLevel = daysBehind >= 7 ? 'urgent' : daysBehind >= 3 ? 'recommended' : 'info'
  return { level, daysBehind }
}

/** The banner headline, escalating with how long the update has been pending. */
export function reminderHeadline(u: UpdateInfo, tone: ReminderTone): string {
  const v = `Spy Master ${u.latest}`
  switch (tone.level) {
    case 'urgent':
      return `${v} has been available for over a week — you're on ${u.current}. Please update.`
    case 'recommended':
      return `${v} is available (you're on ${u.current}). An update is recommended.`
    default:
      return `${v} is available — you're on ${u.current}.`
  }
}
