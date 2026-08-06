import { describe, it, expect, beforeAll } from 'vitest'
import { quotePaths, shellFamily, refreshAgents, terminals } from './terminalRegistry'

// shellFamily consults window.api.platform for the "unknown shell" fallback.
beforeAll(() => {
  ;(window as unknown as { api: unknown }).api = { platform: 'win32' }
})

// Dropped/pasted file paths land directly on an agent's command line. The old
// implementation DETECTED $, backtick and quotes but wrapped them in DOUBLE
// quotes — exactly where they still expand — so a file named `id`.txt executed.
describe('quotePaths', () => {
  const NASTY = '/tmp/$(whoami)-`id`-"x".txt'

  it('neutralises command substitution for posix shells', () => {
    const out = quotePaths([NASTY], 'bash')
    expect(out.startsWith("'")).toBe(true)
    expect(out.endsWith("'")).toBe(true)
    // Inside single quotes nothing expands, so these survive as literal text.
    expect(out).toContain('$(whoami)')
    expect(out).toContain('`id`')
  })

  it("escapes an embedded single quote posix-style (close, escape, reopen)", () => {
    // There is no escape INSIDE posix single quotes, so the only correct form is
    // to end the quote, emit an escaped quote, and start a new one.
    expect(quotePaths(["/tmp/it's.txt"], 'zsh')).toBe(`'/tmp/it'\\''s.txt'`)
  })

  it('escapes an embedded single quote PowerShell-style (doubled)', () => {
    expect(quotePaths(["C:\\it's.txt"], 'pwsh')).toBe("'C:\\it''s.txt'")
  })

  it('single-quotes for PowerShell so $ and backtick stay inert', () => {
    const out = quotePaths([NASTY], 'powershell')
    expect(out.startsWith("'")).toBe(true)
    expect(out).toContain('$(whoami)')
  })

  it('double-quotes for cmd and drops embedded quotes it cannot escape', () => {
    // cmd.exe has no escape mechanism; leaving the quote in would let the
    // argument break out of its own quoting.
    const out = quotePaths(['C:\\a "b".txt'], 'cmd')
    expect(out).toBe('"C:\\a b.txt"')
  })

  it('joins multiple paths with a space, each quoted independently', () => {
    expect(quotePaths(['/a.txt', '/b c.txt'], 'bash')).toBe(`'/a.txt' '/b c.txt'`)
  })

  it('quotes even a boring path, so the caller never has to reason about it', () => {
    expect(quotePaths(['/plain.txt'], 'bash')).toBe(`'/plain.txt'`)
  })
})

describe('shellFamily', () => {
  it('maps the known shell ids', () => {
    expect(shellFamily('powershell')).toBe('powershell')
    expect(shellFamily('pwsh')).toBe('powershell')
    expect(shellFamily('cmd')).toBe('cmd')
    expect(shellFamily('gitbash')).toBe('posix')
    expect(shellFamily('wsl')).toBe('posix')
    expect(shellFamily('zsh')).toBe('posix')
  })

  it('falls back to the platform default for an unknown id', () => {
    // window.api.platform is stubbed to win32 above.
    expect(shellFamily(undefined)).toBe('powershell')
    expect(shellFamily('default')).toBe('powershell')
  })
})

// Writing into a terminal whose subtree is content-visibility:hidden puts the
// text in xterm's buffer but leaves the RENDERED rows stale, and nothing dirties
// them again until the next chunk of output arrives — so a quiet agent's pane
// could sit showing a stale screen after a workspace switch. refreshAgents is
// what forces the redraw once layout is back.
describe('refreshAgents', () => {
  const fake = (rows: number) => {
    const calls: Array<[number, number]> = []
    return {
      term: { rows, refresh: (a: number, b: number) => calls.push([a, b]) },
      calls
    }
  }

  it('redraws the full viewport of each named pane', () => {
    const a = fake(24)
    const b = fake(10)
    terminals.set('a', a.term as never)
    terminals.set('b', b.term as never)
    refreshAgents(['a', 'b'])
    expect(a.calls).toEqual([[0, 23]])
    expect(b.calls).toEqual([[0, 9]])
    terminals.clear()
  })

  it('ignores ids with no live terminal', () => {
    expect(() => refreshAgents(['gone'])).not.toThrow()
  })

  // rows is 0 on a terminal that has never been laid out; refresh(0, -1) is a
  // nonsense range that xterm would either reject or treat as the whole buffer.
  it('skips a terminal that has never been laid out', () => {
    const t = fake(0)
    terminals.set('c', t.term as never)
    refreshAgents(['c'])
    expect(t.calls).toEqual([])
    terminals.clear()
  })
})
