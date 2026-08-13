import { app } from 'electron'

// Feedback is submitted through Web3Forms (https://web3forms.com) — a form-to-
// email relay. The renderer can't POST anywhere itself (the production CSP is
// locked to 'self'), so the submit runs here in the main process, mirroring the
// update check. Web3Forms mails whatever address is tied to the access key, so
// the destination (leniv.tech@gmail.com) lives on the Web3Forms dashboard, NOT
// in this source — swapping inboxes never needs a code change.
//
// SETUP (one-time): create a free access key at https://web3forms.com with the
// destination set to leniv.tech@gmail.com, then paste it below. The key is a
// public, send-only token (it can only deliver to that one preconfigured
// inbox), so it's safe to ship in the client — it is not a secret.
const WEB3FORMS_ACCESS_KEY = 'a0716458-59c5-441c-8305-30aaaf40339b'
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit'

export type FeedbackCategory = 'bug' | 'idea' | 'other'

export interface FeedbackInput {
  category: FeedbackCategory
  message: string
  /** Optional reply-to address so the sender can be answered. */
  email?: string
}

export interface FeedbackResult {
  ok: boolean
  /** Machine-readable failure reason (the renderer maps it to a message). */
  error?: 'not-configured' | 'empty' | 'network' | 'rejected'
}

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  idea: 'Idea / feature',
  other: 'Comment'
}

/** Loosely validate an email so a typo doesn't get rejected as the reply-to. */
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/**
 * Deliver a feedback message to the maintainer's inbox via Web3Forms. Never
 * throws — every failure resolves to a typed result the renderer can surface.
 * Version/platform are stamped here (authoritative) rather than trusted from
 * the renderer.
 */
export async function sendFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  if (!WEB3FORMS_ACCESS_KEY || WEB3FORMS_ACCESS_KEY.startsWith('PASTE_')) {
    return { ok: false, error: 'not-configured' }
  }
  const message = (input?.message ?? '').trim()
  if (!message) return { ok: false, error: 'empty' }

  const category: FeedbackCategory =
    input.category === 'bug' || input.category === 'idea' ? input.category : 'other'
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  const version = app.getVersion()
  const platform = `${process.platform} ${process.arch}`

  // A single readable body — the maintainer reads one email, not a form dump.
  const body =
    `${message}\n\n` +
    `— category: ${CATEGORY_LABEL[category]}\n` +
    `— from: ${email || '(not provided)'}\n` +
    `— app: Agent Master v${version}\n` +
    `— platform: ${platform}`

  const payload: Record<string, string> = {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: `Agent Master feedback — ${CATEGORY_LABEL[category]} (v${version})`,
    from_name: 'Agent Master',
    message: body
  }
  // Only set the reply-to when it's a real address; a garbage value makes
  // Web3Forms reject the whole submission.
  if (email && looksLikeEmail(email)) payload.email = email

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(WEB3FORMS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Web3Forms' free plan rejects "server-side" requests (Pro-only) by
        // sniffing the User-Agent — a non-browser UA (Electron main's default
        // fetch sends none / a Node UA) comes back as "This method is not
        // allowed ... Pro plan is required". A browser-like UA is accepted, so
        // this header is what makes the POST succeed from the main process.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    })
    if (!res.ok) return { ok: false, error: 'rejected' }
    const json = (await res.json().catch(() => null)) as { success?: boolean } | null
    return json?.success ? { ok: true } : { ok: false, error: 'rejected' }
  } catch {
    // Offline, DNS failure, timeout — the renderer offers a mailto fallback.
    return { ok: false, error: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** The maintainer inbox, exposed so the renderer's mailto fallback can target it. */
export const FEEDBACK_EMAIL = 'leniv.tech@gmail.com'
