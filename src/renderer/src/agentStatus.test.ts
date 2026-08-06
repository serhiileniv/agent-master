import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createAgentStatusTracker,
  DONE_AFTER_MS,
  DONE_CONFIRM_MS,
  MAX_WORK_MS,
  SETTLE_MS,
  type AgentStatusSink
} from './agentStatus'
import { MISSING_BIN_WINDOW_MS } from './missingBinary'

// The attention system: whether a card shows a spinner, a tick or an amber
// "needs you", and whether the app raises a desktop notification. Every one of
// these thresholds exists because an earlier version got it wrong — false
// "done" alerts on mid-task pauses, attention lost when a program rang the bell
// and kept drawing, a log tail read as an agent thinking. None of it had a test
// while it lived in a .tsx file, which vitest does not collect.

function sink(): AgentStatusSink & {
  statuses: string[]
  notices: string[]
  cues: string[]
  flashes: number
  missing: string[]
} {
  const s = {
    statuses: [] as string[],
    notices: [] as string[],
    cues: [] as string[],
    flashes: 0,
    missing: [] as string[],
    setStatus: (v: string) => void s.statuses.push(v),
    setWorking: () => void s.statuses.push('working'),
    notify: (k: string) => void s.notices.push(k),
    sound: (c: string) => void s.cues.push(c),
    doneFlash: () => void s.flashes++,
    missingBinary: (b: string) => void s.missing.push(b)
  }
  return s as unknown as AgentStatusSink & {
    statuses: string[]
    notices: string[]
    cues: string[]
    flashes: number
    missing: string[]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Stream output for `ms`, in chunks close enough together never to settle. */
function streamFor(t: { onData: (s: string) => void }, ms: number): void {
  const step = SETTLE_MS / 2
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    t.onData('.')
    vi.advanceTimersByTime(step)
  }
}

describe('working and settling', () => {
  it('flips to working on the first chunk and settles to idle', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)

    t.onData('hello')
    expect(s.statuses).toEqual(['working'])

    vi.advanceTimersByTime(SETTLE_MS)
    expect(s.statuses).toEqual(['working', 'idle'])
  })

  it('coalesces a burst into one working flip', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    for (let i = 0; i < 20; i++) t.onData('chunk')
    expect(s.statuses).toEqual(['working'])
  })

  it('settles to attention when the tail looks like a blocking prompt', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onData('Do you want to make this edit?')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(s.statuses.at(-1)).toBe('attention')
    expect(s.notices).toEqual(['attention'])
  })

  // A dev server or log tail prints forever. It must not read as an agent
  // thinking, or the card spins indefinitely and the work timer climbs.
  it('classifies unbroken output past the ceiling as steady, not working', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, MAX_WORK_MS + SETTLE_MS)
    expect(s.statuses.at(-1)).toBe('idle')
    // One working flip at the start, then it stops flipping.
    expect(s.statuses.filter((x) => x === 'working')).toHaveLength(1)
  })
})

describe('the done notification', () => {
  it('says nothing for a burst too short to be a task', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS / 2)
    vi.advanceTimersByTime(SETTLE_MS + DONE_CONFIRM_MS * 2)
    expect(s.notices).toEqual([])
    expect(s.flashes).toBe(0)
  })

  it('announces a finish once a real task goes quiet long enough', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS + 1000)

    vi.advanceTimersByTime(SETTLE_MS)
    expect(s.notices).toEqual([]) // settled, but not yet believed

    vi.advanceTimersByTime(DONE_CONFIRM_MS)
    expect(s.notices).toEqual(['done'])
    expect(s.cues).toEqual(['done'])
    expect(s.flashes).toBe(1)
  })

  // The regression this whole confirm delay exists for: agents pause for
  // several seconds mid-task (thinking, sub-agent handoffs) and the settle
  // alone read every pause as a finish.
  it('cancels a pending finish when output resumes', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS + 1000)

    vi.advanceTimersByTime(SETTLE_MS + DONE_CONFIRM_MS / 2)
    t.onData('back to work')
    vi.advanceTimersByTime(DONE_CONFIRM_MS)

    expect(s.notices).toEqual([])
  })

  it('does not also announce done when the task ended in a question', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS + 1000)
    t.onData('\nDo you want to proceed?')

    vi.advanceTimersByTime(SETTLE_MS + DONE_CONFIRM_MS * 2)
    expect(s.notices).toEqual(['attention'])
  })
})

