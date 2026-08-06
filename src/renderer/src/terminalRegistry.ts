import type { Terminal } from '@xterm/xterm'
import { useStore, activeWs } from './store'

/**
 * Live xterm instances keyed by agent id. TerminalPane (un)registers on
 * mount/unmount so the macOS Edit-menu handler can reach whichever terminal
 * currently holds focus without threading refs through the component tree.
 */
export const terminals = new Map<string, Terminal>()

/**
 * Each pane's FitAddon-driven refit, keyed by agent id. Registered on mount so a
 * workspace's terminals can be re-measured when it's brought to the foreground —
 * background workspaces are laid out while hidden, and a refit on show settles
 * any viewport drift from the visibility flip.
 */
export const fits = new Map<string, () => void>()

/** Refit a set of agents' terminals (the workspace being activated). */
export function refitAgents(ids: string[]): void {
  for (const id of ids) fits.get(id)?.()
}

/**
 * Pending-output flush per pane, keyed by agent id. Panes in a hidden
 * (background) workspace buffer PTY writes instead of feeding xterm per chunk —
 * the DOM renderer pays ANSI parse + DOM mutation for every write even while
 * visibility-hidden. App.tsx flushes a workspace's panes as it comes to the
 * foreground, before refit/focus, so the switch always shows current content.
 */
export const flushes = new Map<string, () => void>()

/** Flush buffered output for a set of agents (the workspace being activated). */
export function flushAgents(ids: string[]): void {
  for (const id of ids) flushes.get(id)?.()
}

/**
 * Force a pane's visible rows to be redrawn.
 *
 * Writing into a terminal whose subtree is still `content-visibility: hidden`
 * puts the text in xterm's buffer but leaves the RENDERED rows stale — and
 * nothing dirties them again until the next chunk of output arrives, so a quiet
 * agent's pane could sit showing yesterday's screen after a workspace switch.
 * (This hid behind the maximize case, where the refit happens to change the
 * pane's size and a resize forces a full redraw. A tab switch doesn't resize
 * anything, so there was nothing to force it.)
 *
 * Called once layout is restored, after flush + refit.
 */
export function refreshAgents(ids: string[]): void {
  for (const id of ids) {
    const t = terminals.get(id)
    // rows is 0 on a terminal that has never been laid out; refresh(0, -1)
    // would be a nonsense range.
    if (t && t.rows > 0) t.refresh(0, t.rows - 1)
  }
}

/**
 * Hand keyboard focus back to the active terminal (the maximized one, else the
 * sole selected one). Called after an overlay closes or a click lands off a pane,
 * so typing never dead-ends on `<body>` when no selection *transition* occurred
 * to trigger TerminalPane's own focus effect.
 */
export function focusActiveTerminal(): void {
  const ws = activeWs(useStore.getState())
  const id = ws?.focusedId ?? ws?.selectedIds[0]
  if (id) terminals.get(id)?.focus()
}

// Diagnostics hook, alongside window.__agentStore. An off-screen pane buffers
// its agent's output instead of writing it to xterm, and the only way to tell
// that apart from "written but not painted" is to read the terminal's BUFFER —
// a subtree with content-visibility:hidden renders nothing either way, so the
// DOM cannot distinguish them. smoke:offscreen uses this to assert the
// buffering actually happens, not merely that nothing is lost. Never used by
// the app itself.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__spymasterTerminalText = (
    id: string
  ): string | null => {
    const t = terminals.get(id)
    if (!t) return null
    const buf = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  }
}

type ShellFamily = 'posix' | 'powershell' | 'cmd'

/** Map a shell id from `shells:list` onto its quoting rules. */
export function shellFamily(shellId?: string): ShellFamily {
  switch (shellId) {
    case 'powershell':
    case 'pwsh':
      return 'powershell'
    case 'cmd':
      return 'cmd'
    case 'gitbash':
    case 'wsl':
    case 'bash':
    case 'bash-opt':
    case 'zsh':
      return 'posix'
    default:
      // Unknown/'default' — assume the platform's usual shell.
      return window.api.platform === 'win32' ? 'powershell' : 'posix'
  }
}

/**
 * Paths → one shell-ready string.
 *
 * This must ESCAPE, not merely detect. The previous version wrapped anything
 * containing `$`, a backtick or a quote in DOUBLE quotes — which is exactly where
 * those characters still expand. A file innocently named `` `id`.txt `` or
 * `$(whoami).txt`, dropped onto a pane, would execute on the agent's command line.
 *
 * Single quotes are the safe container in both posix and PowerShell; only the
 * quote character itself needs escaping, and each family does it differently.
 * cmd.exe has no escape at all, so double quotes are the best available and any
 * embedded quote is dropped rather than left to break out.
 */
