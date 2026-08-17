# CONTEXT.md — domain glossary

The vocabulary of Agent Master, as the code actually uses it. Use these terms exactly. Where two names
exist for one concept, this file names the winner.

This is a **descriptive** document: it records the language in the codebase today, including the
inconsistencies. It is not a rename plan. See [CLAUDE.md](CLAUDE.md) for working rules and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

Agent Master has been renamed four times — **Vectro → agent-canvas → Monad → Spy Master → Agent
Master**. Earlier names survive in identifiers, storage keys, and git branch names. That is
deliberate: changing them would orphan existing users' data.

The Agent Master rename, like the Spy Master one before it, was a **clean break** on app identity:
new `appId`, new `productName`, and therefore a new userData directory. Nothing is migrated forward
from Spy Master. What was *not* broken is anything already written into a user's own repo — see the
frozen names below.

---

## Core entities

### Agent — `AgentInstance` (`src/renderer/src/store.ts`)

One running terminal on the canvas: a PTY, a card on screen, and usually its own git worktree.
**"Agent" is the canonical term.** The codebase also calls this a *terminal* (user-facing strings),
a *pane* (`TerminalPane.tsx`), a *card* (drag/layout code), and a *tile* (tiling math). All five mean
`AgentInstance`. Prefer **agent** in new code; the others are acceptable where they match the
surrounding file's register — *terminal* in user-facing copy, *card*/*tile* in layout code.

Capped at `MAX_AGENTS = 9` per workspace — more than that on one canvas is unreadable.

Persisted fields include `label` (short pronounceable name, e.g. "Robi"), geometry, `isolation`,
`shellId`, and `projectPath`. Runtime-only fields (`ptyId`, `status`, `cwd`, `branch`, `isolated`,
drag markers) are never written to disk.

### Workspace — `WorkspaceSession`

One open project folder with its own canvas of agents. **This is what the top-bar tabs switch
between.** Exactly one is `activeWorkspaceId` (visible and interactive); the rest stay mounted but
hidden so their PTYs keep streaming. Capped at `MAX_LIVE_WORKSPACES = 6`.

Workspaces are first-class and **folder-less**: `defaultPath` is the folder *new agents inherit*, not
"the workspace's folder". Renaming a tab never touches a folder on disk. Auto-generated names match
`/^Workspace \d+$/`.

### Agent CLI — `AgentCli` (`api.agents.list()`)

An installed coding-agent binary — Claude Code, Codex, Gemini. Entirely distinct from an
`AgentInstance`. This is the thing whose id lands in `AgentInstance.agentId` to pick an icon.

### Worktree

A `git worktree` checkout giving one agent an isolated branch. Identified by **(repoRoot, agentId)** —
nothing is stored, the location is derived:

- **container** — `<parent-of-repo>/.agentmaster-worktrees`, a *sibling* of the repo so the agent never
  sees nested worktrees as untracked. Shared by all repos with the same parent.
- **worktree path** — `<container>/<repoName>-<short12>`
- **branch** — `canvas/<short12>`, where `short12` is 12 alphanumeric chars of the agent's UUID

### Repo

A git repository root (`repoRoot`). Used consistently and unambiguously throughout `src/main/git.ts`.

### Stage

The tiling surface a workspace's agents are laid out on (`Stage.tsx`). One Stage is mounted per live
workspace. Historically also called the **canvas** — see below.

### Scope root

The absolute directory the file panel is confined to. Every path the renderer sends the file API is
relative to it, and nothing outside it is reachable — see `resolveWithin` / `resolveWithinReal` in
`src/main/scoped-files.ts`. Resolved by `agentPath()`, so it follows the selected agent's folder.

### Entry

One file or folder row in the file tree (`FileEntry`, `{ name, kind: 'dir' | 'file' }`). Say *entry*
rather than "node" or "item" — the operations are named after it (`createEntry`, `renameEntry`,
`moveEntry`, `deleteEntries`).

### Inline editor

The text box that replaces a row in the file tree while creating or renaming, with its validation
message underneath. Distinct from the **file editor**, which is the CodeMirror pane below the tree.

