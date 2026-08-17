import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  applyArrow,
  applyClick,
  cycleRenameRange,
  EMPTY_SELECTION,
  flattenTree,
  newEntryParent,
  pruneSelection,
  renameRange,
  type RangeMode,
  type Selection,
  type TreeRow
} from '../fileTreeSelection'
import {
  canDrop,
  distinctRoots,
  DRAG_AUTO_EXPAND_MS,
  dropTargetDir,
  plannedMoves
} from '../fileTreeDnd'
import {
  describeOp,
  dropEntry,
  needsConfirm,
  peek,
  planUndo,
  pushOp,
  type FileOp,
  type UndoEntry
} from '../fileUndo'
import { fileIcon } from '../fileIcons'
import ContextMenu, { type MenuItem } from './ContextMenu'
import Modal from './Modal'
import {
  IconFileArchive,
  IconFileBraces,
  IconFileCode,
  IconFileImage,
  IconFileLock,
  IconFilePage,
  IconFileTerminal,
  IconFileText,
  IconFiles,
  IconFolderOpen
} from './Icons'

interface FileTreeProps {
  /** Absolute directory the tree is rooted at (scope root, resolved by FilePanel). */
  root: string
  /** The rel path currently open in the editor — highlighted when matched. */
  selectedPath: string | null
  /** Fired when a file row is opened; rel is relative to `root`. */
  onOpen: (rel: string) => void
  /** Bumped by FilePanel's watcher — re-lists the root + expanded dirs live. */
  refreshNonce: number
}

/** The glyph for one row. Folders get open/closed; files go through the
 *  extension map in fileIcons.ts. */
function RowIcon({ row, expanded }: { row: TreeRow; expanded: boolean }): JSX.Element {
  if (row.kind === 'dir') {
    return (
      <span className="filetree__icon filetree__icon--folder">
        {expanded ? <IconFolderOpen size={14} /> : <IconFiles size={14} />}
      </span>
    )
  }
  const { glyph, tone } = fileIcon(row.name)
  const Glyph =
    glyph === 'code'
      ? IconFileCode
      : glyph === 'braces'
        ? IconFileBraces
        : glyph === 'text'
          ? IconFileText
          : glyph === 'image'
            ? IconFileImage
            : glyph === 'lock'
              ? IconFileLock
              : glyph === 'archive'
                ? IconFileArchive
                : glyph === 'terminal'
                  ? IconFileTerminal
                  : IconFilePage
  return (
    <span className={`filetree__icon filetree__icon--${tone}`}>
      <Glyph size={14} />
    </span>
  )
}

/** The inline editor's state: creating a new entry, or renaming an existing one. */
type Draft =
  | { mode: 'create'; parentRel: string; kind: 'file' | 'dir' }
  | { mode: 'rename'; rel: string; name: string; isDir: boolean }

/** A confirmation waiting on the user. Each carries everything needed to
 *  complete the operation, so the modal is a pure function of it. */
type Pending =
  | { kind: 'delete'; rels: string[]; dirty: string[]; undoable: boolean }
  | { kind: 'trashFailed'; rels: string[] }
  | { kind: 'move'; moves: Array<{ from: string; to: string }>; destDir: string; copy: boolean }
  | { kind: 'overwrite'; moves: Array<{ from: string; to: string }>; copy: boolean; names: string[] }
  | { kind: 'undo'; entry: UndoEntry }

/**
 * The file tree: lazy directory listing, multi-select, inline create/rename,
 * drag-and-drop, clipboard, and undo.
 *
 * Rows render from a FLAT list (see flattenTree) rather than a recursive walk.
 * Selection ranges, arrow-key movement and drag all reason about what is
 * visible on screen, in order, so producing that list once and rendering from
 * it means those behaviours and the render can never disagree.
 *
 * Every rule that has a VS Code equivalent matches it — including the ones that
 * look arbitrary alone, like New File landing BESIDE a selected file rather
 * than inside anything, and a drop onto a file retargeting to that file's
 * folder. See docs/specs/file-panel-operations.md.
 */
