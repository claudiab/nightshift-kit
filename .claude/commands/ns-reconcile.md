---
name: ns-reconcile
description: Verify what the overnight run actually produced, using GitHub state only — never an agent's self-report. Classifies each issue/branch as DELIVERED / PARTIAL / STRANDED / DEAD and prints recovery commands. Run this every morning before reading any digest.
allowed-tools: Read, Bash(git fetch*), Bash(git ls-remote*), Bash(git diff*), Bash(git worktree*), Bash(gh pr*), Bash(gh issue*)
---

# /ns-reconcile — trust the repo, not the report

Agents report success they did not achieve. In the run this kit was extracted from,
six agents each reported "complete" on the same night; **zero** had pushed a branch.
This command exists because the only trustworthy evidence is what is visible on GitHub.

Argument (optional): a date `YYYY-MM-DD` or an issue number. Default: last night.

## Rule

**Never read an agent's summary, comment, or session output as evidence.** Only these count:

| Evidence | Command |
|---|---|
| Branch exists remotely | `git ls-remote --heads origin <branch_prefix>ns-issue-<N>` |
| PR exists, and its base | `gh pr list --head <branch> --state all --json number,baseRefName,isDraft,url` |
| Breadcrumb comment posted | `gh issue view <N> --json comments` |
| The diff is real | `git fetch origin <branch> && git diff origin/<base_branch>...origin/<branch> --stat` |

## Steps

1. `git fetch origin --prune --quiet`
2. Load `nightshift.config.json`. Find last night's candidates: the digest issue
   (`Night Shift digest — <date>`) plus any `.claude/worktrees/ns-issue-*` on disk plus
   any remote branch matching `<branch_prefix>ns-issue-*`.
3. For each, gather the four facts and classify:
   - **DELIVERED** — branch exists AND a PR is open against `base_branch` AND the diff is non-empty.
   - **PARTIAL** — branch exists but no PR; or PR with empty diff; or PR targeting the
     wrong base. **A PR aimed at a protected branch is an incident — close it and say so loudly.**
   - **STRANDED** — no branch, but a breadcrumb comment with the change exists. Recoverable.
   - **DEAD** — no branch, no PR, no comment. The agent produced nothing.
4. For every DELIVERED item, **check the diff, not the description**: does
   `git diff --stat` touch only files inside the issue's stated scope? Out-of-scope
   files → flag as `SCOPE-LEAK`.
5. Orphan worktrees: any `.claude/worktrees/ns-issue-*` with no open PR → list with
   `scripts/worktree.sh rm <name>` as the recovery command. Do not remove them yourself.

## Output

```
Night Shift reconcile — <date>
DELIVERED  #123 → PR #456 (base: development, +120/−8, 4 files)      ✓ in scope
PARTIAL    #124 → branch exists, no PR        recover: gh pr create --base development --head claude/ns-issue-124
STRANDED   #125 → breadcrumb only             recover: apply diff from issue comment, then push
DEAD       #126 → nothing                     recover: re-queue (label ready-for-agent)
INCIDENT   #127 → PR #457 targets main        CLOSED. Investigate before next run.
Orphan worktrees: ns-issue-126   →  scripts/worktree.sh rm ns-issue-126
```

Then stop. You do not fix anything. You tell the human what is true.
