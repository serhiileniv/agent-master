import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { IconClose, IconSend } from './Icons'
import Modal from './Modal'

type Category = 'bug' | 'idea' | 'other'

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' }
]

const PLACEHOLDER: Record<Category, string> = {
  bug: 'What went wrong, and what were you doing when it happened?',
  idea: 'What would you like Spy Master to do?',
  other: 'Anything on your mind: comments, praise, questions…'
}

/**
 * Feedback (bugs / ideas / comments) → the maintainer's inbox. The send itself
 * runs in the main process (feedback.ts); this just collects the message and
 * reports the outcome. On a network failure it offers a mailto fallback so a
 * report is never silently lost.
 */
export default function Feedback(): JSX.Element {
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen)
  const pushToast = useStore((s) => s.pushToast)
  const [category, setCategory] = useState<Category>('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.app.version().then((v) => alive && setVersion(v))
    return () => {
      alive = false
    }
  }, [])

  const close = (): void => setFeedbackOpen(false)

  const payload = (): FeedbackInput => ({
    category,
    message: message.trim(),
    email: email.trim() || undefined
  })

  const openMailto = (): void => {
    void window.api.feedback.mailto(payload())
  }

  const send = async (): Promise<void> => {
    const msg = message.trim()
    if (!msg || sending) return
    setSending(true)
    try {
      const res = await window.api.feedback.send(payload())
      if (res.ok) {
        pushToast('Thanks, your feedback was sent.', 'success')
        close()
        return
      }
      if (res.error === 'not-configured') {
        // The Web3Forms key hasn't been pasted in yet (or this is a dev build).
        pushToast('In-app sending isn’t set up yet. Opening your mail app instead.', 'info')
        openMailto()
        return
      }
      // Offline / rejected: keep the modal open, offer the mail-client fallback.
      pushToast('Couldn’t send right now.', 'error', {
        actionLabel: 'Email instead',
        onAction: openMailto
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal className="feedback" label="Send feedback" onClose={close} initialFocus=".feedback__text">
      <div className="settings__head">
        <span className="settings__title">Send feedback</span>
        <button className="settings__close" onClick={close} aria-label="Close">
          <IconClose size={16} />
        </button>
      </div>

      <div className="feedback__body">
        <p className="feedback__intro">
          Found a bug, have an idea, or just want to say something? It goes straight to the maker.
        </p>

        <div className="settings__seg feedback__seg">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={'settings__seg-btn' + (category === c.id ? ' is-active' : '')}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <textarea
          className="feedback__text"
          rows={6}
          placeholder={PLACEHOLDER[category]}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends without reaching for the mouse.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void send()
            }
          }}
        />

        <input
          className="feedback__email"
          type="email"
          placeholder="Your email (optional, so I can reply)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="feedback__foot">
        <span className="feedback__meta">{version ? `Spy Master v${version}` : ''}</span>
        <button
          className="feedback__send"
          disabled={!message.trim() || sending}
          onClick={() => void send()}
        >
          <IconSend size={14} />
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Modal>
  )
}
