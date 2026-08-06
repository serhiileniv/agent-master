/**
 * Quiet boot: the bootstrap a pane runs before it shows anything.
 *
 * A freshly spawned shell is noisy — a banner, whatever the user's profile
 * prints, and the echo of the two commands the pane injects (the cwd pin and a
 * readiness sentinel). None of that belongs above an agent, so TerminalPane
 * holds rendering back until the sentinel comes through and then reveals a clean
 * screen. The pieces of that handshake live here so they can be tested without
 * a DOM: TerminalPane owns the timing, this module owns the strings and the math.
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
