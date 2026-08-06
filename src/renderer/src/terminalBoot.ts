/**
 * Quiet boot: the bootstrap a pane runs before it shows anything.
 *
 * A freshly spawned shell is noisy — a banner, whatever the user's profile
 * prints, and the echo of the two commands the pane injects (the cwd pin and a
 * readiness sentinel). None of that belongs above an agent, so rendering is held
 * back until the sentinel comes through and a clean screen can be revealed.
 *
 * The whole handshake lives here — the strings, the math, and the phase machine
 * that drives them — so it can be tested without a DOM. TerminalPane owns the
 * transport (the PTY and the xterm instance) and supplies them as a sink.
 */

/** Sentinel the shell prints once the cwd pin has run. Contiguous only in the
 *  OUTPUT — the command that prints it splits the token, so its echo can't be
 *  mistaken for the real thing. Legacy spelling; the storage-compatible name. */
export const BOOT_MARK = 'M0nadRdy'

/** Shell command that pins the agent to its worktree dir, per shell. Returns
 *  null when there's no cwd to pin or the shell is unknown (spawn cwd stands). */
export function buildCd(sid: string | undefined, win: boolean, cwd: string): string | null {
  if (!cwd) return null
  if (sid === 'powershell' || sid === 'pwsh' || (win && !sid))
    return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`
  if (sid === 'cmd') return `cd /d "${cwd}"`
  if (sid === 'gitbash') {
    const posix = cwd.replace(/\\/g, '/')
    return `cd '${posix.replace(/'/g, "'\\''")}'`
  }
  if (!win) return `cd '${cwd.replace(/'/g, "'\\''")}'`
  return null
}

/**
 * A command that prints `mark` to stdout and then clears the screen.
 *
 * Two jobs. The mark lands (ANSI-strippable) in the output only — the echoed
 * command splits the token across a concat, so the quiet-boot watcher can match
 * the whole token without false-firing on echo.
 *
 * The clear is the belt to that braces: it makes the SHELL wipe the banner, the
 * profile's chatter and both injected echoes off the screen. Normally the
 * watcher has already reset the pane by the time it runs and it costs nothing —
 * but if the sentinel is ever missed and the safety-net reveal dumps the boot
 * output instead, the clear is still in that dump, so the user lands on a clean
 * prompt rather than on `Set-Location …` and a stray `M0nadRdy`.
 */
export function buildSentinelCmd(sid: string | undefined, win: boolean, mark: string): string {
  const a = mark.slice(0, 3)
  const b = mark.slice(3)
  if (sid === 'powershell' || sid === 'pwsh' || (win && !sid))
    return `Write-Host -NoNewline ('${a}'+'${b}'); Clear-Host`
  if (sid === 'cmd') return `set _m1=${a}&&set _m2=${b}&&<nul set /p=%_m1%%_m2%&&cls`
  // Not `clear`: that needs terminfo. The sequences are erase-screen,
  // erase-scrollback, cursor-home — what every clear resolves to anyway.
  return `printf %s '${a}''${b}'; printf '\\033[2J\\033[3J\\033[H'`
}

/** Reveal deadline for the agent phase, measured from when its launch command
 *  was sent. Output here means the agent is alive, so this stays a flat cap —
 *  a chatty non-TUI agent must not be able to hold the pane blank. */
export const AGENT_REVEAL_MS = 2500

/** Never give up on the sentinel before this. A cold shell — antivirus on
 *  powershell.exe, a profile that loads modules — can be slow to say anything
 *  at all, and a budget that expires during that silence dumps the whole boot. */
export const BOOT_MIN_MS = 4000
/** Once the shell IS talking, give up this long after it goes quiet. */
export const BOOT_SETTLE_MS = 1500
/** Absolute ceiling, so a wedged shell still reveals rather than staying blank. */
export const BOOT_MAX_MS = 20000

/**
 * How long to wait for the cwd sentinel, given how long the phase has already
 * been running. Re-armed on every chunk, so the wait tracks the shell's silence
 * rather than a fixed budget from spawn — the fixed budget is what used to
 * expire mid-startup and leak the banner and injected commands into the pane.
 */
export function cwdRevealDelay(elapsedMs: number): number {
  const floor = Math.max(BOOT_SETTLE_MS, BOOT_MIN_MS - elapsedMs)
  return Math.max(0, Math.min(floor, BOOT_MAX_MS - elapsedMs))
}

/** Find `token` in `raw`, tolerating ANSI/control sequences interspersed between
 *  its characters (ConPTY + PSReadLine render output with cursor/SGR codes mixed
 *  in, so a plain indexOf on the raw stream misses it). Returns the raw index
 *  just AFTER the token's last character, or -1 if not (yet) present. */
export function rawIndexAfterToken(raw: string, token: string): number {
  let clean = ''
  const map: number[] = [] // clean char index -> raw index
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === '\x1b') {
      i++
      if (raw[i] === '[') {
        i++
        while (i < raw.length && (raw.charCodeAt(i) < 0x40 || raw.charCodeAt(i) > 0x7e)) i++
        i++ // the final byte
      } else if (raw[i] === ']') {
        i++
        while (i < raw.length && raw[i] !== '\x07' && !(raw[i] === '\x1b' && raw[i + 1] === '\\')) i++
        i += raw[i] === '\x1b' ? 2 : 1
      } else {
        i++
      }
      continue
    }
    clean += raw[i]
    map.push(i)
    i++
  }
  const idx = clean.indexOf(token)
  if (idx === -1) return -1
  return map[idx + token.length - 1] + 1
}

