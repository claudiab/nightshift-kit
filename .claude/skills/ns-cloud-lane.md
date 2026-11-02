---
name: ns-cloud-lane
description: Preamble for an agent running in a remote/sandboxed session with no human, no .env, and possibly no `git push`. Setup order, what the sandbox can't do, breadcrumb-then-deliver discipline, and the definition of done. Hand this to any lane you dispatch to the cloud.
---

# Cloud lane preamble

You are a sandboxed coding agent. You have **zero prior context, no `.env`, and no way
to ask a human anything mid-run.** Everything you need is in this file, the repo's
`CLAUDE.md`, and your task prompt. Follow this file exactly, in order.

## 1. Setup — STEP 0, before reading anything else

```bash
git fetch origin <base_branch>
git checkout -B <branch_prefix><lane-branch> origin/<base_branch>
```

Do this **before** you read `CLAUDE.md` or the rest of this file. Sandboxes boot on a
stale, frozen commit; the instructions you need may not exist on that commit. Use
`checkout -B`, not `-b` — if the sandbox's starting branch already has your name,
`-b` errors and the lane stalls before it starts.

Then read `nightshift.config.json` and `CLAUDE.md`.

**Read versions from the lockfile / `package.json`, never from prose.** Docs drift.
Anything you assume about which APIs exist, based on a version you remember, will be
wrong.

## 2. Environment bootstrap — only if you need to build or test

No `.env` exists. Typical sequence (adjust to the repo):

```bash
cp .env.example .env            # the example has the right shape and no real secrets
npm install                      # if a binary download fails (proxy-blocked host), set
                                 # that package's skip-download env var and move on
```

Skip this entirely for read-only or docs work — it takes minutes.

## 3. What this environment probably cannot do

Assume egress is **GitHub-only** until proven otherwise. Consequences:

| Blocked | Meaning for you |
|---|---|
| Live app URLs | No browser QA, no live verification. Don't try. |
| Binary downloads (e2e browsers, native deps) | Those suites cannot run here. |
| Cloud provider APIs | Prep the config, don't apply it. |
| External APIs | No live third-party calls. |

There is usually no local database.

**Never fake a result.** If you cannot execute something, say so in the PR body:
`NOT EXECUTED: <suite> — <host> is unreachable in this sandbox; run <exact command>
locally to verify.` Reasoning from code you read is legitimate evidence — quote the
lines. Claiming a green suite you never ran is not.

## 4. Verify what you can

Run `verify.build` and `verify.test` from the config. Format **only the files you
changed**. Format is a gate, not a courtesy — paste the check result in your PR body.

## 5. Breadcrumb → deliver → sweep. This order is not optional.

Your sandbox is not persisted. Undelivered work is gone if the session dies. So:

1. **Breadcrumb first** — post an issue comment with: branch, files, root cause, the
   change (enough detail, including key code, that a human could re-implement from
   this comment alone), and what you did / did not verify.
2. **Deliver** (§6).
3. **Only then** run any long test sweep, and post a short follow-up with the result.

Run tests in the foreground, one project at a time, low parallelism. Never background
a build — a backgrounded process outlives your ability to see its result.
**Never schedule a reminder or wake-up for yourself.** A lane runs once, delivers, stops.

## 6. Deliver

Commit locally first (`git add -A && git commit`). Then, in order of preference:

- **`git push -u origin <branch>` + `gh pr create --draft --base <base_branch>`** — if
  the sandbox allows it. Try once. If it prompts for permission nobody can answer,
  it will kill the session — so if your harness is known to block push, skip to the next path.
- **GitHub API tools** (`push_files` / `create_pull_request` style) — only when every
  changed file is small (< 8 KB) and nothing was deleted or renamed. These tools
  re-emit file contents through the model; large files get corrupted. Verified.
- **Diff-comment delivery** — post `git diff origin/<base_branch>..HEAD` as fenced
  ` ```diff ` issue comments, each ≤ 60 KB, headed `DIFF k/n <branch> <sha>`, plus a
  `NEW FILES:` / `DELETED FILES:` list and a final `PR-BODY` comment. A human or the
  reconcile step applies it. Byte-exact — never retype.

Never write under `.claude/` or `.git/` in the sandbox — it trips the same fatal
permission prompt. Scratch goes in `/tmp/`.

If delivery fails entirely, post the exact per-attempt error in a final comment so a
human can recover the branch. This is survivable only because you did §5 first.

## 7. PR requirements

- Base is always `base_branch`. Pass it explicitly every time. Never a protected branch.
- Draft by default. Ready only if you executed real verification.
- Body states: what changed, what you ran + results, what you could not run + why,
  tests added by name.

## 8. House rules

- **No `git stash`** — shared across worktrees; concurrent sessions pop each other's.
  Use a WIP commit.
- **No repo-wide formatters.**
- **Stop and report** rather than proceed on: schema changes needing data migration,
  auth changes, anything involving a real secret.

## 9. Definition of done

1. Breadcrumb comment on the issue.
2. A branch and a PR number exist on GitHub (or a diff-comment series a human can apply).
3. PR against `base_branch`, body states what was and wasn't verified.
4. A final issue comment linking the PR.

If you got partway, say exactly how far. **A truthful partial result is useful. A
confident false one costs more than doing nothing.**
