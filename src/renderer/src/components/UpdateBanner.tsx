import { useMemo } from 'react'
import { useStore } from '../store'
import { reminderTone, reminderHeadline } from '../updateReminder'

/**
 * Persistent, escalating "an update is available" strip under the titlebar. It
 * stays put for the whole session (until dismissed) and returns on the next
 * launch as long as a newer release exists — the "continuous notification"
 * half of the update feature. Tone firms up the longer the version is behind.
 *
 * On Windows the update also downloads in place (see main/update.ts): the
 * action button walks available → "Downloading… n%" → "Restart to update".
 * Everywhere else (and on any updater error) it links to the download site.
 */
export default function UpdateBanner(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const ustate = useStore((s) => s.updateState)
  const dismissed = useStore((s) => s.updateDismissed)
  const dismissUpdate = useStore((s) => s.dismissUpdate)

  // Seed/read the first-seen clock once per detected version, not every render.
  const tone = useMemo(() => (update ? reminderTone(update.latest) : null), [update])

  if (!update || dismissed || !tone) return null

  const ready = ustate?.status === 'ready'
  const downloading = ustate?.status === 'downloading'
  const text = ready
    ? `Agent Master ${update.latest} is downloaded. Restart to finish updating.`
    : reminderHeadline(update, tone)

  return (
    <div className={`updbar updbar--${tone.level}`} role="status">
      <svg className="updbar__icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path
          d="M12 19V6M6 12l6-6 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="updbar__text">{text}</span>
      {ready ? (
        <button className="updbar__btn" onClick={() => window.api.update.install()}>
          Restart to update
        </button>
      ) : downloading ? (
        <button className="updbar__btn" disabled>
          Downloading… {ustate.percent}%
        </button>
      ) : (
        <button className="updbar__btn" onClick={() => void window.api.openExternal(update.url)}>
          Update now
        </button>
      )}
      <button
        className="updbar__dismiss"
        title="Hide until next launch"
        aria-label="Hide until next launch"
        onClick={dismissUpdate}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
