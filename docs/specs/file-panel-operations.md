# File panel operations

- **Status:** approved
- **Written:** 2026-08-15
- **Shipped in:** v0.0.0 _(fill on merge)_

## Problem

The file panel on the right can browse the project and edit a file that already exists, and that is
all it can do. To add a file, delete one, rename one, or move one into a different folder, you have
to leave the app entirely and go to Finder or a terminal — for the single most ordinary thing anyone
does with a project. The tree is also text-only: every row is the same grey filename, so scanning a
folder of thirty files means reading thirty names one at a time instead of recognising shapes.

## Behaviour

VS Code's Explorer is the reference for all of this. Where a behaviour below reads as arbitrary, it
is arbitrary in the same way VS Code is, deliberately, so that muscle memory transfers.

### Icons

1. Every file row shows an icon to the left of its name, tinted by file type — TypeScript blue,
   JavaScript yellow, JSON/data green, stylesheets blue, Markdown and text grey, images violet,
   config and lock files amber. Unrecognised types get a plain document icon in the default text
   colour.
2. Every folder row shows a folder icon that changes between closed and open as I expand it.
3. The icons are drawn in the app's own icon style — thin outlines, square corners, the chamfered
   bottom-right corner — not an imported icon pack.

### Selection

4. Clicking a row selects it. Clicking a file also opens it in the editor below; clicking a folder
   also expands or collapses it.
5. ⌘-clicking adds or removes a row from the selection. ⇧-clicking selects every row between the
   last-clicked row and the clicked one, as they appear on screen.
6. Selecting more than one row does not open anything in the editor.
7. Arrow keys move the selection: ↑/↓ to the previous/next visible row, → expands a collapsed folder
   or steps into an expanded one, ← collapses an expanded folder or jumps to its parent. ⇧ with ↑/↓
   extends the selection.

### Creating

8. The panel header has a New File button and a New Folder button.
9. Choosing New File adds an empty row with a text box in the tree, inside the selected folder — or
   beside the selected file, in that file's folder. With nothing selected it goes at the top level.
10. Typing a name and pressing Enter creates the file and opens it in the editor. Creating a folder
    selects it instead of opening anything.
11. Typing a name containing slashes, such as `utils/dates.ts`, creates the intermediate folders too.
    A name ending in a slash creates a folder even from the New File button.
12. A name that cannot be used shows the reason directly under the text box and refuses to commit:
    empty, starting with a slash, or already taken by something in the same folder.
13. Escape cancels; the row disappears and nothing is created.

### Renaming

14. Renaming replaces the row with a text box holding the current name, with the name pre-selected
    but not the extension — so typing immediately replaces `index` in `index.ts`.
15. Pressing F2 again while renaming cycles what is selected: name, then whole filename, then
    extension.
16. A name already taken in that folder is refused with the reason shown, the same as when creating.
17. Renaming a file that is open in the editor below keeps it open, under its new name.

### Deleting

18. Deleting asks first, naming what will go — one file, or the number of items when several are
    selected — and confirming moves them to the macOS Trash, where they can be recovered.
19. The confirmation has a "Don't ask me again" checkbox. Ticking it means future deletes go straight
    to the Trash without asking, and that choice survives an app restart.
20. If anything being deleted has uncommitted git changes, the confirmation says so explicitly, and
    appears even when "Don't ask me again" was ticked.
21. Deleting a file that is open in the editor below closes it, unless it has unsaved edits.
22. If macOS refuses to trash something, the app says so and offers to delete it permanently instead.

### Moving

23. Dragging a row onto a folder moves it into that folder. Dragging onto a file moves it into that
    file's folder, never over the file itself.
24. Holding ⌥ while dropping copies instead of moving.
25. Hovering a closed folder mid-drag opens it after about half a second, so I can drop into
    something nested.
26. A drop that cannot work is refused rather than attempted: onto itself, into its own subfolder, or
    back into the folder it already lives in.
27. A move asks for confirmation, naming the item and the destination, with the same "Don't ask me
    again" checkbox as delete.
28. Dropping a file from Finder onto the tree copies it into the folder I dropped it on.
29. Dragging multiple selected rows moves them all together.
30. If something with the same name is already at the destination, the app asks whether to replace it
    rather than overwriting silently.

### Clipboard

31. ⌘C then ⌘V into a folder copies the file there. Pasting into the folder it came from produces
    `name copy.ts`, then `name copy 2.ts`, so it never overwrites.
32. ⌘X then ⌘V moves instead of copying.

### Undo

33. ⌘Z with the tree focused reverses the last file operation — create, rename, move, copy or delete —
    and asks for confirmation before undoing a create, because undoing a create deletes a file that
    now exists.
