---
name: run-agentmaster
description: Build, run, and start the Agent Master (agent-canvas) Electron desktop app so a human can review it. Use when asked to run, start, launch, or preview the app, or to confirm a UI change in the real window.
---

# Run Agent Master (agent-canvas)

Agent Master is an **Electron desktop app** (electron-vite + React renderer). To review
a change, launch the real window with `npm run dev` and look at it.

**All paths below are relative to the repo root**, and commands assume that is
the working directory. Shell examples use the Bash tool (Git Bash); `npm` also
works from PowerShell.

This skill is written for the primary development setup: **Windows with a real
display**, where there is no headless/xvfb layer and none is needed. The
`npm run dev` and `npm run build` paths are cross-platform; the single-instance
and detached-launch sections below are Windows-specific and are called out as
such.

## Prerequisites

Dependencies may be missing — a fresh checkout can have an **empty
`node_modules`** (0 entries). Check and install if so:

```bash
[ "$(ls node_modules 2>/dev/null | wc -l)" -gt 0 ] || npm install
```

`npm install` downloads the Electron binary (~tens of MB) and can take a few
minutes the first time. Run it in the background and wait for it to finish
before launching.

## Run (the normal path — live window with hot reload)

```bash
npm run dev            # electron-vite dev: opens the window, HMR on save
```

- Opens the actual app window. Edits to `src/renderer/**` hot-reload; main-
  process changes trigger a restart.
- This is a **long-running foreground process**.
- **An agent cannot keep this window open for the user.** A dev server /
  Electron window spawned from a Claude tool session (Bash background *or*
  PowerShell `Start-Process`) is torn down when the call returns — Windows
  job-object cleanup reaps the whole process tree, and it wouldn't surface on
  the user's interactive desktop regardless. The build runs fine and logs
  "start electron app…", then the process exits (0) with no window left.
- **So ask the user to launch it themselves.** In Claude Code they can type
  `!npm run dev` in the prompt — the `!` prefix runs it in *their* session, so
  the window opens on their desktop and persists with hot reload. Stop with
  Ctrl-C in that terminal.
- Agent-side (headless, self-terminating checks only): `npx electron <script>.cjs`
  where the script calls `process.exit()` itself — see the driving-state
  section below. That works because the process ends within the tool call.

## Run (production-like, no dev server)

Use when you want the built artifact rather than the dev server:

```bash
npm run build          # electron-vite build → out/{main,preload,renderer}
npx electron .         # main entry is ./out/main/index.js
```

`npm run build` must be re-run after any source change for this path to pick
it up (unlike `npm run dev`).

## Driving state (optional — for automated/headless checks)

You usually don't need this — a human reviews the window. But if an agent
needs to render a specific state without clicking through the UI:

- The Zustand store is exposed on the window as **`window.__agentStore`**
  (see `store.ts`). Set state directly, e.g. to open a project:
  `window.__agentStore.setState({ projectPath, projectName, isGit: true, baseBranch: 'main' })`.
- A throwaway BrowserWindow can load `out/renderer/index.html` with the
  preload at `out/preload/index.js`. Register the real IPC first with
  `registerIpc(() => win)` from `out/main/ipc.js` — otherwise the renderer's
  on-load calls (`agents:list`, `project:save`, `update:check`, …) throw "No
  handler registered" and a `projectPath` change hangs on the failing save.
  The `scripts/smoke/phase*-smoke.cjs` files are working examples of this pattern.
- `webContents.capturePage()` gives a PNG; the window must be shown
  (`show: true`) for it to actually paint.

## Launching a second instance alongside the installed app (Windows)

If the packaged app is installed and open, it runs as **`Agent Master.exe`** (not
`electron.exe`) and holds a **single-instance lock keyed to the `agentmaster`
userData dir** (`index.ts` `requestSingleInstanceLock`). So a plain
`npm run dev` / `npx electron .` launched while it's open acquires no lock and
`app.quit()`s immediately — a clean **exit 0** right after "start electron
app…", easily mistaken for a crash. `Get-Process electron` also shows nothing,
because the installed app is `Agent Master.exe`.

To run a source build next to it without touching the user's app, give the new
instance its **own userData dir** (separate lock) and launch it **detached via
WMI** (`Win32_Process.Create` escapes the Claude tool session's job object, so
it survives the tool call; a Bash-background or `Start-Process` launch is
reaped). This is what actually produced a visible, persistent window:

Run from the repo root — `$repo` is resolved from the working directory, so
there is nothing machine-specific to edit:

```powershell
npm run build   # first — dev runs leave out/main pointing at the dev server
$repo = (Get-Location).Path
$ud = Join-Path $env:TEMP 'agentmaster-dev-userdata'
New-Item -ItemType Directory -Force -Path $ud | Out-Null
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"' + $exe + '" . --user-data-dir="' + $ud + '"'
  CurrentDirectory = $repo
}
# verify: Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
```

`Win32_Process.Create` needs **absolute** paths for both `$exe` and
`CurrentDirectory` — that is why `$repo` is resolved rather than using a
relative path.

It runs as `electron.exe` (dev), starts on a blank throwaway userData, and does
not hot-reload — rebuild + relaunch after further changes. Kill it by PID when
done.

## Gotchas

- **Empty `node_modules` on a fresh checkout** → run `npm install` first; it's
  slow (Electron binary download).
- **`package-lock.json` version drift** — after a version bump the lockfile can
  lag `package.json`; `npm install` re-syncs it (a harmless 2-line diff).
- **Don't reach for xvfb / `--no-sandbox` / Playwright** — those are for
  headless Linux. This is Windows with a display; `npm run dev` just works.