---

## Naming hazards

These have concrete potential to cause bugs. Read them before writing code that touches either.

### `Workspace` is **not** a workspace

```ts
export type Workspace = RecentProject   // { path, name }
```

The type named `Workspace` is an alias for a **recently-opened folder** in the switcher's recents
list. The live tab is `WorkspaceSession`. So the store field `workspaces: Workspace[]` means
**recents**, not open tabs — open tabs live elsewhere in the session state.

> When you read or write "workspace", establish which one you mean. `WorkspaceSession` = live tab.
> `Workspace`/`RecentProject` = recents entry.

### `agentId` means two different things

- On `AgentInstance`, **`agentId` is the CLI product id** (`claude`, `codex`, `gemini`). The
  instance's own identity is its `id` field.
- In every main-process signature — `git.ts`, `ipc.ts`, the preload bridge — **`agentId` means
  `AgentInstance.id`**.

The meaning flips at the IPC boundary. When passing an id across it, confirm which one you have.

### `agentPath()` is the only correct answer to "where does this agent run?"

```ts
export function agentPath(ws, agent): string | null
```

The agent's own `projectPath` override if it has one, else its workspace's `defaultPath`, else null.
Worktree creation, the diff view, the file panel, and the spawn cwd must all agree — **reading
`ws.defaultPath` directly is the bug this function exists to prevent.**

### `isolation` vs `isolated`

`isolation: 'worktree' | 'shared'` is the *intent*. `isolated: boolean` is the runtime *outcome* —
false when an agent asked for a worktree but silently fell back to the shared directory. The pair
exists precisely because they can disagree; do not collapse them.

### Three verbs for "put this agent in front of me"

- **focus** (`focusTerminal`) — maximize / tmux-style zoom to fill the viewport
- **reveal** (`revealAgent`) — bring forward without zooming
- **select** (`selectedIds`) — selection and keyboard target

Distinct concepts, distinct state (`focusedId` vs `selectedIds`).

### `merge` vs `apply`

- **merge** (`mergeAgent`) — commit the agent's work, then `git merge --no-ff` its branch into the
  current HEAD. Aborts cleanly on conflict.
- **apply** (`applyAgentFiles`, "partial apply") — take the agent's version of *specific files* onto
  the current branch as a plain commit. **No merge**, so the agent's branch stays unmerged and the
  agent can keep working.

### `hasWork` is a safety predicate, not a status

On `OrphanWorktree`, `hasWork` is true if the branch is unmerged, the tree is dirty, **or anything
failed while checking**. It fails safe: true means never auto-remove. "Not owned by this workspace"
is not the same as "safe to delete."

---

## Legacy terms

Still load-bearing. **Do not rename these opportunistically — user data depends on them. Do not
spread them into new code either.**

| Term | Where it survives | Why |
|---|---|---|
| **canvas** | `PersistedCanvas`, `CANVAS_DIR = '.monad'` | The old name for the Stage/workspace surface. Renderer state, CSS, and user-visible copy were renamed to **stage** (`stageW`/`stageH`, `setStageSize`, `.app__stage`); what survives is tied to the on-disk `canvas.json` format and must not be renamed. |
| **`canvas/` branch prefix** | Every worktree branch: `canvas/<short12>` | User-visible in git. The renderer strips it via `displayBranch()`. Worktree removal is *gated* on this prefix — changing it would strand existing branches. |
| **`vectro.`** | Every localStorage key | Frozen since the Vectro rename, and left alone through every rename since: each clean break gives a fresh userData directory, so these start empty anyway and renaming them would be churn against keys three files document as frozen. |
| **`vec-`** | CSS class prefix, ~100 occurrences | Cosmetic, but a bulk rename is churn with no user benefit. |
| **project** | `api.project.*`, `projectPath` params, `ProjectRef`, `ProjectBar.tsx`, `useActiveProjectPath/Name` | **Mixed.** Current when it means "a folder on disk" or a recents entry. Legacy when it means the workspace. |
| **`.monad/canvas.json`** | Per-project legacy save file | Read once to migrate old users, then ignored. There is deliberately **no** `project:save` handler. Kept at the *Monad* spelling through every rename since: nothing writes it, so renaming it would point the migration at a folder that can never exist. |
| **`.spymaster-worktrees/`, `.monad-worktrees/`** | Pre-rename worktree containers, one per earlier name | New worktrees go to `.agentmaster-worktrees/`, but git registers worktrees by absolute path inside the user's `.git`, so pre-rename checkouts are still there. `worktreeContainers()` returns all three; `createWorktree` adopts a legacy worktree in place, and orphan cleanup whitelists exactly those containers and nothing else. Every rename appends here; nothing is removed. |
| **`'preview' \| 'free'` layout modes** | `PersistedCanvas.layoutMode` in type defs | Dead. Live `LayoutMode` is `'grid' \| 'columns'`; hydration coerces anything non-`'columns'` to `'grid'`. |

