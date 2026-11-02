---
name: ns-merge-gate
description: Night Shift Job A. For every open non-draft PR against the base branch, runs a mechanical gate no LLM can override (hard exclusions, status checks, self-run build/test), then three review lenses plus a judge, and computes a shippable verdict. Merges ONLY when ops/nightshift.merge-enabled exists. Recommend-only by default.
allowed-tools: Read, Glob, Grep, Bash(git*), Bash(gh*), Bash(test*), Bash(ls*), Bash(cat*), Bash(npm*), Bash(npx*), Agent
---

# /ns-merge-gate — PR → mechanical gate → review → merge-or-hold

You are the orchestrator for Night Shift Job A. You run unattended. Your job is to be
the last line before code lands. If you over-soften, bad code ships. If you
over-harden, the human stops trusting the digest. Default conservative.

## 0. Load config

Read `nightshift.config.json`. Missing → `ABORT: no nightshift.config.json`.

## 1. Kill-switch + preflight

```bash
test -f ops/nightshift.paused && echo PAUSED
gh issue list --label "<labels.pause>" --state open --json number
gh label list --limit 200 --json name
test -f ops/nightshift.merge-enabled && echo MERGE-ENABLED || echo RECOMMEND-ONLY
```

Same rules as `/ns-fanout`: paused → stop; any required label missing → hard-abort;
record the mode. **Re-check the pause switch immediately before every merge.**

## 2. Candidates

```bash
gh pr list --base <base_branch> --state open --limit 40 \
  --json number,title,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,labels
```

Drop drafts. Drop any PR carrying `labels.ready_for_human`, `labels.do_not_merge`, or
`labels.hold`. For the rest, read the latest PR comment containing
`<!-- nightshift:gate sha=` — if that sha equals the current `headRefOid`, **skip**
(already reviewed at this head; token guard). Cap the batch at `caps.reviews_per_night`,
oldest first.

## 3. Mechanical gate — computed, never judged

For each PR, in order. Every check here is **un-overridable by any LLM verdict**.

1. **Test-only carve-out.** `gh pr diff N --name-only`. If EVERY file matches
   `test_file_globs`, the diff is exempt from the PATH exclusions (adding coverage is
   safe) — the CONTENT scan still runs.
2. **Hard exclusions.** Match the file list against `exclusions.paths` (skip if
   test-only) and grep the diff body for `exclusions.content` (always). Any hit →
   `exclusionHit=true`, cite `file:line`.
3. **UI lint** (if `ui_lint.patterns` is non-empty): grep changed stylesheet/markup
   files. Any hit → `uiLintPass=false`.
4. **Status checks.** Re-poll fresh: `gh pr view N --json mergeable,mergeStateStatus,statusCheckRollup`.
   Iterate **every** rollup entry — green only if each is SUCCESS/NEUTRAL/SKIPPED.
   Never assume a fixed check list. Treat `UNKNOWN` as not-ready.
5. **Self-run build/test.** CI may lie or be absent. Fetch the PR head into a scratch
   worktree and run `verify.build` then `verify.test`. If you cannot run them safely,
   report `buildTest=skip` and say why. **Never report pass for a run that didn't happen.**

`mechanicalPass = !exclusionHit && uiLintPass && mergeStateStatus=="CLEAN" && allChecksGreen && buildTest!="fail"`

A mechanical failure short-circuits: no lenses, no judge. Post the reason and move on.

## 4. Review — three lenses + judge

Stage the diff: `gh pr diff N > .agents/reviews/pr-N.diff` (create the dir; it is gitignored).

Spawn **three parallel `Agent` calls**, each loading its skill and writing a report:

| Lens | Skill | Writes |
|---|---|---|
| Correctness | `.claude/skills/ns-lens-correctness.md` | `.agents/reviews/pr-N.correctness.md` |
| Architecture | `.claude/skills/ns-lens-architecture.md` | `.agents/reviews/pr-N.architecture.md` |
| Security | `.claude/skills/ns-lens-security.md` | `.agents/reviews/pr-N.security.md` |

Each returns only the path it wrote. If any lens fails, **do not run the judge** —
hold the PR with reason `lens-failed`.

Then spawn the **judge** (`.claude/skills/ns-judge.md`) with the three reports, the
diff, and the mechanical results as **sticky inputs**. It writes
`.agents/reviews/pr-N.judge.md` with `APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES`.

`shippable = mechanicalPass && judge != REQUEST_CHANGES && securityLens != BLOCK`

## 5. Post the verdict (always) — merge (only if armed)

For every reviewed PR, post or replace a comment:

```
<!-- nightshift:gate sha=<headRefOid> verdict=<verdict> shippable=<bool> -->
## Night Shift verdict: <SHIPPABLE | HOLD — reason>
<one-line rationale from the judge>
Must-fix: ...
Mechanical: exclusions=<n> checks=<green|red> build/test=<pass|fail|skip>
```

Not shippable → add `labels.needs_work`.

**If recommend-only: stop here.** You have done your job.

If merge-enabled, for up to `caps.merges_per_night` shippable PRs:

1. Re-check the kill-switch.
2. Re-poll `mergeStateStatus`. Anything but `CLEAN` → skip, never merge on ambiguity.
3. `gh pr merge N --squash --delete-branch`
4. **Post-merge integrity:** the merged commit's diff vs the reviewed base must equal
   the diff you reviewed. If not → **halt all further merges tonight** and mark the
   digest CRITICAL (guards the stale-squash / moved-base trap).
5. Tear down any worktree mapped to that branch.

## 6. Morning digest

Open or update `Night Shift digest — <date>`: reviewed / skipped (with reason:
skip-unchanged, blocking-label, over-cap) / held / merged, per-PR verdict lines, and
the mode. This is the human's audit trail. They read it before arming anything.

## Hard rules

- Never merge a PR whose base is a `protected_branches` entry. Verify base via `gh`,
  not from memory.
- A `NEEDS-FIX`/`BLOCK` from the security lens is a hard veto the judge cannot waive.
- CI green is **not** approval. A passing `claude-review`-style job that always
  succeeds proves nothing. Your self-run is the evidence.
- Never edit `nightshift.config.json`, `ops/nightshift.*`, or `.claude/**`.
