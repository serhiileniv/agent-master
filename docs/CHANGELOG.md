# Changelog

Notable changes per release. Installers for every version are on the
[releases page](https://github.com/serhiileniv/spymaster/releases).

This file was reconstructed from git history at v0.1.25; entries before then are summarised rather
than exhaustive. Entries below keep the product name they shipped under.

## v0.1.30

- **Renamed Monad → Spy Master**, with a new app icon: a fedora-and-shades silhouette lit by the
  ember of a cigar, drawn in the app's own palette. macOS gets the inset squircle tile it expects
  and Windows a full-bleed square. Regenerate both with `npm run icons`.
- **This is a clean break, on purpose.** New app identity means a new settings folder, so Spy Master
  starts empty rather than inheriting a Monad profile, and installed copies of Monad will not
  auto-update to it. The one-shot Vectro→Monad profile migration was removed at the same time.
- **Your agent worktrees are not affected.** New ones go to `.spymaster-worktrees/`, but a worktree
  created before the rename is adopted where it stands, and orphan cleanup still knows about both
  locations. `.monad/canvas.json` is likewise still read.

## v0.1.27

- **Fixed: no agents found on macOS.** Claude Code, Codex, and the rest showed as "not installed"
  when Monad was opened from Finder or the Dock. A GUI launch inherits a minimal `PATH` and never
  reads your shell config, so anything installed via Homebrew, nvm, or the native installer was
  invisible. Monad now asks your login shell for its real `PATH`, and checks the usual install
  locations as a backstop.
- **Fixed: agent commands failing inside a pane but working in Terminal.** Panes ran a non-login
  shell, which skips `~/.zprofile` — where Homebrew and most version managers put their setup. Panes
  now start login shells, matching iTerm, Ghostty, and Terminal.app.
- **Fixed: the update notice never appearing when a check failed.** A failed update check produced no
  banner and no error, leaving you on an old version with no signal. A failed check now falls back to
  a direct release lookup, and update diagnostics are written to a log file.

## v0.1.26

- **Fixed: agents silently lost worktree isolation after every restart.** Restoring a session read
  the wrong field, so real git repos came back marked as non-git and new agents fell back to sharing
  the project folder — editing your actual working tree instead of an isolated worktree. Present
  since v0.1.25.
- **Fixed: closing a tab while the canvas was saving could lose the whole tab set.** Two writers
  shared one temp file, so overlapping saves could interleave and leave `workspaces.json` spliced.
- **Fixed: agents starting at the same time could race for a worktree.** The loser quietly ran in
  the shared project folder while the UI still showed it as isolated.
- **Fixed: closing an agent left its CLI running.** Killing a terminal now reaps the whole process
  tree instead of just the shell, so nothing keeps holding worktree files open.
- **Fixed: a dropped file whose name contained shell metacharacters could execute.** Paths are now
  escaped for the target shell rather than merely quoted.
- Fixed: pane theme and per-agent folder changes not persisting on their own; layout changes lost
  when quitting within 400ms; the review panel latching on "Merging…" after a failure; the terminal
  falling back to the wrong shell on restore; workspaces past the tab cap being permanently deleted.
- Background workspaces stop rendering entirely instead of merely being invisible, which should cut
  idle GPU load with several workspaces open.
- Overlays are now proper dialogs — focus is trapped and restored, Escape closes, and toasts are
  announced to screen readers.
- Added unit tests and linting, and wired the five existing integration tests that were never
  running in CI; packaging is now blocked unless all of them pass.

## v0.1.25

- Top-bar tabs became real **workspaces** — renameable, no longer tied to a folder, with an agent
  count. Folder selection moved onto the individual agent.
- Workspace state moved to `workspaces.json` in the app's user-data folder, with one-time migration
  from the old per-project `.monad/canvas.json`.
- Adopted the new Monad spirograph logo for the app icon and emblem.
- README rewritten for a general audience; added the MIT `LICENSE` file and a current demo video.

## v0.1.24

- Added the right-side worktree **file explorer and editor**, with a CodeMirror-based editor and a
  path-traversal guard on all reads.
- File panel follow-ups: dropped the per-card Files button, scoped the tree to the project root,
  fixed editor scrolling.
- Added tile-free logo mark variants (white and black, SVG and PNG).

## v0.1.23

- Logo redesign.

## v0.1.22

- **Windows in-place auto-update** via `electron-updater`. Releases now must ship `latest*.yml` and
  blockmap files alongside installers.

## v0.1.21

- Power and thermal pass: pause rendering when the window is unwatched, and batch PTY output before
  crossing IPC instead of sending per-chunk. Idle aurora/blur effects were the other major draw.

## v0.1.20

- Moved releases and the download site into this repository; the separate site repo was retired.
- Pinned the toast close button.

## v0.1.17 – v0.1.19

- UX pass: keyboard shortcuts surfaced in Settings, quick-launcher command palette, `.monad`
  directory rename.
- Fixed broken download links left over from the rename (`Vectro-*` → `Monad-*`).

## v0.1.16

- Persistent, escalating update reminder plus an in-app feedback form.

## v0.1.15

- **Renamed Vectro → Monad.** Full rebrand: identity, migration for existing installs, Lora serif
  redesign, and a reworked dock. Local storage keys intentionally kept their old prefix so existing
  users didn't lose state.

## v0.1.0 – v0.1.14

Early development. Highlights:

- Core canvas of parallel PTY terminals with automatic tiling.
- Per-agent git worktree isolation, in-app diff, and merge.
- Agent relaunch on reopen rather than restoring a bare shell.
- In-app update notifications.
- Repeated terminal interaction work — focus reliability, copy/paste across platforms, selection,
  and screenshot/file paste.
- Release pipeline: installers published automatically on a version tag.
