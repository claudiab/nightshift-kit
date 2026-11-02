---
name: ns-review
description: Three-lens review (correctness, architecture, security) plus a judge, on the current branch's diff vs the base branch. Read-only — no push, no PR, no merge. Use locally before asking a human to merge; /ns-merge-gate runs the same lenses overnight.
allowed-tools: Read, Glob, Grep, Bash(git diff*), Bash(git log*), Bash(git fetch*), Bash(git rev-parse*), Bash(git status*), Bash(mkdir*), Bash(gh pr*), Write(.agents/reviews/**), Agent
---

# /ns-review [pr-number] — three lenses + judge

Three independent reviewers read the same diff through three lenses. A judge
synthesizes one verdict. Reviewers never see each other's reports. The judge never
re-reviews the diff — it weighs and rules.

## Preconditions

1. Read `nightshift.config.json`.
2. Current branch starts with `branch_prefix` (or a PR number was given). Agents do
   not review human commits directly without being asked.
3. `origin/<base_branch>` is reachable and the diff against it is non-empty. No diff →
   say so and stop. Never fabricate a verdict on nothing.

## Steps

### 0. Scope

```bash
git fetch origin <base_branch>
git diff --stat origin/<base_branch>...HEAD
git diff --name-only origin/<base_branch>...HEAD | wc -l
```

If file count > `caps.max_files_per_pr`: print the "smallest reversible step" reminder
and ask whether to proceed. Wait for an explicit yes.

### 1. Stage the diff

```bash
mkdir -p .agents/reviews
git diff origin/<base_branch>...HEAD > .agents/reviews/<branch>.diff
```

(`.agents/` is gitignored. Install adds it.)

### 2. Three reviewers, in parallel — one message, three `Agent` calls

Each prompt: name the skill file to load first, hand over the diff path, specify the
output path, and instruct the subagent to return **only the path it wrote**.

- Correctness → `.claude/skills/ns-lens-correctness.md` → `.agents/reviews/<branch>.correctness.md`
- Architecture → `.claude/skills/ns-lens-architecture.md` → `.agents/reviews/<branch>.architecture.md`
- Security → `.claude/skills/ns-lens-security.md` → `.agents/reviews/<branch>.security.md`

Any reviewer fails or returns no file → surface it and stop. **Do not run the judge on
incomplete signal.**

### 3. Judge

One `Agent`: load `.claude/skills/ns-judge.md`, adjudicate the three reports, write
`.agents/reviews/<branch>.judge.md`. Hard input it cannot override: a `BLOCK` from the
security lens → overall `REQUEST CHANGES`, full stop.

### 4. Print

- The `## Verdict:` line
- The one-line rationale
- The report paths
- Count of must-fix items

Then stop. Do not push, do not open a PR, do not merge. A human reads the judge
report and decides.

## Model note

Reviewers are fan-out workers — use your cheaper tier. The judge is a judgment call
others will trust — use your stronger tier. Route by tier alias, never by a hardcoded
model ID; IDs go stale every generation.
