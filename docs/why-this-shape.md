# Why this shape

The first version of this was simple: *review open PRs with three AI reviewers; if
they approve, merge.* A four-judge review panel (Product, UX, Engineering, Security)
scored it 3–4 out of 10 and **unanimously voted BLOCK** — while agreeing the
architecture was salvageable.

They found six defects. Each one was verified live, and each one maps to a gate in
the kit. If you remove a gate, know which defect you are re-opening.

## 1. The reviewers weren't callable from the scheduler

The review lenses existed only as interactive slash commands. The scheduled job could
read skill files but could not invoke `/commands`. The "three reviewers" in the design
were never going to run.

→ Every lens is a **skill file** an agent can read, not a command that needs a human
session. (`.claude/skills/ns-lens-*.md`, `ns-judge.md`)

## 2. CI green proved nothing

Free private-repo plan → branch protection returned 403, there were no required
checks, no PR-time build or test, and one CI job (`claude-review`) **always reported
success**. "CI is green" was true for every PR, including broken ones.

→ The merge gate **self-runs build and test** on the PR head and iterates every
status check by name. A job that always passes is explicitly not read as approval.
(`/ns-merge-gate` step 3)

## 3. The merge command was ungoverned

`gh pr merge` was in no allow / ask / deny list. Any agent could run it against any
PR, including one accidentally based on `main`. (That later happened, once, and
started a production deploy.)

→ Merge runs **only** as a fail-closed orchestrator step gated on an explicit flag
file, after a final state re-poll. A PreToolUse hook verifies the base branch of any
merge — via shell or GitHub API — and blocks protected targets, failing closed when
it cannot verify. (`guard-protected-branch.mjs`, `settings.example.json`)

## 4. Path-glob exclusions leak

The exclusion list was path globs. A dropped tenant filter in a query, or a payment
client called from a file not named `payment`, sails through a path regex. Proven by a
real PR that was CLEAN + green + mergeable while touching the database schema and a
migration.

→ Exclusions match **path OR content**. The content list is grepped in the diff body
on every PR. (`nightshift.config.json → exclusions.content`)

## 5. The kill-switch was a silent no-op

The pause label didn't exist. `gh issue list --label nightshift:pause` on a
non-existent label returns empty — which the job read as "not paused." The emergency
stop would have done nothing.

→ `setup-labels.sh` **creates and asserts** every label. A missing label at job start
is a **hard abort**, not a silent skip. (`/ns-fanout` and `/ns-merge-gate` step 1)

## 6. "Ready for agent" was far too permissive

Sampled: roughly one in eight `ready-for-agent` issues was actually buildable with
zero human input. The rest were dependency-blocked, embedded schema or auth work, or
needed a taste decision. Neither gate rendered the UI. Owner-locked surfaces
(pricing, public copy) had no exclusion at all.

→ The build-gate became **three judges, unanimous, default BLOCK**: a dependency-
readiness check (every "depends on" must already be on the base branch), a body-content
scan for excluded keywords and pending-decision phrases, a four-point mechanical UX
buildability check, and an exclusion for irreversible-if-shipped surfaces. Plus the
**anti-bar-lowering floor**: if almost nothing passes, freeze and ask a human to look
at the filter — never loosen the gate to hit the nightly quota. (`/ns-fanout` step 3)

## And one more, from production: agents lie about delivery

Not maliciously. On one night, six cloud agents each reported "complete." **Zero**
had pushed a branch. The sandboxes were ephemeral; the work was gone.

→ `/ns-reconcile` reads **only** GitHub state — branch exists, PR exists, diff is
non-empty, breadcrumb comment posted — and never an agent's own summary. The cloud
lane preamble mandates **breadcrumb → deliver → then sweep**, so a hung test suite
can't cost the whole change. (`/ns-reconcile`, `ns-cloud-lane.md`)

---

The pattern across all seven: **the LLM is never the only thing standing between a
mistake and production.** Every "the model will be careful" was replaced with a
mechanical check the model cannot override, a flag a human must create, or a piece of
evidence read from the repo instead of from the agent.
