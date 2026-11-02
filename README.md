# Night Shift

**Point Claude Code at your GitHub backlog. Wake up to reviewed PRs — not surprises.**

A drop-in kit for running coding agents on a backlog overnight, with every "the model
will be careful" replaced by a gate the model can't override. Two jobs, two flags, one
kill-switch, and a morning step that trusts the repo instead of the agent.

```
 ready-for-agent issues
          │
   ┌──────▼──────┐   3 judges · unanimous · default BLOCK
   │  BUILD-GATE │   "can an agent build this with zero human input?"
   └──────┬──────┘
   blocked│greenlit (≤ K per night, non-overlapping scopes)
          ▼
   one worktree per issue → implement + tests → draft PR
          │
   ┌──────▼──────┐   mechanical checks no LLM can override
   │  MERGE-GATE │   → 3 review lenses → judge
   └──────┬──────┘
     hold │ shippable → merge  (only if you armed it)
          ▼
   morning digest  +  /ns-reconcile  (reads GitHub, never the agent's story)
```

Both jobs start in **recommend-only** mode. They post verdicts and write nothing until
you `touch` a flag file — build first, merge later, each after reading real digests.

## What's in the box

| | File | Does |
|---|---|---|
| **config** | `nightshift.config.json` | The one file you edit: base branch, verify commands, caps, labels, **exclusions** |
| **commands** | `/ns-fanout` | Job B — issues → build-gate → worktree → draft PR |
| | `/ns-merge-gate` | Job A — PRs → mechanical gate → lenses → judge → merge-or-hold |
| | `/ns-reconcile` | Morning — DELIVERED / PARTIAL / STRANDED / DEAD, from GitHub state only |
| | `/ns-implement` | One issue → one PR, in a worktree, refuses to guess |
| | `/ns-review` | Three lenses + judge on your current branch, read-only |
| | `/ns-babysit` | 30-min CI sweep: fixes the boring reds, escalates the rest |
| **skills** | `ns-bar.md` | The operating bar every agent loads first |
| | `ns-lens-{correctness,architecture,security}.md` | The three reviewers. Security BLOCK = veto |
| | `ns-judge.md` | Sole-finding test, sticky blocks, verdict table |
| | `ns-cloud-lane.md` | Preamble for sandboxed agents: breadcrumb → deliver → then sweep |
| **guards** | `hooks/guard-protected-branch.mjs` | Blocks merges/pushes to `main` via shell *and* GitHub API. Fails closed |
| | `settings.example.json` | Deny list: no push to main, no force, no `--no-verify` |
| **scripts** | `setup-labels.sh` | Creates + **asserts** the labels the kill-switch depends on |
| | `worktree.sh` | `new` / `rm` / `ls` / `gc --prune` — one agent, one checkout |
| **docs** | `docs/nightshift-runbook.md` | Gates, caps, kill-switch, go-live checklist, revert runbook |
| | `docs/why-this-shape.md` | The six defects a review panel found in the naive version |

## Install

```bash
git clone https://github.com/YOUR-USER/nightshift-kit
./nightshift-kit/install.sh /path/to/your/repo
```

Then, by hand — the script will remind you:

1. Edit `nightshift.config.json` → `repo`, `base_branch`, your `verify` commands, and
   **add your own exclusions** (the defaults are a floor).
2. Merge `.claude/settings.example.json` into your `.claude/settings.json`. Without
   this, nothing technically stops a push to `main`.
3. `scripts/setup-labels.sh`

Requires: Claude Code, `gh` CLI (authenticated), Node 18+, a repo with a base branch
that isn't `main`.

## Run

Label a few issues `ready-for-agent`. Then:

```
/ns-fanout          # tonight's build-gate verdicts (no code written yet)
/ns-merge-gate      # tonight's PR verdicts (nothing merged yet)
```

Read the digest issue it opens. Do that for a week. When the verdicts match how
you'd have voted:

```bash
touch ops/nightshift.build-enabled    # Job B starts opening draft PRs
# ...a few more nights of digests...
touch ops/nightshift.merge-enabled    # Job A starts merging shippable PRs
```

Schedule both as **server-side** jobs (hosted scheduled task, CI cron, a box that
stays up) — `7 1 * * *` and `7 3 * * *`. A local loop that only runs while your
editor is open is not a nightly job.

Panic button: `touch ops/nightshift.paused` or open an issue labeled `nightshift:pause`.
Either one stops both jobs, and is re-checked before every merge.

## What you'll find in the morning

- **A digest issue** — `Night Shift digest — <date>`: what was reviewed, built,
  merged, held, skipped, and why, per item.
- **Draft PRs** from Job B, each `Closes #N`, each with a body that says what was
  verified and what wasn't.
- **Verdict comments** on every reviewed PR with a `<!-- nightshift:gate sha=… -->`
  marker so the same head is never reviewed twice.
- **Labels** — `ready-for-human` on issues a judge blocked (with the reason),
  `nightshift:needs-work` on held PRs.
- Then run `/ns-reconcile`. It ignores all of the above and checks what's actually
  on GitHub.

## Honest limits

- **Auto-merge is the least-tested part.** In the repo this was extracted from, the
  cloud fan-out and reconcile steps ran for months across dozens of lanes; the merge
  gate ran in recommend-only mode. The gates are designed from real failures, but
  "armed and merging unattended" is a step *you* take with *your* digests in hand.
- **The build-gate blocks most issues.** On purpose. Sampled: roughly one in eight
  `ready-for-agent` issues was actually buildable with zero human input. If the gate
  freezes on pass rate, fix the backlog — don't loosen the gate.
- **Exclusions are only as good as your list.** The defaults cover auth, payments,
  migrations, secrets, CI, and the kit's own files. Your irreversible-if-shipped
  surfaces (pricing, public copy, SEO) are yours to add.
- **No branch protection?** Then `settings.example.json` + the hook are your only
  technical gate against a push to `main`. Install them.
- **Agents report success they didn't achieve.** Six out of six, one night, zero
  branches pushed. `/ns-reconcile` exists because of that. Run it every morning.
- The `reference/workflows/` scripts need a specific workflow runtime. The slash
  commands don't. Use the commands unless you know you have the runtime.

## Why it looks like this

The naive version — "three AI reviewers approve, merge" — was reviewed by a four-judge
panel and unanimously blocked. Six verified defects. Every gate in this kit maps to one.
[`docs/why-this-shape.md`](docs/why-this-shape.md).

## License

MIT.
