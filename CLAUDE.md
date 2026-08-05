# CLAUDE.md

Operating rules for AI agents working in this repository. Read this before touching anything.

Spy Master is an Electron desktop app that runs multiple CLI coding agents side by side, each in its own
PTY and its own isolated git worktree. It ships as a signed installer to real users, so a regression
here is not a broken test — it is a broken app on someone's machine, and in the worst case it is
their lost work.

## Read these first

Do not duplicate what they say; they are current and authoritative.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the three processes fit together, the
  isolation model, persistence, security posture, and the full test inventory.
- **[CONTEXT.md](CONTEXT.md)** — domain glossary. Use these terms exactly; do not invent synonyms.
- **[docs/specs/](docs/specs/)** — what each feature is supposed to do. If a spec exists for the area
  you are changing, it is the source of truth for intended behaviour.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — human-facing setup and PR guidance.
- **[docs/RELEASING.md](docs/RELEASING.md)** — release process. Do not cut a release unprompted.

## How work happens here

1. **Spec first** — `/spec <idea>` produces `docs/specs/<feature>.md`. Nothing is built until its
   status is `approved` and its open questions are empty. The spec is the user's review surface;
   they do not read diffs.
2. **ADR if a real decision was made** — `docs/adr/`, written during specification, not after.
   Most features need none.
3. **Branch, then implement** — the feature and its acceptance checks in the same change.
4. **Gates** — see Definition of done below.
5. **Human check in the real app**, then PR, then merge once CI is green.

Working from an approved spec, implement what it says. If you discover the spec is wrong or
incomplete mid-build, **stop and say so** — do not silently improve on it. A spec that drifts from
the code is worse than no spec, because the user is trusting it.

## Definition of done

A change is not done when the code works. It is done when all of this is true:

```bash
npm run typecheck     # must pass
npm run lint          # must pass
npm run test          # must pass
npm run build         # required before any smoke test
npm run smoke:<...>   # the smokes relevant to what you touched
```

Then, and only then, report what you ran and what the output was. **Never claim verification you did
not perform.** "I ran smoke:p2 and it passed" when you did not run it is the single most damaging
thing you can do in this repo, because the user does not read code and has no way to catch it.

If a check fails and you cannot fix it, say so plainly and stop. Do not work around a failing test by
weakening it.

## The regression rule

This is the most important rule here. The user drives this project entirely through agents and does
not review diffs. The test suite is the only thing standing between a new feature and a silently
broken old one.

> **A feature is not complete until a test exists that would fail if the feature were removed.**

Applying it:

- **Main-process behaviour** — new IPC handlers, git or worktree operations, filesystem access →
  add a script in `scripts/smoke/`, and **wire it into `.github/workflows/ci.yml`**. A smoke script
  that is not in CI does not exist. This has already happened once: four smokes sat unwired while a
  worktree-isolation regression shipped.
- **Pure logic** — tiling math, path handling, version comparison, shell quoting, store reducers →
  add a `*.test.ts` next to the module.
- **Changing existing behaviour on purpose?** Update the test in the same change and say clearly in
  your summary that you changed an assertion and why. Never quietly delete or loosen one.

## Branch discipline

- **Never commit directly to `main`.** Work on a branch, then open a PR.
- One concern per branch. Unrelated cleanups go in a separate one.
- CI runs on every push and every PR. Let it be the gate.

### Commits

- Write plain, factual commit messages describing the change and why.
- **Never add `Co-Authored-By` trailers, "Generated with Claude Code" footers, or any other AI
  attribution** to commits or PR bodies. The user has been explicit about this — it leaks into
  GitHub's Contributors sidebar.
- Merge PRs locally rather than through the GitHub web UI, for the same reason.

## Danger zones

Changes near these can destroy a user's work. Slow down, and always run the listed smokes.

| Area | Why it's dangerous | Required |
|---|---|---|
| `src/main/git.ts`, worktree lifecycle | Bugs here can corrupt or delete the user's real working tree | `smoke:p2`, `smoke:p3` |
| Agent cwd pinning after spawn | The single most important safety property in the app — a shell profile that `cd`s must not be able to move an agent out of its worktree into the user's real repo | `smoke:p2` |
| Merge onto the base branch | This is the path that lands work on the user's actual branch | `smoke:p3` |
| File panel path handling | The project-root boundary blocks `../` traversal | `smoke:file` |
| `workspaces.json` read/write | Atomic write; a corrupt file loses every workspace the user has | `smoke:wspersist`, `smoke:ws` |
| Preload bridge / CSP (`src/main/index.ts`) | Widening the API surface widens the attack surface | Justify explicitly |

## Traps that have bitten before

- **Electron ABI pin — do not bump Electron casually.** `node-pty` ships prebuilt, and `.npmrc`
  pins `target=29.4.6` because **ABI 121 is the highest node-pty prebuilt available** in
  `@homebridge/node-pty-prebuilt-multiarch` v0.13.1. Bumping the Electron major is therefore not a
  matter of moving the pin: past that ABI there may be no prebuilt at all, which means either
  building from source (reintroducing a native toolchain requirement for every contributor) or
  staying put. Treat an Electron upgrade as its own scoped piece of work, never as a drive-by. If
  the pin and Electron ever disagree, the module fails to load at runtime — `smoke:pty` catches it.
- **`vitest.config.ts` only includes `src/**/*.test.ts`** — not `.tsx`. A test written in a `.tsx`
  file will be silently skipped, not reported as failing.
- **Smoke scripts resolve built bundles by relative depth** (`join(__dirname, '..', '..', 'out',
  ...)`). Moving a smoke script breaks it unless the depth moves too.
- **Smokes need `npm run build` first.** They drive the built bundles in `out/`, not source. A stale
  build means you tested the previous version of your change.
- **ESLint ignores `scripts/` and all `*.cjs`**, so smoke scripts are unlinted. Read them carefully.

## Code conventions

- **Match the file you are editing.** This codebase has a consistent voice; follow it rather than
  introducing a new pattern. Comment density, naming, and idiom should look like the surrounding
  code.
- The renderer never shells out to git or touches the filesystem directly — it asks the main process
  over IPC and receives a result.
- Keep the `contextBridge` surface narrow and explicitly enumerated.
- Use the vocabulary in [CONTEXT.md](CONTEXT.md). Legacy terms persist in some identifiers and
  storage keys for compatibility — do not rename them opportunistically, and do not spread them into
  new code.

## Working with the user

The user does not write or read code. That shapes how you should communicate:

- Describe changes in terms of **observable app behaviour**, not implementation. "Renaming a
  workspace now survives restart" beats "persisted `name` in the workspace reducer."
- When you need a decision, present the trade-off in user terms and give a recommendation.
- To let the user see a change in the real app, use the `run-spymaster` skill.
- Report failures honestly and immediately. A surfaced problem is cheap; a hidden one ships.
