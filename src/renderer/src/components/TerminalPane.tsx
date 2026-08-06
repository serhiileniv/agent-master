import { memo, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import {
  useStore,
  wsById,
  agentPath,
  agentPathById,
  displayBranch,
  RAIL_INSET,
  PAD,
  type AgentInstance,
  type AgentStatus
} from '../store'
import { terminals, fits, flushes, quotePaths, pasteIntoTerminal } from '../terminalRegistry'
import { isPaneOnScreen, OFFSCREEN_BUFFER_CAP } from '../paneVisibility'
import { createPathExistsCache } from '../pathExistsCache'
import { createQuietBoot, stripCursorStyle, type QuietBoot } from '../terminalBoot'
import { createAgentStatusTracker } from '../agentStatus'
import { AGENT_INSTALL_URLS } from '../agentInstall'
import { playCue, type Cue } from '../sound'
import { IconClose, IconWide, IconNarrow } from './Icons'
import AgentBadge from './AgentBadge'

/** Floor for the maximized pane before the stage has reported its size. */
const MIN_FOCUS_SIZE = 200

/**
 * Shared across every pane: xterm re-scans a row's links each time the pointer
 * enters it, and each path-looking token on that row cost an IPC round-trip and
 * an `fs.stat` — uncached, so sweeping the mouse over a build log restatted the
 * same files for as long as it kept moving. Keyed by cwd, so two worktrees can
 * never borrow each other's answer. See pathExistsCache.ts for the expiry rules.
 */
const pathExists = createPathExistsCache({
  lookup: (cwd, token) => window.api.file.exists(cwd, token)
})

// Path-looking tokens in terminal output ("src/foo.ts:42", "..\lib\a.py") —
// candidates are verified against the pane's cwd in the main process, so only
// real files light up as links.
const FILE_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])?[\w][\w.-]*(?:[\\/][\w.-]+)+(?::\d+(?::\d+)?)?/g

/** Turn a FILE_RE token into a forward-slash rel path under `cwd`, stripping the
 *  trailing :line(:col) and surrounding quotes/brackets the same way the main
 *  process's resolveFileTarget does. Returns null when the file lands OUTSIDE
 *  cwd (different root, or `..` escape) so the caller can fall back to OS-open. */