---

## IPC channel convention

`<namespace>:<verb>` — lowercase namespace, camelCase verb (`cleanOrphans`, `applyFiles`,
`hasImage`). `ipcMain.handle` for request/response, `ipcMain.on` for fire-and-forget, `send()` for
main→renderer pushes.

Namespaces: `pty:`, `clipboard:`, `shells:`, `agents:`, `app:`, `update:`, `feedback:`, `wallpaper:`,
`path:`, `file:`, `project:`, `workspaces:`, `git:`, `worktree:`, `notify:`, `attention:`, `menu:`.

Known irregularities — match them rather than "fixing" them in passing:

- **`open:external`** — namespace is a verb, not a noun. Surfaced as top-level `api.openExternal`.
- **`path:` and `file:`** are two channel prefixes backing one preload namespace (`api.file.*`).
- **`workspaces:`** is the only plural namespace.

New channels should follow the regular convention.

---

## Persistence

| Location | Holds | Status |
|---|---|---|
| `userData/workspaces.json` | `PersistedWorkspaces { version, activeId, workspaces[] }` — the whole tab set | **Current single source of truth.** Atomic write-and-rename, serialized through a save chain, so a crash mid-write cannot corrupt it. |
| `<project>/.monad/canvas.json` | `PersistedCanvas` — one canvas per project | Legacy, read-only. Migrated once, then ignored; files are deliberately left on disk as a fallback. |
| `<parent>/.agentmaster-worktrees/` | Worktree container | Current |
| `<parent>/.spymaster-worktrees/`, `<parent>/.monad-worktrees/` | Pre-rename worktree containers | Legacy, still adopted and still cleaned |
| localStorage `vectro.*` | `settings`, `filePanelWidth`, `recent`, `openWorkspaces` (legacy), `update.firstSeen.<version>` | Current data, frozen key names |

Note `PersistedWorkspace.path` is the pre-per-agent-folders name for `defaultPath`, kept read-only
for compatibility — hydration reads `defaultPath ?? path ?? null`.

---

## Agent lifecycle

1. **create** — `createWorktree(repoRoot, agentId)`. `git worktree add <path> -b canvas/<short>`,
   falling back to reusing an existing branch from a previous session. Reuse is validated by
   `isRegisteredWorktree()` — a bare `existsSync` is explicitly not sufficient. Serialized per repo
   against `.git/index.lock` contention.
2. **run** — PTY spawns **cwd-pinned**, so a shell profile that `cd`s cannot move the agent out of
   its worktree into the user's real working tree. This is the single most important safety property
   in the app.
3. **diff** — `getAgentDiff()` diffs from the **merge-base**, not the base tip. Untracked files get a
   synthesized "new file" hunk, capped per-file and in total.
4. **land** — `mergeAgent()` (whole branch) or `applyAgentFiles()` (specific files, branch stays
   unmerged).
5. **teardown** — `removeWorktree()` removes the worktree, deletes the branch, and prunes. Called
   from `removeAgent`. **Closing a workspace tab deliberately does *not* tear down** — worktrees and
   branches survive a tab close.
6. **orphan sweep** — `findOrphanWorktrees()` / `cleanOrphanWorktrees()` reclaim worktrees left by
   previous sessions, skipping any where `hasWork` is true.
