export const meta = {
  name: 'nightly-backlog-fanout',
  description:
    'Night Shift Job B. Select ready-for-agent issues with genuinely no human action needed, run a UNANIMOUS build-gate (Product + UX + Engineering judges, all three must greenlight), then for up to K disjoint-scope issues build the work in a per-issue worktree off origin/<base> (implementer agent: implement + tests + self-run build/test + local commit, never push). PURE COMPUTE in recommend-only mode (no flag) — it only returns greenlight/block verdicts; it writes code ONLY when ops/nightshift.build-enabled exists. The orchestrator pushes + opens PRs, which Job A gates the next night. See docs/nightshift-runbook.md.',
  phases: [
    { title: 'Preflight', detail: 'kill-switch + label assertion + candidate issue selection' },
    { title: 'Build-gate', detail: 'unanimous Product + UX + Engineering panel per candidate' },
    { title: 'Implement', detail: 'serial worktree-isolated implementer for K disjoint greenlit issues (build-enabled only)' },
  ],
}

// Constants are inlined: the workflow runtime has no filesystem access, so keep these
// in sync with nightshift.config.json by hand. `MAIN` resolves the checkout root at
// runtime so the same script works locally and in a fresh remote checkout.
const MAIN = '"$(git rev-parse --show-toplevel)"'
const REPO_SLUG = 'OWNER/REPO'
const BASE = 'development'
const BRANCH_PREFIX = 'claude/'
const VERIFY_BUILD = 'npm run build'
const VERIFY_TEST = 'npm test'
const K_DEFAULT = 2 // issues built per night; start low
const K = (args && Number(args.k)) || K_DEFAULT
const SKIP_IF_ANY_LABEL = ['ready-for-human', 'needs-info', 'question', 'blocked', 'epic']

// Hard-exclusion keywords scanned in the issue BODY (route to ready-for-human).
const BODY_EXCLUDE_KEYWORDS = [
  'migration', 'schema', 'auth', 'permission', 'payment', 'billing', 'secret', 'env var', 'pricing',
]
// Pending-decision phrases => not autonomous-ready.
const PENDING_PHRASES = [
  'pick one', 'tbd', 'to be decided', 'pending decision', 'needs discussion', 'open question',
]

const HOUSE_RULES =
  'Follow the repo CLAUDE.md exactly. Match surrounding code; introduce no new patterns. ' +
  'Touch ONLY files inside your assigned worktree path. Never push. Never edit .claude/**, ops/**, or nightshift.config.json.'

