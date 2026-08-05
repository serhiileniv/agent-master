# Specs

One document per feature, describing what it does in **observable behaviour** — what a person sees
and does in the app — rather than how it is built.

## Why these exist

Spy Master is built almost entirely by AI agents working from instructions, and reviewed by someone who
does not read diffs. That makes the spec the **review surface**: it is the artifact where a wrong
feature can be caught before it exists, at the point when catching it is nearly free.

A spec does three jobs:

1. **Agreement before building.** If the spec is wrong, the feature is wrong. Cheaper to find out here.
2. **A written baseline.** The corpus records what the app is supposed to do, in reviewable language.
   When behaviour changes, the spec changes in the same PR — so drift is visible.
3. **The source of the tests.** Each numbered behaviour maps to an acceptance check that ends up in
   `scripts/smoke/` or a `*.test.ts`. This is the mechanism that stops new features from breaking old
   ones — see the regression rule in [CLAUDE.md](../../CLAUDE.md).

## Writing one

Run `/spec <what you want the app to do>`. It interrogates the idea, then drafts the document from
[TEMPLATE.md](TEMPLATE.md).

Nothing gets built until the spec is `approved` and its **Open questions** section is empty.

## Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Being written or still has open questions. Not buildable. |
| `approved` | Agreed. Build it on a branch. |
| `shipped` | Merged. Record the version in **Shipped in**. |
| `superseded` | Replaced by a later spec. Link to it; do not delete the file. |

Superseded specs stay in the repo — the record of what the app used to do, and why it changed, is
worth more than a tidy directory.

## Relationship to ADRs

A spec says **what the app does**. An [ADR](../adr/) says **why a technical decision was made** —
and only for decisions a future contributor might otherwise reverse without knowing the reasoning
(worktrees living outside the repo, workspaces being folder-less, the frozen `vectro.` storage keys).

Most features need a spec and no ADR. Write the ADR when the decision is made, during specification —
not afterwards, where it degrades into a changelog entry. `docs/CHANGELOG.md` already covers that.

## Backfill

Specs written after the fact for already-shipped features are worth having: they give the corpus a
baseline and often surface behaviour nobody can currently name. Mark them `shipped` and note in
**Notes** that they were written retroactively.
