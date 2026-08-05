# Staggered restore

- **Status:** draft — **not proceeding** (decided 2026-08-05)
- **Written:** 2026-08-05
- **Shipped in:** _(not shipped)_

> **Not being built.** Queuing agent starts means one shell that never reports back can hold a slot
> open, and the mitigation for that (a per-agent deadline) was judged not worth the complexity
> against a launch cost that the PATH and git-caching fixes already reduce. Kept because the
> Problem section and the measurements in Notes are the record of why launch was slow; if the heat
> is still there after those fixes land, this is where to restart — not from scratch.

## Problem

I keep several projects open at once — that is the whole reason I use Monad — so a normal session
is three or four workspace tabs with a handful of agents in each. When I launch the app, every one
of those agents starts in the same instant: every terminal in every tab, foreground and background
alike, boots its shell and relaunches its agent CLI simultaneously. On my Mac the fans spin up
within a second or two of clicking the Dock icon and the whole machine goes sluggish while it
works through the pile. Once it settles, the same agents run in parallel perfectly happily and I
barely notice them — so it is not that I am running too much, it is that Monad tries to start all
of it at once.

## Behaviour

1. When I launch Monad with several workspaces saved, every workspace and every agent in them still
   comes back and ends up running — nothing is skipped, and I do not have to click anything to
   bring an agent back.
2. When I launch, the agents in the workspace that opens in front start before the agents in
   background workspaces.
3. While the restore is still working through the queue, an agent that has not started yet shows a
   visibly pending state on its card rather than looking broken, failed, or blank.
4. When I click a background workspace tab while the restore is still working, that workspace's
   agents move to the front of the queue and start next.
5. When I start a new agent by hand (the **+** menu, ⌘T, opening a folder) while a restore is in
   progress, it starts immediately and does not wait behind the queue.
6. When the restore finishes, the app is in exactly the state it reaches today: same agents, same
   worktrees, same branches, same layout, all running in parallel.
7. An agent that fails to start during a staggered restore reports its error on its own card, the
   same way it does today, and does not stop the rest of the queue.
8. Closing a workspace tab, or closing an agent, while the restore is in progress removes it from
   the queue instead of starting it afterwards.

## Out of scope

- **Not starting agents at all.** Choosing to leave agents unstarted on launch is a separate
  feature with a real trade-off against convenience, and belongs behind a user setting. This spec
  restores everything, exactly as today — it only changes *when* within the first few seconds.
- **Reducing memory.** Staggering spreads the startup load; it does not lower the steady-state
  footprint. Ten restored agents still costs ten agents' worth of RAM.
- **Unloading or pausing agents in background workspaces.** Background agents keep streaming, which
  is deliberate and load-bearing.
- **Changing the `MAX_LIVE_WORKSPACES = 6` cap**, or the `MAX_AGENTS = 9` per-workspace cap.
- **The concurrency number as a user setting.** It should be picked by the app, not tuned by hand.

## Acceptance checks

| # | Check | Kind | Where |
|---|---|---|---|
| 1 | Restore a saved set of 2 workspaces × 3 agents; assert all 6 agents reach a live PTY, and that 6 worktrees exist | smoke | `scripts/smoke/restore-smoke.cjs` — **must be wired into `.github/workflows/ci.yml`** |
| 1 | Every persisted agent is enqueued exactly once — no drops, no duplicates — for sets larger than the concurrency limit | unit | `src/renderer/src/spawnQueue.test.ts` |
| 2 | Queue ordering puts active-workspace agents ahead of background ones | unit | `src/renderer/src/spawnQueue.test.ts` |
| 3 | An agent awaiting its turn reports the existing `starting` status, not `error`/`exited` | unit | `src/renderer/src/spawnQueue.test.ts` |
| 4 | Activating a workspace reprioritises its pending agents to the head of the queue | unit | `src/renderer/src/spawnQueue.test.ts` |
| 5 | An agent added while the queue is draining bypasses the queue | unit | `src/renderer/src/spawnQueue.test.ts` |
| 6 | Post-restore state matches today's: agent count, isolation flag, and branch per agent | smoke | `scripts/smoke/restore-smoke.cjs` |
| 6 | No more than N spawns are ever in flight at once during the restore | smoke | `scripts/smoke/restore-smoke.cjs` — assert observed peak concurrency ≤ N |
| 7 | One agent whose spawn rejects does not prevent later queue entries from starting | unit | `src/renderer/src/spawnQueue.test.ts` |
| 8 | An agent removed while pending is never spawned (no orphan PTY, no orphan worktree) | unit + smoke | `src/renderer/src/spawnQueue.test.ts`, `scripts/smoke/restore-smoke.cjs` |

