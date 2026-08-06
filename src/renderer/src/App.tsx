import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Titlebar from './components/Titlebar'
import Rail from './components/Rail'
import Stage from './components/Stage'
import Toasts from './components/Toasts'
import Home from './components/Home'
import ProjectBar from './components/ProjectBar'
import UpdateBanner from './components/UpdateBanner'
import Modal from './components/Modal'

// On-demand overlays — split out of the initial chunk. They're never the first
// view, so keeping them out of it buys real startup time; the cost is a possible
// chunk fetch on first open, which OverlayLoading below covers.
const Settings = lazy(() => import('./components/Settings'))
const CommandPalette = lazy(() => import('./components/CommandPalette'))
const DiffPanel = lazy(() => import('./components/DiffPanel'))
const Feedback = lazy(() => import('./components/Feedback'))
// Docked (not an overlay), but still lazy — the file panel's body pulls in the
// editor/tree chunk (Phase 3), which the first stage view never needs.
const FilePanel = lazy(() => import('./components/FilePanel'))

/**
 * Suspense fallback for the overlay chunks. It used to be `null`: on a cold
 * chunk (first ⌘K of the session, a slow disk, an app that was just updated)
 * clicking Settings or Diff painted absolutely nothing for a beat, which reads
 * as a dead button — so people click again, and again. A backdrop + spinner
 * makes the wait legible and swallows those repeat clicks. Deliberately NOT a
 * dialog: there is nothing to label or focus yet, and announcing an empty
 * dialog only to replace it milliseconds later is worse than staying quiet.
 */
function OverlayLoading(): JSX.Element {
  return (
    <div className="modal modal--loading">
      <div className="modal__spinner" role="status" aria-label="Loading" />
    </div>
  )
}
import { useStore, activeWs, useActiveAgents, NEEDS_ATTENTION } from './store'
import {
  restoreWorkspaces,
  saveWorkspaces,
  closeWorkspaceById,
  persistedSignature
} from './openProject'
import { installPowerIdle } from './powerIdle'
import { initWindowFocus } from './windowFocus'
import { applyAccent } from './accent'
import {
  handleMenuEdit,
  terminals,
  focusActiveTerminal,
  refitAgents,
  flushAgents,
  pasteIntoTerminal
} from './terminalRegistry'