const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['paused', 'labelsOk', 'buildEnabled', 'candidates'],
  properties: {
    paused: { type: 'boolean' },
    pausedReason: { type: 'string' },
    labelsOk: { type: 'boolean', description: 'true only if all required labels exist (nightshift:pause/hold/blocked/needs-work, do-not-merge, needs-info)' },
    missingLabels: { type: 'array', items: { type: 'string' } },
    buildEnabled: { type: 'boolean', description: 'true if ops/nightshift.build-enabled exists' },
    candidates: {
      type: 'array',
      description: 'open issues labeled ready-for-agent AND none of SKIP_IF_ANY_LABEL',
      items: {
        type: 'object',
        required: ['number', 'title', 'labels', 'bodyExcerpt'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', description: 'the scope:* label if present, else the top-level directory the issue names (for disjoint-scope selection)' },
          bodyExcerpt: { type: 'string', description: 'first ~1200 chars of the issue body, verbatim' },
        },
      },
    },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['greenlight', 'reason'],
  properties: {
    greenlight: { type: 'boolean' },
    reason: { type: 'string', description: 'one-line: why greenlit, or precisely what blocks it' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'cited file:line / mockup ref / component existence checks' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['ok', 'committed', 'filesChanged', 'selfTestPass', 'branch', 'worktree', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    selfTestPass: { type: 'boolean', description: 'true only if VERIFY_BUILD and VERIFY_TEST actually ran green' },
    summary: { type: 'string' },
    blockers: { type: 'string' },
  },
}

// ── Budget guard ──────────────────────────────────────────────────────────────
if (budget.total && budget.remaining() < 60_000) {
  log(`Budget too low (${Math.round(budget.remaining() / 1000)}k) — aborting Job B.`)
  return { aborted: 'insufficient-budget' }
}

// ── Phase 1: Preflight ────────────────────────────────────────────────────────
phase('Preflight')
const preflight = await agent(
  [
    `Night Shift Job B preflight. Repo ${REPO_SLUG}; run gh from ${MAIN}. READ ONLY — no comments/labels/edits.`,
    `1. KILL-SWITCH: paused=true if file ops/nightshift.paused exists OR \`gh issue list --label nightshift:pause --state open\` is non-empty.`,
    `2. LABELS: labelsOk=true only if all exist (\`gh label list --limit 200\`): nightshift:pause, nightshift:hold, nightshift:blocked, nightshift:needs-work, do-not-merge, needs-info.`,
    `3. BUILD FLAG: cd ${MAIN} first, then run \`test -f ops/nightshift.build-enabled && echo PRESENT || echo ABSENT\`. Set buildEnabled=true ONLY if it prints PRESENT. Also run \`git rev-parse --short HEAD\` and \`ls -1 ops/\` and state both in your output so the resolved checkout is verifiable.`,
    `4. CANDIDATES: \`gh issue list --label ready-for-agent --state open --limit 40 --json number,title,labels,body\`. KEEP only issues that have NONE of {${SKIP_IF_ANY_LABEL.join(', ')}}. For each kept issue return number, title, all label names, its scope (scope:* label or top-level directory named), and bodyExcerpt (first ~1200 chars verbatim).`,
    `Return the structured object. Be honest about gh failures.`,
  ].join('\n'),
  { label: 'preflight', phase: 'Preflight', schema: PREFLIGHT_SCHEMA },
)

if (!preflight) return { aborted: 'preflight-failed' }
if (preflight.paused) { log(`PAUSED: ${preflight.pausedReason}`); return { paused: true, reason: preflight.pausedReason } }
if (!preflight.labelsOk) { log(`HARD-ABORT: missing labels ${(preflight.missingLabels || []).join(', ')}`); return { aborted: 'missing-labels', missingLabels: preflight.missingLabels } }

// Mechanical body pre-filter (before spending judge tokens): drop issues whose body
// hits a hard-exclusion keyword or a pending-decision phrase.
const lc = s => (s || '').toLowerCase()
const prefiltered = (preflight.candidates || []).filter(c => {
  const body = lc(c.bodyExcerpt)
  const kw = BODY_EXCLUDE_KEYWORDS.find(k => body.includes(k))
  const ph = PENDING_PHRASES.find(p => body.includes(p))
  if (kw) { log(`#${c.number} pre-excluded: body keyword "${kw}"`); return false }
  if (ph) { log(`#${c.number} pre-excluded: pending phrase "${ph}"`); return false }
  return true
})
log(`Job B: ${(preflight.candidates || []).length} candidates → ${prefiltered.length} after body pre-filter. buildEnabled=${preflight.buildEnabled}, K=${K}`)

// ── Phase 2: Unanimous build-gate (Product + UX + Engineering) ─────────────────
phase('Build-gate')
const gatePrompt = (issue, role, focus) => [
  `You are the ${role} judge on the Night Shift BUILD panel. Decide if issue #${issue.number} ("${issue.title}") can be built overnight by an agent with ZERO human input. Default to BLOCK on any doubt.`,
  `Repo ${REPO_SLUG}, work from ${MAIN}. Read the full issue: \`gh issue view ${issue.number}\`. Verify claims against the actual code (grep/read); do NOT trust the body.`,
  `Issue labels: ${issue.labels.join(', ')}.`,
  ``,
  focus,
  ``,
  `Return greenlight=true ONLY if your dimension is fully satisfied with cited evidence.`,
].join('\n')

const gated = await pipeline(
  prefiltered,
  issue => parallel([
    () => agent(gatePrompt(issue, 'Product',
      'Greenlight only if: valuable NOW (not internal polish), and NOT a product/positioning/pricing decision disguised as a task.'),
      { label: `gate-product:#${issue.number}`, phase: 'Build-gate', schema: JUDGE_SCHEMA, model: 'sonnet' }),
    () => agent(gatePrompt(issue, 'UX (mechanical buildability)',
      'Greenlight only if ALL four hold with cited evidence: (a) any UI change pins a mockup or an existing screen to match; (b) every component it references already EXISTS (grep-confirm each); (c) ALL user-facing copy/labels/strings are spelled out in the issue (no agent-invented text); (d) no open taste / "pick one" decision.'),
      { label: `gate-ux:#${issue.number}`, phase: 'Build-gate', schema: JUDGE_SCHEMA, model: 'sonnet' }),
    () => agent(gatePrompt(issue, 'Engineering',
      `Greenlight only if: well-scoped to a SINGLE module, testable, DEPENDENCY-READY (every helper / sibling issue / endpoint the body names already exists on origin/${BASE} — verify by grep/gh; any "depends on"/"built separately"/"sibling issue" pointing at an OPEN item is a BLOCK), and the body contains NO schema/auth/payment/secret work.`),
      { label: `gate-eng:#${issue.number}`, phase: 'Build-gate', schema: JUDGE_SCHEMA, model: 'sonnet' }),
  ]).then(([product, ux, eng]) => {
    const votes = { product, ux, eng }
    const unanimous = !!(product && ux && eng && product.greenlight && ux.greenlight && eng.greenlight)
    return { issue, votes, unanimous }
  }),
)

const greenlit = gated.filter(Boolean).filter(g => g.unanimous)
const blocked = gated.filter(Boolean).filter(g => !g.unanimous).map(g => ({
  number: g.issue.number, title: g.issue.title,
  blockedBy: ['product', 'ux', 'eng'].filter(k => !(g.votes[k] && g.votes[k].greenlight)),
  reasons: ['product', 'ux', 'eng'].filter(k => g.votes[k] && !g.votes[k].greenlight).map(k => `${k}: ${g.votes[k].reason}`),
}))
for (const b of blocked) log(`#${b.number} BLOCKED by ${b.blockedBy.join('+')} — ${b.reasons.join(' | ')}`)

// Anti-bar-lowering floor: if almost nothing is buildable, freeze rather than loosen.
const passRate = prefiltered.length ? greenlit.length / prefiltered.length : 0
if (prefiltered.length >= 6 && passRate < 1 / 6) {
  log(`Build-gate pass rate ${(passRate * 100).toFixed(0)}% < ~1-in-6 — FREEZING fan-out; the filter needs human review.`)
  return { job: 'nightly-backlog-fanout', frozen: 'pass-rate-floor', greenlit: greenlit.map(g => g.issue.number), blocked }
}

// Select up to K greenlit issues touching DISJOINT scopes (no two share a scope:* label).
const selected = []
const usedScopes = new Set()
for (const g of greenlit) {
  const scope = g.issue.scope || (g.issue.labels.find(l => l.startsWith('scope:')) || '')
  if (usedScopes.has(scope)) continue
  usedScopes.add(scope)
  selected.push(g)
  if (selected.length >= K) break
}
log(`Greenlit ${greenlit.length}; selected ${selected.length} disjoint for build (K=${K}).`)

// ── Phase 3: Implement (ONLY when build-enabled; SERIAL so worktree creation never races) ─
phase('Implement')
const built = []
if (!preflight.buildEnabled) {
  log('RECOMMEND-ONLY (no ops/nightshift.build-enabled) — posting panel verdicts, writing NO code.')
} else {
  for (const g of selected) {
    const issue = g.issue
    const branch = `${BRANCH_PREFIX}ns-issue-${issue.number}`
    const worktree = `${MAIN}/.claude/worktrees/ns-issue-${issue.number}`
    const impl = await agent(
      [
        `Implement issue #${issue.number} ("${issue.title}") fully autonomously, in an ISOLATED worktree you create.`,
        `Setup (run from ${MAIN}; do these EXACTLY, branching off origin/${BASE}, NOT current HEAD):`,
        `  git -C ${MAIN} fetch origin ${BASE}`,
        `  git -C ${MAIN} worktree add -b ${branch} ${worktree} origin/${BASE}`,
        `  cp ${MAIN}/.env.example ${worktree}/.env 2>/dev/null || true`,
        `Work EXCLUSIVELY inside ${worktree}. The branch is ${branch}.`,
        ``,
        `Read the issue: \`gh issue view ${issue.number}\`. Implement it + the tests the repo requires.`,
        HOUSE_RULES,
        ``,
        `Then, in the worktree:`,
                `1. \`${VERIFY_BUILD}\` then \`${VERIFY_TEST}\` and iterate until green. selfTestPass MUST reflect the real run.`,
        `2. Format ONLY changed files. Never a repo-wide formatter.`,
        `3. Commit in the worktree (do NOT push — the orchestrator pushes) with a conventional message referencing #${issue.number}.`,
        `Return the structured result including branch and worktree.`,
      ].join('\n'),
      { label: `impl:#${issue.number}`, phase: 'Implement', schema: IMPL_SCHEMA, model: 'sonnet' },
    )
    built.push({ issue: issue.number, branch, worktree, impl })
    log(`#${issue.number}: committed=${impl ? impl.committed : false} selfTest=${impl ? impl.selfTestPass : false}`)
  }
}

return {
  job: 'nightly-backlog-fanout',
  buildEnabled: preflight.buildEnabled,
  mode: preflight.buildEnabled ? 'build' : 'recommend-only',
  K,
  greenlit: greenlit.map(g => ({ number: g.issue.number, title: g.issue.title })),
  selected: selected.map(g => g.issue.number),
  blocked,
  built: built.map(b => ({ issue: b.issue, branch: b.branch, worktree: b.worktree, committed: b.impl ? b.impl.committed : false, selfTestPass: b.impl ? b.impl.selfTestPass : false, filesChanged: b.impl ? b.impl.filesChanged : [] })),
  orchestratorActions: [
    'For every BLOCKED issue: comment which judge blocked it + why, and add label ready-for-human.',
    'If buildEnabled is FALSE: stop (recommend-only) — optionally comment the greenlight verdict on selected issues. Write/push NO code.',
    'If buildEnabled is TRUE: for each built issue whose impl.committed && selfTestPass, push the branch (git push -u origin <branch>) and open a DRAFT PR (gh pr create --draft --base <BASE> --head <branch> --body "Closes #<n>"). PR is verified via gh pr list --head, never agent self-report. These flow into Job A (nightly-merge-gate) the next night.',
    'Reconcile orphan worktrees (any .claude/worktrees/ns-issue-* with no open PR) and open/update the morning digest.',
  ],
}
