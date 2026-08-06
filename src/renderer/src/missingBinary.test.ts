import { describe, it, expect } from 'vitest'
import { missingBinaryMatchers, reportsMissingBinary, startupBinaryName } from './missingBinary'

const claude = missingBinaryMatchers('claude')
const saw = (tail: string): boolean => reportsMissingBinary(tail, claude)

describe('startupBinaryName', () => {
  it('takes the program, not its arguments', () => {
    expect(startupBinaryName('claude --resume --model opus')).toBe('claude')
  })

  it('strips a path and a Windows extension, and lowercases', () => {
    expect(startupBinaryName('/usr/local/bin/claude')).toBe('claude')
    expect(startupBinaryName('C:\\Tools\\Claude.EXE --resume')).toBe('claude')
    expect(startupBinaryName('claude.cmd')).toBe('claude')
  })

  it('is empty when there is nothing to run', () => {
    expect(startupBinaryName(undefined)).toBe('')
    expect(startupBinaryName('')).toBe('')
    expect(startupBinaryName('   ')).toBe('')
  })
})

describe('missingBinaryMatchers', () => {
  it('recognises every shell family we spawn', () => {
    expect(saw('bash: claude: command not found')).toBe(true)
    expect(saw('claude: No such file or directory')).toBe(true)
    expect(saw('zsh: command not found: claude')).toBe(true)
    expect(saw("The term 'claude' is not recognized as the name of a cmdlet")).toBe(true)
    expect(saw("'claude' is not recognized as an internal or external command")).toBe(true)
  })

  it('recognises the binary however it was spelled on the line', () => {
    expect(saw('bash: /usr/local/bin/claude: command not found')).toBe(true)
    expect(saw("The term 'claude.exe' is not recognized")).toBe(true)
    expect(saw('bash: claude.cmd: command not found')).toBe(true)
  })

  it('sees through the colour codes shells wrap these errors in', () => {
    expect(saw('\x1b[31mbash: claude: command not found\x1b[0m')).toBe(true)
  })

  it('does nothing without a binary to watch, so a plain shell never toasts', () => {
    expect(reportsMissingBinary('bash: claude: command not found', missingBinaryMatchers(''))).toBe(
      false
    )
  })

  // The reason matching is line-scoped. The echoed startup command keeps the
  // binary name in the tail for the whole window, so a tail-wide search fires on
  // any unrelated "no such file" — an agent reporting a missing optional config,
  // which is completely routine.
  it('does not fire when the name and the error are on different lines', () => {
    expect(saw('$ claude --resume\nError: config.json: No such file or directory')).toBe(false)
    expect(saw('$ claude\nsome-other-tool: command not found')).toBe(false)
  })

  it('does not fire on the echoed command alone', () => {
    expect(saw('PS D:\\repo> claude --resume')).toBe(false)
    expect(saw('$ claude')).toBe(false)
  })

  it('does not fire for a different binary with a similar name', () => {
    expect(saw('bash: claudia: command not found')).toBe(false)
    expect(saw('bash: notclaude: command not found')).toBe(false)
  })

  it('escapes regex metacharacters in the binary name', () => {
    const odd = missingBinaryMatchers('my+tool')
    expect(reportsMissingBinary('bash: my+tool: command not found', odd)).toBe(true)
    expect(reportsMissingBinary('bash: myXtool: command not found', odd)).toBe(false)
  })
})