export function quotePaths(paths: string[], shellId?: string): string {
  const fam = shellFamily(shellId)
  return paths
    .map((p) => {
      if (fam === 'cmd') return `"${p.replace(/"/g, '')}"`
      if (fam === 'powershell') return `'${p.replace(/'/g, "''")}'`
      return `'${p.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}

/**
 * Paste the OS clipboard into a terminal — the single source of truth for every
 * paste path (xterm Ctrl/⌘+V, context menu, mac Edit menu, the app-level Windows
 * fallback). Reads via the main process (window.api.clipboard) because
 * navigator.clipboard.readText() rejects intermittently in Electron when the
 * window isn't focused, which made paste silently no-op. term.paste() applies
 * bracketed-paste + \r\n cleanup so TUIs/agents receive the text correctly.
 */
export async function pasteIntoTerminal(term: Terminal, shellId?: string): Promise<void> {
  try {
    const t = await window.api.clipboard.read()
    if (t) {
      term.paste(t)
      return
    }
    // No text — copied files paste as quoted paths, like any terminal.
    const files = await window.api.clipboard.readFiles()
    if (files.length) {
      term.paste(quotePaths(files, shellId))
      return
    }
    // A screenshot: a pty can't carry pixels, so forward the raw Ctrl+V byte so
    // TUIs that read the OS clipboard themselves (Claude Code image paste) get it.
    if (await window.api.clipboard.hasImage()) term.input('\x16', true)
  } catch {
    /* clipboard unavailable — nothing to paste */
  }
}

/**
 * Route a macOS Edit-menu command (⌘C/⌘V/⌘A) by focus.
 *
 * A focused terminal → xterm selection + the main-process clipboard (same path
 * as Ctrl/Cmd handling on Windows). A focused plain input (rename / search) →
 * native editing so those fields still copy/paste normally. The distinction is
 * the DOM: xterm's textarea lives inside `.vec-pane__term`; the inputs don't.
 */
export async function handleMenuEdit(action: 'copy' | 'paste' | 'selectAll'): Promise<void> {
  const el = document.activeElement as HTMLElement | null

  const applyToTerm = async (term: Terminal): Promise<void> => {
    if (action === 'copy') {
      if (term.hasSelection()) window.api.clipboard.write(term.getSelection())
    } else if (action === 'paste') {
      await pasteIntoTerminal(term)
      term.focus()
    } else {
      term.selectAll()
    }
  }

  const termHost = el?.closest?.('.vec-pane__term') as HTMLElement | null
  if (termHost) {
    const paneId = (termHost.closest('.vec-pane') as HTMLElement | null)?.dataset.id
    const term = paneId ? terminals.get(paneId) : undefined
    if (term) await applyToTerm(term)
    return
  }

  // Plain input / textarea (rename field, search box).
  const input = el as HTMLInputElement | HTMLTextAreaElement | null
  if (!input || typeof input.value !== 'string') {
    // Nothing has DOM focus (e.g. the user clicked a pane header, then hit ⌘V).
    // Route to the terminal they mean: the focused pane, or the single selected
    // one — so paste "just works" instead of silently going nowhere.
    const ws = activeWs(useStore.getState())
    // Only an unambiguous target — the maximized pane or the sole selection; under a
    // multi-select, paste stays suppressed rather than landing in an arbitrary pane.
    const targetId = ws?.focusedId ?? (ws?.selectedIds.length === 1 ? ws.selectedIds[0] : null)
    const term = targetId ? terminals.get(targetId) : undefined
    if (term) await applyToTerm(term)
    return
  }
  if (action === 'selectAll') {
    input.select?.()
    return
  }
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  if (action === 'copy') {
    const sel = input.value.slice(start, end)
    if (sel) window.api.clipboard.write(sel)
    return
  }
  // paste — splice clipboard text in at the cursor, then fire a native input
  // event so React's controlled value stays in sync.
  const t = await window.api.clipboard.read()
  if (!t) return
  const next = input.value.slice(0, start) + t + input.value.slice(end)
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  setter?.call(input, next)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const pos = start + t.length
  input.setSelectionRange?.(pos, pos)
}
