import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AGENT_REVEAL_MS,
  BOOT_MARK,
  BOOT_MAX_MS,
  BOOT_MIN_MS,
  BOOT_SETTLE_MS,
  buildCd,
  buildSentinelCmd,
  cwdRevealDelay,
  rawIndexAfterToken,
  createQuietBoot,
  type QuietBootSink
} from './terminalBoot'

describe('buildCd', () => {
  it('pins PowerShell with a literal path, doubling embedded quotes', () => {
    expect(buildCd('powershell', true, "D:\\it's\\wt")).toBe(
      "Set-Location -LiteralPath 'D:\\it''s\\wt'"
    )
  })

  it('falls back to PowerShell on Windows when the shell is unknown', () => {
    expect(buildCd(undefined, true, 'D:\\wt')).toBe("Set-Location -LiteralPath 'D:\\wt'")
  })

  it('uses cd /d for cmd and a posix cd for Git Bash', () => {
    expect(buildCd('cmd', true, 'D:\\wt')).toBe('cd /d "D:\\wt"')
    expect(buildCd('gitbash', true, 'D:\\wt')).toBe("cd 'D:/wt'")
  })

  it('has nothing to pin without a cwd', () => {
    expect(buildCd('powershell', true, '')).toBeNull()
  })
})

describe('buildSentinelCmd', () => {
  // The whole quiet boot hangs off this: the watcher matches the mark in the
  // OUTPUT, so the command that prints it must never contain it contiguously.
  it('never spells the mark out in the command itself', () => {
    for (const sid of ['powershell', 'pwsh', 'cmd', 'gitbash', 'zsh', undefined]) {
      expect(buildSentinelCmd(sid, true, BOOT_MARK)).not.toContain(BOOT_MARK)
      expect(buildSentinelCmd(sid, false, BOOT_MARK)).not.toContain(BOOT_MARK)
    }
  })

  // Belt to the watcher's braces. If the sentinel is ever missed and the
  // safety-net reveal dumps the boot output, this clear is inside that dump —
  // it is what keeps the banner and the injected `Set-Location` off the pane.
  it('clears the screen after printing, in every shell family', () => {
    expect(buildSentinelCmd('powershell', true, BOOT_MARK)).toContain('Clear-Host')
    expect(buildSentinelCmd('pwsh', true, BOOT_MARK)).toContain('Clear-Host')
    expect(buildSentinelCmd(undefined, true, BOOT_MARK)).toContain('Clear-Host')
    expect(buildSentinelCmd('cmd', true, BOOT_MARK)).toContain('cls')
    // erase screen, erase scrollback, home — no terminfo needed
    expect(buildSentinelCmd('zsh', false, BOOT_MARK)).toContain('\\033[2J\\033[3J\\033[H')
  })

  it('prints the mark before it clears, so the watcher still sees it', () => {
    const cmd = buildSentinelCmd('powershell', true, BOOT_MARK)
    expect(cmd.indexOf('Write-Host')).toBeLessThan(cmd.indexOf('Clear-Host'))
  })
})

describe('cwdRevealDelay', () => {
  // The regression this exists for: a fixed budget from spawn expired while a
  // cold PowerShell was still starting, so the safety net fired and dumped the
  // banner plus both injected commands into the pane.
  it('waits out a slow cold start before giving up', () => {
    expect(cwdRevealDelay(0)).toBe(BOOT_MIN_MS)
    expect(2500).toBeLessThan(BOOT_MIN_MS) // the old fixed budget would have fired
  })

  it('settles quickly once the shell is talking', () => {
    expect(cwdRevealDelay(BOOT_MIN_MS)).toBe(BOOT_SETTLE_MS)
    expect(cwdRevealDelay(BOOT_MIN_MS + 5000)).toBe(BOOT_SETTLE_MS)
  })

  it('never pushes the reveal past the absolute ceiling', () => {
    expect(BOOT_MAX_MS - 500 + cwdRevealDelay(BOOT_MAX_MS - 500)).toBe(BOOT_MAX_MS)
    expect(cwdRevealDelay(BOOT_MAX_MS + 1000)).toBe(0)
  })
})

describe('rawIndexAfterToken', () => {
  it('finds a token split by ANSI sequences and returns the raw tail index', () => {
    const raw = 'M0n\x1b[32mad\x1b]0;title\x07Rdy\x1b[0mREST'
    const i = rawIndexAfterToken(raw, BOOT_MARK)
    expect(i).toBeGreaterThan(-1)
    expect(raw.slice(i)).toBe('\x1b[0mREST')
  })

  it('does not match the echoed command, which splits the token', () => {
    const echo = "PS D:\\wt> " + buildSentinelCmd('powershell', true, BOOT_MARK) + '\r\n'
    expect(rawIndexAfterToken(echo, BOOT_MARK)).toBe(-1)
  })

  it('reports absence until the token is complete', () => {
    expect(rawIndexAfterToken('M0nadR', BOOT_MARK)).toBe(-1)
  })
})

// --- the phase machine ------------------------------------------------------
// Shipped without coverage of its own: the strings and the math were tested,
// the sequencing that uses them was not. These drive it with fake timers.

interface Recorder {
  sink: QuietBootSink
  screen: string
  resets: number
  shell: string[]
  startups: number
}

