# Contributing to Spy Master

Thanks for taking the time to help. Spy Master is a small project and every bug report,
reproduction, or patch genuinely moves it forward.

## Ways to help

- **Report a bug** — [open an issue](https://github.com/Serhii-Leniv/spymaster/issues/new/choose).
  Terminal and PTY bugs are extremely platform-dependent, so please include your OS, the agent
  CLI you were running, and the Spy Master version from **Settings → About**.
- **Suggest a feature** — open an issue describing the workflow you're trying to get to. Concrete
  "I was trying to X and had to Y" reports are more useful than feature names.
- **Send a pull request** — see below.

## Getting set up

You'll need **Node.js + npm** and **git**. No Rust or C++ toolchain is required — `node-pty`
installs a prebuilt binary, and `.npmrc` pins the Electron ABI it's built against.

```bash
git clone https://github.com/Serhii-Leniv/spymaster.git
cd Spy Master
npm install
npm run dev          # hot-reloading dev build
```

For a production-like run: `npm run build && npm run preview`.

## Before you open a PR

Run the fast checks — CI runs these on every push and packaging is gated on them:

```bash
npm run typecheck
npm run lint
npm run test
```

Then run the integration smoke tests relevant to what you touched. These drive the **real built
bundles** over IPC under a headless Electron, so run `npm run build` first:

```bash
npm run build
npm run smoke:pty          # PTY loads under Electron ABI + shell echo
npm run smoke:p2           # git detect, worktree isolation, agent cwd pinning, teardown
npm run smoke:p3           # diff sees changes, merge lands work on base branch
```

The full list lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). If you changed anything in
`src/main/git.ts` or the worktree lifecycle, run `smoke:p2` and `smoke:p3` — those cover the paths
where a bug can destroy someone's work.

## Pull request guidelines

- **Open an issue first for anything large.** It's much cheaper to disagree about the approach
  before the code exists.
- **Keep PRs focused.** One concern per PR; unrelated cleanups in a separate one.
- **Match the surrounding code.** The codebase has a consistent style — follow the file you're
  editing rather than introducing new patterns.
- **Add a smoke test for main-process behaviour.** New IPC handlers or git operations should be
  covered by a script in `scripts/smoke/`; existing files are good templates.
- **Describe how you verified it.** "Ran smoke:p3 on Windows" is worth more than a description of
  the diff.

## Repository layout

```
src/main/       Electron main process — IPC, PTY manager, git/worktree
src/preload/    contextBridge API surface
src/renderer/   React + Zustand UI, xterm.js terminals
scripts/smoke/  Electron integration smoke tests
scripts/diag/   manual diagnostic harnesses
docs/           architecture, release process, changelog
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Security

Please don't file security issues publicly — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
