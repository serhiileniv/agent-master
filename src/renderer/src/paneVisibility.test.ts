import { describe, it, expect } from 'vitest'
import { isPaneOnScreen, OFFSCREEN_BUFFER_CAP } from './paneVisibility'

const pane = (over: Partial<Parameters<typeof isPaneOnScreen>[0]> = {}) =>
  isPaneOnScreen({
    activeWorkspaceId: 'ws1',
    workspaceId: 'ws1',
    focusedId: null,
    agentId: 'a1',
    ...over
  })

describe('isPaneOnScreen', () => {
  it('paints a pane in the active workspace with nothing maximized', () => {
    expect(pane()).toBe(true)
  })

  // The whole point of the change: a background tab's agent keeps running, but
  // its terminal stops repainting into a layer the compositor skips.
  it('skips a pane whose workspace is a background tab', () => {
    expect(pane({ activeWorkspaceId: 'ws2' })).toBe(false)
  })

  it('skips the siblings hidden behind a maximized pane', () => {
    expect(pane({ focusedId: 'a2' })).toBe(false)
  })

  it('paints the maximized pane itself', () => {
    expect(pane({ focusedId: 'a1' })).toBe(true)
  })

  // Maximizing in a background tab must not resurrect that tab's painting.
  it('still skips a maximized pane in a background workspace', () => {
    expect(pane({ activeWorkspaceId: 'ws2', focusedId: 'a1' })).toBe(false)
  })

  it('skips every pane before the first workspace opens', () => {
    expect(pane({ activeWorkspaceId: null })).toBe(false)
  })
})

describe('offscreen buffering', () => {
  // A cap this size can hold far more than a terminal can display, so flushing
  // at it never skips content the user could have seen — but it does stop a
  // runaway background process from growing the heap without bound.
  it('caps buffered output well above one screenful and well below a leak', () => {
    expect(OFFSCREEN_BUFFER_CAP).toBeGreaterThanOrEqual(64 * 1024)
    expect(OFFSCREEN_BUFFER_CAP).toBeLessThanOrEqual(512 * 1024)
  })
})