34. Undo does not cover deleting a folder, or deleting a file larger than 5 MB; the confirmation for
    those says the delete cannot be undone. They are still recoverable from the Trash.
35. ⌘Z in the tree and ⌘Z in the editor are independent — whichever has focus is the one that undoes.

### Context menu

36. Right-clicking a row opens a menu with every operation that applies to it: New File, New Folder,
    Rename, Delete, Cut, Copy, Paste, Copy Path, Copy Relative Path, Reveal in Finder.
37. Right-clicking empty space below the tree offers the operations that apply to the top level.
38. New File and New Folder do not appear when right-clicking a file, matching VS Code.

### Sorting

39. Folders sort before files, and both sort so that `file2` comes before `file10` rather than after.

## Out of scope

- **Compact folders** — VS Code collapses a chain like `a/b/c` into one row by default. It makes each
  row several separate click targets, which complicates selection, rename and drop targeting
  throughout. Deliberately omitted; can be added later.
- **File nesting** — grouping `foo.js`/`foo.js.map` under `foo.ts`. Off by default in VS Code too.
- **Type-ahead find / filter box** in the tree.
- **Git status decorations** — colouring filenames by modified/untracked. The uncommitted-changes
  warning at delete time (behaviour 20) is the only git-awareness here.
- **Preview vs pinned tabs** — the panel shows one file at a time; there is nothing to pin.
- **Dragging files out of the app** into Finder or another application.
- **Duplicating the icon set's coverage** — around 20 file types are mapped, not the ~240 of Seti or
  the ~1,400 of Material Icon Theme. The fallback is a plain document icon.

## Acceptance checks

| # | Check | Kind | Where |
|---|---|---|---|
| 1, 3 | Extension → icon-kind mapping resolves ts/tsx/js/json/css/md/images/lock/config and falls back for unknown | unit | `src/renderer/src/fileIcons.test.ts` |
| 2 | Folder icon kind flips on expanded state | unit | `src/renderer/src/fileIcons.test.ts` |
| 4–7 | Selection reducer: click replaces, ⌘ toggles, ⇧ ranges over visible order, arrows move/extend | unit | `src/renderer/src/fileTreeSelection.test.ts` |
| 9 | New-item placement: inside a selected folder, beside a selected file, root when nothing selected | unit | `src/renderer/src/fileTreeSelection.test.ts` |
| 10, 11 | `createEntry` writes the file; a name with slashes creates intermediate dirs; trailing slash makes a folder | smoke | `scripts/smoke/file-ops-smoke.cjs` |
| 12, 16 | Name validation rejects empty, leading slash, collision; accepts otherwise; warns on whitespace | unit | `src/main/scoped-files.test.ts` |
| 14, 15 | Rename selection ranges: basename for `index.ts`, whole name for `.gitignore` and folders; F2 cycle order | unit | `src/renderer/src/fileTreeSelection.test.ts` |
| 17, 21 | Editor follows a rename and closes on delete unless dirty | unit | `src/renderer/src/store.test.ts` |
| 18, 22 | `deleteEntries` trashes via the OS and reports failure rather than falling back silently | smoke | `scripts/smoke/file-ops-smoke.cjs` |
| 19 | The don't-ask-again choice round-trips through localStorage | unit | `src/renderer/src/store.test.ts` |
| 20 | `gitDirtyPaths` reports uncommitted paths under a root | smoke | `scripts/smoke/file-ops-smoke.cjs` |
| 23, 26 | Drop-target resolution: file → its parent; refuses self, descendant, and same-parent move | unit | `src/renderer/src/fileTreeDnd.test.ts` |
| 24, 31, 32 | `moveEntry`/`copyEntry` move and copy; incremental naming produces `copy`, `copy 2` | smoke | `scripts/smoke/file-ops-smoke.cjs` |
| 30 | A move onto an existing name reports a conflict instead of overwriting; overwrite flag replaces | smoke | `scripts/smoke/file-ops-smoke.cjs` |
| 33, 34 | Undo stack: records each op, replays the inverse, marks folder and >5MB deletes non-undoable | unit | `src/renderer/src/fileUndo.test.ts` |
| 39 | Sort puts dirs first and orders `file2` before `file10` | unit | `src/main/scoped-files.test.ts` |
| — | **Containment holds for every new write operation** — create, rename, move, copy, delete all refuse `..`, absolute paths, and symlinks pointing outside the root | unit + smoke | `src/main/scoped-files.test.ts`, `scripts/smoke/file-ops-smoke.cjs` |
| 8, 13, 25, 27, 28, 29, 35–38 | Visual and pointer-driven: inline input appearance, drag auto-expand timing, context-menu contents, Finder drop | manual | — |

