/**
 * Recognising "the agent CLI isn't installed" in a pane's own output.
 *
 * A pane with a startupCommand auto-runs an agent CLI. When the binary is gone
 * the shell just prints its own "command not found" and the app says nothing,
 * so the user sees a dead terminal with no explanation. This turns that line
 * into something the app can act on.
 *
 * The matching is deliberately LINE-scoped. The echoed startup command keeps
 * the binary name in the tail for the whole detection window, so "binary
 * somewhere in the tail AND an error phrase somewhere in the tail" false-fires
 * on any stray "No such file or directory" — an agent noting that an optional
 * config is missing, say. The name and the error signature have to sit on the
 * same line, in one of the real shell formats: a bare echoed command line never
 * matches, and neither does an error about some other file.
 */
import { stripAnsi } from './attention'

/** How long after the startup command is sent to keep watching. */
export const MISSING_BIN_WINDOW_MS = 20000

/**
 * The bare program name a startup command runs — `claude` for
 * `/usr/local/bin/claude.exe --resume`. Empty when there is nothing to watch.
 */
export function startupBinaryName(startupCommand: string | undefined): string {
  return (((startupCommand ?? '').trim().split(/\s+/)[0] ?? '').split(/[\\/]/).pop() ?? '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
}

/**
 * One matcher per shell family that reports a missing command differently.
 * Empty for an empty binary name, which disables the watch entirely.
 */
export function missingBinaryMatchers(bin: string): RegExp[] {
  if (!bin) return []
  const binEsc = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `claude` → also matches `claude.exe`, `/usr/local/bin/claude`, …
  const binTok = `(?:\\S*[\\\\/])?${binEsc}(?:\\.(?:exe|cmd|bat))?`
  return [
    // bash/dash/POSIX exec: `bash: claude: command not found`,
    // `claude: No such file or directory` (with optional `bash: ` prefix).
    new RegExp(
      `(?:^|[:\\s])${binTok}\\s*:\\s*(?:command not found|no such file or directory)`,
      'i'
    ),
    // zsh/fish put the name last: `zsh: command not found: claude`.
    new RegExp(`command not found\\s*:\\s*${binTok}(?:$|[\\s'"\`])`, 'i'),
    // PowerShell: `The term 'claude' is not recognized …`.
    new RegExp(`term ['"‘“]?${binTok}['"’”]? is not recognized`, 'i'),
    // cmd.exe: `'claude' is not recognized as an internal or external command …`.
    new RegExp(`['"]${binTok}['"] is not recognized as an internal or external`, 'i')
  ]
}

/**
 * Does this output contain a missing-binary report for the watched binary?
 * Colour codes are stripped per line — shells routinely colour these errors.
 */
export function reportsMissingBinary(tail: string, matchers: RegExp[]): boolean {
  if (matchers.length === 0) return false
  return stripAnsi(tail)
    .split(/\r?\n/)
    .some((line) => matchers.some((re) => re.test(line)))
}
