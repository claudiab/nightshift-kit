---
name: ns-babysit
description: Recurring CI sweep over open agent PRs. Fixes the boring red checks (format, auto-fixable lint, lockfile drift, stale base) with one small commit per PR per run, and escalates everything else. Never force-pushes. A PR that fails the same diagnosis twice is handed to a human, not retried.
allowed-tools: Read, Edit, Glob, Grep, Bash(git*), Bash(gh*), Bash(npm*), Bash(npx*)
---

# /ns-babysit [pr-number] — keep the assembly line moving

Glue work. The goal is that nobody wakes up to a stack of red PRs that just needed
`prettier --write`.

## Non-negotiable rules

- **Never force-push.** No `--force`, no `--force-with-lease`, no `-f`. If a fix needs
  a history rewrite, refuse and comment.
- **Never push to a `protected_branches` entry.**
- **Never disable a gate to make CI green.** If the gate is right and the code is
  wrong, fix the code or comment and stop.
- **One commit per PR per run.** Two problems → fix the first, let the next run take the second.
- **Only push to `branch_prefix` branches.** Human-owned branches get a comment, never a commit.
- **Skip drafts** unless labeled `babysit:ok`.
- **Same PR, same diagnosis, two runs in a row → stop touching it.** Comment the
  failure summary, add `labels.needs_info`, move on. Do not loop on hard failures.

## Steps

1. Read `nightshift.config.json`.
2. `gh pr list --base <base_branch> --state open --json number,title,headRefName,author,labels,statusCheckRollup,isDraft --limit 50`
3. Oldest-updated first. Green → skip. Red → `gh pr checks N` then
   `gh run view <run-id> --log-failed`.
4. Diagnose against the known-remediation table:

| Symptom | Fix | Commit message |
|---|---|---|
| Format check fails | run the formatter **on changed files only** | `chore: apply formatter` |
| Lint fails, auto-fixable | `<lint> --fix` on changed files | `chore: apply lint --fix` |
| Lint fails, not auto-fixable | **comment and stop** | — |
| Lockfile drift after base merge, `package.json` untouched by PR | reinstall to refresh lockfile | `chore: refresh lockfile after base merge` |
| Lockfile drift, PR intentionally changes deps | **comment and stop** | — |
| Can't merge base (stale) | `git merge origin/<base_branch>`; resolve conflicts in **lockfiles / generated files only** | `chore: merge <base_branch>` |
| Conflicts in source files | **refuse and comment** | — |
| Flaky test (passed on previous push, same spec) | `gh run rerun <id> --failed` once. Still red → treat as real. | no commit |
| Coverage drop on a touched file | comment with file + current % — **do not write the tests yourself** | — |
| Anything else | comment with job name + log excerpt, add `labels.needs_info` | — |

5. After a fix commit: `git push` (no flags). If a review verdict comment already exists
   on the PR, note that the head moved so the gate re-runs it.
6. Append one line per PR touched to `ops/babysit-log.md`:
   `<ISO timestamp> | PR #N | <format|lint|lockfile|merge|rerun|commented|skipped> | <result>`

## Refusals

- A PR with a force-push in its recent history (someone is actively rewriting) → skip with a comment.
- More than 10 PRs need fixes in one run → fix the oldest 5, comment "deferred to next
  sweep" on the rest, exit. The cap stops one config breakage from becoming 30 noisy commits.
- A fix that would touch migration files → refuse and comment. Migrations are
  intentional artifacts.

## Output

One line: `Swept N PRs — F fixed, R rerun, C commented, S skipped`. Detail lives in the log.

## Scheduling

Meant to run every 30 minutes during working hours. See `docs/runbook.md` → Scheduling.
