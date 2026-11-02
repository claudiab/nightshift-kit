# Night Shift — runbook

> **Default state: recommend-only.** No code is written and nothing is merged until
> you create two flag files, one at a time, after reading several nights of digests.
> Every gate below exists because a review panel found a way the naive version breaks.
> See `why-this-shape.md`.

Two composing jobs, both targeting your **base branch** only. A protected branch
(`main`) is never touched.

| Job | When | What it does | Default |
|---|---|---|---|
| **B — `/ns-fanout`** | ~01:07 | Pick `ready-for-agent` issues → **unanimous** Product+UX+Eng build-gate → build in isolated worktrees → open draft PRs | recommend-only (verdicts, no code) |
| **A — `/ns-merge-gate`** | ~03:07 | Review open PRs → mechanical gate + 3 lenses + judge → **merge if all gates pass** | recommend-only (verdicts, no merge) |
| **Morning — `/ns-reconcile`** | when you wake up | Verify what actually landed, from GitHub state only | always safe |

Job B's PRs flow into Job A the next night. Every overnight change clears the
**build-gate** (before code exists) *and* the **merge-gate** (before it lands).

```
            ready-for-agent issues
                     │
          ┌──────────▼──────────┐
          │  BUILD-GATE (Job B) │  3 judges, unanimous, default BLOCK
          │  Product · UX · Eng │
          └──────────┬──────────┘
          blocked ◄──┤──► greenlit (≤ K, disjoint scopes)
     ready-for-human │
                     ▼
            worktree per issue ──► implement + tests ──► draft PR
                                                           │
                                               ┌───────────▼───────────┐
                                               │  MERGE-GATE (Job A)   │
                                               │  mechanical (no LLM)  │
                                               │  → 3 lenses → judge   │
                                               └───────────┬───────────┘
                                                hold ◄─────┤─────► merge (if armed)
                                           needs-work      │
                                                           ▼
                                                   morning digest issue
```

## The two gates

### Gate 1 — BUILD (`/ns-fanout`)

An issue is built only if **all three judges greenlight**:

- **Product** — valuable now, and not a product/positioning decision in disguise.
- **UX** — mechanically buildable: mockup or existing screen pinned; every referenced
  component grep-confirmed to exist; all copy spelled out; no "pick one."
- **Engineering** — single module, testable, every named dependency already on the base
  branch, nothing matching the exclusions.

Any block → comment which judge + why, label `ready-for-human`. Greenlit issues (cap
**K** per night, disjoint scopes) get a worktree off `origin/<base>` and one
implementer agent each: implement + tests + self-run build/test + local commit. The
orchestrator pushes and opens the draft PR, then **verifies it exists via `gh`**.

### Gate 2 — MERGE (`/ns-merge-gate`)

For each open non-draft PR against the base:

1. **Skip-unchanged** — a `<!-- nightshift:gate sha=… -->` marker matching the head
   means it was already reviewed at this commit. Token guard.
2. **Mechanical pre-checks** — computed from `gh`/`git`, **un-overridable by any
   model**: hard-exclusion path+content scan · every status check green (iterated,
   never a fixed list) · `mergeStateStatus == CLEAN` · optional UI lint.
3. **Self-run build/test** on the PR head. CI can be absent, misconfigured, or a job
   that always passes. Your run is the evidence.
4. **Review** — correctness, architecture, security lenses in parallel; a judge
   adjudicates with every mechanical result as a sticky input. Security BLOCK = veto.
5. **Merge or hold** — shippable *and* `ops/nightshift.merge-enabled` present → re-poll
   state once more, squash-merge, run the **post-merge integrity check** (merged diff
   must equal reviewed diff), tear down the worktree. Otherwise post the verdict,
   label `nightshift:needs-work`, leave open.

## Hard exclusions

`nightshift.config.json → exclusions`. Matched on **path OR content**, because path
globs leak: a dropped ownership filter, or a secret read from a file that isn't
named `auth`, evades a path regex. The defaults are a floor. **Add your own.** The bot
must never be able to modify its own provisioner, merge logic, exclusion list, caps,
or kill-switch — those paths are excluded by default.

**Test-only carve-out:** if *every* changed file matches `test_file_globs`, the diff
skips the path globs (adding coverage is safe). The content scan still runs.

## Caps

