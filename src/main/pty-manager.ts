import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import os from 'os'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'

export interface SpawnOptions {
  /** Executable to launch (defaults to the platform shell). */
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
}

type DataCb = (id: string, data: string) => void
type ExitCb = (id: string, code: number, signal?: number) => void

/**
 * Owns every live pseudo-terminal. One PtyManager per app; each agent card
 * gets one session keyed by a uuid. Data/exit are pushed out via callbacks so
 * the main process can forward them to the renderer over IPC.
 */
export class PtyManager {
  private sessions = new Map<string, pty.IPty>()

  constructor(private onData: DataCb, private onExit: ExitCb) {}

  spawn(opts: SpawnOptions): string {
    const id = randomUUID()
    const isWin = process.platform === 'win32'
    const shell = opts.shell || (isWin ? 'powershell.exe' : process.env.SHELL || 'bash')
    // This branch bypasses shells.ts (it fires when a workspace saved on another
    // machine names a shellId we don't have), so it needs the login flag too —
    // otherwise those panes silently lose ~/.zprofile and every PATH it sets.
    // The Windows fallback is powershell.exe, so it needs -NoLogo for the same
    // reason shells.ts does: otherwise the pane opens on the banner + upgrade nag.
    const args =
      opts.args ?? (isWin ? (opts.shell ? [] : ['-NoLogo']) : opts.shell ? [] : ['-l'])

    let proc: pty.IPty
    try {
      // xterm.js renders truecolor; advertise it. "xterm-color" claimed a
      // 16-colour terminal from the 90s and made agent CLIs (Claude Code,
      // aider…) silently degrade their palettes and TUI rendering.
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd || os.homedir(),
        env: {
          ...process.env,
          COLORTERM: 'truecolor',
          ...(opts.env ?? {})
        } as Record<string, string>
      })
    } catch (e) {
      // Surface to the renderer (the invoke promise rejects) so the card can
      // show an inline error + retry instead of hanging on a dead terminal.
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`Could not start "${shell}": ${reason}`)
    }

    proc.onData((d) => this.onData(id, d))
    proc.onExit(({ exitCode, signal }) => {
      this.onExit(id, exitCode, signal)
      this.sessions.delete(id)
    })

    this.sessions.set(id, proc)
    return id
  }

  write(id: string, data: string): void {
    try {
      this.sessions.get(id)?.write(data)
    } catch {
      /* writing to a closed conpty/pipe throws (EPIPE/EPERM) — the process
         already exited; the exit handler will clean up. Ignore. */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.resize(cols, rows)
    } catch {
      /* resize on a dead pty throws on some platforms; ignore */
    }
  }

  kill(id: string): void {
    const proc = this.sessions.get(id)
    if (proc) killTree(proc)
    this.sessions.delete(id)
  }

  killAll(): void {
    for (const proc of this.sessions.values()) killTree(proc)
    this.sessions.clear()
  }
}

/**
 * Kill a pty AND everything it spawned.
 *
 * `IPty.kill()` alone only takes down the shell that node-pty launched. The
 * agent CLI the user actually cares about (`claude`, `aider`, …) is a grandchild,
 * and on Windows ConPTY it is not reliably reaped when its host dies — so closing
 * an agent, recovering from a renderer crash, or quitting the app leaked live
 * `node`/`python` processes that kept holding worktree files open.
 *
 * Windows: taskkill walks the tree by pid. POSIX: node-pty puts the child in its
 * own process group (pid == pgid), so negating the pid signals the whole group.
 */
function killTree(proc: pty.IPty): void {
  const pid = proc.pid
  if (process.platform === 'win32') {
    if (!pid) return
    // taskkill /T covers the ConPTY host AND its descendants, so this fully
    // replaces IPty.kill() — do NOT also call it. Killing the host out from
    // under node-pty and then calling kill() on the now-invalid native handle
    // segfaults the process on teardown. node-pty notices the exit on its own
    // and fires onExit, which is what clears the session map.
    // Non-zero exit just means the tree was already gone; ignore it.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // No such group (already exited) or not permitted — fall back to the pty's
    // own kill, which at least takes the direct child down.
    try {
      proc.kill()
    } catch {
      /* already dead */
    }
  }
}