/** PSReadLine's DECSCUSR cursor-style sequence. Left in, it re-enables the fast
 *  blink the pane deliberately turns off. */
// eslint-disable-next-line no-control-regex
const CURSOR_STYLE_SEQ = /\x1b\[[0-9]* q/g

export function stripCursorStyle(s: string): string {
  return s.replace(CURSOR_STYLE_SEQ, '')
}

/** The sequence a TUI emits when it takes over the alternate screen — the agent
 *  has painted, so there is something worth showing. */
const ALT_SCREEN = '\x1b[?1049h'

/** Everything the boot does to the pane and the shell. */
export interface QuietBootSink {
  /** Wipe the pane. */
  resetScreen: () => void
  /** Write to the pane. */
  write: (s: string) => void
  /** Send the agent's startup command down the PTY. Must be idempotent. */
  sendStartup: () => void
  /** Send a line to the shell (the cwd pin, the sentinel). */
  writeToShell: (line: string) => void
}

export interface QuietBoot {
  /** True while rendering is held back. Once false, the caller writes output to
   *  the pane itself and must stop calling onData. */
  isBooting: () => boolean
  /** Kick off the handshake. Call after the PTY subscriptions are in place, so
   *  nothing the shell says in reply is missed. */
  begin: () => void
  /** A raw PTY chunk, while booting. */
  onData: (chunk: string) => void
  dispose: () => void
}

/**
 * Hold the pane blank until the shell is ready, then reveal it clean.
 *
 * Two phases, either of which may be skipped:
 *
 *  - **cwd** — the pin and the sentinel have been sent; wait for the sentinel to
 *    appear in the OUTPUT (not its echo) and treat everything after it as the
 *    real start.
 *  - **agent** — the startup command has been sent; wait for its TUI to take
 *    over the alternate screen.
 *
 * A timeout always reveals in the end, so an unexpected shell can never leave
 * the pane permanently blank.
 */
export function createQuietBoot(
  spec: { shellId: string | undefined; win: boolean; cwd: string; hideAgent: boolean },
  sink: QuietBootSink
): QuietBoot {
  const cdCmd = buildCd(spec.shellId, spec.win, spec.cwd)
  let booting = !!cdCmd || spec.hideAgent
  let phase: 'cwd' | 'agent' = cdCmd ? 'cwd' : 'agent'
  let accum = ''
  let clock = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const endBoot = (tail: string): void => {
    booting = false
    clearTimeout(timer)
    if (disposed) return
    sink.resetScreen()
    if (tail) sink.write(stripCursorStyle(tail))
  }

  // Safety net: if the sentinel / alt-screen never shows (an exotic shell, a
  // non-TUI agent), reveal what we have and make sure the agent launched.
  // `restart` starts a fresh clock for a new phase; otherwise the cwd phase
  // re-arms off the same clock as each chunk lands, so the wait follows the
  // shell's silence instead of a fixed budget that a slow start blows past.
  const armTimeout = (restart = false): void => {
    clearTimeout(timer)
    if (restart || !clock) clock = Date.now()
    const wait = phase === 'cwd' ? cwdRevealDelay(Date.now() - clock) : AGENT_REVEAL_MS
    timer = setTimeout(() => {
      if (disposed) return
      const tail = accum
      accum = ''
      endBoot(tail)
      sink.sendStartup()
    }, wait)
  }

  return {
    isBooting: () => booting,

    begin() {
      if (disposed) return
      // With nothing to hide this behaves exactly as it did before quiet boot
      // existed: pin the cwd, then run the startup command.
      if (!booting) {
        if (cdCmd) sink.writeToShell(cdCmd)
        sink.sendStartup()
      } else if (cdCmd) {
        // Pin the cwd, then print the sentinel so we know when its echo/output
        // is done and can reveal a clean screen. The sentinel also clears the
        // screen shell-side, so even a missed reveal lands clean.
        sink.writeToShell(cdCmd)
        sink.writeToShell(buildSentinelCmd(spec.shellId, spec.win, BOOT_MARK))
        armTimeout()
      } else {
        // No cwd to pin but a known agent to hide: launch it straight away,
        // hidden, and reveal when its TUI takes over the screen.
        sink.sendStartup()
        armTimeout()
      }
    },

    onData(chunk) {
      if (disposed) return
      accum += chunk
      if (phase === 'cwd') {
        armTimeout()
        const j = rawIndexAfterToken(accum, BOOT_MARK)
        if (j === -1) return
        const tail = accum.slice(j)
        accum = ''
        if (spec.hideAgent) {
          // cwd pinned & hidden; launch the agent, still hidden, and reveal when
          // its TUI takes over the alternate screen.
          phase = 'agent'
          sink.resetScreen()
          sink.sendStartup()
          armTimeout(true)
        } else {
          endBoot(tail) // clean prompt; a non-agent command shows normally
          sink.sendStartup()
        }
      } else {
        const i = accum.indexOf(ALT_SCREEN)
        if (i !== -1) endBoot(accum.slice(i))
      }
    },

    dispose() {
      disposed = true
      clearTimeout(timer)
    }
  }
}
