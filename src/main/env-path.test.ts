import { describe, it, expect } from 'vitest'
import { mergePath, noteIsUsable } from './env-path'

// Guards the macOS "no agents installed" bug: a Finder/Dock launch inherits
// launchd's minimal PATH, so every agent CLI in Homebrew/nvm/~/.local is
// invisible until the login shell's PATH is merged back in.
const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('mergePath', () => {
  it('recovers shell dirs missing from the launchd PATH', () => {
    const merged = mergePath('/opt/homebrew/bin:' + LAUNCHD, LAUNCHD, [])
    expect(merged.split(':')).toContain('/opt/homebrew/bin')
  })

  it('lets the shell PATH decide precedence between two copies of a binary', () => {
    // /opt/homebrew/bin must stay ahead of /usr/local/bin if the shell said so,
    // otherwise we launch an old Intel-Homebrew agent over the current one.
    const merged = mergePath('/opt/homebrew/bin:/usr/local/bin', LAUNCHD, ['/usr/local/bin'])
    const dirs = merged.split(':')
    expect(dirs.indexOf('/opt/homebrew/bin')).toBeLessThan(dirs.indexOf('/usr/local/bin'))
  })

  it('appends fallbacks after the inherited PATH, not before', () => {
    const dirs = mergePath(null, LAUNCHD, ['/opt/homebrew/bin']).split(':')
    expect(dirs.indexOf('/usr/bin')).toBeLessThan(dirs.indexOf('/opt/homebrew/bin'))
  })

  it('still works when the shell harvest fails', () => {
    // Timeout, missing $SHELL, or an rc file that exits non-zero — the fallback
    // dirs are the whole reason this case is survivable.
    const merged = mergePath(null, LAUNCHD, ['/opt/homebrew/bin', '/Users/x/.claude/local'])
    expect(merged.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin',
      '/Users/x/.claude/local'
    ])
  })

  it('deduplicates across sources, keeping first occurrence', () => {
    const dirs = mergePath('/opt/homebrew/bin:/usr/bin', LAUNCHD, ['/opt/homebrew/bin']).split(':')
    expect(dirs.filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1)
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1)
    expect(dirs[0]).toBe('/opt/homebrew/bin')
  })

  it('treats trailing-slash variants as the same dir', () => {
    const dirs = mergePath('/opt/homebrew/bin/', LAUNCHD, ['/opt/homebrew/bin']).split(':')
    expect(dirs.filter((d) => d.startsWith('/opt/homebrew/bin'))).toEqual(['/opt/homebrew/bin'])
  })

  it('drops empty segments so PATH never gains an implicit cwd entry', () => {
    // A leading/trailing/doubled colon means "current directory" to execvp —
    // a real security footgun, and easy to inherit from a sloppy rc file.
    const merged = mergePath('::/opt/homebrew/bin:', '/usr/bin::', [])
    expect(merged).toBe('/opt/homebrew/bin:/usr/bin')
    expect(merged.split(':').every(Boolean)).toBe(true)
  })

  it('handles every source being empty', () => {
    expect(mergePath(null, '', [])).toBe('')
  })
})

/**
 * The remembered login-shell PATH is what makes every launch after the first
 * open instantly instead of waiting seconds on the rc chain. It is also the one
 * thing here that could silently RE-introduce the missing-agents bug: reuse a
 * note that doesn't describe this machine and the + menu goes empty again.
 */
describe('noteIsUsable', () => {
  it('accepts a note written by the same login shell', () => {
    expect(noteIsUsable({ shell: '/bin/zsh', path: '/opt/homebrew/bin' }, '/bin/zsh')).toBe(true)
  })

  it('rejects a note from a DIFFERENT login shell', () => {
    // zsh → fish is a whole different rc chain; that PATH is someone else's answer.
    expect(noteIsUsable({ shell: '/bin/zsh', path: '/opt/homebrew/bin' }, '/opt/homebrew/bin/fish'))
      .toBe(false)
  })

  it('rejects an empty or blank path so a bad note can never shadow a real harvest', () => {
    expect(noteIsUsable({ shell: '/bin/zsh', path: '' }, '/bin/zsh')).toBe(false)
    expect(noteIsUsable({ shell: '/bin/zsh', path: '   ' }, '/bin/zsh')).toBe(false)
  })

  it('rejects corrupt / hand-edited notes rather than trusting them', () => {
    expect(noteIsUsable(null, '/bin/zsh')).toBe(false)
    expect(noteIsUsable('/opt/homebrew/bin', '/bin/zsh')).toBe(false)
    expect(noteIsUsable({ path: '/opt/homebrew/bin' }, '/bin/zsh')).toBe(false)
    expect(noteIsUsable({ shell: '/bin/zsh' }, '/bin/zsh')).toBe(false)
    expect(noteIsUsable({ shell: 1, path: 2 }, '/bin/zsh')).toBe(false)
  })

  it('matches a note written when $SHELL was unset', () => {
    // harvestFromLoginShell bails without $SHELL, but a note can still have been
    // written as '' — it must match the same unset state, not any real shell.
    expect(noteIsUsable({ shell: '', path: '/usr/bin' }, undefined)).toBe(true)
    expect(noteIsUsable({ shell: '', path: '/usr/bin' }, '/bin/zsh')).toBe(false)
  })
})