Behaviour 3 also has a visual component (what "pending" looks like on the card). The *status* is
unit-checked above; the appearance is manual, and deliberately so — it is spacing and colour.

## Terms

- **agent** — one running terminal: a PTY, a card, usually its own worktree. _(existing)_
- **workspace** — a live tab (`WorkspaceSession`), per [CONTEXT.md](../../CONTEXT.md). _(existing)_
- **worktree** — the isolated `git worktree` checkout for one agent. _(existing)_
- **restore** — reopening the saved workspace set on launch (`restoreWorkspaces`). _(existing)_
- **spawn queue** — the bounded, prioritised list of agents waiting to start. _(new — add to
  `CONTEXT.md` in the same PR)_

## Risk

Touches two danger zones from [CLAUDE.md](../../CLAUDE.md):

- **Worktree lifecycle.** Restore is the path that creates a worktree per agent. Deferring a spawn
  must not change *whether* a worktree is created, nor create one for an agent that was closed
  while it waited. `createWorktree` is already serialized per repo, so the queue must not be relied
  on for that ordering — nor may it defeat it.
- **Agent cwd pinning after spawn.** The pin is injected right after spawn. Queuing must not
  separate a spawn from its pin, or an agent could land in the user's real repo.

**Mandatory: `smoke:p2`, `smoke:p3`, plus the new `smoke:restore`.** `smoke:wspersist` too, since
restore reads `workspaces.json`.

## Decisions

- **Queue, do not skip.** Deferring background workspaces entirely would break the product's core
  promise — parallel work across projects. The cost being fixed is the simultaneous *start*, not
  the parallel running, so everything still starts.
- **The queue lives in the renderer, not the main process.** It orders `TerminalPane` mount-effect
  spawns, and only the renderer knows which workspace is in front and which agent the user just
  clicked. The main process has no view of either.
- **Concurrency limit is a fixed small number, not derived from CPU count.** The cost per spawn is
  dominated by shell rc-chain I/O and an agent CLI's own boot, not by cores, so a core-scaled
  number would be tuned against the wrong quantity. Start at 2–3 and revisit with a real
  measurement on the reporter's M-series Mac.
- **Manually-created agents bypass the queue.** A queue that delays an agent the user just asked
  for trades a startup problem for a responsiveness problem.

## Open questions

- [ ] What exactly does a pending card show? Options: the existing `starting` status dot unchanged;
      a distinct "queued" label; or a subdued card. Needs a call before build — behaviour 3 is not
      checkable without it.
- [ ] Should the queue drain on a timer as well as on completion, so one hung shell (a spawn that
      neither resolves nor rejects) cannot stall every agent behind it? Leaning yes, with a
      per-entry ceiling of a few seconds — but it needs a decision, because "stalled forever behind
      one bad shell" is strictly worse than today's behaviour.
- [ ] Does the first agent of a *newly opened* folder (`openProjectByPath` → `addAgent`) count as
      manual (bypasses) or as restore (queued)? It is created by the app, but in direct response to
      the user opening a folder.

## Notes

- Measured cause, from the investigation on 2026-08-05: with 3 workspaces × 5 agents, launch fired
  roughly 100 git subprocesses, 15 login shells and up to 15 agent CLIs within the first seconds.
  The git half is fixed separately (repo-root caching, commit `601f972`) and is not what this spec
  addresses; the shells and agent CLIs are.
- Two related fixes already landed on `perf/nonblocking-path-detect` and are independent of this
  one: the login-shell PATH harvest no longer blocks window creation, and the renderer is now
  minified (3.20MB → 1.94MB).
- Rejected alternative: spawning background workspaces lazily on first tab activation. Simpler, but
  it means an agent you left working overnight in a background tab is not working when you get
  back — a silent behaviour change, and the opposite of what background workspaces are for.
- Worth revisiting later, and deliberately not here: an explicit user setting for how much a launch
  should restore. That is the only real lever on memory, and it is a genuine trade-off rather than
  a free win.