export default function App(): JSX.Element {
  const liveWorkspaces = useStore((s) => s.liveWorkspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const activeAgents = useActiveAgents()
  const setShells = useStore((s) => s.setShells)
  const setAgentClis = useStore((s) => s.setAgentClis)
  const setStageSize = useStore((s) => s.setStageSize)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const feedbackOpen = useStore((s) => s.feedbackOpen)
  const diffAgentId = useStore((s) => activeWs(s)?.diffAgentId ?? null)
  // The right-docked file panel is part of the layout (not an overlay): when
  // open it shrinks the stage from the right, and the stage's ResizeObserver
  // re-tiles every card. Both flags come from the active workspace / global width.
  const filePanelOpen = useStore((s) => activeWs(s)?.filePanel.open ?? false)
  const filePanelWidth = useStore((s) => s.filePanelWidth)
  const zoomFactor = useStore((s) => s.settings.zoomFactor)
  const accent = useStore((s) => s.settings.accent)
  const wallpaper = useStore((s) => s.settings.wallpaper)
  const terminalOpacity = useStore((s) => s.settings.terminalOpacity)
  const windowTranslucency = useStore((s) => s.settings.windowTranslucency)
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  // Ids snapshotted when a bulk close is requested (⌘W on a multi-selection, or
  // the palette command) — one confirm closes all. Store-held (on the active
  // workspace) so the palette can raise it too; this component owns the confirm UI.
  const bulkCloseIds = useStore((s) => activeWs(s)?.bulkCloseIds ?? null)
  const clearBulkClose = useStore((s) => s.clearBulkClose)
  // Workspace tab awaiting close confirmation (tab × or palette). Closing a tab
  // kills every PTY in it, so it always confirms; this component owns the modal.
  const confirmWorkspaceCloseId = useStore((s) => s.confirmWorkspaceCloseId)
  const clearWorkspaceClose = useStore((s) => s.clearWorkspaceClose)
  const closingWs = confirmWorkspaceCloseId
    ? liveWorkspaces.find((w) => w.id === confirmWorkspaceCloseId)
    : undefined
  const saveTimer = useRef<number>()
  const stageBoxRef = useRef<HTMLDivElement>(null)

  // Detect the shells + agent CLIs installed on this machine, once on launch.
  // Panes hold their spawn until shells resolve, so a REJECTED detection must
  // still settle the flag (with an empty list) or every terminal would wait
  // forever. An empty list just means "use the platform default".
  useEffect(() => {
    void window.api.shells.list().catch(() => []).then(setShells)
    void window.api.agents.list().catch(() => []).then(setAgentClis)
  }, [setShells, setAgentClis])

  // Tag the platform so CSS can adapt mac chrome (traffic lights, notch safe-area).
  useEffect(() => {
    document.body.classList.toggle('is-mac', window.api.platform === 'darwin')
  }, [])

  // Freeze decorative animation (aurora, emblem glow) while the window is
  // unfocused, hidden, or the user has gone idle — see powerIdle.ts.
  useEffect(() => installPowerIdle(), [])

  // Desaturate the whole UI while this window is not the key window, the way
  // native apps do — see windowFocus.ts.
  useEffect(() => initWindowFocus(), [])

  // Reopen every live workspace from last session (spawning all their agents) and
  // restore which one was in front. Falls back to the last recent project.
  useEffect(() => {
    void restoreWorkspaces()
  }, [])

  // Measure the shared stage box (one per window) and feed it to the store,
  // which re-tiles EVERY live workspace. Deliberately here, not per-Stage: a
  // background workspace's Stage is visibility-hidden and must never report 0.
  useEffect(() => {
    const el = stageBoxRef.current
    if (!el) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setStageSize(el.clientWidth, el.clientHeight))
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [setStageSize])

  // Bringing a workspace to the foreground: refit its terminals (they were not
  // laid out at all while hidden) and hand keyboard focus to its active pane, so
  // switching tabs lands you typing immediately.
  //
  // TWO rAFs, not one: the layer is content-visibility:hidden while backgrounded,
  // so removing that only restores the subtree's layout on the NEXT frame. A
  // single rAF measured a pane that still had no box, the fit was skipped, and
  // the terminal kept a stale size if the window had been resized meanwhile.
  useEffect(() => {
    if (!activeWorkspaceId) return
    let inner = 0
    const raf = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const ws = useStore.getState().liveWorkspaces.find((w) => w.id === activeWorkspaceId)
        if (!ws) return
        const ids = ws.agents.map((a) => a.id)
        // Background panes buffer their PTY writes (TerminalPane) — replay them
        // before refit/focus so the workspace surfaces fully up to date.
        flushAgents(ids)
        refitAgents(ids)
        focusActiveTerminal()
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(inner)
    }
  }, [activeWorkspaceId])

  // Persistent update reminder. The main process reads the app repo's release
  // feed; we re-check on a delay after launch and then periodically, stashing
  // the result so the persistent UpdateBanner nags until the user actually
  // updates (the "continuous notification" the feature is about). The banner is
  // the single update surface — no toast twin cluttering the corner — and its
  // tone escalates the longer the release has gone un-installed. Silent on
  // failure and when up to date.
  useEffect(() => {
    const runCheck = (): void => {
      void window.api.update.check().then((u) => useStore.getState().setUpdate(u))
    }
    // On Windows the check above also starts an in-place background download;
    // its progress stream upgrades the banner button to "Restart to update".
    const offState = window.api.update.onState((st) => useStore.getState().setUpdateState(st))
    // Delay the first check so it never competes with startup, then re-check
    // every 6h to catch releases cut while a long session stays open.
    const first = window.setTimeout(runCheck, 5000)
    const interval = window.setInterval(runCheck, 6 * 60 * 60 * 1000)
    return () => {
      offState()
      window.clearTimeout(first)
      window.clearInterval(interval)
    }
  }, [])

  // Apply the interface zoom (scales the whole app for high-DPI displays).
  useEffect(() => {
    window.api.zoom.set(zoomFactor)
  }, [zoomFactor])

  // Mirror the active workspace's "needs you" count to the OS (taskbar flash /
  // dock badge), so a backgrounded window still signals waiting agents. The memo
  // derives a plain number, so the effect — and the IPC send — only fires when it
  // changes, not on every agents-array churn. (Cross-workspace attention is
  // surfaced by the tab badges, not the taskbar, in this version.)
  const attentionCount = useMemo(
    () => activeAgents.filter((a) => NEEDS_ATTENTION.includes(a.status ?? 'starting')).length,
    [activeAgents]
  )
  useEffect(() => {
    window.api.attention.set(attentionCount)
  }, [attentionCount])

  // Clicking a desktop notification lands on the agent that raised it — same
  // "bring it to the foreground without force-maximizing" behavior as the rail's
  // attention bell, so both entry points stay consistent. revealAgent guards the
  // ghost-id case (pane closed between the notification and the click) itself,
  // and brings the agent's workspace forward if it's a background one.
  useEffect(() => {
    return window.api.notify.onClick((agentId) => {
      useStore.getState().revealAgent(agentId)
    })
  }, [])

  // macOS Edit-menu (⌘C/⌘V/⌘A) → routed by focus (terminal vs. plain input).
  // No-op on Windows/Linux, where the main process never sends these.
  useEffect(() => {
    return window.api.menu.onEdit((action) => void handleMenuEdit(action))
  }, [])

  // Windows/Linux paste fallback. xterm only handles Ctrl+V while its textarea is
  // the focused element; if focus has drifted onto a pane header / the stage /
  // nothing, Ctrl+V would dead-end (and paste tools like Wispr Flow warn "click a
  // text box first"). Route it to the active terminal instead. macOS is already
  // covered by the Edit-menu path above (handleMenuEdit), so skip it there to
  // avoid a double paste. When xterm's own textarea or a plain input is focused,
  // let their native handlers own it.
  useEffect(() => {
    if (window.api.platform === 'darwin') return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return
      const el = document.activeElement as HTMLElement | null
      if (el?.closest?.('.vec-pane__term')) return // xterm handles it itself
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return // native input
      const ws = activeWs(useStore.getState())
      // Only an UNAMBIGUOUS target: the maximized pane, or the sole selection.
      // Under a multi-select there's no single active terminal, so pasting into
      // selectedIds[0] could auto-run a clipboard command in a pane the user didn't
      // mean — keep suppressing it there (paste dead-ends, which is the safe choice).
      const id = ws?.focusedId ?? (ws?.selectedIds.length === 1 ? ws.selectedIds[0] : null)
      const term = id ? terminals.get(id) : null
      if (!term) return
      e.preventDefault()
      term.focus()
      // Pass the target pane's shell so copied file paths are quoted with the
      // right escaping rules (see terminalRegistry.quotePaths).
      void pasteIntoTerminal(term, ws?.agents.find((a) => a.id === id)?.shellId)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // When every overlay closes (palette / settings / diff / shortcuts), hand keyboard focus
  // back to the active terminal. Dismissing an overlay unmounts its input and
  // React drops focus to <body>; since selectedIds doesn't change, TerminalPane's
  // selection-driven focus effect never re-fires, so typing would dead-end until
  // the user clicks a pane. rAF lets the overlay finish unmounting first.
  const overlayOpen = settingsOpen || paletteOpen || feedbackOpen || !!diffAgentId
  const prevOverlayOpen = useRef(false)
  useEffect(() => {
    if (prevOverlayOpen.current && !overlayOpen) requestAnimationFrame(focusActiveTerminal)
    prevOverlayOpen.current = overlayOpen
  }, [overlayOpen])

  // When the OS window regains focus (returning from Wispr Flow, alt-tab, another
  // app), Chromium doesn't reliably restore DOM focus to xterm's hidden textarea —
  // it often falls to <body>. Dictation/paste tools (Wispr Flow) then see no focused
  // text field and refuse to insert ("click a text box first"), and typed input
  // dead-ends. Re-focus the active terminal — but ONLY when focus actually fell
  // through (body/null) and no overlay owns it, so we never steal from a focused
  // rename/search field or a terminal that already has focus. rAF lets Chromium's
  // own focus restoration settle first.
  useEffect(() => {
    // Re-detect agent CLIs on focus too: "install claude, alt-tab back" should
    // just work — the launch-time detect otherwise pins the + menu until a full
    // app restart. Throttled (focus can flap on overlay/dialog churn) and the
    // store only updates when the detected set actually changed, so the common
    // no-change case re-renders nothing.
    let lastAgentScan = 0
    const rescanAgents = (): void => {
      if (Date.now() - lastAgentScan < 5000) return
      lastAgentScan = Date.now()
      void window.api.agents.list().then((next) => {
        const st = useStore.getState()
        // The launch-time detect hasn't landed yet — let it be the baseline,
        // or every pre-installed CLI would toast as "newly detected".
        if (!st.agentClisLoaded) return
        const prevIds = st.agentClis.map((c) => c.id)
        // detectAgents returns a stable (KNOWN_AGENTS) order, so a positional
        // compare is an exact set compare.
        if (next.length === prevIds.length && next.every((c, i) => c.id === prevIds[i])) return
        st.setAgentClis(next)
        for (const c of next) {
          if (!prevIds.includes(c.id)) {
            st.pushToast(`${c.label} detected. Available under +`, 'success')
          }
        }
      })
    }
    const onFocus = (): void => {
      rescanAgents()
      requestAnimationFrame(() => {
        const st = useStore.getState()
        const ws = activeWs(st)
        if (st.settingsOpen || st.paletteOpen || st.feedbackOpen || ws?.diffAgentId) return
        const el = document.activeElement
        if (el && el !== document.body) return
        // A multi-select has no single active terminal; focusing selectedIds[0] would
        // fire its onFocus → setSelected([id]) and silently collapse the selection.
        // Leave focus on <body> in that case (typing already has no single target).
        if (!ws?.focusedId && (ws?.selectedIds.length ?? 0) > 1) return
        // If a pane's search box is open, its input is the intended target — restore
        // focus there instead of stealing it into the terminal.
        const search = document.querySelector('.vec-pane__search-input') as HTMLElement | null
        if (search) {
          search.focus()
          return
        }
        focusActiveTerminal()
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Load the chosen wallpaper (read in main → data URL so CSP stays strict).
  useEffect(() => {
    if (!wallpaper) {
      setWallpaperUrl(null)
      return
    }
    let cancelled = false
    void window.api.wallpaper.read(wallpaper).then((url) => {
      if (!cancelled) setWallpaperUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [wallpaper])

  // Terminal background opacity (lower reveals the wallpaper behind).
  useEffect(() => {
    document.documentElement.style.setProperty('--term-alpha', String(terminalOpacity))
  }, [terminalOpacity])

  // Frosted-glass blur on terminals is only enabled with a wallpaper (it's the
  // most expensive thing to animate; off otherwise for max smoothness).
  useEffect(() => {
    document.body.classList.toggle('has-wallpaper', !!wallpaperUrl)
  }, [wallpaperUrl])

  // Window backdrop. The main process owns the real setting (it needs it before
  // the renderer exists), so push ours to it and let CSS paint an opaque scene
  // when the desktop is no longer showing through. Runs on mount too, which
  // keeps the two copies in step if either drifts.
  useEffect(() => {
    document.body.classList.toggle('is-opaque-window', !windowTranslucency)
    void window.api.window.setTranslucency(windowTranslucency)
  }, [windowTranslucency])

  // Accent colour drives the whole palette.
  useEffect(() => {
    applyAccent(accent)
  }, [accent])

  // Keyboard shortcuts: ⌘ on macOS, Ctrl+Shift on Windows/Linux (avoids the
  // shell's own Ctrl-key readline bindings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useStore.getState()
      const ws = activeWs(st)
      if (e.key === 'Escape') {
        if (ws?.diffAgentId) st.setDiffAgentId(null)
        else if (st.paletteOpen) st.setPaletteOpen(false)
        else if (st.feedbackOpen) st.setFeedbackOpen(false)
        else if (st.settingsOpen) st.setSettingsOpen(false)
        else if (ws?.focusedId) {
          // Never steal Esc from a focused terminal — vim and Claude Code use
          // it constantly. Exit focus with ⌘/Ctrl⇧Enter, double-click, or Esc
          // when the terminal doesn't have keyboard focus.
          const inTerm = (document.activeElement as HTMLElement | null)?.closest?.(
            '.vec-pane__term'
          )
          if (!inTerm) st.clearFocus()
        }
        return
      }
      // Switch workspace — ⌘⌥1…9 (Ctrl+Alt on Win/Linux). Brings that live tab to
      // the foreground; no-op if that slot is empty. Exclude AltGr (which reports
      // as Ctrl+Alt): on EU layouts it types digits/brackets, and swallowing those
      // would stop the user entering them into the terminal. Only preventDefault
      // when we actually switch, so an unhandled combo falls through.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        !e.getModifierState('AltGraph') &&
        /^[1-9]$/.test(e.key)
      ) {
        const target = st.liveWorkspaces[Number(e.key) - 1]
        if (target && target.id !== st.activeWorkspaceId) {
          e.preventDefault()
          st.setActiveWorkspace(target.id)
        }
        return
      }
      // Interface zoom — plain ⌘/Ctrl with +/−/0 (like browsers / VS Code).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const round = (v: number): number => Math.round(v * 10) / 10
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          st.setSetting('zoomFactor', Math.min(1.8, round(st.settings.zoomFactor + 0.1)))
          return
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          st.setSetting('zoomFactor', Math.max(0.7, round(st.settings.zoomFactor - 0.1)))
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          st.setSetting('zoomFactor', 1)
          return
        }
      }

      const mod = e.metaKey || (e.ctrlKey && e.shiftKey)
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        st.setPaletteOpen(!st.paletteOpen)
        return
      }
      // ⌘/ (Ctrl+Shift+/): deep-link to the Shortcuts tab in Settings. On
      // layouts where Shift+/ types '?', the Windows chord reports key === '?' —
      // match both. Toggles: press again while it's showing to close.
      if (e.key === '/' || e.key === '?') {
        e.preventDefault()
        if (st.settingsOpen && st.settingsTab === 'shortcuts') st.setSettingsOpen(false)
        else {
          st.setSettingsTab('shortcuts')
          st.setSettingsOpen(true)
        }
        return
      }
      // With an overlay up, the stage is hidden — don't let ⌘T/⌘1/⌘2/⌘W/cycle
      // fire actions the user can't see (spawning panes behind Settings, silently
      // swapping layout, stealing selection). Only Escape / ⌘K / ⌘/ operate above.
      if (st.settingsOpen || st.paletteOpen || st.feedbackOpen || ws?.diffAgentId) return
      if (!ws) return
      if (k === 't') {
        e.preventDefault()
        st.addAgent()
      } else if (k === '1') {
        e.preventDefault()
        st.setLayoutMode('grid')
      } else if (k === '2') {
        e.preventDefault()
        st.setLayoutMode('columns')
      } else if (k === 'e') {
        // ⌘E / Ctrl+Shift+E — VS Code's Explorer toggle (deliberately NOT F,
        // which the terminal owns for find).
        e.preventDefault()
        st.toggleFilePanel()
      } else if (k === 'w') {
        if (ws.selectedIds.length >= 2) {
          // Multi-selection: ONE confirm for the whole batch (the per-pane flow
          // would stack N dialogs). Safe default — worktrees are kept.
          e.preventDefault()
          st.requestBulkClose(ws.selectedIds)
        } else {
          const sel = ws.selectedIds[0]
          if (sel) {
            e.preventDefault()
            // Guarded close (worktree dirty-check + confirm) — never force-delete.
            st.requestClose(sel)
          }
        }
      } else if (e.code === 'Enter' && e.shiftKey) {
        // ⌘⇧Enter (Ctrl+Shift+Enter): toggle maximize on the current terminal.
        e.preventDefault()
        if (ws.focusedId) st.clearFocus()
        else {
          const target = ws.selectedIds[0] ?? ws.agents[0]?.id
          if (target) st.focusTerminal(target)
        }
      } else if ((e.code === 'BracketRight' || e.code === 'BracketLeft') && e.shiftKey) {
        // ⌘⇧]/[ (Ctrl+Shift+]/[): cycle terminals — follows maximize if active.
        e.preventDefault()
        const list = ws.agents
        if (!list.length) return
        const dir = e.code === 'BracketRight' ? 1 : -1
        const curId = ws.focusedId ?? ws.selectedIds[0]
        const cur = list.findIndex((a) => a.id === curId)
        const base = cur === -1 ? (dir === 1 ? -1 : 0) : cur
        const next = list[(base + dir + list.length) % list.length]
        if (ws.focusedId) st.focusTerminal(next.id)
        else st.setSelected([next.id])
        terminals.get(next.id)?.focus()
      } else if (
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown'
      ) {
        // ⌘Arrow (Ctrl+Shift+Arrow): move selection to the geometrically nearest
        // card in that direction, using the tiled rect centres. No wrap-around —
        // pressing into an edge is a no-op, which is what "spatial" implies.
        e.preventDefault()
        const list = ws.agents
        const curId = ws.focusedId ?? ws.selectedIds[0]
        const cur = list.find((a) => a.id === curId)
        if (!cur) return
        const cx = cur.x + cur.w / 2
        const cy = cur.y + cur.h / 2
        const horiz = e.code === 'ArrowLeft' || e.code === 'ArrowRight'
        const sign = e.code === 'ArrowRight' || e.code === 'ArrowDown' ? 1 : -1
        let best: (typeof list)[number] | null = null
        let bestP = Infinity
        let bestS = Infinity
        for (const a of list) {
          if (a.id === cur.id) continue
          const dx = a.x + a.w / 2 - cx
          const dy = a.y + a.h / 2 - cy
          // Primary = travel along the pressed axis (must be strictly forward);
          // secondary breaks ties between cards equally far in that direction.
          // The ±0.5 slop absorbs the integer rounding in laidOut, so cards in
          // the same row/column compare as equals despite 1px centre drift.
          const p = (horiz ? dx : dy) * sign
          const s2 = Math.abs(horiz ? dy : dx)
          if (p <= 0.5) continue
          if (p < bestP - 0.5 || (Math.abs(p - bestP) <= 0.5 && s2 < bestS)) {
            best = a
            bestP = p
            bestS = s2
          }
        }
        if (!best) return
        // Follows maximize like the cycle chord: retarget the maximized pane to
        // the destination instead of dropping back to the grid.
        if (ws.focusedId) st.focusTerminal(best.id)
        else st.setSelected([best.id])
        terminals.get(best.id)?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Autosave every live workspace's stage, debounced. The signature is derived
  // from the snapshot that actually gets written, so there is no list of fields
  // — or of store slices — maintained here to fall out of step with it. Runtime
  // churn (status/pty id) is stripped before it reaches the signature, so a
  // streaming agent never triggers a write. Background workspaces autosave too,
  // so their edits survive a close/restart.
  const persistedKey = useStore(persistedSignature)
  useEffect(() => {
    window.clearTimeout(saveTimer.current)
    // One write for the whole tab set — saveWorkspaces reads the store itself,
    // so it always persists the latest state rather than this render's snapshot.
    saveTimer.current = window.setTimeout(() => void saveWorkspaces(), 400)
    return () => window.clearTimeout(saveTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedKey])

  // The debounce above was the ONLY path to disk, so quitting (or reloading)
  // within 400ms of a change silently threw it away — move a pane, hit ⌘Q, lose
  // the move. Flush the pending write on teardown. Writes are serialized in the
  // main process, so this can't race the debounced save it pre-empts.
  useEffect(() => {
    const flush = (): void => {
      window.clearTimeout(saveTimer.current)
      void saveWorkspaces()
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true">
        <span className="aurora__orb aurora__orb--1" />
        <span className="aurora__orb aurora__orb--2" />
        <span className="aurora__orb aurora__orb--3" />
      </div>
      {wallpaperUrl && (
        <div className="wallpaper" style={{ backgroundImage: `url(${wallpaperUrl})` }} />
      )}
      <Titlebar />
      <ProjectBar />
      <UpdateBanner />
      <div
        className="app__main"
        style={{ ['--filepanel-w' as any]: filePanelOpen ? filePanelWidth + 'px' : '0px' }}
      >
        <Rail />
        <div className="app__stage" ref={stageBoxRef}>
          {/* One persistently-mounted Stage per live workspace — only the active
             one is visible (the rest are visibility-hidden but laid out, so their
             PTYs keep streaming and show crisp on switch). Home when none open. */}
          {liveWorkspaces.length === 0 ? (
            <Home />
          ) : (
            liveWorkspaces.map((w) => (
              <div
                key={w.id}
                className={'workspace-layer' + (w.id === activeWorkspaceId ? ' is-active' : '')}
                aria-hidden={w.id !== activeWorkspaceId}
              >
                <Stage workspaceId={w.id} />
              </div>
            ))
          )}
        </div>
        {/* Docked file panel — sibling of the stage so it occupies the reserved
           --filepanel-w gutter (see .app__stage right). Lazy, so its own
           Suspense boundary keeps the docked layout independent of the overlays. */}
        {filePanelOpen && (
          <Suspense fallback={null}>
            <FilePanel />
          </Suspense>
        )}
      </div>
      <Suspense fallback={<OverlayLoading />}>
        {/* Stacking order mirrors the Escape handler's close order (diff →
           palette → settings), bottom to top: ⌘K over Settings must paint the
           palette ON TOP, not open it hidden underneath with focus stolen. */}
        {settingsOpen && <Settings />}
        {feedbackOpen && <Feedback />}
        {paletteOpen && <CommandPalette />}
        {diffAgentId && <DiffPanel />}
      </Suspense>
      {bulkCloseIds && (
        <Modal
          className="confirm"
          labelledBy="bulk-close-title"
          onClose={clearBulkClose}
          onEscape={clearBulkClose}
        >
          <div className="confirm__title" id="bulk-close-title">Close {bulkCloseIds.length} terminals?</div>
          <div className="confirm__body">
            This ends their processes. Isolated terminals keep their branches and worktrees on
            disk. No work is lost, and you can merge or clean them up later.
          </div>
          <div className="confirm__actions">
            <button className="confirm__btn" onClick={clearBulkClose}>
              Cancel
            </button>
            <button
              className="confirm__btn confirm__btn--danger"
              onClick={() => {
                // keepWorktree for every card: a batch close must never cascade
                // into silent worktree deletion (a no-op for shared panes, and
                // for any pane closed individually in the meantime).
                const { removeAgent } = useStore.getState()
                for (const id of bulkCloseIds) removeAgent(id, { keepWorktree: true })
                clearBulkClose()
              }}
            >
              Close all
            </button>
          </div>
        </Modal>
      )}
      {closingWs &&
        (() => {
          const busy = closingWs.agents.filter(
            (a) => a.status === 'working' || NEEDS_ATTENTION.includes(a.status ?? 'starting')
          ).length
          return (
            <Modal
              className="confirm"
              labelledBy="ws-close-title"
              onClose={clearWorkspaceClose}
              onEscape={clearWorkspaceClose}
            >
              <div className="confirm__title" id="ws-close-title">Close “{closingWs.name}”?</div>
              <div className="confirm__body">
                {busy > 0
                  ? `${busy === 1 ? 'An agent is' : `${busy} agents are`} still busy in this workspace. Closing the tab stops ${busy === 1 ? 'it' : 'them'}. `
                  : 'This ends the workspace’s terminals. '}
                Worktrees and branches stay on disk, and the stage is saved, so you can reopen the
                project to pick up where you left off.
              </div>
              <div className="confirm__actions">
                <button className="confirm__btn" onClick={clearWorkspaceClose}>
                  Cancel
                </button>
                <button
                  className="confirm__btn confirm__btn--danger"
                  onClick={() => {
                    closeWorkspaceById(closingWs.id)
                    clearWorkspaceClose()
                  }}
                >
                  Close workspace
                </button>
              </div>
            </Modal>
          )
        })()}
      <Toasts />
    </div>
  )
}