export default function FileTree({
  root,
  selectedPath,
  onOpen,
  refreshNonce
}: FileTreeProps): JSX.Element {
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map())
  const [loading, setLoading] = useState<Set<string>>(new Set())

  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [draftMsg, setDraftMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [rangeMode, setRangeMode] = useState<RangeMode>('prefix')
  const [menu, setMenu] = useState<{ x: number; y: number; row: TreeRow | null } | null>(null)
  const [clipboard, setClipboard] = useState<{ rels: string[]; cut: boolean } | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [dontAsk, setDontAsk] = useState(false)
  // Bumped by our OWN operations so the tree redraws immediately instead of
  // waiting ~450ms for the watcher to come back around.
  const [localNonce, setLocalNonce] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoExpandTarget = useRef<string | null>(null)

  const pushToast = useStore((s) => s.pushToast)
  const confirmDelete = useStore((s) => s.confirmDelete)
  const confirmMove = useStore((s) => s.confirmMove)
  const setConfirmDelete = useStore((s) => s.setConfirmDelete)
  const setConfirmMove = useStore((s) => s.setConfirmMove)
  const fileRenamed = useStore((s) => s.fileRenamed)
  const fileDeleted = useStore((s) => s.fileDeleted)

  const visible = useMemo(
    () => flattenTree({ rootEntries, cache, expanded }),
    [rootEntries, cache, expanded]
  )
  const rowByRel = useMemo(() => new Map(visible.map((r) => [r.rel, r])), [visible])

  // A new scope root invalidates everything below it — reload from scratch, and
  // drop selection/clipboard/undo with it: none of them mean anything in a
  // different project.
  useEffect(() => {
    setExpanded(new Set())
    setCache(new Map())
    setLoading(new Set())
    setRootEntries(null)
    setSel(EMPTY_SELECTION)
    setDraft(null)
    setClipboard(null)
    setUndoStack([])
    if (!root) return
    let cancelled = false
    window.api.file.tree(root, '').then((r) => {
      if (!cancelled) setRootEntries(r.entries)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  // Live refresh: on a watcher bump (or one of our own operations), re-list the
  // root and every currently expanded dir so created/deleted/renamed entries
  // appear — WITHOUT collapsing anything.
  useEffect(() => {
    if ((refreshNonce === 0 && localNonce === 0) || !root) return
    let cancelled = false
    window.api.file.tree(root, '').then((r) => {
      if (!cancelled) setRootEntries(r.entries)
    })
    expanded.forEach((rel) => {
      window.api.file.tree(root, rel).then((r) => {
        if (!cancelled) setCache((c) => new Map(c).set(rel, r.entries))
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce, localNonce])

  // Rows can vanish under a selection — a delete, or a collapse. Anything
  // still selected that no longer exists would make the next ⇧-click or ⌘⌫
  // act on nothing, so prune whenever the visible set changes.
  useEffect(() => {
    setSel((s) => pruneSelection(s, visible))
  }, [visible])

  const loadDir = useCallback(
    (rel: string) => {
      if (cache.has(rel) || loading.has(rel)) return
      setLoading((l) => new Set(l).add(rel))
      window.api.file
        .tree(root, rel)
        .then((r) => setCache((c) => new Map(c).set(rel, r.entries)))
        .catch(() => {
          /* unreadable dir — leave it uncached so a retry can re-read it */
        })
        .finally(() =>
          setLoading((l) => {
            const n = new Set(l)
            n.delete(rel)
            return n
          })
        )
    },
    [root, cache, loading]
  )

  const expandDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => (prev.has(rel) ? prev : new Set(prev).add(rel)))
      loadDir(rel)
    },
    [loadDir]
  )

  const collapseDir = useCallback((rel: string) => {
    setExpanded((prev) => {
      if (!prev.has(rel)) return prev
      const next = new Set(prev)
      next.delete(rel)
      return next
    })
  }, [])

  const toggleDir = useCallback(
    (rel: string) => {
      // Decide first, then act: a state updater must be pure, and doing the IPC
      // read inside setExpanded double-fired it under StrictMode.
      if (expanded.has(rel)) collapseDir(rel)
      else expandDir(rel)
    },
    [expanded, collapseDir, expandDir]
  )

  /** Redraw from disk now rather than waiting for the watcher. */
  const refreshNow = useCallback(() => setLocalNonce((n) => n + 1), [])

  const record = useCallback(
    (op: FileOp) => setUndoStack((s) => pushOp(s, root, op)),
    [root]
  )

  // ---- Operations -------------------------------------------------------

  const doCreate = useCallback(
    async (parentRel: string, name: string, kind: 'file' | 'dir') => {
      const rel = parentRel ? `${parentRel}/${name}` : name
      const r = await window.api.file.create(root, rel, kind)
      if (!r.ok) {
        pushToast(r.error ?? `Could not create ${name}`, 'error')
        return
      }
      record({ kind: 'create', rels: [r.rel ?? rel] })
      refreshNow()
      // A created file opens; a created folder is selected and expanded — VS
      // Code's split, and the useful one: you make a folder to put things in.
      if (kind === 'file') {
        onOpen(r.rel ?? rel)
        setSel({ selected: [r.rel ?? rel], anchor: r.rel ?? rel })
      } else {
        setSel({ selected: [r.rel ?? rel], anchor: r.rel ?? rel })
        expandDir(r.rel ?? rel)
      }
    },
    [root, record, refreshNow, onOpen, pushToast, expandDir]
  )

  const doRename = useCallback(
    async (rel: string, name: string) => {
      const r = await window.api.file.rename(root, rel, name)
      if (!r.ok) {
        pushToast(r.error ?? `Could not rename ${rel}`, 'error')
        return
      }
      const to = r.rel ?? rel
      record({ kind: 'rename', from: rel, to })
      fileRenamed(rel, to)
      refreshNow()
      setSel({ selected: [to], anchor: to })
    },
    [root, record, refreshNow, fileRenamed, pushToast]
  )

  /** Run a set of moves, surfacing a conflict as a question rather than
   *  overwriting. `copy` duplicates instead of moving (the ⌥-drag). */
  const runMoves = useCallback(
    async (moves: Array<{ from: string; to: string }>, copy: boolean, overwrite = false) => {
      const done: Array<{ from: string; to: string }> = []
      const clashed: Array<{ from: string; to: string }> = []
      for (const m of moves) {
        const r = await window.api.file.move(root, m.from, m.to, { copy, overwrite })
        if (r.ok) done.push(m)
        else if (r.conflict) clashed.push(m)
        else pushToast(r.error ?? `Could not move ${m.from}`, 'error')
      }
      if (done.length) {
        record(copy ? { kind: 'copy', rels: done.map((m) => m.to) } : { kind: 'move', items: done })
        if (!copy) done.forEach((m) => fileRenamed(m.from, m.to))
        refreshNow()
        setSel({ selected: done.map((m) => m.to), anchor: done[done.length - 1].to })
      }
      if (clashed.length) {
        setPending({
          kind: 'overwrite',
          moves: clashed,
          copy,
          names: clashed.map((m) => m.to.slice(m.to.lastIndexOf('/') + 1))
        })
      }
    },
    [root, record, refreshNow, fileRenamed, pushToast]
  )

  /** Trash entries. Snapshots first so the delete can be undone; a folder or an
   *  oversized file yields a snapshot with no bytes, which is what makes the
   *  operation report itself as un-undoable. */
  const runDelete = useCallback(
    async (rels: string[]) => {
      const snapshots = await window.api.file.snapshot(root, rels)
      const r = await window.api.file.remove(root, rels)
      const removed = rels.filter((rel) => !r.failed.includes(rel))
      if (removed.length) {
        record({ kind: 'delete', rels: removed, snapshots })
        fileDeleted(removed)
        refreshNow()
        setSel(EMPTY_SELECTION)
      }
      // The OS refused. Never escalate silently — ask.
      if (r.failed.length) setPending({ kind: 'trashFailed', rels: r.failed })
    },
    [root, record, refreshNow, fileDeleted]
  )

  /** Ask before trashing, unless the user turned that off — except when
   *  something has uncommitted git work, which always asks. */
  const requestDelete = useCallback(
    async (rels: string[]) => {
      if (!rels.length) return
      const [dirty, snapshots] = await Promise.all([
        window.api.file.dirtyPaths(root, rels),
        window.api.file.snapshot(root, rels)
      ])
      const undoable =
        snapshots.length === rels.length && snapshots.every((s) => s.kind === 'file' && s.content != null)
      if (!confirmDelete && dirty.length === 0) {
        void runDelete(rels)
        return
      }
      setDontAsk(false)
      setPending({ kind: 'delete', rels, dirty, undoable })
    },
    [root, confirmDelete, runDelete]
  )

  const requestMove = useCallback(
    (moves: Array<{ from: string; to: string }>, destDir: string, copy: boolean) => {
      if (!moves.length) return
      // A copy is additive — VS Code never confirms one, and neither do we.
      if (copy || !confirmMove) {
        void runMoves(moves, copy)
        return
      }
      setDontAsk(false)
      setPending({ kind: 'move', moves, destDir, copy })
    },
    [confirmMove, runMoves]
  )

  const doPaste = useCallback(
    async (destDir: string) => {
      if (!clipboard?.rels.length) return
      if (clipboard.cut) {
        requestMove(plannedMoves(clipboard.rels, destDir), destDir, false)
        setClipboard(null)
        return
      }
      const landed: string[] = []
      for (const from of distinctRoots(clipboard.rels)) {
        const r = await window.api.file.copyInto(root, from, destDir)
        if (r.ok && r.rel) landed.push(r.rel)
        else if (!r.ok) pushToast(r.error ?? `Could not copy ${from}`, 'error')
      }
      if (landed.length) {
        record({ kind: 'copy', rels: landed })
        refreshNow()
        setSel({ selected: landed, anchor: landed[landed.length - 1] })
      }
    },
    [clipboard, root, record, refreshNow, requestMove, pushToast]
  )

  const runUndo = useCallback(
    async (entry: UndoEntry) => {
      const plan = planUndo(entry.op)
      if (plan.kind === 'delete') {
        // Undoing a create/copy removes what it made — to the Trash, not
        // permanently, so an undo is itself recoverable.
        const r = await window.api.file.remove(root, plan.rels)
        if (!r.ok) pushToast('Could not undo — some files could not be removed', 'error')
        else fileDeleted(plan.rels)
      } else if (plan.kind === 'move') {
        for (const m of plan.items) {
          const r = await window.api.file.move(root, m.from, m.to)
          if (r.ok) fileRenamed(m.from, m.to)
          else pushToast(r.error ?? 'Could not undo the move', 'error')
        }
      } else {
        const results = await window.api.file.restore(root, plan.snapshots)
        if (results.some((r) => !r.ok)) pushToast('Some files could not be restored', 'error')
      }
      setUndoStack((s) => dropEntry(s, entry))
      refreshNow()
    },
    [root, refreshNow, fileDeleted, fileRenamed, pushToast]
  )

  const requestUndo = useCallback(() => {
    const entry = peek(undoStack, root)
    if (!entry) return
    if (!entry.undoable) {
      pushToast(`“${entry.label}” cannot be undone — recover it from the Trash`, 'info')
      setUndoStack((s) => dropEntry(s, entry))
      return
    }
    // Undoing a create DELETES a file that now exists, so it asks; reversing a
    // move or restoring a delete is additive and doesn't.
    if (needsConfirm(entry.op)) setPending({ kind: 'undo', entry })
    else void runUndo(entry)
  }, [undoStack, root, runUndo, pushToast])

  // ---- Inline editor ----------------------------------------------------

  const selectedRow = sel.selected.length === 1 ? (rowByRel.get(sel.selected[0]) ?? null) : null

  const startCreate = useCallback(
    (kind: 'file' | 'dir', explicitParent?: string) => {
      const parentRel = explicitParent ?? newEntryParent(selectedRow)
      if (parentRel) expandDir(parentRel)
      setDraft({ mode: 'create', parentRel, kind })
      setDraftValue('')
      setDraftMsg(null)
    },
    [selectedRow, expandDir]
  )

  const startRename = useCallback(
    (row: TreeRow) => {
      setDraft({ mode: 'rename', rel: row.rel, name: row.name, isDir: row.kind === 'dir' })
      setDraftValue(row.name)
      setDraftMsg(null)
      setRangeMode('prefix')
    },
    []
  )

  // Focus the inline input and pre-select the right part of the name: the
  // basename without its extension, so typing replaces `index` in `index.ts`.
  useEffect(() => {
    if (!draft) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (draft.mode === 'rename') {
      const [start, end] = renameRange(draft.name, draft.isDir)
      el.setSelectionRange(start, end)
    }
  }, [draft])

  /** Names already in the folder the draft targets — collisions are refused
   *  inline rather than by a dialog after the fact. */
  const draftSiblings = useMemo(() => {
    if (!draft) return []
    const parent = draft.mode === 'create' ? draft.parentRel : draft.rel.slice(0, draft.rel.lastIndexOf('/'))
    const entries = parent ? (cache.get(parent) ?? []) : (rootEntries ?? [])
    const names = entries.map((e) => e.name)
    // Renaming to the SAME name isn't a collision.
    return draft.mode === 'rename' ? names.filter((n) => n !== draft.name) : names
  }, [draft, cache, rootEntries])

  const validate = useCallback(
    (value: string): boolean => {
      const trimmed = value.replace(/[\\/]+$/, '')
      if (!trimmed.trim()) {
        setDraftMsg({ text: 'A file or folder name must be provided.', error: true })
        return false
      }
      if (value.startsWith('/') || value.startsWith('\\')) {
        setDraftMsg({ text: 'A file or folder name cannot start with a slash.', error: true })
        return false
      }
      const first = trimmed.split(/[\\/]/)[0]
      if (draftSiblings.includes(first)) {
        setDraftMsg({
          text: `A file or folder “${first}” already exists at this location. Please choose a different name.`,
          error: true
        })
        return false
      }
      if (value !== value.trim()) {
        setDraftMsg({
          text: 'Leading or trailing whitespace detected in file or folder name.',
          error: false
        })
        return true
      }
      setDraftMsg(null)
      return true
    },
    [draftSiblings]
  )

  const commitDraft = useCallback(() => {
    if (!draft) return
    if (!validate(draftValue)) return
    const value = draftValue.trim()
    if (draft.mode === 'create') {
      // A trailing slash means folder even from the New File button, and a
      // value with separators creates the intermediate folders too.
      const kind = /[\\/]\s*$/.test(draftValue) ? 'dir' : draft.kind
      void doCreate(draft.parentRel, value.replace(/[\\/]+$/, ''), kind)
    } else if (value !== draft.name) {
      void doRename(draft.rel, value)
    }
    setDraft(null)
    setDraftMsg(null)
  }, [draft, draftValue, validate, doCreate, doRename])

  const cancelDraft = useCallback(() => {
    setDraft(null)
    setDraftMsg(null)
  }, [])

  // ---- Keyboard ---------------------------------------------------------

  const onTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // The inline input owns every key while it's open.
      if (draft) return
      const mod = e.metaKey || e.ctrlKey
      const rels = sel.selected

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const key = e.key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right'
        const r = applyArrow(sel, key, visible, expanded, e.shiftKey)
        if (r.expand) expandDir(r.expand)
        if (r.collapse) collapseDir(r.collapse)
        setSel(r.selection)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // macOS binds Enter to rename in VS Code's explorer; Space opens.
        if (selectedRow) startRename(selectedRow)
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        if (selectedRow?.kind === 'file') onOpen(selectedRow.rel)
        else if (selectedRow) toggleDir(selectedRow.rel)
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        if (selectedRow) startRename(selectedRow)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        void requestDelete(rels)
        return
      }
      if (mod && (e.key === 'c' || e.key === 'x')) {
        e.preventDefault()
        if (rels.length) setClipboard({ rels: [...rels], cut: e.key === 'x' })
        return
      }
      if (mod && e.key === 'v') {
        e.preventDefault()
        void doPaste(selectedRow ? dropTargetDir(selectedRow) : '')
        return
      }
      if (mod && e.key === 'z') {
        // The tree has focus, so this ⌘Z is the tree's — the editor below keeps
        // its own history and never sees this one.
        e.preventDefault()
        requestUndo()
        return
      }
      if (e.key === 'Escape') {
        setClipboard(null)
      }
    },
    [
      draft,
      sel,
      visible,
      expanded,
      selectedRow,
      expandDir,
      collapseDir,
      toggleDir,
      onOpen,
      startRename,
      requestDelete,
      doPaste,
      requestUndo
    ]
  )

  // ---- Drag and drop ----------------------------------------------------

  const clearAutoExpand = useCallback(() => {
    if (autoExpandTimer.current) clearTimeout(autoExpandTimer.current)
    autoExpandTimer.current = null
    autoExpandTarget.current = null
  }, [])

  const onRowDragStart = useCallback(
    (e: React.DragEvent, row: TreeRow) => {
      // Dragging a row that isn't selected makes it the selection first —
      // otherwise the drag would silently move something else.
      const rels = sel.selected.includes(row.rel) ? sel.selected : [row.rel]
      if (!sel.selected.includes(row.rel)) setSel({ selected: [row.rel], anchor: row.rel })
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData('application/x-agentmaster-files', JSON.stringify(rels))
      // Some text is required for the drag to start at all on macOS.
      e.dataTransfer.setData('text/plain', rels.join('\n'))
    },
    [sel]
  )

  const onRowDragOver = useCallback(
    (e: React.DragEvent, row: TreeRow | null) => {
      const dir = dropTargetDir(row)
      const copy = e.altKey
      const dragged = readDragRels(e)
      // A Finder drop carries no rels of ours — it's an import, always allowed.
      const external = dragged === null
      if (!external && !canDrop(dragged, dir, copy).ok) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = external ? 'copy' : copy ? 'copy' : 'move'
      setDropDir(dir)
      // Hovering a closed folder opens it after a beat, so nested folders are
      // reachable mid-drag. The timer resets whenever the hovered row changes.
      if (row?.kind === 'dir' && !expanded.has(row.rel)) {
        if (autoExpandTarget.current !== row.rel) {
          clearAutoExpand()
          autoExpandTarget.current = row.rel
          autoExpandTimer.current = setTimeout(() => {
            expandDir(row.rel)
            clearAutoExpand()
          }, DRAG_AUTO_EXPAND_MS)
        }
      } else {
        clearAutoExpand()
      }
    },
    [expanded, expandDir, clearAutoExpand]
  )

  const onRowDrop = useCallback(
    async (e: React.DragEvent, row: TreeRow | null) => {
      e.preventDefault()
      clearAutoExpand()
      setDropDir(null)
      const destDir = dropTargetDir(row)
      const dragged = readDragRels(e)
      if (dragged === null) {
        // From outside the app: copy the files in.
        const sources = Array.from(e.dataTransfer.files ?? [])
          .map((f) => window.api.getPathForFile(f))
          .filter(Boolean)
        if (!sources.length) return
        const results = await window.api.file.import(root, destDir, sources)
        const landed = results.filter((r) => r.ok && r.rel).map((r) => r.rel as string)
        if (landed.length) {
          record({ kind: 'copy', rels: landed })
          refreshNow()
        }
        results.filter((r) => !r.ok).forEach((r) => pushToast(r.error ?? 'Could not import file', 'error'))
        return
      }
      const copy = e.altKey
      if (!canDrop(dragged, destDir, copy).ok) return
      requestMove(plannedMoves(dragged, destDir), destDir, copy)
    },
    [root, clearAutoExpand, requestMove, record, refreshNow, pushToast]
  )

  // ---- Context menu -----------------------------------------------------

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const row = menu.row
    const targetDir = dropTargetDir(row)
    const rels = row && sel.selected.includes(row.rel) ? sel.selected : row ? [row.rel] : []
    const isDir = row?.kind === 'dir'
    const items: MenuItem[] = []
    // New File / New Folder only when the target can contain things — VS Code
    // hides them on a file row.
    if (!row || isDir) {
      items.push(
        { key: 'new-file', label: 'New File…', onSelect: () => startCreate('file', targetDir) },
        { key: 'new-folder', label: 'New Folder…', onSelect: () => startCreate('dir', targetDir) },
        { key: 's1', separator: true }
      )
    }
    if (row) {
      items.push(
        { key: 'cut', label: 'Cut', hint: '⌘X', onSelect: () => setClipboard({ rels, cut: true }) },
        { key: 'copy', label: 'Copy', hint: '⌘C', onSelect: () => setClipboard({ rels, cut: false }) }
      )
    }
    items.push({
      key: 'paste',
      label: 'Paste',
      hint: '⌘V',
      disabled: !clipboard?.rels.length,
      onSelect: () => void doPaste(targetDir)
    })
    if (row) {
      items.push(
        { key: 's2', separator: true },
        {
          key: 'copy-path',
          label: 'Copy Path',
          onSelect: () => {
            void window.api.file.absPath(root, row.rel).then((abs) => {
              if (abs) window.api.clipboard.write(abs)
            })
          }
        },
        {
          key: 'copy-rel',
          label: 'Copy Relative Path',
          onSelect: () => window.api.clipboard.write(row.rel)
        },
        {
          key: 'reveal',
          label: 'Reveal in Finder',
          onSelect: () => void window.api.file.reveal(root, row.rel)
        },
        { key: 's3', separator: true },
        { key: 'rename', label: 'Rename…', hint: 'F2', onSelect: () => startRename(row) },
        {
          key: 'delete',
          label: 'Delete',
          hint: '⌘⌫',
          danger: true,
          onSelect: () => void requestDelete(rels)
        }
      )
    }
    return items
  }, [menu, sel, clipboard, root, startCreate, startRename, requestDelete, doPaste])

  // ---- Render -----------------------------------------------------------

  const renderDraftRow = (depth: number): JSX.Element => (
    <div className="filetree__draft" style={{ paddingLeft: 6 + depth * 14 }}>
      <div className="filetree__draftrow">
        <span className="filetree__icon filetree__icon--default">
          {draft?.mode === 'create' && draft.kind === 'dir' ? (
            <IconFiles size={14} />
          ) : (
            <IconFilePage size={14} />
          )}
        </span>
        <input
          ref={inputRef}
          className="filetree__input"
          value={draftValue}
          spellCheck={false}
          onChange={(e) => {
            setDraftValue(e.target.value)
            validate(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              cancelDraft()
            } else if (e.key === 'F2' && draft?.mode === 'rename') {
              // F2 again cycles name → whole → extension.
              e.preventDefault()
              const { mode, range } = cycleRenameRange(draftValue, draft.isDir, rangeMode)
              setRangeMode(mode)
              inputRef.current?.setSelectionRange(range[0], range[1])
            }
          }}
          // Blur commits if valid and cancels if not, matching VS Code.
          onBlur={() => (draftMsg?.error ? cancelDraft() : commitDraft())}
        />
      </div>
      {draftMsg && (
        <div className={'filetree__msg' + (draftMsg.error ? ' is-error' : ' is-warn')}>
          {draftMsg.text}
        </div>
      )}
    </div>
  )

  const rows: JSX.Element[] = []
  // The draft row for a create at the ROOT renders before everything else.
  if (draft?.mode === 'create' && draft.parentRel === '') rows.push(<div key="draft-root">{renderDraftRow(0)}</div>)

  for (const row of visible) {
    const isOpen = row.kind === 'dir' && expanded.has(row.rel)
    const isSelected = sel.selected.includes(row.rel)
    const isCut = clipboard?.cut && clipboard.rels.includes(row.rel)
    if (draft?.mode === 'rename' && draft.rel === row.rel) {
      rows.push(<div key={row.rel}>{renderDraftRow(row.depth)}</div>)
    } else {
      rows.push(
        <div
          key={row.rel}
          className={
            'filetree__row' +
            (row.kind === 'dir' ? ' filetree__row--dir' : ' filetree__row--file') +
            (isSelected ? ' is-selected' : '') +
            (row.rel === selectedPath ? ' is-open' : '') +
            (row.name.startsWith('.') ? ' is-dotfile' : '') +
            (isCut ? ' is-cut' : '') +
            (dropDir === (row.kind === 'dir' ? row.rel : null) ? ' is-droptarget' : '')
          }
          style={{ paddingLeft: 6 + row.depth * 14 + (row.kind === 'file' ? 14 : 0) }}
          draggable
          onDragStart={(e) => onRowDragStart(e, row)}
          onDragOver={(e) => onRowDragOver(e, row)}
          onDragLeave={() => setDropDir(null)}
          onDrop={(e) => void onRowDrop(e, row)}
          onClick={(e) => {
            const next = applyClick(sel, row.rel, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }, visible)
            setSel(next)
            // A modified click is selecting, not opening — and a multi-selection
            // has no single file to show.
            if (e.metaKey || e.ctrlKey || e.shiftKey) return
            if (row.kind === 'dir') toggleDir(row.rel)
            else onOpen(row.rel)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!sel.selected.includes(row.rel)) setSel({ selected: [row.rel], anchor: row.rel })
            setMenu({ x: e.clientX, y: e.clientY, row })
          }}
          title={row.rel}
        >
          {row.kind === 'dir' && <span className="filetree__twisty">{isOpen ? '▾' : '▸'}</span>}
          <RowIcon row={row} expanded={isOpen} />
          <span className="filetree__name">{row.name}</span>
        </div>
      )
    }
    // Placeholders and the draft row belong directly under their parent.
    if (isOpen) {
      const children = cache.get(row.rel)
      if (draft?.mode === 'create' && draft.parentRel === row.rel) {
        rows.push(<div key={row.rel + ':draft'}>{renderDraftRow(row.depth + 1)}</div>)
      }
      if (!children) {
        rows.push(
          <div
            key={row.rel + ':loading'}
            className="filetree__row filetree__row--loading"
            style={{ paddingLeft: 6 + (row.depth + 1) * 14 + 14 }}
          >
            Loading…
          </div>
        )
      } else if (children.length === 0 && !(draft?.mode === 'create' && draft.parentRel === row.rel)) {
        rows.push(
          <div
            key={row.rel + ':empty'}
            className="filetree__row filetree__row--empty"
            style={{ paddingLeft: 6 + (row.depth + 1) * 14 + 14 }}
          >
            (empty)
          </div>
        )
      }
    }
  }

  return (
    <>
      <div className="filetree__actions">
        <button
          className="filetree__action"
          title="New File…"
          onClick={() => startCreate('file')}
          aria-label="New File"
        >
          <IconFilePage size={14} />
          <span className="filetree__actionplus">+</span>
        </button>
        <button
          className="filetree__action"
          title="New Folder…"
          onClick={() => startCreate('dir')}
          aria-label="New Folder"
        >
          <IconFiles size={14} />
          <span className="filetree__actionplus">+</span>
        </button>
      </div>
      <div
        className="filetree"
        ref={treeRef}
        tabIndex={0}
        role="tree"
        onKeyDown={onTreeKeyDown}
        onDragOver={(e) => onRowDragOver(e, null)}
        onDrop={(e) => void onRowDrop(e, null)}
        onContextMenu={(e) => {
          // Empty space below the rows targets the root.
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          setSel(EMPTY_SELECTION)
          setMenu({ x: e.clientX, y: e.clientY, row: null })
        }}
      >
        {rootEntries === null ? (
          <div className="filetree__row filetree__row--loading">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="filetree__row filetree__row--empty">(empty)</div>
        ) : (
          rows
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {pending && (
        <PendingModal
          pending={pending}
          dontAsk={dontAsk}
          setDontAsk={setDontAsk}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending
            setPending(null)
            if (p.kind === 'delete') {
              if (dontAsk) setConfirmDelete(false)
              void runDelete(p.rels)
            } else if (p.kind === 'move') {
              if (dontAsk) setConfirmMove(false)
              void runMoves(p.moves, p.copy)
            } else if (p.kind === 'overwrite') {
              void runMoves(p.moves, p.copy, true)
            } else if (p.kind === 'undo') {
              void runUndo(p.entry)
            } else if (p.kind === 'trashFailed') {
              void window.api.file.removePermanently(root, p.rels).then((r) => {
                if (!r.ok) pushToast('Some files could not be deleted', 'error')
                else fileDeleted(p.rels)
                refreshNow()
              })
            }
          }}
        />
      )}
    </>
  )
}

