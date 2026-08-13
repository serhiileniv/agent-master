# Security Policy

## Supported versions

Agent Master is in active development and ships frequently. Only the **latest release** receives security
fixes — please reproduce on the current version before reporting.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/serhiileniv/agent-master/security/advisories/new)
(Security → Report a vulnerability). Include:

- What you found and why it's exploitable
- Steps to reproduce, ideally with a minimal case
- The Agent Master version, your OS, and the agent CLI involved
- Any proposed fix, if you have one

You can expect an initial response within a few days. As a solo-maintained project there's no
formal SLA and no bug-bounty program, but valid reports will be fixed and credited in the release
notes unless you'd rather stay anonymous.

## Threat model

Agent Master is a **local desktop application** with no server component, no account system, and no
telemetry. That shapes what counts as a vulnerability.

**In scope:**

- Sandbox or `contextIsolation` escapes from the renderer into the main process
- Content Security Policy bypasses in the production build
- Path traversal in the file panel — reading or writing outside the opened project root
- Git operations escaping their worktree, or destroying data outside the agent's branch
- Command injection through project paths, branch names, or workspace names
- Anything that causes code to execute without the user having chosen to launch it

**Out of scope:**

- **The agent CLIs themselves.** Agent Master spawns `claude`, `codex`, `gemini`, `cursor-agent` and
  similar tools on your behalf, with your credentials. What those agents do — including running
  commands and modifying files — is their behaviour, not Agent Master's. Report those upstream.
- **A user deliberately running a destructive command in a terminal card.** The terminals are real
  PTYs; that's the product.
- Unsigned builds triggering Gatekeeper or SmartScreen warnings. This is a known gap — code signing
  and notarization are on the roadmap and tracked publicly.
- Vulnerabilities in Electron or dependencies that already have a public advisory and a pending
  upgrade. A PR bumping the dependency is welcome instead.

## Notes for users

Agent Master runs entirely on your machine and holds no credentials of its own — agents authenticate with
the CLI logins already on your system. Agent worktrees live in a sibling `.agentmaster-worktrees/`
directory next to your repository, and workspace state lives in `workspaces.json` in the app's
user-data folder. Nothing is transmitted off your machine.
