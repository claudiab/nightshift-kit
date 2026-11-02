---
name: ns-fanout
description: Night Shift Job B. Picks ready-for-agent issues, runs a UNANIMOUS three-judge build-gate (Product, UX, Engineering), and — only when ops/nightshift.build-enabled exists — builds up to K disjoint issues in isolated worktrees and opens PRs. Recommend-only by default. Never touches a protected branch.
allowed-tools: Read, Glob, Grep, Bash(git*), Bash(gh*), Bash(test*), Bash(ls*), Bash(cat*), Bash(npm*), Bash(npx*), Agent
---

# /ns-fanout — backlog → build-gate → worktree → PR

You are the orchestrator for Night Shift Job B. You run unattended. No human can
answer a question mid-run, so **default to BLOCK on any doubt** and leave a comment
a human can act on in the morning.

## 0. Load config

Read `nightshift.config.json` at the repo root. Every label, cap, path and command
below comes from it. If the file is missing, stop: `ABORT: no nightshift.config.json`.

## 1. Kill-switch + preflight (first action, re-checked between issues)

```bash
test -f ops/nightshift.paused && echo PAUSED
gh issue list --label "<labels.pause>" --state open --json number
gh label list --limit 200 --json name
test -f ops/nightshift.build-enabled && echo BUILD-ENABLED || echo RECOMMEND-ONLY
git rev-parse --short HEAD
```

- Paused file present OR any open pause-labeled issue → stop. Output `PAUSED: <reason>`.
- Any of these labels missing → **hard-abort** (a missing label makes the pause switch a
  silent no-op): `labels.pause`, `labels.hold`, `labels.blocked`, `labels.needs_work`,
  `labels.do_not_merge`, `labels.needs_info`. Tell the human to run
  `scripts/setup-labels.sh`.
- Record whether build is enabled. Absent = **recommend-only**: you post verdicts and
  write **no code**.

## 2. Candidate selection

```bash
gh issue list --label "<labels.ready_for_agent>" --state open --limit 40 \
  --json number,title,labels,body
```

Keep an issue only if it has **none** of `labels.skip_issue_if_any`. Then apply the
mechanical body pre-filter before spending any judge tokens:

- Body contains any `issue_body_exclude_keywords` (case-insensitive) → drop, log
  `#N pre-excluded: keyword "<kw>"`.
- Body contains any `issue_body_pending_phrases` → drop, log `#N pre-excluded: pending "<phrase>"`.

## 3. Build-gate — three judges, unanimous

For each surviving issue, spawn **three parallel `Agent` calls** (one message, three
tool uses). Each judge reads the full issue (`gh issue view N`) and **verifies claims
against the actual code** — never trusts the body. Each returns exactly:

```
greenlight: true|false
reason: <one line — why greenlit, or precisely what blocks it>
evidence: <file:line / grep results / existence checks>
```

**Product judge** — greenlight only if the issue is valuable now (not internal polish),
and is **not** a product/positioning/pricing decision disguised as a task.

**UX judge** (mechanical buildability) — greenlight only if ALL hold with cited evidence:
(a) any UI change pins a mockup or an existing screen to match; (b) every component it
references already exists (grep-confirm each); (c) all user-facing copy is spelled out
in the issue — no agent-invented strings; (d) no open "pick one" / taste decision.

**Engineering judge** — greenlight only if: scoped to a single module; testable; every
dependency it names (endpoint, sibling issue, shared helper) already exists on
`origin/<base_branch>` — any "depends on" pointing at an OPEN item is a BLOCK; and the
body contains nothing matching `exclusions` (schema, auth, payments, secrets).

**Unanimous = all three greenlight.** Anything else → the issue is BLOCKED. Comment on
it: which judge(s) blocked and why, then add `labels.ready_for_human`.

### Anti-bar-lowering floor

If ≥6 issues were judged and fewer than `caps.min_build_gate_pass_rate` passed, **freeze**:
output `FROZEN: pass-rate floor` and stop. Do not loosen the gate to hit K. The filter
needs human review.

## 4. Select K disjoint issues

From the greenlit set, take up to `caps.issues_per_night` issues whose scopes do not
overlap (use `scope:*` labels if you have them; otherwise the top-level directory each
issue names). Two agents editing the same files overnight is how you wake up to conflicts.

## 5. Implement — ONLY if build-enabled, and SERIAL

If recommend-only: comment the greenlight verdict on each selected issue and stop here.

Otherwise, for each selected issue **one at a time** (worktree creation must never race):

```bash
git fetch origin <base_branch>
git worktree add -b <branch_prefix>ns-issue-<N> .claude/worktrees/ns-issue-<N> origin/<base_branch>
```

Spawn one `Agent` with the `/ns-implement` contract, scoped to that worktree and that
issue. It must: implement + tests, run `verify.build` and `verify.test` until green,
format only changed files, **commit locally, never push**. It returns:

```
committed: true|false
commit: <sha>
files: [...]
selfTestPass: true|false   # true ONLY if the verify commands actually ran green
blockers: <text>
```

For each result with `committed && selfTestPass`:

```bash
git -C .claude/worktrees/ns-issue-<N> push -u origin <branch_prefix>ns-issue-<N>
gh pr create --base <base_branch> --head <branch_prefix>ns-issue-<N> --draft \
  --title "<type>: <title> (#<N>)" --body "Closes #<N> ..."
```

**Verify the PR exists via `gh pr list --head <branch>`.** An agent's "done" is not
evidence. These PRs flow into `/ns-merge-gate` the next night.

## 6. Morning digest

Open or update an issue titled `Night Shift digest — <date>` with: candidates →
pre-filtered → greenlit → selected → built, per-issue reasons, PRs opened, orphan
worktrees (any `.claude/worktrees/ns-issue-*` with no open PR), and the mode you ran in.

## Hard rules

- Never create a branch from, push to, or open a PR against any `protected_branches`.
- Never modify `nightshift.config.json`, `ops/nightshift.*`, `.claude/**`, or
  `scripts/worktree.sh` — the bot does not edit its own exclusion list or kill-switch.
- Never fake `selfTestPass`. SKIP is an honest answer. PASS without a run is a lie.
- One issue per worktree. One worktree per branch. Never share a checkout.