/** Our own rows from a drag, or null when the drag came from outside the app
 *  (a Finder drop) — the two are handled completely differently. */
function readDragRels(e: React.DragEvent): string[] | null {
  const types = Array.from(e.dataTransfer.types ?? [])
  if (!types.includes('application/x-agentmaster-files')) return null
  try {
    // getData is empty during dragover in some browsers; the type check above is
    // what actually distinguishes internal from external there.
    const raw = e.dataTransfer.getData('application/x-agentmaster-files')
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function baseName(rel: string): string {
  return rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
}

/** Every confirmation the tree can raise, as one modal driven by the pending
 *  operation. Keeping them together means the wording stays consistent and the
 *  destructive ones can't quietly diverge from the safe ones. */
function PendingModal({
  pending,
  dontAsk,
  setDontAsk,
  onCancel,
  onConfirm
}: {
  pending: Pending
  dontAsk: boolean
  setDontAsk: (v: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  let title = ''
  let body: JSX.Element | string = ''
  let confirmLabel = 'OK'
  let danger = false
  let showDontAsk = false

  if (pending.kind === 'delete') {
    const { rels, dirty, undoable } = pending
    title =
      rels.length === 1
        ? `Are you sure you want to delete “${baseName(rels[0])}”?`
        : `Are you sure you want to delete these ${rels.length} items?`
    confirmLabel = 'Move to Trash'
    danger = true
    showDontAsk = true
    body = (
      <>
        {rels.length > 1 && <div className="confirm__list">{rels.map(baseName).join(', ')}</div>}
        <div>You can restore {rels.length === 1 ? 'this item' : 'these items'} from the Trash.</div>
        {dirty.length > 0 && (
          <div className="confirm__warn">
            {dirty.length === 1
              ? `“${baseName(dirty[0])}” has uncommitted changes.`
              : `${dirty.length} of these have uncommitted changes.`}{' '}
            That work is not in git — the Trash is the only copy.
          </div>
        )}
        {!undoable && <div className="confirm__warn">This cannot be undone with ⌘Z.</div>}
      </>
    )
  } else if (pending.kind === 'trashFailed') {
    title = 'Failed to move to the Trash'
    confirmLabel = 'Delete Permanently'
    danger = true
    body = (
      <>
        <div>{pending.rels.map(baseName).join(', ')}</div>
        <div className="confirm__warn">
          Deleting permanently cannot be undone and the files will not be in the Trash.
        </div>
      </>
    )
  } else if (pending.kind === 'move') {
    const { moves, destDir } = pending
    const where = destDir || 'the project root'
    title =
      moves.length === 1
        ? `Are you sure you want to move “${baseName(moves[0].from)}” into “${where}”?`
        : `Are you sure you want to move these ${moves.length} items into “${where}”?`
    confirmLabel = 'Move'
    showDontAsk = true
    body = moves.length > 1 ? <div className="confirm__list">{moves.map((m) => baseName(m.from)).join(', ')}</div> : ''
  } else if (pending.kind === 'overwrite') {
    title =
      pending.names.length === 1
        ? `“${pending.names[0]}” already exists in the destination. Replace it?`
        : `${pending.names.length} items already exist in the destination. Replace them?`
    confirmLabel = 'Replace'
    danger = true
    body = (
      <>
        <div className="confirm__list">{pending.names.join(', ')}</div>
        <div className="confirm__warn">Replacing cannot be undone.</div>
      </>
    )
  } else {
    title = `Would you like to undo “${pending.entry.label}”?`
    confirmLabel = 'Undo'
    body = describeOp(pending.entry.op).startsWith('Create')
      ? 'This will move what was created to the Trash.'
      : ''
  }

  return (
    <Modal className="confirm" label={title} onClose={onCancel} onEscape={onCancel}>
      <div className="confirm__title">{title}</div>
      <div className="confirm__body">{body}</div>
      {showDontAsk && (
        <label className="confirm__check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Don&rsquo;t ask me again
        </label>
      )}
      <div className="confirm__actions">
        <button className="confirm__btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className={'confirm__btn' + (danger ? ' confirm__btn--danger' : '')}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