describe('the bell', () => {
  it('goes to attention immediately, without waiting for a settle', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onData('working')
    t.onBell()
    expect(s.statuses.at(-1)).toBe('attention')
    expect(s.notices).toEqual(['attention'])
  })

  // Programs ring the bell and then keep drawing the prompt. Without the latch
  // that redraw flips working → idle and the attention is lost.
  it('sticks through the output that follows it', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onBell()
    t.onData('redrawing the prompt')
    vi.advanceTimersByTime(SETTLE_MS)
    expect(s.statuses.at(-1)).toBe('attention')
  })

  it('is cleared by the user typing, since they are evidently engaged', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onBell()
    t.onUserInput()
    expect(s.statuses.at(-1)).toBe('idle')
  })

  it('ignores typing when no bell is latched', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onData('x')
    const before = [...s.statuses]
    t.onUserInput()
    expect(s.statuses).toEqual(before)
  })
})

describe('exit', () => {
  it('reports a clean exit as finished', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onExit(0)
    expect(s.statuses).toEqual(['exited'])
    expect(s.notices).toEqual(['exited'])
    expect(s.cues).toEqual(['done'])
  })

  it('reports a non-zero exit as an error', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onExit(1)
    expect(s.statuses).toEqual(['error'])
    expect(s.notices).toEqual(['error'])
    expect(s.cues).toEqual(['error'])
  })

  it('supersedes a pending finish rather than announcing twice', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS + 1000)
    vi.advanceTimersByTime(SETTLE_MS)
    t.onExit(0)
    vi.advanceTimersByTime(DONE_CONFIRM_MS * 2)
    expect(s.notices).toEqual(['exited'])
  })
})

describe('missing binary', () => {
  const spec = { startupCommand: 'claude --resume' }

  it('reports the binary when the shell says it is not found', () => {
    const s = sink()
    const t = createAgentStatusTracker(spec, s)
    t.armMissingBinaryWatch()
    t.onData('bash: claude: command not found\n')
    expect(s.missing).toEqual(['claude'])
  })

  it('reports at most once however much more output arrives', () => {
    const s = sink()
    const t = createAgentStatusTracker(spec, s)
    t.armMissingBinaryWatch()
    t.onData('bash: claude: command not found\n')
    t.onData('bash: claude: command not found\n')
    expect(s.missing).toEqual(['claude'])
  })

  it('watches nothing until the startup command has been sent', () => {
    const s = sink()
    const t = createAgentStatusTracker(spec, s)
    t.onData('bash: claude: command not found\n')
    expect(s.missing).toEqual([])
  })

  it('stops watching once the window has passed', () => {
    const s = sink()
    const t = createAgentStatusTracker(spec, s)
    t.armMissingBinaryWatch()
    vi.advanceTimersByTime(MISSING_BIN_WINDOW_MS + 1000)
    t.onData('bash: claude: command not found\n')
    expect(s.missing).toEqual([])
  })

  it('watches nothing for a pane with no startup command', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.armMissingBinaryWatch()
    t.onData('bash: claude: command not found\n')
    expect(s.missing).toEqual([])
  })
})

describe('dispose', () => {
  it('stops a pending settle from firing into a torn-down pane', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    t.onData('x')
    t.dispose()
    vi.advanceTimersByTime(SETTLE_MS + DONE_CONFIRM_MS * 2)
    expect(s.statuses).toEqual(['working'])
  })

  it('stops a pending finish from notifying after teardown', () => {
    const s = sink()
    const t = createAgentStatusTracker({}, s)
    streamFor(t, DONE_AFTER_MS + 1000)
    vi.advanceTimersByTime(SETTLE_MS)
    t.dispose()
    vi.advanceTimersByTime(DONE_CONFIRM_MS * 2)
    expect(s.notices).toEqual([])
  })
})