`scripts/smoke/file-ops-smoke.cjs` runs in CI as part of `smoke:file` — `file-smoke.cjs` requires it
and drives it on the same window, so both halves of the file panel's coverage report through one
verdict under the step CI already invokes. It stays a separate module (and a standalone
`smoke:fileops`) because it is a separate concern, but it is deliberately not a separate CI step: a
smoke that is not in CI does not exist, and this arrangement makes it impossible for the wiring to be
forgotten.

## Terms

- **File panel** — the right-docked explorer + editor. _(existing)_
- **Scope root** — the absolute directory the panel is confined to; every path is relative to it and
  nothing outside it is reachable. _(existing)_
- **Entry** — one file or folder row in the tree. _(new)_
- **Inline editor** — the text box that replaces a row while creating or renaming. _(new)_

## Risk

Touches **file panel path handling**, the danger zone in CLAUDE.md — and widens it considerably. Until
now the panel could read anything inside the scope root and write to one file at a time. It can now
create, move, copy and delete, against the user's real project folder rather than an agent worktree.

Mandatory: `smoke:file` (existing behaviour must not regress) and the new `smoke:file-ops`.

Two hardenings ship with it:

- **Write operations resolve symlinks.** `resolveWithin` is lexical by design and does not follow
  links — documented and accepted for reads, where the worst case is reading a file you shouldn't.
  For delete and move it is not acceptable, because a symlinked folder inside the project would be a
  route to destroy something outside it. A separate `resolveWithinReal` resolves the real path of the
  nearest existing ancestor and refuses anything landing outside the root. Reads keep the existing
  guard unchanged, so existing behaviour and its tests are untouched.
- **Delete goes to the OS Trash**, never `fs.rm`. A trash failure surfaces to the user; it never
  silently escalates to a permanent delete.

## Decisions

- **VS Code as the reference, not a starting point.** Every interaction that has a VS Code equivalent
  matches it, including the parts that look odd in isolation (New File appearing beside a selected
  file rather than inside it; drop-on-file retargeting to the parent; three different conflict
  behaviours for create vs paste vs move). Diverging where there is no reason to costs the user their
  existing muscle memory.
- **The icons are ours, not VS Code's.** Seti and Material Icon Theme are both MIT and could be
  vendored, but they are coloured, filled and largely brand logos, and would sit visibly apart from
  every other icon in the app. What actually makes VS Code's tree scannable is colour rather than
  glyph detail, so the app's own outline geometry with per-type tinting gets the benefit without the
  clash. Around 20 mappings, not 1,400.
- **The uncommitted-changes warning is a deliberate departure from VS Code.** VS Code warns about
  unsaved editor changes; it has no idea about git. This app is driven by agents writing into a real
  repository, where uncommitted work is the one thing that cannot be recovered from either the Trash
  or git history. That case is worth naming out loud, and worth showing even when the user has
  suppressed the ordinary confirmation.
- **Optimistic tree updates.** The folder watcher takes roughly 450 ms end to end (300 ms in the main
  process, 150 ms in the renderer). Waiting for it would make every operation feel laggy, so the tree
  applies the change as soon as the main process reports success; the watcher then confirms. The
  update is applied on success only, never before, so a failed operation never shows a tree that
  lies.
- **Undo is renderer-side, holding deleted bytes in memory.** Same approach and therefore the same
  limits as VS Code: folders are not undoable, and a 5 MB cap keeps a delete from pinning arbitrary
  memory. Both cases are stated in the confirmation rather than discovered afterwards.
- **Shipped in three stages** — core operations, then movement, then undo — each independently
  usable and tested, so a regression in undo cannot take basic file creation down with it.

## Open questions

None.

## Notes

- Prior art read directly from `microsoft/vscode`: `fileActions.ts` (create/rename/delete/paste
  validation and incremental naming), `explorerViewer.ts` (inline input, sorter, `FileDragAndDrop`),
  `files.contribution.ts` (every default), `abstractTree.ts` (the 500 ms drag auto-expand),
  `undoRedoService.ts` (the undo confirmation).
- Rejected: importing Material Icon Theme (~900 SVGs) or Seti (an icon font). Both MIT, both legally
  fine to vendor with attribution; rejected on visual-consistency grounds, not licensing. Worth
  revisiting only if the hand-drawn set proves too thin in practice.
- Seti, VS Code's built-in default, has no folder icons at all — that is why stock VS Code shows only
  twisties beside folders. This spec adds folder icons, which is closer to Material's behaviour.
- VS Code changed `explorer.confirmDelete` in 1.108 so that it suppresses the permanent-delete
  confirmation too, not just the trash one. Not relevant here — this app never permanently deletes
  except as the explicit fallback in behaviour 22, which always asks.
