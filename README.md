<p align="center">
  <img alt="Spy Master" src="build/icon-mac.png" width="148">
</p>

<h1 align="center">Spy Master</h1>

<p align="center">
  <b>Run a whole team of coding agents at once.</b><br>
  The desktop space for parallel agentic coding — start five, keep them out of each
  other's way, ship the one that nailed it.
</p>

<p align="center">
  <a href="https://serhiileniv.github.io/spymaster/"><img alt="Download Spy Master" src="https://img.shields.io/badge/Download-Spy%20Master-ff453a?style=flat-square"></a>
  <a href="https://github.com/serhiileniv/spymaster/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/serhiileniv/spymaster?style=flat-square&label=latest&color=ff453a"></a>
  <a href="https://github.com/serhiileniv/spymaster/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/serhiileniv/spymaster/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://github.com/serhiileniv/spymaster/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/serhiileniv/spymaster?style=flat-square&color=f0b429"></a>
  <img alt="macOS and Windows" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows-1f2430?style=flat-square">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-30d158?style=flat-square">
</p>

<p align="center">
  <img alt="Six AI coding agents running in parallel on the Spy Master stage, each in its own git worktree" src="assets/demo.gif" width="880">
  <br>
  <sub><a href="https://github.com/serhiileniv/spymaster/blob/main/assets/demo.mp4">▶ Watch the full demo</a></sub>
</p>

---

**[Download](#download)** · **[Quick start](#quick-start)** · **[FAQ](docs/FAQ.md)** ·
**[Docs](#docs)**

---

## Why Spy Master

Running several coding agents at once means several terminals, several checkouts, and a
running tally in your head of which agent touched what. Spy Master is the place to do it properly:
every agent gets its own pane and its own git worktree, so they never step on each other's
work — or on yours.

## Bring your own agents

Spy Master drives the agent CLIs you already run — **Claude Code, Codex, Gemini, Cursor**, or any
terminal tool — spawned on your machine with your own keys. No middleman, no markup, no extra
subscription, and **no inference cost**: the intelligence is whatever you've already installed.

Which also means nothing leaves your computer. No account, no telemetry, no background
service — just the app and the tools you point it at.

## Download

| Platform | Download |
| --- | --- |
| **macOS** (Apple Silicon) | [SpyMaster&#8209;macOS&#8209;arm64.dmg](https://github.com/serhiileniv/spymaster/releases/latest/download/SpyMaster-macOS-arm64.dmg) |
| **Windows** (x64) | [SpyMaster&#8209;Windows&#8209;Setup.exe](https://github.com/serhiileniv/spymaster/releases/latest/download/SpyMaster-Windows-Setup.exe) |

> [!IMPORTANT]
> **macOS needs one extra command on first launch.** Spy Master isn't signed with a paid Apple
> Developer certificate yet, so macOS quarantines it and claims the app is *"damaged."* It
> isn't. After dragging Spy Master to Applications, clear the flag once:
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Spy Master.app"
> ```
>
> Windows shows a comparable one-time SmartScreen prompt (**More info → Run anyway**).
> Signing and notarization are on the roadmap.

Older versions and install notes live on **[the download page](https://serhiileniv.github.io/spymaster/)**.
Spy Master checks for updates on launch and tells you when one's ready.

## Quick start

1. **Install an agent CLI** — [`claude`](https://docs.claude.com/en/docs/claude-code/overview),
   `codex`, `gemini`, or `cursor-agent` — and make sure it's on your `PATH`.
2. **Open a project.** Point Spy Master at any folder; a git repo is what unlocks per-agent isolation.
3. **Add agents** from the toolbar. Each card is a real terminal; up to nine tile automatically.
4. **Review & merge.** Open a card's **Diff** tab, then **Merge** into your base branch — or
   **Discard** and let the next agent take it.

## Docs

- **[FAQ](docs/FAQ.md)** — cost, git requirements, agent limits, where your data lives, how
  Spy Master compares to tmux and cloud agent platforms
- **[Architecture](docs/ARCHITECTURE.md)** — process split, isolation model, security posture, tests
- **[Contributing](CONTRIBUTING.md)** — building from source, the checks to run, PR guidelines
- **[Changelog](docs/CHANGELOG.md)** — what changed in each release

Spy Master is in active development and every report helps —
[open an issue](https://github.com/serhiileniv/spymaster/issues/new/choose) with bugs or feature
requests. Found a security problem? Report it privately via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Serhii Leniv