function relUnderCwd(cwd: string, token: string): string | null {
  const cleaned = token
    .replace(/(?::\d+){1,2}$/, '') // trailing :line(:col)
    .replace(/^['"(<[]+|['")>\],.;]+$/g, '')
  if (!cleaned || !cwd) return null
  const t = cleaned.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const isAbs = /^[A-Za-z]:\//.test(t) || t.startsWith('/') || t.startsWith('~/')
  let rel: string
  if (isAbs) {
    // Windows compares paths case-insensitively — tolerate a drive-letter case
    // mismatch between the emitted token and the stored cwd.
    const bl = base.toLowerCase()
    const tl = t.toLowerCase()
    if (tl === bl || !tl.startsWith(bl + '/')) return null // the dir itself, or outside it
    rel = t.slice(base.length + 1)
  } else {
    rel = t.replace(/^\.\//, '')
  }
  if (!rel || rel === '..' || rel.split('/').includes('..')) return null
  return rel
}

/** m:ss elapsed while an agent works; hidden for bursts under 3s (shell echo). */
function WorkTimer({ since }: { since: number }): JSX.Element | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    // The display derives from Date.now() - since, so the interval can stop
    // entirely while the document is hidden and self-correct on return.
    let t: ReturnType<typeof setInterval> | undefined
    const sync = (): void => {
      clearInterval(t)
      t = undefined
      if (document.visibilityState === 'visible') {
        setTick((n) => n + 1)
        t = setInterval(() => setTick((n) => n + 1), 1000)
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  if (s < 3) return null
  return (
    <span className="vec-pane__timer">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  )
}

/** Status → status-dot colour (CSS custom properties from the palette). */
const STATUS_COLOR: Record<AgentStatus, string> = {
  starting: 'var(--status-idle)',
  working: 'var(--status-working)',
  idle: 'var(--status-idle)',
  attention: 'var(--status-attention)',
  exited: 'var(--status-done)',
  error: 'var(--status-error)'
}

/* Theme-matched xterm palettes. The background stays transparent in both — the
   pane veil (.vec-pane__term, driven by the opacity slider) paints the actual
   surface. Explicit selection colours because xterm's default was nearly
   invisible on the translucent glass. */
const TERM_THEME_DARK = {
  background: 'rgba(0,0,0,0)',
  foreground: '#cdd6e4',
  cursor: '#cdd6e4',
  selectionBackground: 'rgba(138, 170, 255, 0.36)',
  selectionInactiveBackground: 'rgba(138, 170, 255, 0.18)'
}
/* Light terminals are white with near-black text. The ANSI 16 are the GitHub
   Light set — the default xterm colours (picked for dark) wash out on white. */
const TERM_THEME_LIGHT = {
  background: 'rgba(0,0,0,0)',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.22)',
  selectionInactiveBackground: 'rgba(9, 105, 218, 0.11)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}
/** Pick the xterm palette: the pane's own override wins, 'auto' follows the app. */
const resolvedTermTheme = (
  override?: 'auto' | 'dark' | 'light'
): typeof TERM_THEME_LIGHT | typeof TERM_THEME_DARK => {
  const mode =
    override && override !== 'auto' ? override : document.documentElement.dataset.theme
  return mode === 'light' ? TERM_THEME_LIGHT : TERM_THEME_DARK
}

/**
 * One terminal window. The SAME instance is reused across every layout mode, so
 * switching Grid/Columns/Free never kills the PTY. In free mode it's absolutely
 * positioned (driven by Moveable). Status is detected from PTY output so the
 * stage can show, at a glance, which agent is working / idle / waiting on you.
 */
function TerminalPane({
  agent,
  workspaceId
}: {
  agent: AgentInstance
  workspaceId: string
}): JSX.Element {
  const id = agent.id
  const termHostRef = useRef<HTMLDivElement>(null)
  // One array traversal for the three per-agent fields we read; useShallow keeps
  // the re-render gated to actual changes in branch / isolated / status. All
  // scoped to THIS pane's workspace (background workspaces stream too).
  const { branch, isolated, status, workingSince } = useStore(
    useShallow((s) => {
      const a = wsById(s, workspaceId)?.agents.find((x) => x.id === id)
      return {
        branch: a?.branch,
        isolated: a?.isolated,
        status: a?.status ?? ('starting' as AgentStatus),
        workingSince: a?.workingSince
      }
    })
  )
  // Whether this pane's workspace is the one on screen — gates DOM-focus grabs so
  // a hidden background pane never steals keyboard focus from the active stage.
  const isActive = useStore((s) => s.activeWorkspaceId === workspaceId)
  // Spawning is held until shell detection resolves — see the guard in the mount
  // effect below.
  const shellsLoaded = useStore((s) => s.shellsLoaded)
  const selected = useStore((s) => wsById(s, workspaceId)?.selectedIds.includes(id) ?? false)
  const closing = useStore((s) => wsById(s, workspaceId)?.closingIds.includes(id) ?? false)
  const removeAgent = useStore((s) => s.removeAgent)
  const fontSize = useStore((s) => s.settings.fontSize)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const scrollback = useStore((s) => s.settings.scrollback)
  const confirmClose = useStore((s) => s.settings.confirmClose)
  const renameAgent = useStore((s) => s.renameAgent)
  const toggleWide = useStore((s) => s.toggleWide)
  // With a single pane there's nothing to weigh a "wider" card against — it
  // already fills the row — so the toggle would be inert. Hide it below 2.
  const agentCount = useStore((s) => wsById(s, workspaceId)?.agents.length ?? 0)
  const focusTerminal = useStore((s) => s.focusTerminal)
  const clearFocus = useStore((s) => s.clearFocus)
  const focused = useStore((s) => wsById(s, workspaceId)?.focusedId === id)
  const stageW = useStore((s) => s.stageW)
  const stageH = useStore((s) => s.stageH)
  const setDiffAgentId = useStore((s) => s.setDiffAgentId)
  const pendingClose = useStore((s) => wsById(s, workspaceId)?.pendingCloseId === id)
  const clearPendingClose = useStore((s) => s.clearPendingClose)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const ptyRef = useRef<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(agent.label)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // The pane's terminal-theme override, readable from inside the mount effect's
  // observer without re-creating the Terminal when it changes.
  const termThemeRef = useRef(agent.termTheme)
  termThemeRef.current = agent.termTheme
  const [closePrompt, setClosePrompt] = useState<{
    checking: boolean
    dirty: boolean
    count: number
    /** Shared-dir terminal: closing deletes nothing on disk. */
    shared?: boolean
  } | null>(null)
  // Transient "task finished" nod: set by the long-burst done path in
  // evaluateIdle, cleared once the one-shot CSS animation has played out
  // (see .is-done-flash). Timer survives a relaunch (retryNonce) harmlessly —
  // it only flips this flag back off.
  const [doneFlash, setDoneFlash] = useState(false)
  const doneFlashTimer = useRef<number>()
  useEffect(() => () => window.clearTimeout(doneFlashTimer.current), [])
  // Once-per-pane guard for the "agent binary isn't installed" toast. A ref (not
  // effect-local) so a Relaunch (retryNonce re-runs the effect) doesn't re-nag
  // about the same missing binary.
  const missingBinNotified = useRef(false)

  // Ctrl/⌘-V and the context-menu Paste both route through the shared paste
  // routine (see terminalRegistry.pasteIntoTerminal).
  const pasteFromClipboard = async (): Promise<void> => {
    if (termRef.current) await pasteIntoTerminal(termRef.current, agent.shellId)
  }

  useEffect(() => {
    const host = termHostRef.current
    if (!host) return
    // Wait for shell detection. Restored panes mount the instant
    // hydrateWorkspaces lands, which is usually BEFORE shells:list resolves — so
    // the lookup below found nothing and the pty quietly fell back to the
    // platform default, ignoring the user's Git Bash / WSL / pwsh choice. This
    // effect re-runs when the flag flips, and does nothing until then.
    if (!shellsLoaded) return
    setSpawnError(null)

    const term = new Terminal({
      fontFamily,
      fontSize,
      scrollback,
      cursorBlink: false, // steady cursor — the blink read as a fast jitter
      allowTransparency: true, // so the pane bg / wallpaper can show through
      allowProposedApi: true, // Unicode11Addon + registerLinkProvider need it
      smoothScrollDuration: 120, // wheel scrolling glides instead of jumping
      // We own the context menu; xterm's mac default of selecting the word
      // under a right-click silently replaced the user's selection before the
      // menu's Copy could read it.
      rightClickSelectsWord: false,
      theme: resolvedTermTheme(termThemeRef.current)
    })
    termRef.current = term
    // Expose to the macOS Edit-menu handler (routes ⌘C/⌘V/⌘A by focus).
    terminals.set(id, term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    // Clickable URLs open in the user's real browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.api.openExternal(uri)))
    // Correct emoji / CJK cell widths — agent TUIs (Claude Code) are full of
    // them, and the default Unicode 6 tables misalign their box-drawing.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)
    // Deliberately NO WebGL renderer: it draws glyphs into a bitmap canvas,
    // and with the interface zoom (default 1.1) + fractional tile coordinates
    // that bitmap lands between device pixels — the compositor resamples it
    // and EVERY glyph goes soft. The DOM renderer rasterizes text at final
    // resolution and stays crisp at any zoom; its perf is fine at ≤9 panes.

    // File paths in output become links (verified against the pane's cwd in
    // the main process; only real files activate). Click opens the default app.
    const fileLinks = term.registerLinkProvider({
      provideLinks(y, cb) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const w = wsById(useStore.getState(), workspaceId)
        // Prefer the live cwd (an isolated agent's worktree); fall back to the
        // folder this agent is pointed at, which may not be the workspace default.
        const a = w?.agents.find((x) => x.id === id)
        const cwd = a?.cwd ?? agentPath(w, a) ?? ''
        const cands: { x: number; t: string }[] = []
        FILE_RE.lastIndex = 0
        for (let m = FILE_RE.exec(text); m; m = FILE_RE.exec(text)) {
          cands.push({ x: m.index, t: m[0] })
        }
        if (!cands.length || !cwd) return cb(undefined)
        void Promise.all(cands.map((c) => pathExists.exists(cwd, c.t))).then((oks) => {
          const links = cands
            .filter((_, i) => oks[i])
            .map((c) => ({
              range: { start: { x: c.x + 1, y }, end: { x: c.x + c.t.length, y } },
              text: c.t,
              activate: () => {
                // Open in the in-app viewer at PROJECT-ROOT scope (never the
                // worktree copy — the human edits the real files). The printed
                // path is cwd-relative, but the worktree mirrors the repo so the
                // same rel resolves under the project root. Fall back to an
                // OS-level open only when the file lives outside cwd.
                const rel = relUnderCwd(cwd, c.t)
                if (rel) {
                  const st = useStore.getState()
                  st.openFilePanel({ kind: 'root' })
                  st.openFile(rel)
                } else {
                  void window.api.file.open(cwd, c.t)
                }
              }
            }))
          cb(links.length ? links : undefined)
        })
      }
    })

    // Copy on mod+C when there's a selection (else let Ctrl-C be SIGINT);
    // paste on mod+V; open find on mod+F. The modifier is PLATFORM-SPECIFIC:
    // Ctrl on Windows/Linux, ⌘ on macOS — treating ctrl===meta everywhere let a
    // mac Ctrl+C-with-selection copy instead of interrupting the process, and
    // Ctrl+F opened find instead of readline forward-char. (On mac ⌘C/⌘V are
    // consumed by the menu before reaching here; ⌘F still lands here.)
    // preventDefault() is load-bearing on the intercepted combos: returning
    // false only stops xterm's own processing, NOT the browser default. Without
    // it, Ctrl+V ALSO fired the native `paste` event on xterm's hidden textarea
    // (xterm pastes it too) — every paste landed TWICE. Dictation tools that
    // simulate Ctrl+V (Wispr Flow) hit the same double-paste.
    const isMac = window.api.platform === 'darwin'
    term.attachCustomKeyEventHandler((e): boolean => {
      if (e.type !== 'keydown') return true
      const mod = isMac ? e.metaKey : e.ctrlKey
      // App-level chords (maximize toggle, pane cycling) — keep them out of the
      // pty; the window keydown handler picks them up as the event bubbles.
      if (
        mod &&
        e.shiftKey &&
        (e.code === 'Enter' || e.code === 'BracketRight' || e.code === 'BracketLeft')
      ) {
        return false
      }
      // Spatial navigation (⌘Arrow / Ctrl+Shift+Arrow) is app-level too. On mac
      // the chord carries no Shift, so it's checked apart from the trio above —
      // plain Ctrl+Arrow (readline word-jump) still reaches the pty on Win/Linux.
      if (
        mod &&
        (isMac || e.shiftKey) &&
        (e.code === 'ArrowLeft' ||
          e.code === 'ArrowRight' ||
          e.code === 'ArrowUp' ||
          e.code === 'ArrowDown')
      ) {
        return false
      }
      const k = e.key.toLowerCase()
      if (mod && k === 'c' && term.hasSelection()) {
        // macOS copy is ⌘C — a separate key from the Ctrl+C interrupt — so it
        // always copies. On Windows/Linux Ctrl+C is BOTH copy and SIGINT, and
        // copy-on-select leaves a selection highlighted after every drag: if that
        // lingering selection made Ctrl+C copy, you could never interrupt a running
        // process (it'd copy instead of sending SIGINT). So only treat Ctrl+C as
        // copy when copy-on-select is OFF — i.e. when an explicit copy gesture is
        // actually needed. With it ON the text is already on the clipboard, so we
        // fall through to SIGINT (matching Windows Terminal).
        if (isMac || !useStore.getState().settings.copyOnSelect) {
          e.preventDefault()
          window.api.clipboard.write(term.getSelection())
          // Explicit confirmation: Ctrl+C is ambiguous (copy vs. SIGINT), so without
          // feedback the user can't tell it copied and re-hits it — which, after the
          // clear below, sends SIGINT instead. A brief toast breaks that loop.
          useStore.getState().pushToast('Copied', 'success')
          // On Windows/Linux `mod` IS Ctrl, so a lingering selection would make
          // every Ctrl+C copy instead of sending SIGINT — clear it so the next
          // Ctrl+C falls through to the interrupt. (On macOS copy is ⌘C, separate
          // from Ctrl+C, so there's no collision — but clearing is still conventional.)
          if (!isMac) term.clearSelection()
          return false
        }
        // Windows/Linux with copy-on-select on: the drag already copied this text,
        // so Ctrl+C is purely the interrupt. Drop the stale highlight and fall
        // through so xterm sends SIGINT (\x03) to the running process.
        term.clearSelection()
      }
      if (mod && k === 'v') {
        e.preventDefault()
        void pasteFromClipboard()
        return false
      }
      if (mod && k === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        return false
      }
      return true
    })

    // Copy-on-select (iTerm-style). MOUSE selections copy on mouseup — the moment
    // the drag settles — NOT on a debounce timer: the old 250ms debounce kept getting
    // reset by trailing onSelectionChange ticks (autoscroll, a tiny drag correction),
    // so the copy landed late or never and the user had to re-copy. Firing once on
    // mouseup makes the settled selection always reach the clipboard and drops the
    // Win+V clipboard-history spam. NON-mouse selections (context-menu / ⌘A Select
    // All, keyboard) never produce a mouseup, so a short-debounced onSelectionChange
    // still covers them — but it skips while a mouse drag is in flight so the two
    // paths never double-copy.
    let selecting = false
    const onTermMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      selecting = true
    }
    // `copy=false` (window blur) just tears the gesture down without touching the
    // clipboard — the button was released outside the OS window (mouseup swallowed),
    // so we must not leave `selecting` stuck nor clobber the clipboard.
    const endSelect = (copy: boolean): void => {
      if (!selecting) return
      selecting = false
      if (!copy) return
      if (!useStore.getState().settings.copyOnSelect) return
      if (!term.hasSelection()) return
      const sel = term.getSelection()
      if (sel) window.api.clipboard.write(sel)
    }
    const onWinMouseUp = (): void => endSelect(true)
    const onWinBlur = (): void => endSelect(false)
    // Debounced copy for NON-mouse selection changes (Select All etc.). Skipped
    // while `selecting` — a mouse drag — so mouseup remains the single writer there.
    let selTimer: ReturnType<typeof setTimeout> | undefined
    term.onSelectionChange(() => {
      if (selecting) return
      clearTimeout(selTimer)
      selTimer = setTimeout(() => {
        if (!useStore.getState().settings.copyOnSelect) return
        const sel = term.getSelection()
        if (sel) window.api.clipboard.write(sel)
      }, 100)
    })
    // Capture phase: xterm handles mouse events on its inner screen element, so
    // listen on the way DOWN to reliably catch the press/move/release regardless.
    host.addEventListener('mousedown', onTermMouseDown, true)
    window.addEventListener('mouseup', onWinMouseUp, true)
    window.addEventListener('blur', onWinBlur)

    let raf = 0
    const doFit = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // A pane in a background workspace has no layout box (its layer is
        // content-visibility:hidden), so fit() would propose nonsense and we'd
        // resize the pty to a degenerate size — reflowing the agent's TUI for
        // no reason. Keep the last good geometry; App refits on activation.
        if (host.offsetWidth === 0 || host.offsetHeight === 0) return
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
        if (ptyId) window.api.pty.resize(ptyId, term.cols, term.rows)
      })
    }
    fitRef.current = doFit
    // Register the refit so App can re-measure this pane when its workspace is
    // brought to the foreground (it was laid out while hidden).
    fits.set(id, doFit)
    doFit()

    // Take keyboard focus if we're the active pane in the FOREGROUND workspace.
    // Covers first mount AND, crucially, Relaunch: bumping retryNonce re-creates
    // the Terminal without any selection transition, so the soleSelected effect
    // wouldn't re-fire and typing would dead-end on the fresh shell. A background
    // workspace's pane must not grab focus here.
    const st0 = useStore.getState()
    if (st0.activeWorkspaceId === workspaceId && wsById(st0, workspaceId)?.selectedIds[0] === id)
      term.focus()

    const state = useStore.getState()
    const { setAgentRuntime, setStatus } = state
    // This pane's own workspace folder — NOT the active one. "Spawn all on
    // restart" spawns background panes while another workspace is on screen, so
    // reading a global projectPath here would create the worktree in the wrong repo.
    // This agent's OWN folder — not the active workspace's, and not necessarily
    // its own workspace's default either, since an agent can be pointed
    // elsewhere. Getting this wrong creates the worktree in the wrong repo.
    const projectPath = agentPath(wsById(state, workspaceId), agent)
    const shell = state.shells.find((sh) => sh.id === agent.shellId)
    let ptyId: string | null = null
    let disposed = false
    // Assigned once the PTY exists, but held at effect scope so the unmount
    // cleanup can stop its reveal timer (that was the one timer cleanup missed).
    let boot: QuietBoot | null = null
    let lastNotify = 0
    const unsubs: Array<() => void> = []

    const labelOf = (): string =>
      wsById(useStore.getState(), workspaceId)?.agents.find((a) => a.id === id)?.label ?? 'Terminal'

    // Notify only for a backgrounded agent: app window unfocused OR the card is
    // off-screen. Never nag about the terminal you're already watching.
    const maybeNotify = (kind: 'attention' | 'done' | 'exited' | 'error'): void => {
      const st = useStore.getState()
      if (!st.settings.notifications) return
      // A background workspace signals through its tab badge, not a desktop popup
      // (whose click would have nowhere to land in this version) — only the
      // workspace on screen fires notifications.
      if (st.activeWorkspaceId !== workspaceId) return
      // A clean finish — whether it settled quietly ('done') or the process exited
      // 0 ('exited') — is the same "your agent is done" signal, so both honour the
      // "notify when finished" toggle. Only error exits notify unconditionally.
      if ((kind === 'done' || kind === 'exited') && !st.settings.notifyOnDone) return
      const a = wsById(st, workspaceId)?.agents.find((x) => x.id === id)
      if (!a) return
      const wz = a.w * st.zoom
      const hz = a.h * st.zoom
      const sx = st.panX + a.x * st.zoom
      const sy = st.panY + a.y * st.zoom
      const offscreen = sx + wz < 0 || sx > st.stageW || sy + hz < 0 || sy > st.stageH
      const appUnfocused = typeof document !== 'undefined' && !document.hasFocus()
      if (!offscreen && !appUnfocused) return
      const now = Date.now()
      if (now - lastNotify < 4000) return
      lastNotify = now
      const body =
        kind === 'attention'
          ? 'Waiting for your input'
          : kind === 'done'
            ? 'Finished, ready for you'
            : kind === 'error'
              ? 'Process exited with an error'
              : 'Process finished'
      window.api.notify.agent({ id, title: labelOf(), body })
    }

    // Audible cue — gated by `sounds` alone (not by `notifications` or by
    // backgrounding), so you also hear it for the agent you're watching. The
    // 'done' cue additionally honours notifyOnDone: that toggle decides whether
    // a finish alerts AT ALL; sounds/notifications pick the channel. Both clean
    // finish paths (settle and exit-0) pass cue 'done', so gating on the cue
    // covers them. Rate-limiting lives in playCue.
    const maybeSound = (cue: Cue): void => {
      const st = useStore.getState().settings
      if (!st.sounds) return
      if (cue === 'done' && !st.notifyOnDone) return
      playCue(cue)
    }

    // Everything that decides what the output MEANS — working, finished,
    // waiting for you, binary missing — lives in the tracker. This effect owns
    // the transport (pty, xterm) and hands it the raw stream.
    const tracker = createAgentStatusTracker(
      { startupCommand: agent.startupCommand },
      {
        setStatus: (s) => setStatus(id, s),
        setWorking: (since) => setAgentRuntime(id, { status: 'working', workingSince: since }),
        notify: maybeNotify,
        sound: maybeSound,
        doneFlash: () => {
          // Quiet visual nod on the card itself (green ring sweep + tick in the
          // header). The timeout slightly outlives the 1.2s animation so the
          // class is never yanked mid-sweep.
          setDoneFlash(true)
          window.clearTimeout(doneFlashTimer.current)
          doneFlashTimer.current = window.setTimeout(() => setDoneFlash(false), 1400)
        },
        missingBinary: (bin) => {
          // The ref, not the tracker, is what makes this once-only: it outlives
          // a relaunch (which builds a new tracker), so retrying a pane whose
          // binary is still missing doesn't toast again.
          if (missingBinNotified.current) return
          missingBinNotified.current = true
          const url = AGENT_INSTALL_URLS[bin]
          // Sticky error toast (Toasts.tsx never auto-dismisses errors); unknown
          // binaries have no docs URL to offer, so they get no action button.
          useStore
            .getState()
            .pushToast(
              `“${bin}” isn’t installed or isn’t on your PATH`,
              'error',
              url
                ? { actionLabel: 'Install guide', onAction: () => void window.api.openExternal(url) }
                : undefined
            )
        }
      }
    )

    // BEL from the program itself is the one non-heuristic "I need you" signal
    // (Claude Code rings it on permission prompts). Treat it as attention.
    term.onBell(() => tracker.onBell())

    const start = async (): Promise<void> => {
      setStatus(id, 'starting')
      const wt = await window.api.worktree.create(projectPath ?? '', id, agent.isolation)
      if (disposed) return
      setAgentRuntime(id, { branch: wt.branch, cwd: wt.cwd, isolated: wt.isolated })
      // Asked for an isolated worktree but git couldn't give us one — don't let it
      // pass as a silent "shared" tag; say why so the user can fix it (e.g. make an
      // initial commit) instead of unknowingly editing the shared project dir.
      if (agent.isolation === 'worktree' && !wt.isolated && wt.reason) {
        useStore.getState().pushToast(`“${labelOf()}” isn’t isolated: ${wt.reason}`, 'error')
      }

      let pid: string
      try {
        pid = await window.api.pty.spawn({
          cwd: wt.cwd || undefined,
          cols: term.cols,
          rows: term.rows,
          shell: shell?.command,
          args: shell?.args
        })
      } catch (e) {
        if (disposed) return
        setStatus(id, 'error')
        setSpawnError(e instanceof Error ? e.message : String(e))
        return
      }
      if (disposed) {
        window.api.pty.kill(pid)
        return
      }
      ptyId = pid
      ptyRef.current = pid
      setAgentRuntime(id, { ptyId: pid })
      setStatus(id, 'idle')

      // --- Quiet boot -----------------------------------------------------
      // The injected cwd-pin (and a known agent's launch command) would echo —
      // flashing `Set-Location …` and the raw command before the agent paints.
      // Hold the VISIBLE render back until the shell signals the cwd-pin is done
      // (a printed sentinel) and the agent takes over the alternate screen, then
      // reveal a clean start. Output still reaches onActivity (status + the
      // missing-bin watch) — only rendering waits. A timeout always reveals in
      // the end, so an unexpected shell can never leave the pane blank; and the
      // sentinel clears the screen shell-side, so that reveal is clean too.
      let startupSent = false
      const sendStartup = (): void => {
        if (startupSent || !agent.startupCommand) return
        startupSent = true
        // Arm the missing-binary watch from when the command is sent.
        tracker.armMissingBinaryWatch()
        window.api.pty.write(pid, agent.startupCommand + '\r')
      }
      const quietBoot = createQuietBoot(
        {
          shellId: shell?.id,
          win: window.api.platform === 'win32',
          cwd: wt.cwd,
          hideAgent: !!agent.agentId && !!agent.startupCommand
        },
        {
          resetScreen: () => term.reset(),
          write: (s) => term.write(s),
          sendStartup,
          writeToShell: (line) => window.api.pty.write(pid, line + '\r')
        }
      )
      boot = quietBoot

      // An OFF-SCREEN pane buffers its writes instead of feeding xterm: the DOM
      // renderer pays a full ANSI parse + DOM mutation per write even into a
      // subtree the compositor skips. Off-screen means a background workspace
      // OR a pane sitting behind a maximized sibling — see paneVisibility.ts.
      //
      // There is deliberately no flush TIMER. The old one fired every 400ms,
      // which meant a hidden pane re-rendered 2.5×/second into a surface nobody
      // could see; nothing consumes that paint, because status detection, the
      // bell and the missing-binary watch all read the RAW pty stream via
      // tracker.onData, which this never touches. What remains are the only two
      // reasons to write early: the size cap (so a runaway background process
      // can't grow the heap without bound) and coming back on screen, which App
      // drives through the flush registry.
      //
      // Nothing is ever dropped — chunks concatenate in order and replay
      // byte-identically on flush, so scrollback and TUI alternate-screen state
      // are exact. A BEL in the raw chunk still flushes immediately so onBell
      // (attention, notification) stays prompt.
      let pendingWrites: string[] = []
      let pendingLen = 0
      const flushPending = (): void => {
        if (!pendingWrites.length) return
        const out = pendingWrites.join('')
        pendingWrites = []
        pendingLen = 0
        term.write(out)
      }
      flushes.set(id, flushPending)

      // The DECSCUSR strip is chunk-boundary safe: a sequence split across two
      // PTY chunks is held back (carry) and stripped once complete — otherwise
      // the leaked half re-enabled the fast-blink cursor it exists to suppress.
      let seqCarry = ''
      unsubs.push(window.api.pty.onData(pid, (d) => {
        let s = seqCarry ? seqCarry + d : d
        seqCarry = ''
        const partial = s.match(/\x1b(?:\[[0-9]* ?)?$/)
        if (partial) {
          seqCarry = partial[0]
          s = s.slice(0, s.length - partial[0].length)
        }
        if (s) {
          if (quietBoot.isBooting()) quietBoot.onData(s)
          else {
            const out = stripCursorStyle(s)
            const st = useStore.getState()
            const onScreen = isPaneOnScreen({
              activeWorkspaceId: st.activeWorkspaceId,
              workspaceId,
              focusedId: wsById(st, workspaceId)?.focusedId ?? null,
              agentId: id
            })
            if (!onScreen && !d.includes('\x07')) {
              pendingWrites.push(out)
              pendingLen += out.length
              if (pendingLen > OFFSCREEN_BUFFER_CAP) flushPending()
            } else {
              flushPending()
              term.write(out)
            }
          }
        }
        tracker.onData(d)
      }))
      unsubs.push(
        window.api.pty.onExit(pid, (code) => {
          ptyRef.current = null
          // Status, notification and cue for the exit all live in the tracker.
          tracker.onExit(code)
          flushPending()
          term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n')
        })
      )
      term.onData((d) => {
        window.api.pty.write(pid, d)
        tracker.onUserInput()
        // When the user runs a command, tag the terminal if it's a known agent —
        // so the badge appears even when an agent is started by hand.
        if (d.includes('\r')) {
          const buf = term.buffer.active
          const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
          // The full command after the last shell-prompt character, plus its bare
          // program name for agent matching.
          const after = (line.match(/.*[>$#%]\s*(\S.*)$/)?.[1] ?? '').trim()
          const base = ((after.split(/\s+/)[0] ?? '').split(/[\\/]/).pop() ?? '').toLowerCase()
          if (base) {
            const st = useStore.getState()
            const hit = st.agentClis.find((c) => c.command.toLowerCase() === base || c.id === base)
            if (hit) {
              // Remember the FULL typed line (unless one's already set from the
              // "Start <agent>" menu) so a hand-started agent relaunches on reopen
              // with its flags intact — not as a bare `claude`.
              const had = wsById(st, workspaceId)?.agents.find((a) => a.id === id)?.startupCommand
              setAgentRuntime(id, {
                agentId: hit.id,
                agentLabel: hit.label,
                ...(had ? {} : { startupCommand: after })
              })
            }
          }
        }
      })

      // Subscriptions are in place, so nothing the shell replies with is missed.
      quietBoot.begin()
    }
    void start().catch((e) => {
      if (disposed) return
      setStatus(id, 'error')
      setSpawnError(e instanceof Error ? e.message : String(e))
    })

    const ro = new ResizeObserver(doFit)
    ro.observe(host)

    // Terminal interior follows the app theme (white/black text in light mode),
    // unless this pane pinned its own via the context menu (termThemeRef).
    // theme.ts stamps data-theme on <html> — including live OS switches in
    // 'system' mode — so watching that attribute covers every path.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = resolvedTermTheme(termThemeRef.current)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      disposed = true
      tracker.dispose()
      boot?.dispose()
      clearTimeout(selTimer)
      themeObserver.disconnect()
      host.removeEventListener('mousedown', onTermMouseDown, true)
      window.removeEventListener('mouseup', onWinMouseUp, true)
      window.removeEventListener('blur', onWinBlur)
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsubs.forEach((u) => u())
      fileLinks.dispose()
      if (ptyId) window.api.pty.kill(ptyId)
      ptyRef.current = null
      searchRef.current = null
      // No flush on teardown. It existed to stop a pending 400ms timer firing
      // into a disposed terminal; that timer is gone, and replaying buffered
      // output into a pane that is being destroyed is pure waste — worse, an
      // xterm write is asynchronous, so it would be parsing into a terminal
      // that dispose() has already torn down.
      terminals.delete(id)
      fits.delete(id)
      flushes.delete(id)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, shellsLoaded])

  // Entering focus (maximize) also hands over KEYBOARD focus — same for a
  // notification click — so you can type immediately without clicking in. Only
  // when this workspace is on screen; App re-focuses on workspace activation.
  useEffect(() => {
    if (focused && isActive) termRef.current?.focus()
  }, [focused, isActive])

  // The single selected terminal always owns keyboard focus, so you can type the
  // instant it becomes active — clicking its header, cycling to it, spawning it,
  // or having selection fall back to it when a neighbour closes. (Clicking empty
  // stage keeps the current selection; Stage re-focuses it there.)
  const soleSelected = useStore((s) => {
    const w = wsById(s, workspaceId)
    return !!w && w.selectedIds.length === 1 && w.selectedIds[0] === id
  })
  useEffect(() => {
    // Don't focus when the shell failed to spawn — the term's textarea is detached
    // from the DOM (the error view replaced the body), so focusing it would send
    // keystrokes nowhere. The Retry button autoFocuses instead. Only when this
    // workspace is on screen — a hidden pane must never grab keyboard focus.
    if (soleSelected && isActive && !spawnError) termRef.current?.focus()
  }, [soleSelected, isActive, spawnError])

  // Escape closes the in-pane overlays the global handler can't see: the close
  // confirm (most dangerous dialog in the app) and the right-click menu. Capture
  // phase + stopImmediatePropagation so App's window keydown doesn't ALSO act on
  // the same Esc (e.g. un-maximizing the pane behind the dialog).
  useEffect(() => {
    if (!menu && !closePrompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setMenu(null)
      setClosePrompt(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, closePrompt])

  // Live terminal options from settings (no respawn needed).
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.fontSize = fontSize
    t.options.fontFamily = fontFamily
    t.options.scrollback = scrollback
    fitRef.current?.()
  }, [fontSize, fontFamily, scrollback])

  // Re-palette in place when this pane's theme override changes (app-theme
  // changes are handled by the MutationObserver in the mount effect).
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.theme = resolvedTermTheme(agent.termTheme)
  }, [agent.termTheme])

  const beginClose = async (): Promise<void> => {
    // Shared dir (or downgraded): nothing is deleted on disk. Confirmed via
    // the same in-app modal as worktree closes (no native window.confirm).
    if (agent.isolation !== 'worktree' || isolated === false) {
      if (confirmClose) setClosePrompt({ checking: false, dirty: false, count: 0, shared: true })
      else removeAgent(id)
      return
    }
    // Isolated worktree: never delete a branch with uncommitted work silently.
    setClosePrompt({ checking: true, dirty: false, count: 0 })
    const projectPath = agentPathById(useStore.getState(), id)
    try {
      const res = projectPath ? await window.api.git.diff(projectPath, id) : null
      const untracked = res?.untracked?.length ?? 0
      const changed = res?.diff ? res.diff.match(/^diff --git/gm)?.length ?? 0 : 0
      // Untracked files are synthesized into the diff as `diff --git` sections
      // too, so `changed` already counts them — adding `untracked` on top would
      // double-count every new file. The bare untracked count is only the
      // fallback for when the diff itself couldn't be produced (error path).
      const count = changed > 0 ? changed : untracked
      const dirty = !!res?.hasChanges || untracked > 0
      if (!dirty && !confirmClose) {
        setClosePrompt(null)
        removeAgent(id)
        return
      }
      setClosePrompt({ checking: false, dirty, count })
    } catch {
      setClosePrompt({ checking: false, dirty: false, count: 0 })
    }
  }

  // A close requested from outside the pane (⌘W / command palette) runs the same
  // guarded flow as the × button, so a worktree's uncommitted work is never
  // force-deleted without a prompt. Ref keeps the effect off beginClose's identity.
  const beginCloseRef = useRef(beginClose)
  beginCloseRef.current = beginClose
  useEffect(() => {
    if (!pendingClose) return
    clearPendingClose()
    void beginCloseRef.current()
  }, [pendingClose, clearPendingClose])

  const relaunch = (): void => {
    setSpawnError(null)
    setSearchOpen(false)
    setRetryNonce((n) => n + 1)
  }

  // Context-menu actions hand focus back to the terminal, so you can keep
  // typing right after Copy/Paste without clicking into the pane again.
  const copySelection = (): void => {
    const sel = termRef.current?.getSelection()
    if (sel) window.api.clipboard.write(sel)
    setMenu(null)
    termRef.current?.focus()
  }
  const paste = (): void => {
    void pasteFromClipboard()
    setMenu(null)
    termRef.current?.focus()
  }

  const dotColor = STATUS_COLOR[status]
  const ringClass =
    status === 'attention'
      ? ' is-attention'
      : status === 'error'
        ? ' is-error'
        : status === 'working'
          ? ' is-working'
          : ''
  const ended = (status === 'exited' || status === 'error') && !spawnError

  // Focused = maximized to the viewport (real refit → more rows/cols, crisp
  // text, correct mouse selection). Otherwise the pane sits in its tiled slot.
  const style = focused
    ? {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        transform: `translate(${RAIL_INSET}px, ${PAD}px)`,
        width: Math.max(MIN_FOCUS_SIZE, stageW - RAIL_INSET - PAD),
        height: Math.max(MIN_FOCUS_SIZE, stageH - PAD * 2)
      }
    : {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        transform: `translate(${agent.x}px, ${agent.y}px)`,
        width: agent.w,
        height: agent.h
      }

  const commitRename = (): void => {
    renameAgent(id, draft.trim())
    setEditing(false)
  }

  const runSearch = (dir: 'next' | 'prev', q = query): void => {
    if (!q) return
    if (dir === 'next') searchRef.current?.findNext(q)
    else searchRef.current?.findPrevious(q)
  }

  // Closing find hands focus back to the terminal — no extra click to resume.
  const closeSearch = (): void => {
    setSearchOpen(false)
    termRef.current?.focus()
  }

  // Show "shared" when an isolated terminal silently fell back to the project dir.
  const downgraded = agent.isolation === 'worktree' && isolated === false

  return (
    <>
    <div
      className={
        'vec-pane' +
        (selected ? ' is-selected' : '') +
        (focused ? ' is-focused' : '') +
        ringClass +
        (closing ? ' is-closing' : '') +
        (doneFlash ? ' is-done-flash' : '')
      }
      data-id={id}
      style={style}
    >
      <div
        className="vec-pane__header"
        title={focused ? 'Double-click to restore' : 'Double-click to focus'}
        // Clicking the header (title/dot/empty chrome) hands keyboard focus back to
        // the terminal, so re-clicking the active pane after focus left it (a modal,
        // the rail…) resumes typing. On *click*, not pointerdown: mousedown on the
        // non-focusable header blurs the textarea, so focusing earlier gets undone —
        // click fires after that blur and sticks. Capture phase so Moveable (which
        // owns the header as its drag target) can't swallow it. Skip inputs/buttons
        // so the rename field and branch/close/restore keep their focus.
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('input, button')) return
          if (!spawnError) termRef.current?.focus()
        }}
        onDoubleClick={() => (focused ? clearFocus() : focusTerminal(id))}
      >
        <span
          className={
            'vec-pane__dot' +
            (status === 'exited' ? ' vec-pane__dot--done' : '') +
            (status === 'working' ? ' vec-pane__dot--working' : '')
          }
          style={{ background: dotColor }}
        />
        {doneFlash && (
          <span className="vec-pane__done-check" aria-hidden="true">
            ✓
          </span>
        )}
        <AgentBadge id={agent.agentId} label={agent.agentLabel} />
        {editing ? (
          <input
            className="vec-pane__rename"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') {
                e.stopPropagation()
                setEditing(false)
              }
            }}
          />
        ) : (
          <span
            className="vec-pane__title"
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraft(agent.label)
              setEditing(true)
            }}
          >
            {agent.label}
          </span>
        )}
        {status === 'working' && workingSince ? <WorkTimer since={workingSince} /> : null}
        {downgraded ? (
          <span
            className="vec-pane__branch vec-pane__branch--shared"
            title="Worktree isolation unavailable: running in the shared project directory"
          >
            shared
          </span>
        ) : (
          agent.isolation === 'worktree' &&
          branch && (
            <button
              className="vec-pane__branch vec-pane__branch--btn"
              title="Review changes & merge"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setDiffAgentId(id)
              }}
            >
              {displayBranch(branch)}
            </button>
          )
        )}
        {!focused && agentCount > 1 && (
          // Hidden while maximized: the tiled geometry it changes isn't visible
          // there, so the toggle would read as a broken button. Also hidden with
          // a single pane, where "wider" has nothing to expand against.
          <button
            className="vec-pane__wide"
            title={agent.wide ? 'Normal width' : 'Wider card'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              toggleWide(id)
            }}
          >
            {agent.wide ? <IconNarrow /> : <IconWide />}
          </button>
        )}
        {focused && (
          <button
            className="vec-pane__branch vec-pane__branch--btn"
            title="Restore to the grid"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              clearFocus()
            }}
          >
            Restore
          </button>
        )}
        <button
          className="vec-pane__close"
          title="Remove terminal"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void beginClose()
          }}
        >
          <IconClose />
        </button>
      </div>
      {spawnError ? (
        <div className="vec-pane__error">
          <div className="vec-pane__error-title">Couldn’t start the shell</div>
          <div className="vec-pane__error-msg">{spawnError}</div>
          <button className="vec-pane__retry" autoFocus onPointerDown={(e) => e.stopPropagation()} onClick={relaunch}>
            Retry
          </button>
        </div>
      ) : (
        <div className="vec-pane__body">
          <div
            className="vec-pane__term"
            data-term-theme={agent.termTheme ?? 'auto'}
            ref={termHostRef}
            // Focusing/typing in a terminal selects it (React onFocus fires when
            // xterm's hidden textarea gains focus). Guarded so it only updates
            // the store when the selection actually changes.
            onFocus={() => {
              const w = wsById(useStore.getState(), workspaceId)
              if (!w || w.selectedIds.length !== 1 || w.selectedIds[0] !== id)
                useStore.getState().setSelected([id])
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
            }}
            // Dropping files inserts their quoted paths, like any terminal.
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(e) => {
              e.preventDefault()
              const paths = Array.from(e.dataTransfer.files)
                .map((f) => window.api.getPathForFile(f))
                .filter(Boolean)
              if (paths.length) {
                termRef.current?.paste(quotePaths(paths, agent.shellId))
                termRef.current?.focus()
              }
            }}
          />

          {searchOpen && (
            <div className="vec-pane__search" onPointerDown={(e) => e.stopPropagation()}>
              <input
                className="vec-pane__search-input"
                autoFocus
                placeholder="Find"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  runSearch('next', e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runSearch(e.shiftKey ? 'prev' : 'next')
                  else if (e.key === 'Escape') {
                    e.stopPropagation()
                    closeSearch()
                  }
                }}
              />
              <button className="vec-pane__search-btn" title="Previous (Shift+Enter)" onClick={() => runSearch('prev')}>
                ‹
              </button>
              <button className="vec-pane__search-btn" title="Next (Enter)" onClick={() => runSearch('next')}>
                ›
              </button>
              <button className="vec-pane__search-btn" title="Close (Esc)" onClick={closeSearch}>
                ✕
              </button>
            </div>
          )}

          {ended && (
            <div className="vec-pane__ended" onPointerDown={(e) => e.stopPropagation()}>
              <span>Process ended</span>
              <button className="vec-pane__relaunch" onClick={relaunch}>
                Relaunch
              </button>
            </div>
          )}

          {menu && (
            <>
              <div
                className="vec-pane__menu-backdrop"
                onPointerDown={() => setMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu(null)
                }}
              />
              <div
                className="vec-pane__menu"
                style={{ left: menu.x, top: menu.y }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  className="vec-pane__menu-item"
                  disabled={!termRef.current?.hasSelection()}
                  onClick={copySelection}
                >
                  Copy
                </button>
                <button className="vec-pane__menu-item" onClick={paste}>
                  Paste
                </button>
                <button
                  className="vec-pane__menu-item"
                  onClick={() => {
                    termRef.current?.selectAll()
                    setMenu(null)
                  }}
                >
                  Select all
                </button>
                <button
                  className="vec-pane__menu-item"
                  onClick={() => {
                    termRef.current?.clear()
                    setMenu(null)
                  }}
                >
                  Clear
                </button>
                <div className="vec-pane__menu-sep" />
                <div className="vec-pane__menu-head">Terminal theme</div>
                {(
                  [
                    ['auto', 'Match app'],
                    ['dark', 'Always dark'],
                    ['light', 'Always light']
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    className={
                      'vec-pane__menu-item' +
                      ((agent.termTheme ?? 'auto') === mode ? ' is-checked' : '')
                    }
                    onClick={() => {
                      useStore.getState().setAgentRuntime(id, { termTheme: mode })
                      setMenu(null)
                      termRef.current?.focus()
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>

    {/* Rendered via a portal: a position:fixed modal inside the stage transform
        would be positioned relative to the pane, not the screen. */}
    {closePrompt &&
      createPortal(
        <div className="modal" onPointerDown={() => setClosePrompt(null)}>
          <div className="confirm" onPointerDown={(e) => e.stopPropagation()}>
            {closePrompt.checking ? (
              <div className="confirm__body">Checking for uncommitted changes…</div>
            ) : closePrompt.shared ? (
              <>
                <div className="confirm__title">Close “{agent.label}”?</div>
                <div className="confirm__body">
                  This ends the terminal’s process. Nothing on disk is deleted.
                </div>
                <div className="confirm__actions">
                  <button className="confirm__btn" onClick={() => setClosePrompt(null)}>
                    Cancel
                  </button>
                  <button
                    className="confirm__btn confirm__btn--danger"
                    onClick={() => {
                      removeAgent(id)
                      setClosePrompt(null)
                    }}
                  >
                    Close terminal
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="confirm__title">Close “{agent.label}”?</div>
                <div className="confirm__body">
                  {closePrompt.dirty ? (
                    <>
                      This branch has{' '}
                      <b>
                        {closePrompt.count > 0 ? closePrompt.count : 'uncommitted'}{' '}
                        {closePrompt.count === 1 ? 'change' : 'changes'}
                      </b>{' '}
                      that aren’t merged yet. Deleting the worktree permanently loses them.
                      committed and uncommitted alike.
                    </>
                  ) : (
                    'This will delete the terminal’s worktree and branch. No uncommitted changes were found.'
                  )}
                </div>
                <div className="confirm__actions">
                  <button className="confirm__btn" onClick={() => setClosePrompt(null)}>
                    Cancel
                  </button>
                  <button
                    className="confirm__btn confirm__btn--safe"
                    title="Close the terminal but keep its branch + worktree on disk"
                    onClick={() => {
                      removeAgent(id, { keepWorktree: true })
                      setClosePrompt(null)
                    }}
                  >
                    Keep branch
                  </button>
                  <button
                    className="confirm__btn confirm__btn--danger"
                    onClick={() => {
                      removeAgent(id)
                      setClosePrompt(null)
                    }}
                  >
                    Delete worktree
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// Memoized: when the store changes, only panes whose agent object actually
// changed re-render (status flips touch a single agent, not the whole list).
export default memo(TerminalPane)
