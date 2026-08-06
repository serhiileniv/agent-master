# Architecture

How Spy Master is put together, for anyone modifying it. For build and run instructions see
[CONTRIBUTING.md](../CONTRIBUTING.md); for cutting a release see [RELEASING.md](RELEASING.md).

## Overview

Spy Master is an Electron app with the standard three-process split. The main process owns everything
privileged — PTYs, git, the filesystem — and the renderer owns nothing but pixels and state. All
crossings go through a narrow, explicitly enumerated `contextBridge` API.

```
src/
  main/        Electron main process
    index.ts          window + production CSP
    ipc.ts            IPC handlers (pty / project / git / worktree / diff-merge / update)
    pty-manager.ts    node-pty session manager
    git.ts            git + worktree + diff/merge
    scoped-files.ts   file panel reads/writes, confined to a scope root
    workspace-store.ts  atomic, serialized read/write of workspaces.json
    update.ts         newer-release check against the release feed
  preload/     contextBridge API (window.api.{pty,project,git,worktree,update,platform})
  renderer/    React + Zustand; xterm.js terminals on an auto-tiling stage
    agentStatus.ts    what a pane's output means (working / done / attention)
    missingBinary.ts  recognising "the agent CLI isn't installed"
    terminalBoot.ts   quiet boot — hold the pane blank until the shell is ready
    components/  Stage, TerminalPane, Rail, CommandPalette, DiffPanel, Settings
```

Handlers in `ipc.ts` are deliberately thin. Where a channel carries real
decisions — the file panel's containment guard, the workspace file's atomicity —
those live in their own module so they can be unit-tested without booting
Electron, and the handler just calls them.

## Terminals

Each agent card is a real PTY. xterm.js in the renderer talks to
[`node-pty`](https://github.com/microsoft/node-pty) in the main process over IPC.

`node-pty` ships as a **prebuilt** binary (`@homebridge/node-pty-prebuilt-multiarch`), which is why
no native toolchain is needed to build Spy Master. `.npmrc` pins the Electron ABI the prebuilt is
compiled against — **if you bump the Electron major version, that pin must move with it**, or the
module will fail to load at runtime. `npm run smoke:pty` exists specifically to catch this.

PTY output is batched before crossing the IPC boundary rather than sent per-chunk. This matters:
a chatty agent generating output at full speed will otherwise saturate IPC and heat the machine.

**Off-screen panes stop painting, but never stop running.** A pane in a background workspace, or
one sitting behind a maximized sibling, is `content-visibility: hidden` — the compositor skips it
entirely — so feeding xterm would pay a full ANSI parse and DOM mutation for a surface nobody can
see. Those panes buffer their output instead and replay it byte-identically when the pane returns
(`src/renderer/src/paneVisibility.ts`). The agent process is untouched by this, and so is every
signal derived from the raw pty stream: status, the bell, notifications, the missing-binary watch.

Coming back on screen is the **only** thing that drains that buffer — there is deliberately no
timer — so App flushes synchronously on workspace activation and on maximize changes, then forces a
redraw once layout is restored (a write into a still-hidden subtree leaves the rendered rows stale).
`smoke:offscreen` asserts both halves: held back while hidden, whole and in order on return.

## Isolation

Every agent gets `git worktree add` on its own branch (`canvas/<id>`), checked out into a sibling
`.spymaster-worktrees/` directory next to the repository — deliberately outside the repo so it never
appears in the user's own status or file tree.

Agents are **cwd-pinned after spawn**, so a shell profile that `cd`s on startup can't quietly move
an agent out of its worktree and into the user's real working tree. This is the single most
important safety property in the app; treat changes near it carefully and cover them with
`smoke:p2`.

## Diff and merge

`src/main/git.ts` owns the whole lifecycle: detecting whether a folder is a repo, creating and
tearing down worktrees, producing diffs against the base branch, and merging or discarding a
branch. The renderer never shells out to git — it asks for a result.

Every git process the module starts goes through one runner, and that runner is swappable
(`setGitRunner`). Production always uses the real one; tests substitute a scripted git so the
destructive paths — `applyAgentFiles` and its rollback, orphan removal, merge conflict handling —
can be exercised without a repository on disk. Nothing in the app calls `setGitRunner`.

`smoke:p3` covers the path that actually lands work on a user's base branch. Any change to merge
behaviour should run it.

## Persistence

The full tab set lives in `workspaces.json` in Electron's user-data folder, written atomically so a
crash mid-write can't corrupt it. Workspaces are first-class: renameable, folder-less, and each
agent carries its own folder.

Older builds stored one canvas per project at `<project>/.monad/canvas.json`. That file is still
read once to migrate existing users, then ignored. `smoke:wspersist` covers both the current format
and the legacy migration.

## Updates

On launch the app checks the [release feed](https://github.com/serhiileniv/spymaster/releases) and
shows an in-app notice when a newer version exists. Windows additionally supports true in-place
auto-update via `electron-updater`, which requires `latest*.yml` and blockmap files to be attached
to every release — see [RELEASING.md](RELEASING.md).

## Security posture

- `contextIsolation` on, with a preload bridge that exposes only named channels.
- A strict Content Security Policy is applied in production builds (`src/main/index.ts`).
- The file panel enforces a project-root boundary; `smoke:file` asserts that `../` traversal is
  blocked for both reads and directory listings.

See [SECURITY.md](../SECURITY.md) for the threat model and how to report a vulnerability.

## Tests

Two layers, both run in CI on every push (`.github/workflows/ci.yml`). Packaging is gated on them.

**Fast checks** — no build required:

```bash
npm run typecheck
npm run lint        # bug-focused rules (react-hooks + a small correctness set)
npm run test        # unit tests: tiling math, shell quoting, git path decoding,
                    # the git worktree/merge/apply lifecycle against a scripted git,
                    # the file-panel containment guard, workspaces.json atomicity,
                    # the agent status/attention heuristics, and the quiet boot
```

**Integration smoke tests** — these drive the real built bundles and IPC under a headless Electron,
so run `npm run build` first. They live in `scripts/smoke/`:

```bash
npm run smoke:pty          # PTY loads under Electron ABI + shell echo
npm run smoke:p1           # preload bridge, legacy canvas load, renderer PTY
npm run smoke:p2           # git detect, worktree isolation, agent cwd pinning, teardown
npm run smoke:p3           # diff sees changes, merge lands work on base branch
npm run smoke:file         # file tree/read/save + path-traversal guard
npm run smoke:ws           # workspace store
npm run smoke:tabs         # tab behaviour
npm run smoke:wspersist    # workspace persistence + legacy migration
npm run smoke:agentfolder  # per-agent folders
npm run smoke:offscreen    # off-screen panes buffer output, and replay it intact
npm run smoke:envpath      # PATH resolution never hangs shells:list
npm run smoke:quietboot    # a pane opens on a prompt, not the PowerShell banner
```

`scripts/diag/` holds manual diagnostic harnesses — they open a real window for eyeballing terminal
or stage behaviour and are not part of CI.

Smoke scripts resolve the built bundles relative to their own location
(`join(__dirname, '..', '..', 'out', ...)`). If you move one, that depth has to move with it.
