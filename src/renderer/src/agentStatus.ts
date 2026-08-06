/**
 * What a pane's output means: working, finished, or waiting for you.
 *
 * This is the attention system — the thing that decides whether a card shows a
 * spinner, a green tick or an amber "needs you", and whether the app raises a
 * desktop notification. It reads nothing but the raw PTY stream and the clock,
 * and it drives everything through a sink, so the pane wires it to xterm and
 * the store while this module makes the decisions.
 *
 * It lived inside TerminalPane's mount effect, in a .tsx file that
 * vitest.config.ts does not collect, which meant the heuristics with the most
 * tuning history in the app had no test at all.
 */
import { needsAttention, clampTail } from './attention'
import {
  MISSING_BIN_WINDOW_MS,
  missingBinaryMatchers,
  reportsMissingBinary,
  startupBinaryName
} from './missingBinary'
import type { AgentStatus } from './store'
import type { Cue } from './sound'

/** How long output must stop before the status is re-evaluated at all. */
export const SETTLE_MS = 800

/** A working burst shorter than this reads as routine shell echo (ls, cd…),
 *  not a task — don't announce those settling back to idle. */
export const DONE_AFTER_MS = 8000

/** How long a settle must stay silent before "done" is believed. Agent CLIs
 *  routinely pause output for several seconds mid-task (API thinking waits,
 *  sub-agent handoffs); the settle alone reads each such pause as a finish and
 *  fires a false "done". Resumed output cancels the pending notification. */
export const DONE_CONFIRM_MS = 12000

/** Continuous-output ceiling. An agent's work is bursty — tool calls, API waits
 *  and message boundaries punctuate it with gaps that reset the burst — so a
 *  burst that runs THIS long with no gap at all isn't an agent thinking, it's a
 *  process that just keeps printing (dev server, log tail, htop). Kept high so a
 *  genuinely long agent stream is never mistaken for idle. */
export const MAX_WORK_MS = 180000

/** How much raw tail to keep for attention matching. */
export const TAIL_LIMIT = 1200

export type NotifyKind = 'attention' | 'done' | 'exited' | 'error'

/** Everything the tracker does to the outside world. */
export interface AgentStatusSink {
  setStatus: (s: AgentStatus) => void
  /** Enter 'working', carrying the moment the burst began (drives the timer). */
  setWorking: (since: number) => void
  notify: (kind: NotifyKind) => void
  sound: (cue: Cue) => void
  /** Quiet visual nod on the card when a task is confirmed finished. */
  doneFlash: () => void
  /** The startup binary isn't on PATH. Fires at most once per tracker. */
  missingBinary: (bin: string) => void
}

export interface AgentStatusTracker {
  /** A raw chunk straight off the PTY — not ANSI-stripped. Stripping per chunk
   *  leaks halves of escape sequences split across chunk boundaries. */
  onData: (chunk: string) => void
  /** BEL from the program itself — the one non-heuristic "I need you" signal
   *  (Claude Code rings it on permission prompts). */
  onBell: () => void
  onExit: (code: number) => void
  /** The user typed. Engagement clears a latched bell. */
  onUserInput: () => void
  /** The startup command has just been sent — start watching for a missing
   *  binary from now. */
  armMissingBinaryWatch: () => void
  dispose: () => void
}

