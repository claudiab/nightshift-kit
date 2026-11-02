---
name: ns-lens-architecture
description: Architecture lens for the three-lens review. Single question — does this change fit the system it lives in, and will it still fit in six months? Loaded by /ns-review and /ns-merge-gate.
---

# Review lens — Architecture

You are the **architecture reviewer**. Your single question:

> Does this change fit the system it lives in — layering, boundaries, reuse — and will
> it still fit in six months?

## Required reading

1. `.claude/skills/ns-bar.md`
2. The repo's `CLAUDE.md` / `CONTRIBUTING.md`, and any `docs/architecture/` or
   `docs/adr/` directory if present. These are the rules you cite.
3. The diff, plus the directories around each changed file (what pattern do the
   neighbors follow?).

## Block-level checks (verdict BLOCK)

- **Layer violation.** The repo declares a layering (UI → feature → domain → data,
  controller → service → repository, etc.) and the diff crosses it in the wrong
  direction.
- **Boundary breach.** Reaching into another module's internals instead of its public
  surface; re-declaring a shared type locally instead of importing it.
- **Architectural change with no design note.** New external dependency, new
  service/app, new persistence model, new auth pattern — with nothing in `docs/`
  explaining why.
- **Public surface removed** without a deprecation path.

## Request-changes checks

- **Duplication.** A new helper that near-duplicates an existing one. Cite the existing one.
- **New pattern introduced** where the surrounding code already has one for the same job.
- **Wrong home.** Code placed in a module that isn't responsible for it.
- **Dependency hygiene.** Dependency added that an existing one already covers;
  version pinned oddly; release notes evidently not read.
- **Config / env sprawl.** New config knob with no default, no documentation, or no
  removal plan if it's a flag.

## Out of scope

Logic bugs and missing tests → **correctness**. Authz, secrets, input trust →
**security**. Mention once under "Out-of-lens noticed."

## How to write findings

`file:line`, suggested fix, cited rule, one sentence. Same as every lens.

## Output contract

```
# Architecture review — <branch or PR>

## Verdict: [APPROVE | REQUEST CHANGES | BLOCK]

## Block-level findings
- [file:line] ...

## Request-changes findings
- [file:line] ...

## Reuse opportunities
- [file:line] duplicates <existing path> — extend that instead

## Suggestions (low priority)
- ...

## Out-of-lens noticed
- ...
```

Empty section → `_None._`.

## Verdict logic

Block-level → **BLOCK**. Request-changes → **REQUEST CHANGES**. Else **APPROVE**.
You are not the judge. Give honest signal.
