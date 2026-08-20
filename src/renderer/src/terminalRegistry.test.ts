import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  quotePaths,
  shellFamily,
  refreshAgents,
  handleMenuEdit,
  isRichEditable,
  terminals
} from './terminalRegistry'
import { useStore, type WorkspaceSession } from './store'

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

// The macOS Edit menu owns ⌘C/⌘V/⌘A: AppKit consumes the keystroke before the
// page sees it, so whatever handleMenuEdit decides is the ONLY thing that
// happens. Getting the decision wrong is not a dead key — it puts the command on
// a terminal, which is how "paste into the file editor" became "type the
// clipboard onto a running agent's command line".
describe('handleMenuEdit routing', () => {
  const nativeEdit = vi.fn()
  const write = vi.fn()
  const read = vi.fn(async () => 'CLIPBOARD')

  /** A terminal that is the fallback target: registered, selected, selectable. */
  const fakeTerm = (): {
    term: never
    paste: ReturnType<typeof vi.fn>
    selectAll: ReturnType<typeof vi.fn>
  } => {
    const paste = vi.fn()
    const selectAll = vi.fn()
    return {
      term: {
        paste,
        selectAll,
        focus: vi.fn(),
        hasSelection: () => true,
        getSelection: () => 'TERMINAL SCROLLBACK'
      } as never,
      paste,
      selectAll
    }
  }

  /** One live workspace with one selected agent — an unambiguous fallback target. */
  const withOneAgent = (id: string): void => {
    useStore.setState({
      liveWorkspaces: [
        {
          id: 'w1',
          name: 'w',
          defaultPath: '/tmp',
          agents: [{ id }],
          selectedIds: [id],
          focusedId: null
        } as unknown as WorkspaceSession
      ],
      activeWorkspaceId: 'w1'
    })
  }

  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      clipboard: { read, write, hasImage: async () => false, readFiles: async () => [] },
      menu: { nativeEdit }
    }
    nativeEdit.mockClear()
    write.mockClear()
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
    terminals.clear()
  })

  /** The file editor's CodeMirror surface: focusable, editable, not an input. */
  const focusEditor = (): HTMLElement => {
    const cm = document.createElement('div')
    cm.className = 'cm-content'
    cm.setAttribute('contenteditable', 'true')
    cm.tabIndex = 0
    document.body.appendChild(cm)
    cm.focus()
    return cm
  }

  /** Select the contents of a non-editable element, as a mouse drag would. */
  const selectText = (el: Element): void => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  it('sends every command to Chromium when the file editor has focus', async () => {
    withOneAgent('a1')
    const t = fakeTerm()
    terminals.set('a1', t.term)
    focusEditor()

    for (const action of ['copy', 'paste', 'selectAll'] as const) {
      nativeEdit.mockClear()
      await handleMenuEdit(action)
      expect(nativeEdit).toHaveBeenCalledWith(action)
    }
    // …and nothing reached the terminal on the way past.
    expect(t.paste).not.toHaveBeenCalled()
    expect(t.selectAll).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('copies a plain text selection (diff, file preview) rather than the terminal', async () => {
    withOneAgent('a1')
    const t = fakeTerm()
    terminals.set('a1', t.term)
    const diff = document.createElement('div')
    diff.className = 'diff__body'
    diff.textContent = 'a selected diff line'
    document.body.appendChild(diff)
    selectText(diff)

    await handleMenuEdit('copy')
    expect(nativeEdit).toHaveBeenCalledWith('copy')
    // The old behaviour: 'TERMINAL SCROLLBACK' onto the clipboard instead.
    expect(write).not.toHaveBeenCalled()
  })

  // The fallback is deliberate and must survive: click a pane header, hit ⌘V,
  // and the paste should still reach the terminal you were working in.
  it('still falls back to the sole selected terminal when nothing is focused', async () => {
    withOneAgent('a1')
    const t = fakeTerm()
    terminals.set('a1', t.term)

    await handleMenuEdit('paste')
    expect(t.paste).toHaveBeenCalledWith('CLIPBOARD')
    expect(nativeEdit).not.toHaveBeenCalled()
  })

  it('leaves a focused terminal on the xterm path', async () => {
    withOneAgent('a1')
    const t = fakeTerm()
    terminals.set('a1', t.term)
    const pane = document.createElement('div')
    pane.className = 'vec-pane'
    pane.dataset.id = 'a1'
    const host = document.createElement('div')
    host.className = 'vec-pane__term'
    const ta = document.createElement('textarea')
    host.appendChild(ta)
    pane.appendChild(host)
    document.body.appendChild(pane)
    ta.focus()

    await handleMenuEdit('copy')
    expect(write).toHaveBeenCalledWith('TERMINAL SCROLLBACK')
    expect(nativeEdit).not.toHaveBeenCalled()
  })

  it('leaves a focused plain input to the input path', async () => {
    withOneAgent('a1')
    const t = fakeTerm()
    terminals.set('a1', t.term)
    const input = document.createElement('input')
    input.value = 'rename me'
    document.body.appendChild(input)
    input.focus()
    input.setSelectionRange(0, 6)

    await handleMenuEdit('copy')
    expect(write).toHaveBeenCalledWith('rename')
    expect(nativeEdit).not.toHaveBeenCalled()
  })
})

// jsdom does not implement isContentEditable, so the attribute fallback is what
// keeps the tests above honest — and what covers focus landing on a child node.
describe('isRichEditable', () => {
  it('recognises an editable host and its descendants', () => {
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    const line = document.createElement('span')
    host.appendChild(line)
    document.body.appendChild(host)
    expect(isRichEditable(host)).toBe(true)
    expect(isRichEditable(line)).toBe(true)
  })

  it('is false for ordinary elements and for an explicitly non-editable one', () => {
    const plain = document.createElement('div')
    const off = document.createElement('div')
    off.setAttribute('contenteditable', 'false')
    expect(isRichEditable(plain)).toBe(false)
    expect(isRichEditable(off)).toBe(false)
    expect(isRichEditable(null)).toBe(false)
  })
})
