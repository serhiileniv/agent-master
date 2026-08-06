import { describe, it, expect } from 'vitest'
import {
  BOOT_MARK,
  BOOT_MAX_MS,
  BOOT_MIN_MS,
  BOOT_SETTLE_MS,
  buildCd,
  buildSentinelCmd,
  cwdRevealDelay,
  rawIndexAfterToken
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