export function createAgentStatusTracker(
  spec: { startupCommand?: string },
  sink: AgentStatusSink
): AgentStatusTracker {
  let disposed = false
  let tail = ''
  let working = false
  let workingSince = 0
  let bellRang = false
  // Set once output has streamed with no settle-length gap for longer than
  // MAX_WORK_MS — a live process, not a task that will finish. Cleared by any
  // real gap, so a later burst is tracked from scratch.
  let steady = false
  // True once any burst has run long enough to count as a task. Survives the
  // short gaps inside an agent run, so the eventual real finish still notifies
  // even when the final burst itself was brief.
  let taskActive = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let doneConfirmTimer: ReturnType<typeof setTimeout> | undefined

  const bin = startupBinaryName(spec.startupCommand)
  const matchers = missingBinaryMatchers(bin)
  let missingBinNotified = false
  let armedAt = 0

  const checkMissingBin = (): void => {
    if (!bin || missingBinNotified) return
    if (!armedAt || Date.now() - armedAt > MISSING_BIN_WINDOW_MS) return
    if (!reportsMissingBinary(tail, matchers)) return
    missingBinNotified = true
    sink.missingBinary(bin)
  }

  const evaluateIdle = (): void => {
    if (disposed) return
    const ranFor = workingSince ? Date.now() - workingSince : 0
    working = false
    workingSince = 0
    // A real gap happened → the next output is a fresh burst, not a
    // continuation of a steady stream. Re-arm burst tracking.
    steady = false
    // A bell "sticks" until the next settle: programs usually ring it and then
    // keep drawing the prompt, which would otherwise flip the status back to
    // working → idle and lose the attention.
    const next: AgentStatus = bellRang || needsAttention(tail) ? 'attention' : 'idle'
    bellRang = false
    sink.setStatus(next)
    if (ranFor >= DONE_AFTER_MS) taskActive = true
    if (next === 'attention') {
      // The task ended in a question — the attention alert covers it; a later
      // quiet spell must not ALSO announce "done".
      taskActive = false
      clearTimeout(doneConfirmTimer)
      sink.notify('attention')
      sink.sound('attention')
    } else if (taskActive) {
      // Looks finished — but agents pause like this mid-task too. Only believe
      // it after DONE_CONFIRM_MS of unbroken quiet; onData cancels this timer
      // the moment output resumes.
      clearTimeout(doneConfirmTimer)
      doneConfirmTimer = setTimeout(() => {
        if (disposed) return
        taskActive = false
        sink.notify('done')
        sink.sound('done')
        sink.doneFlash()
      }, DONE_CONFIRM_MS)
    }
  }

  return {
    onData(chunk) {
      if (disposed) return
      tail = clampTail(tail + chunk, TAIL_LIMIT)
      checkMissingBin()
      // Output resumed — whatever settle preceded it was a mid-task pause, not
      // a finish. Kill the pending "done" before it can fire.
      clearTimeout(doneConfirmTimer)
      // Once classified steady, stop flipping to "working" on each chunk — just
      // keep the tail current and let the idle timer re-check when the stream
      // finally pauses.
      if (!steady) {
        if (!working) {
          working = true
          workingSince = Date.now()
          sink.setWorking(workingSince)
        } else if (Date.now() - workingSince > MAX_WORK_MS) {
          steady = true
          working = false
          workingSince = 0
          taskActive = false
          sink.setStatus(needsAttention(tail) ? 'attention' : 'idle')
        }
      }
      clearTimeout(idleTimer)
      idleTimer = setTimeout(evaluateIdle, SETTLE_MS)
    },

    onBell() {
      if (disposed) return
      bellRang = true
      clearTimeout(idleTimer)
      clearTimeout(doneConfirmTimer)
      working = false
      workingSince = 0
      steady = false
      taskActive = false
      sink.setStatus('attention')
      sink.notify('attention')
      sink.sound('attention')
    },

    onExit(code) {
      clearTimeout(idleTimer)
      // The exit supersedes any pending settle-based "done".
      clearTimeout(doneConfirmTimer)
      const errored = !!code && code !== 0
      sink.setStatus(errored ? 'error' : 'exited')
      sink.notify(errored ? 'error' : 'exited')
      sink.sound(errored ? 'error' : 'done')
    },

    onUserInput() {
      // Typing into a pane means you're engaged — clear a latched bell so a
      // one-off \a (a build finishing, a beep) doesn't keep the pane stuck
      // showing "attention", and re-nagging, when nothing is waiting on you.
      if (!bellRang) return
      bellRang = false
      if (!working) sink.setStatus('idle')
    },

    armMissingBinaryWatch() {
      armedAt = Date.now()
    },

    dispose() {
      disposed = true
      clearTimeout(idleTimer)
      clearTimeout(doneConfirmTimer)
    }
  }
}