function recorder(): Recorder {
  const r: Recorder = {
    screen: '',
    resets: 0,
    shell: [],
    startups: 0,
    sink: {
      resetScreen: () => {
        r.resets++
        r.screen = ''
      },
      write: (s) => {
        r.screen += s
      },
      sendStartup: () => {
        r.startups++
      },
      writeToShell: (line) => void r.shell.push(line)
    }
  }
  return r
}

const POSIX = { shellId: 'zsh', win: false, cwd: '/wt', hideAgent: false }

/** The sentinel as it lands in OUTPUT — contiguous, unlike its echo. */
const MARK_OUT = BOOT_MARK

describe('createQuietBoot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the pane back until the sentinel arrives, then reveals what follows', () => {
    const r = recorder()
    const boot = createQuietBoot(POSIX, r.sink)
    boot.begin()

    expect(boot.isBooting()).toBe(true)
    expect(r.shell).toEqual([buildCd('zsh', false, '/wt'), buildSentinelCmd('zsh', false, BOOT_MARK)])

    // The banner and both echoes arrive first — none of it may reach the pane.
    boot.onData('Welcome to zsh\r\n$ cd /wt\r\n$ printf ...\r\n')
    expect(r.screen).toBe('')
    expect(boot.isBooting()).toBe(true)

    boot.onData(`${MARK_OUT}\r\n$ `)
    expect(boot.isBooting()).toBe(false)
    expect(r.screen).toBe('\r\n$ ')
    expect(r.startups).toBe(1)
  })

  it('reveals on the timeout when the sentinel never comes', () => {
    const r = recorder()
    const boot = createQuietBoot(POSIX, r.sink)
    boot.begin()
    boot.onData('an exotic shell that never prints it')

    vi.advanceTimersByTime(BOOT_MAX_MS + 1000)
    expect(boot.isBooting()).toBe(false)
    // Whatever we held is shown rather than lost.
    expect(r.screen).toContain('exotic shell')
    expect(r.startups).toBe(1)
  })

  // The regression the elapsed-aware delay exists for: a cold PowerShell that
  // says nothing for seconds used to blow a fixed budget and dump the banner.
  it('waits out a silent cold start instead of dumping the boot', () => {
    const r = recorder()
    const boot = createQuietBoot(POSIX, r.sink)
    boot.begin()

    vi.advanceTimersByTime(BOOT_MIN_MS - 500)
    expect(boot.isBooting()).toBe(true)

    boot.onData(`banner${MARK_OUT}ready`)
    expect(boot.isBooting()).toBe(false)
    expect(r.screen).toBe('ready')
  })

  it('hides the agent through a second phase, revealing on the alternate screen', () => {
    const r = recorder()
    const boot = createQuietBoot({ ...POSIX, hideAgent: true }, r.sink)
    boot.begin()

    boot.onData(`noise${MARK_OUT}`)
    // cwd pinned: screen wiped, agent launched, still hidden.
    expect(boot.isBooting()).toBe(true)
    expect(r.startups).toBe(1)
    expect(r.resets).toBe(1)

    boot.onData('agent warming up')
    expect(r.screen).toBe('')

    boot.onData('\x1b[?1049hTUI PAINTS')
    expect(boot.isBooting()).toBe(false)
    expect(r.screen).toBe('\x1b[?1049hTUI PAINTS')
  })

  it('reveals the hidden agent on the timeout when it has no TUI', () => {
    const r = recorder()
    const boot = createQuietBoot({ ...POSIX, hideAgent: true }, r.sink)
    boot.begin()
    boot.onData(`x${MARK_OUT}`)
    boot.onData('plain text agent, no alternate screen')

    vi.advanceTimersByTime(AGENT_REVEAL_MS + 100)
    expect(boot.isBooting()).toBe(false)
    expect(r.screen).toContain('plain text agent')
  })

  it('skips the cwd phase entirely when there is nothing to pin', () => {
    const r = recorder()
    const boot = createQuietBoot({ ...POSIX, cwd: '', hideAgent: true }, r.sink)
    boot.begin()

    expect(r.shell).toEqual([]) // no pin, no sentinel
    expect(r.startups).toBe(1)
    expect(boot.isBooting()).toBe(true)

    boot.onData('\x1b[?1049h')
    expect(boot.isBooting()).toBe(false)
  })

  it('does not hold anything back when there is neither a cwd nor an agent', () => {
    const r = recorder()
    const boot = createQuietBoot({ ...POSIX, cwd: '', hideAgent: false }, r.sink)
    boot.begin()
    expect(boot.isBooting()).toBe(false)
    expect(r.startups).toBe(1)
  })

  it('strips the cursor-style sequence out of what it reveals', () => {
    const r = recorder()
    const boot = createQuietBoot(POSIX, r.sink)
    boot.begin()
    boot.onData(`${MARK_OUT}\x1b[5 qprompt`)
    expect(r.screen).toBe('prompt')
  })

  it('cannot write into a disposed pane', () => {
    const r = recorder()
    const boot = createQuietBoot(POSIX, r.sink)
    boot.begin()
    boot.dispose()

    boot.onData(`${MARK_OUT}late`)
    vi.advanceTimersByTime(BOOT_MAX_MS * 2)
    expect(r.screen).toBe('')
    expect(r.resets).toBe(0)
  })
})
