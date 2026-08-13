import { useEffect, useMemo, useRef, useState } from 'react'
import { IconTerminal, IconGrid, IconColumns, IconSettings, IconBell, IconFiles } from './Icons'
import {
  useStore,
  activeWs,
  useActiveAgents,
  useActiveLayoutMode,
  useActiveProjectPath,
  NEEDS_ATTENTION,
  MAX_AGENTS
} from '../store'
import { modLabel } from '../shortcuts'

/** Below this many terminals, grid and columns produce the same layout, so the
 *  layout toggle is hidden to keep the dock uncluttered. */
const LAYOUT_TOGGLE_MIN = 3

/** Last segment of a folder path — labels the launch target in the new menu. */
function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

/** Minimal floating dock — icons only, refined liquid glass. Workspace switching
 *  lives in the top bar; the rail is just identity + the active stage's tools. */
export default function Rail(): JSX.Element {
  const projectPath = useActiveProjectPath()
  const agents = useActiveAgents()
  const agentClis = useStore((s) => s.agentClis)
  const full = agents.length >= MAX_AGENTS
  // Single shared menu state — opening this closes the project switcher, etc.
  const newOpen = useStore((s) => s.openMenu === 'rail-new')
  const setOpenMenu = useStore((s) => s.setOpenMenu)
  const setNewOpen = (open: boolean): void => setOpenMenu(open ? 'rail-new' : null)
  const layoutMode = useActiveLayoutMode()
  // Derive with useMemo — a selector that returns a fresh array on every call
  // breaks React 18's useSyncExternalStore (unstable snapshot → render crash).
  const attentionIds = useMemo(
    () => agents.filter((a) => NEEDS_ATTENTION.includes(a.status ?? 'starting')).map((a) => a.id),
    [agents]
  )
  const addAgent = useStore((s) => s.addAgent)
  const setLayoutMode = useStore((s) => s.setLayoutMode)
  const revealAgent = useStore((s) => s.revealAgent)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const filePanelOpen = useStore((s) => activeWs(s)?.filePanel.open ?? false)
  const openFilePanel = useStore((s) => s.openFilePanel)
  const closeFilePanel = useStore((s) => s.closeFilePanel)

  // Folder the next launch from this menu targets. Null = inherit the workspace
  // default. Deliberately scoped to one menu opening and shown in the menu, so
  // it can never become invisible sticky state that surprises a later launch.
  const [target, setTarget] = useState<{ path: string; name: string; isGit: boolean } | null>(null)
  useEffect(() => {
    if (!newOpen) setTarget(null)
  }, [newOpen])

  const chooseTarget = async (): Promise<void> => {
    try {
      const ref = await window.api.project.pick()
      if (!ref) return
      const git = await window.api.git.info(ref.path)
      setTarget({ path: ref.path, name: ref.name, isGit: git.isGit })
    } catch (e) {
      console.error('[agentmaster] choose agent folder failed:', e)
      useStore.getState().pushToast('Couldn’t open that folder.', 'error')
    }
  }

  /** Launch options carrying the chosen folder (if any) through to addAgent. */
  const withTarget = (opts?: Parameters<typeof addAgent>[0]): Parameters<typeof addAgent>[0] =>
    target ? { ...opts, projectPath: target.path, isGit: target.isGit } : opts

  const targetLabel = target?.name ?? (projectPath ? baseName(projectPath) : 'No folder')

  // Cycle focus through the agents that currently need you. revealAgent brings
  // each into view WITHOUT maximizing — so a single attention terminal is just
  // selected in place, not zoomed into a redundant "Restore to the grid" state.
  const cycleRef = useRef(0)
  const focusNextAttention = (): void => {
    if (!attentionIds.length) return
    const next = attentionIds[cycleRef.current % attentionIds.length]
    cycleRef.current += 1
    revealAgent(next)
  }

  return (
    <div className="rail-dock">
      <div className="rail">
        {/* Deliberately NOT gated on projectPath. A folderless workspace still
            needs its terminal button: addAgent has no path requirement and the
            PTY falls back to the home directory. Hiding it made "New workspace"
            a dead end — the rail rendered empty with no way to add anything. */}
        <div className="rail__new">
          <button
            className="rail-btn rail-btn--primary"
            onClick={() => (agentClis.length ? setNewOpen(!newOpen) : addAgent())}
            disabled={full}
            aria-label="New terminal"
            data-tip={full ? `Maximum ${MAX_AGENTS} terminals` : `New terminal · ${modLabel('T')}`}
            title={full ? `Maximum ${MAX_AGENTS} terminals` : undefined}
          >
            <IconTerminal />
          </button>
          {newOpen && (
            <>
              <div className="rail__backdrop" onClick={() => setNewOpen(false)} />
              <div className="rail__menu rail__newmenu">
                <button
                  className="rail__menu-item"
                  onClick={() => {
                    setNewOpen(false)
                    addAgent(withTarget())
                  }}
                >
                  New terminal
                </button>
                <div className="rail__menu-sep" />
                <div className="rail__menu-head">Agents</div>
                {agentClis.map((a) => (
                  <button
                    key={a.id}
                    className="rail__menu-item"
                    onClick={() => {
                      setNewOpen(false)
                      addAgent(withTarget({ command: a.command, agentLabel: a.label, agentId: a.id }))
                    }}
                  >
                    Start {a.label}
                  </button>
                ))}
                {/* Where the launches above will run. Shown rather than
                    hidden, because one workspace can hold agents across
                    several repos and "which folder" is no longer obvious. */}
                <div className="rail__menu-sep" />
                <div className="rail__menu-head">Folder</div>
                <div className="rail__menu-target">
                  <span
                    className={'rail__menu-target-name' + (target ? ' is-override' : '')}
                    title={target?.path ?? projectPath ?? 'Agents will start in your home directory'}
                  >
                    {targetLabel}
                  </span>
                  {target ? (
                    <button
                      className="rail__menu-target-btn"
                      onClick={() => setTarget(null)}
                      title="Go back to this workspace’s folder"
                    >
                      Reset
                    </button>
                  ) : (
                    <button
                      className="rail__menu-target-btn"
                      onClick={() => void chooseTarget()}
                      title="Run the next agent in a different folder"
                    >
                      Change…
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Layout is one choice → one segmented control, not two buttons.
           Grid and columns only diverge at 3+ panes, so the toggle stays
           hidden below that — it would be an inert control. */}
        {agents.length >= LAYOUT_TOGGLE_MIN && (
          <div className="rail__seg" role="group" aria-label="Layout" data-mode={layoutMode}>
            <button
              className={'rail__seg-btn' + (layoutMode === 'grid' ? ' is-active' : '')}
              onClick={() => setLayoutMode('grid')}
              aria-label="Grid layout"
              data-tip={`Grid · ${modLabel('1')}`}
            >
              <IconGrid />
            </button>
            <button
              className={'rail__seg-btn' + (layoutMode === 'columns' ? ' is-active' : '')}
              onClick={() => setLayoutMode('columns')}
              aria-label="Columns layout"
              data-tip={`Columns · ${modLabel('2')}`}
            >
              <IconColumns />
            </button>
          </div>
        )}

        {/* Files: one clean toggle for the right-side explorer, at project
           root scope. Active state mirrors the panel's open flag. This one DOES
           need a folder — the explorer is rooted at the workspace path. */}
        {projectPath && (
          <button
            className={'rail-btn' + (filePanelOpen ? ' is-active' : '')}
            onClick={() => (filePanelOpen ? closeFilePanel() : openFilePanel({ kind: 'root' }))}
            aria-label="Toggle file explorer"
            aria-pressed={filePanelOpen}
            data-tip={`Files · ${modLabel('E')}`}
          >
            <IconFiles size={19} />
          </button>
        )}

        <div className="rail__spacer" />

        {attentionIds.length > 0 && (
          <button
            className="rail-btn rail-btn--attention"
            onClick={focusNextAttention}
            aria-label="Focus terminal needing attention"
            data-tip={`${attentionIds.length} terminal${attentionIds.length > 1 ? 's' : ''} need attention`}
          >
            <IconBell />
            <span className="rail-btn__badge">{attentionIds.length}</span>
          </button>
        )}

        {/* The gear opens Settings directly — the dock stays minimal. Command
           palette and keyboard shortcuts live inside Settings (and keep their
           own hotkeys), so they don't need a spot on the rail. */}
        <button
          className="rail-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          data-tip="Settings"
        >
          <IconSettings />
        </button>
      </div>
    </div>
  )
}