- Job A: `merges_per_night` (default 3), `reviews_per_night` (default 6).
- Job B: `issues_per_night` (default 2). Start lower.
- **Anti-bar-lowering floor:** if the build-gate pass rate drops under
  `min_build_gate_pass_rate`, or two nights produce zero greenlights, Job B
  **freezes** and asks for human review of the filter. It does not loosen the gate to
  hit K.
- **Disjoint scopes:** the K issues for one night must not overlap, so concurrent
  agents never edit the same files.
- Job B runs strictly **before** Job A so they never collide.

## Kill-switch & circuit breakers

Two independent stop signals — either halts **both** jobs:

1. file `ops/nightshift.paused` present (`touch ops/nightshift.paused`)
2. any open issue labeled `nightshift:pause`

Checked as the **first action** of both jobs and **re-checked** between issues and
immediately before every merge. If the required label set is missing at job start the
job **hard-aborts** — a missing label would make the pause query return empty, which
reads as "not paused."

Circuit breakers (halt all further merges tonight): any `gh` failure or `UNKNOWN`
merge state at the re-poll · post-merge diff ≠ reviewed diff · caps reached.

### Enable flags (separate from pause)

Both **absent by default**:

- `ops/nightshift.build-enabled` — Job B writes code and opens PRs. Absent → verdicts only.
- `ops/nightshift.merge-enabled` — Job A merges. Absent → verdict comments only.

Arm `build-enabled` first. PRs still pass Job A's gate before landing. Watch a few
nights of digests. Then, and only then, arm `merge-enabled`.

**Flags and the pause file are tracked files.** A scheduled job runs in a fresh
checkout of the base branch, so a flag only takes effect once it is committed and
pushed there. `touch` + commit + push to arm; `git rm` + push to disarm. (The
pause *label* works instantly — that's why there are two stop signals.)

## Scheduling

Must be a **server-side** schedule that runs while your laptop is closed — a hosted
scheduled task, a CI cron workflow, or a cron on a box that stays up. A local
"loop" that only fires while your editor is open is not a nightly job.

Two routines, non-overlapping. Prompt for each is one line:

- **Job B** — `7 1 * * *` → `Run /ns-fanout. First action: check the kill-switch.`
- **Job A** — `7 3 * * *` → `Run /ns-merge-gate. First action: check the kill-switch.`
- **Babysit** (optional) — `*/30 8-17 * * 1-5` → `Run /ns-babysit.`

## Morning digest

Each run opens or updates `Night Shift digest — <date>`: reviewed / merged / built /
skipped / blocked with per-item reasons, plus orphan worktrees. Then run
`/ns-reconcile` — it ignores the digest and checks GitHub. **Read both before
flipping any flag.**

## Revert runbook — a bad autonomous merge landed

1. `gh pr list --base <base> --state merged --limit 5` — find the merge commit.
2. `git checkout <base> && git pull && git revert -m 1 <merge-sha>` → push a revert PR.
   Never force-push the base.
3. If your base branch auto-deploys to staging, a 3 a.m. merge auto-deployed. Decide
   up front whether that blast radius is acceptable (see Decisions below).
4. `touch ops/nightshift.paused` while you investigate.

## Go-live checklist

1. Resolve the decisions below.
2. `scripts/setup-labels.sh` — creates + asserts labels and `ops/`.
3. Dry-run **recommend-only** for several nights. Read the digests. Calibrate the gate
   against how you'd have voted on the real PRs.
4. Lower caps for week 1 (Job A: 1 merge/night).
5. `touch ops/nightshift.build-enabled` → Job B starts opening PRs.
6. After a few clean nights: `touch ops/nightshift.merge-enabled`.
7. Wire the schedules.

## Decisions you must make before activating

1. **Auto-merge vs recommend-only** — recommend-only for at least a week. Set the
   date and criteria for arming.
2. **Caps** — confirm exact numbers. Start lower than you think.
3. **Schedule times + timezone.**
4. **What is off-limits** — pricing, SEO, public copy, legal text, anything
   irreversible-if-shipped. Put it in `exclusions`.
5. **Deploy-on-merge** — does your base branch auto-deploy? Gate it, or accept
   staging-only blast radius plus the revert runbook.
6. **Is the backlog ready?** If most `ready-for-agent` issues are dependency-blocked
   or under-specified, the gate will (correctly) block almost everything. Fix the
   backlog before blaming the gate.
