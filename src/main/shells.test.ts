import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Spawn args per platform. A macOS pane that isn't a LOGIN shell never sources
// ~/.zprofile — where Homebrew's own install docs put `eval "$(brew shellenv)"`,
// and where most nvm/conda setups live. The pane then has no /opt/homebrew/bin,
// so `claude` is missing inside Spy Master while working fine in iTerm/Ghostty/
// Terminal.app, all of which spawn login shells. That was the reported bug.

// Pretend every candidate shell exists, so the POSIX branch is exercisable from
// a Windows dev machine and from CI. Injected rather than mocked: vitest
// externalizes node builtins, so vi.mock('fs') never reaches shells.ts.
const allExist = (): boolean => true

const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

const realPlatform = process.platform

// detectAgents runs on every window focus. Ruling OUT an agent that isn't
// installed means sweeping all of PATH x every executable extension, so on
// Windows the full scan reaches ~1000 synchronous existsSync calls — on the
// main thread, which is also the thread pumping PTY output to the renderer.
// Alt-tabbing in and out used to pay that each time.
describe('detectAgents caching', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reuses the previous result instead of re-scanning PATH', async () => {
    const { detectAgents } = await import('./shells')
    // Identity, not deep equality: an uncached implementation returns a freshly
    // built array every call, so `toBe` is exactly the distinction under test.
    // (Asserted without mocking fs — vitest externalizes node builtins, per the
    // note above, so the real scan runs and is simply expected to run once.)
    expect(detectAgents()).toBe(detectAgents())
  })
})

describe('detectShells spawn args', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('gives every macOS shell the login flag', async () => {
    setPlatform('darwin')
    process.env.SHELL = '/bin/zsh'
    const { detectShells } = await import('./shells')

    const shells = detectShells(allExist)
    expect(shells.length).toBeGreaterThan(0)
    for (const sh of shells) {
      expect(sh.args, `${sh.id} must be a login shell`).toContain('-l')
    }
  })

  it('gives Linux shells the login flag too', async () => {
    setPlatform('linux')
    process.env.SHELL = '/bin/bash'
    const { detectShells } = await import('./shells')

    const shells = detectShells(allExist)
    // Length guard first: .every() on an empty array is vacuously true, which
    // would turn a detection failure into a passing test.
    expect(shells.length).toBeGreaterThan(0)
    expect(shells.every((s) => s.args.includes('-l'))).toBe(true)
  })

  it('does not add -l on Windows, where it is meaningless', async () => {
    setPlatform('win32')
    const { detectShells } = await import('./shells')

    const shells = detectShells(allExist)
    // -NoLogo, and nothing else: -l is a POSIX login flag with no meaning here.
    // (The banner suppression itself is asserted below.)
    const ps = shells.find((s) => s.id === 'powershell')
    expect(ps?.args).toEqual(['-NoLogo'])
    // Git Bash is the exception that already worked: it is a POSIX shell on
    // Windows and has always been spawned login+interactive.
    const gitBash = shells.find((s) => s.id === 'gitbash')
    if (gitBash) expect(gitBash.args).toEqual(['-l', '-i'])
  })

  it('starts both PowerShells without their startup banner', async () => {
    setPlatform('win32')
    const { detectShells } = await import('./shells')

    // Without -NoLogo every pane opens on "Windows PowerShell / Copyright (C)
    // Microsoft" plus the "Install the latest PowerShell" nag, above the agent.
    const shells = detectShells(allExist)
    for (const id of ['powershell', 'pwsh']) {
      const s = shells.find((x) => x.id === id)
      expect(s, `${id} should be detected`).toBeDefined()
      expect(s?.args).toContain('-NoLogo')
    }
  })

  it('still labels the default shell from $SHELL', async () => {
    setPlatform('darwin')
    process.env.SHELL = '/opt/homebrew/bin/fish'
    const { detectShells } = await import('./shells')

    const def = detectShells(allExist).find((s) => s.id === 'default')
    expect(def?.label).toBe('Default (fish)')
    // fish accepts -l as well; the flag is uniform across POSIX shells.
    expect(def?.args).toEqual(['-l'])
  })
})
