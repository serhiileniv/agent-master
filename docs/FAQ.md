# FAQ

Common questions about running Spy Master. For how it's built, see
[ARCHITECTURE.md](ARCHITECTURE.md); for building from source, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## How Spy Master compares

If you're already running agents in parallel, you're probably doing one of these:

| Instead of… | Spy Master gives you |
| --- | --- |
| **Tiled terminal panes** (tmux, Windows Terminal) | The same tiling, plus per-agent worktrees, status, and diff/merge — no scripting |
| **Manual `git worktree` juggling** | Worktree create/teardown per agent, handled automatically |
| **One agent at a time in your IDE** | Several agents at once, each isolated in its own worktree, reviewed and merged one by one |
| **A cloud agent platform** | Local execution, your own CLIs and keys, no inference bill, no code leaving your machine |

Spy Master isn't another agent — it's the surface you run the agents you already pay for on.

## Does Spy Master cost anything to run?

No. Spy Master is MIT-licensed and free, and it has no inference cost of its own — it drives the
agent CLIs already installed on your machine, using your existing credentials and plans.

## Do I need a git repository?

No, but it's recommended. Spy Master opens any folder; a git repo is what unlocks per-agent worktree
isolation, diff, and merge. Without git you still get the parallel terminal stage.

## macOS says the app is "damaged and can't be opened."

Builds aren't yet signed with a paid Apple Developer certificate, so Gatekeeper quarantines them.
Remove the quarantine flag once after installing:

```bash
xattr -dr com.apple.quarantine "/Applications/Spy Master.app"
```

Windows shows a comparable one-time SmartScreen prompt (**More info → Run anyway**). Proper
signing and notarization are on the roadmap.

## How many agents can run at once?

Up to nine tile automatically on the canvas. Each is a real PTY, so the practical limit is your
machine's CPU and memory.

## Where does Spy Master store my data?

Workspace and layout state lives in `workspaces.json` in the app's user-data folder. Agent
branches live in a sibling `.spymaster-worktrees/` directory next to your repo. Nothing is sent
anywhere — there's no account, no telemetry, and no background service.

## What's actually happening under the hood?

- **Terminals** — xterm.js ↔ `node-pty` (prebuilt) over IPC, with output batched before it
  crosses the boundary.
- **Isolation** — `git worktree add` per agent (branch `canvas/<id>`), kept in a sibling
  `.spymaster-worktrees/` folder; agents are cwd-pinned after spawn so a shell profile can't move
  them out of their worktree.
- **Persistence** — the whole tab set lives in `workspaces.json` in the app's user-data folder,
  written atomically.
- **Updates** — on launch the app checks the
  [release feed](https://github.com/Serhii-Leniv/spymaster/releases) and shows an in-app notice when
  a newer version is out.

Full details — process split, security posture, and the two test layers — are in
[ARCHITECTURE.md](ARCHITECTURE.md).
