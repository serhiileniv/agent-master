import { existsSync } from 'fs'
import { join } from 'path'
import { resolvedPath } from './env-path'

export interface ShellInfo {
  id: string
  label: string
  command: string
  args: string[]
}

/** Resolve an executable on PATH (Windows-aware extensions). */
function onPath(exe: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  // resolvedPath(), not process.env.PATH: on macOS a Finder/Dock launch inherits
  // launchd's minimal PATH and would miss every Homebrew/nvm/~/.local install.
  for (const dir of resolvedPath().split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, exe + ext)
      try {
        if (existsSync(full)) return full
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

export interface AgentCli {
  id: string
  label: string
  command: string
}

// Known AI coding-agent CLIs, in rough order of popularity.
const KNOWN_AGENTS: { id: string; label: string; bins: string[] }[] = [
  { id: 'claude', label: 'Claude Code', bins: ['claude'] },
  { id: 'codex', label: 'Codex', bins: ['codex'] },
  { id: 'gemini', label: 'Gemini', bins: ['gemini'] },
  { id: 'aider', label: 'Aider', bins: ['aider'] },
  { id: 'cursor', label: 'Cursor Agent', bins: ['cursor-agent'] },
  { id: 'opencode', label: 'opencode', bins: ['opencode'] },
  { id: 'qwen', label: 'Qwen Code', bins: ['qwen'] }
]

/**
 * Detect which agent CLIs are installed on PATH, so they can be launched in one
 * click.
 *
 * Cached, because this is not cheap and it is called on every window focus: a
 * MISSING agent costs a full sweep of PATH (every directory x every executable
 * extension) before it can be ruled out, so on Windows the whole scan can run
 * to ~1000 synchronous existsSync calls — on the main thread, which is also the
 * thread forwarding PTY output. Alt-tabbing repeatedly used to pay that every
 * time.
 *
 * The TTL exists so a CLI the user installs while Spy Master is open still shows up
 * without a restart; it just takes up to a minute.
 *
 * Keyed on the PATH as well as the clock: the background PATH harvest (see
 * env-path.ts) can widen PATH seconds after launch, and a time-only cache would
 * keep serving the pre-harvest answer — "no agents installed" — for the rest of
 * the minute. A changed PATH invalidates immediately.
 */
const AGENT_CACHE_MS = 60_000
let agentCache: { at: number; path: string; agents: AgentCli[] } | null = null

export function detectAgents(): AgentCli[] {
  const now = Date.now()
  const path = resolvedPath()
  if (agentCache && agentCache.path === path && now - agentCache.at < AGENT_CACHE_MS) {
    return agentCache.agents
  }
  const out: AgentCli[] = []
  for (const a of KNOWN_AGENTS) {
    const bin = a.bins.find((b) => onPath(b))
    if (bin) out.push({ id: a.id, label: a.label, command: bin })
  }
  agentCache = { at: now, path, agents: out }
  return out
}

/**
 * Login flag for POSIX shells. zsh, bash, and fish all accept -l, and node-pty
 * gives the shell a TTY so it is interactive regardless — meaning both halves
 * of the rc chain (.zprofile + .zshrc) get sourced, as in a real terminal.
 */
export const POSIX_LOGIN_FLAG = '-l'

/**
 * Startup-banner suppressor for both PowerShells. Windows PowerShell 5.1 prints
 * a copyright banner and an "Install the latest PowerShell" nag before the first
 * prompt; pwsh prints its own. Neither belongs in an agent pane.
 */
export const PS_NO_BANNER_FLAG = '-NoLogo'

/**
 * Detect the shells/terminals actually installed on this machine.
 *
 * `exists` is injected so tests can exercise the POSIX branch from a Windows
 * dev box and from CI — mocking `fs` doesn't reach here, since vitest
 * externalizes node builtins.
 */
export function detectShells(exists: (p: string) => boolean = existsSync): ShellInfo[] {
  const shells: ShellInfo[] = []

  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const psPath = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // -NoLogo: without it every pane opens on the "Windows PowerShell / Copyright
    // (C) Microsoft" banner plus the "Install the latest PowerShell" nag, which
    // is pure noise above an agent.
    shells.push({
      id: 'powershell',
      label: 'PowerShell',
      command: exists(psPath) ? psPath : 'powershell.exe',
      args: [PS_NO_BANNER_FLAG]
    })

    const pwsh =
      onPath('pwsh') ||
      (exists('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
        ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
        : null)
    if (pwsh)
      shells.push({ id: 'pwsh', label: 'PowerShell 7', command: pwsh, args: [PS_NO_BANNER_FLAG] })

    shells.push({
      id: 'cmd',
      label: 'Command Prompt',
      command: join(sysRoot, 'System32', 'cmd.exe'),
      args: []
    })

    const gitBash = [
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
    ].find((p) => p && exists(p))
    if (gitBash) shells.push({ id: 'gitbash', label: 'Git Bash', command: gitBash, args: ['-l', '-i'] })

    const wsl = join(sysRoot, 'System32', 'wsl.exe')
    if (exists(wsl)) shells.push({ id: 'wsl', label: 'WSL', command: wsl, args: [] })
  } else {
    // macOS / Linux
    const seen = new Set<string>()
    const add = (id: string, label: string, command: string): void => {
      if (command && exists(command) && !seen.has(command)) {
        seen.add(command)
        // -l (login) is what makes a pane behave like an iTerm/Ghostty/Terminal
        // tab, all of which spawn login shells. Homebrew's own install docs put
        // `eval "$(brew shellenv)"` in ~/.zprofile — login-only — as do most
        // nvm/conda setups, so a non-login shell never sees /opt/homebrew/bin
        // and `claude` is missing inside Spy Master while working everywhere else.
        shells.push({ id, label, command, args: [POSIX_LOGIN_FLAG] })
      }
    }
    const sh = process.env.SHELL
    if (sh) add('default', `Default (${sh.split('/').pop()})`, sh)
    add('zsh', 'zsh', '/bin/zsh')
    add('bash', 'bash', '/bin/bash')
    add('bash-opt', 'bash', '/opt/homebrew/bin/bash')
  }

  return shells
}
