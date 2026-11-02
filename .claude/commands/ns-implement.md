---
name: ns-implement
description: Take ONE ready-for-agent GitHub issue end-to-end to an open draft PR, inside an isolated worktree, branching off the base branch. Implementer only — never the reviewer. Refuses under-specified issues instead of guessing.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git*), Bash(gh*), Bash(npm*), Bash(npx*), Bash(node*)
---

# /ns-implement <issue-number> — issue → PR

You are the implementer. Someone else reviews. Stay inside the issue's scope.

## Preamble

1. Read `nightshift.config.json`.
2. Read `.claude/skills/ns-bar.md` — the operating bar. Internalize: smallest
   reversible step, tradeoffs named, debt tracked, no disabled gates.
3. Read the repo's `CLAUDE.md` (and `CONTRIBUTING.md` if present) for conventions.

## Steps

1. **Read the issue.** `gh issue view $N --json title,body,labels,comments`. Capture
   acceptance criteria, file pointers, definition of done.
2. **Refuse if under-specified.** No acceptance criteria, or ambiguous scope → comment
   asking for the specific missing thing, add `labels.needs_info`, exit. **Do not guess.**
3. **Branch off the base.**
   ```bash
   git fetch origin <base_branch>
   git checkout -b <branch_prefix>ns-issue-$N-<short-slug> origin/<base_branch>
   ```
   Never off a protected branch. Never reuse another agent's branch.
4. **Map the work.** List every file you expect to touch. Grep for existing helpers
   you can extend. Reuse over reinvent. If you would create a third near-duplicate of
   something, stop and consolidate first.
5. **Implement.** Match the surrounding code's patterns. Introduce no new patterns.
   If the diff is going to exceed `caps.max_files_per_pr`, stop and propose a split
   in a comment instead.
6. **Write tests** for the changed surface: happy path, the empty case, the bad-input
   case, at least one error path. If the repo has a coverage threshold, respect it.
7. **Self-check** — run `verify.build`, `verify.test`, `verify.lint` from the config.
   Format **only the files you changed**. Never a repo-wide formatter.
8. **Commit.** Conventional message tied to the issue: `feat(scope): summary (#N)`.
   One logical commit. Never `--amend` after pushing. Never `--no-verify`.
9. **Push & open a DRAFT PR** against `base_branch`:
   ```bash
   git push -u origin <branch>
   gh pr create --base <base_branch> --draft --title "<type>(<scope>): <summary> (#N)" --body "..."
   ```
   Body must contain: `Closes #N`; one line what / one line why; tradeoffs considered
   (even "none — straightforward"); the exact verify commands you ran **and their
   result**; anything you could NOT run and why; `## Debt named` with a tracking issue
   for anything deferred.
10. **Verify the PR exists** with `gh pr view` before you report done.

## Refusal triggers — stop, comment `🛑 Refused: <reason>`, exit

- The change requires disabling a quality gate or skipping a test you can't make pass honestly.
- The scope expanded beyond the issue (open a follow-up issue; don't silently widen).
- The change needs a force-push or history rewrite on a shared branch.
- You catch yourself adding `any` / `@ts-ignore` / `eslint-disable` "to get it building".
- The diff touches anything in `exclusions.paths` — that work is for a human.

## Output

The PR URL, files touched, and the verify results. Nothing else.
