export const meta = {
  name: 'nightly-merge-gate',
  description:
    'Night Shift Job A. For each open NON-DRAFT PR targeting the base branch: skip-unchanged via a head-OID marker, run the mechanical gate (hard-exclusion path+content scan + optional UI lint + mergeStateStatus/statusCheckRollup re-poll + self-run build/test), then the review lenses (correctness/architecture/security) and a judge, and compute the shippable rollup. PURE COMPUTE — it never merges, pushes, or comments; it RETURNS verdicts for the scheduled orchestrator, which posts comments and (only when ops/nightshift.merge-enabled exists) performs the merge. See docs/nightshift-runbook.md.',
  phases: [
    { title: 'Preflight', detail: 'kill-switch + label assertion + candidate PR discovery' },
    { title: 'Mechanical', detail: 'hard-exclusion scan + optional UI lint + re-poll + self-run build/test' },
    { title: 'Review', detail: 'correctness + architecture + security lenses, then judge, per changed PR' },
  ],
}

// ── Constants are inlined: the workflow runtime has no filesystem access, so keep
// these in sync with nightshift.config.json by hand. `MAIN` resolves the checkout root
// at runtime so the same script works locally and in a fresh remote checkout.
const MAIN = '"$(git rev-parse --show-toplevel)"'
const REPO_SLUG = 'OWNER/REPO'
const BASE = 'development'
const VERIFY_BUILD = 'npm run build'
const VERIFY_TEST = 'npm test'
const MAX_TRIO_RUNS = 6 // trio-run cap; merge cap (<=3) is enforced by the orchestrator

const EXCLUDE_PATHS = [
  '.github/workflows/**', '.env*', '**/migrations/**', '**/schema.prisma',
  '**/*auth*/**', '**/*permission*', '**/*guard*', '**/*payment*/**', '**/*billing*/**', '**/*webhook*',
  'Dockerfile*', 'docker-compose*', 'infra/**',
  'scripts/worktree.sh', '.claude/**', 'ops/nightshift.*', 'nightshift.config.json',
]
const EXCLUDE_CONTENT = [
  'process.env.', 'SECRET', 'API_KEY', 'PRIVATE_KEY', 'idempotency', 'webhook signature',
]
// Optional deterministic checks on changed stylesheet/markup files. Empty = skipped.
const UI_LINT = []
const TEST_ONLY_GLOBS = ['**/*.spec.*', '**/*.test.*', '**/__tests__/**']

// ── Schemas ─────────────────────────────────────────────────────────────────
const PREFLIGHT_SCHEMA = {
  type: 'object',
  required: ['paused', 'labelsOk', 'mergeEnabled', 'candidates'],
  properties: {
    paused: { type: 'boolean', description: 'true if ops/nightshift.paused exists OR an open issue is labeled nightshift:pause' },
    pausedReason: { type: 'string' },
    labelsOk: { type: 'boolean', description: 'true only if ALL required labels exist: nightshift:pause, nightshift:hold, nightshift:blocked, nightshift:needs-work, do-not-merge, needs-info (names from nightshift.config.json)' },
    missingLabels: { type: 'array', items: { type: 'string' } },
    mergeEnabled: { type: 'boolean', description: 'true if the file ops/nightshift.merge-enabled exists in the repo' },
    candidates: {
      type: 'array',
      description: 'open NON-DRAFT PRs with base=BASE',
      items: {
        type: 'object',
        required: ['number', 'title', 'headOid', 'mergeable', 'mergeStateStatus', 'allChecksGreen', 'labels', 'markerSha'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          headOid: { type: 'string', description: 'current head commit OID' },
          mergeable: { type: 'string', description: 'MERGEABLE / CONFLICTING / UNKNOWN' },
          mergeStateStatus: { type: 'string', description: 'CLEAN / BEHIND / BLOCKED / DIRTY / UNSTABLE / DRAFT / HAS_HOOKS / UNKNOWN' },
          allChecksGreen: { type: 'boolean', description: 'true only if EVERY statusCheckRollup entry is SUCCESS/NEUTRAL/SKIPPED (none pending/failing); iterate the FULL rollup' },
          checkSummary: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
          touchesUi: { type: 'boolean', description: 'true if the diff changes any stylesheet/markup/UI file (only consulted when UI_LINT is non-empty)' },
          markerSha: { type: 'string', description: 'sha from the existing <!-- nightshift:trio sha=... --> comment, or empty' },
        },
      },
    },
  },
}

const MECHANICAL_SCHEMA = {
  type: 'object',
  required: ['mechanicalPass', 'exclusionHit', 'uiLintPass', 'mergeStateStatus', 'buildTest'],
  properties: {
    mechanicalPass: { type: 'boolean', description: 'true ONLY if: no exclusion hit AND uiLintPass AND mergeStateStatus==CLEAN AND every check green AND buildTest!=fail' },
    testOnly: { type: 'boolean', description: 'true if EVERY changed file matches TEST_ONLY_GLOBS — such a diff is exempt from the PATH globs (test coverage is safe) but the CONTENT scan still applies' },
    exclusionHit: { type: 'boolean' },
    exclusionDetails: { type: 'array', items: { type: 'string' }, description: 'each: the path glob or content pattern matched + file:line' },
    uiLintPass: { type: 'boolean' },
    uiLintDetails: { type: 'array', items: { type: 'string' } },
    mergeStateStatus: { type: 'string', description: 're-polled fresh; treat UNKNOWN as not-ready' },
    buildTest: { type: 'string', enum: ['pass', 'fail', 'skip'], description: 'result of VERIFY_BUILD then VERIFY_TEST on the PR head' },
    buildTestFailures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const LENS_SCHEMA = {
  type: 'object',
  required: ['severity', 'findings'],
  properties: {
    severity: { type: 'string', enum: ['none', 'nit', 'should-fix', 'blocker'] },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const SEC_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'NEEDS-FIX'] },
    findings: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'mustFix', 'rationale'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'APPROVE_WITH_NITS', 'REQUEST_CHANGES'] },
    mustFix: { type: 'array', items: { type: 'string' } },
    nits: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}

// ── Budget guard ──────────────────────────────────────────────────────────────
if (budget.total && budget.remaining() < 60_000) {
  log(`Budget too low (${Math.round(budget.remaining() / 1000)}k) — aborting Job A.`)
  return { aborted: 'insufficient-budget' }
}

// ── Phase 1: Preflight ────────────────────────────────────────────────────────
phase('Preflight')
const preflight = await agent(
  [
    `Night Shift Job A preflight. Repo ${REPO_SLUG}; run gh/git from ${MAIN} (cd into it). READ ONLY — do not comment, label, push, or merge anything.`,
    `1. KILL-SWITCH: report paused=true if the file ops/nightshift.paused exists OR \`gh issue list --label nightshift:pause --state open\` returns any issue. Put the reason in pausedReason.`,
    `2. LABELS: \`gh label list --limit 200\`. labelsOk=true ONLY if ALL of these exist: nightshift:pause, nightshift:hold, nightshift:blocked, nightshift:needs-work, do-not-merge, needs-info. List any missing in missingLabels.`,
    `3. MERGE FLAG: cd ${MAIN} first, then run \`test -f ops/nightshift.merge-enabled && echo PRESENT || echo ABSENT\`. Set mergeEnabled=true ONLY if it prints PRESENT. Also run \`git rev-parse --short HEAD\` and \`ls -1 ops/\` and state both in your output so the resolved checkout is verifiable.`,
    `4. CANDIDATES: \`gh pr list --base ${BASE} --state open --limit 40 --json number,title,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,labels\`. Drop drafts. For each remaining PR:`,
    `   - headOid = headRefOid; mergeable; mergeStateStatus.`,
    `   - allChecksGreen: iterate EVERY statusCheckRollup entry — true only if each is SUCCESS/NEUTRAL/SKIPPED and none is PENDING/QUEUED/IN_PROGRESS/FAILURE/CANCELLED/TIMED_OUT/ACTION_REQUIRED. Never assume a fixed check list. Put a one-line checkSummary.`,
    `   - touchesUi: does \`gh pr diff <n> --name-only\` include any stylesheet/markup/UI file?`,
    `   - markerSha: \`gh pr view <n> --json comments\` — find the latest comment containing "<!-- nightshift:trio sha=" and extract its sha (else empty).`,
    `Return the structured object exactly. Do not fabricate; if a gh call fails, reflect that honestly (e.g. mergeStateStatus="UNKNOWN").`,
  ].join('\n'),
  { label: 'preflight', phase: 'Preflight', schema: PREFLIGHT_SCHEMA },
)

if (!preflight) return { aborted: 'preflight-failed' }
if (preflight.paused) { log(`PAUSED: ${preflight.pausedReason}`); return { paused: true, reason: preflight.pausedReason } }
if (!preflight.labelsOk) { log(`HARD-ABORT: missing labels ${(preflight.missingLabels || []).join(', ')} — run setup-nightshift.sh`); return { aborted: 'missing-labels', missingLabels: preflight.missingLabels } }

const BLOCKING_LABELS = ['ready-for-human', 'do-not-merge', 'nightshift:hold']
const all = preflight.candidates || []
// Skip-unchanged (marker == head) and blocking-label PRs never reach the trio.
const reviewable = all.filter(c => c.markerSha !== c.headOid && !c.labels.some(l => BLOCKING_LABELS.includes(l)))
const trioBatch = reviewable.slice(0, MAX_TRIO_RUNS) // trio-run cap
log(`Job A: ${all.length} PR(s); ${reviewable.length} changed & unblocked; running trio on ${trioBatch.length} (cap ${MAX_TRIO_RUNS}). mergeEnabled=${preflight.mergeEnabled}`)

// ── Phases 2+3: Mechanical → Review, pipelined per PR ──────────────────────────
phase('Mechanical')
const results = await pipeline(
  trioBatch,

  // Stage: mechanical gate
  pr => agent(
    [
      `Night Shift Job A MECHANICAL gate for PR #${pr.number} ("${pr.title}"). Repo ${REPO_SLUG}, run from ${MAIN}. READ ONLY.`,
      `The diff: \`gh pr diff ${pr.number}\` and file list \`gh pr diff ${pr.number} --name-only\`.`,
      ``,
      `(0) TEST-ONLY CARVE-OUT — from \`gh pr diff ${pr.number} --name-only\`, set testOnly=true IFF EVERY changed file matches one of: ${TEST_ONLY_GLOBS.join(', ')}. A test-only diff adds coverage and is exempt from the PATH globs in (1) — but the CONTENT scan and UI lint below STILL apply. If any non-test file changed, testOnly=false and (1) applies in full.`,
      `(1) HARD-EXCLUSION — match the diff against PATH globs (SKIP the PATH globs when testOnly=true) AND CONTENT patterns (ALWAYS); ANY match => exclusionHit=true (un-overridable). Cite file:line.`,
      `PATHS (skipped when testOnly):\n - ${EXCLUDE_PATHS.join('\n - ')}`,
      `CONTENT (always — grep the diff body, paths leak):\n - ${EXCLUDE_CONTENT.join('\n - ')}`,
      ``,
      `(2) UI LINT — ${UI_LINT.length ? `scan changed stylesheet/markup files for ANY of these; any hit => uiLintPass=false:\n - ${UI_LINT.join('\n - ')}` : 'no patterns configured; uiLintPass=true.'}`,
      ``,
      `(4) RE-POLL mergeStateStatus fresh: \`gh pr view ${pr.number} --json mergeStateStatus,mergeable\`. Treat UNKNOWN as not-ready.`,
      ``,
      `(5) SELF-RUN BUILD/TEST (CI may be absent or lie): fetch PR #${pr.number}'s head (${pr.headOid}) into a scratch worktree under ${MAIN}/.claude/worktrees/gate-${pr.number} and run \`${VERIFY_BUILD}\` then \`${VERIFY_TEST}\` there. If you cannot safely run them, set buildTest="skip" and say so in summary (do NOT fake a pass).`,
      ``,
      `mechanicalPass=true ONLY if: exclusionHit==false AND uiLintPass AND mergeStateStatus=="CLEAN" AND buildTest!="fail". Return the structured object.`,
    ].join('\n'),
    { label: `mech:#${pr.number}`, phase: 'Mechanical', schema: MECHANICAL_SCHEMA, model: 'sonnet' },
  ).then(mech => ({ pr, mech })),

  // Stage: review lenses + security lenses + judge
  async prev => {
    if (!prev || !prev.mech) return { ...(prev || {}), shippable: false, reason: 'mechanical-failed' }
    const { pr, mech } = prev
    if (!mech.mechanicalPass) {
      return { pr, mech, shippable: false, reason: mech.exclusionHit ? 'hard-exclusion' : (!mech.uiLintPass ? 'ui-lint' : (mech.mergeStateStatus !== 'CLEAN' ? 'not-clean' : 'build-test')) }
    }
    const diffCmd = `gh pr diff ${pr.number}`
    const lensPrompt = (skill, extra) => [
      `Review lens for PR #${pr.number}. Read \`.claude/skills/${skill}\` and follow its contract. Diff: \`${diffCmd}\` (run from ${MAIN}; read changed files for context). ${extra}`,
    ].join('\n')

    const [correctness, architecture, security] = await parallel([
      () => agent(lensPrompt('ns-lens-correctness.md', 'Flag missed cases, wrong/absent null handling, tests that do not assert the changed behavior, regressions.'), { label: `lens-correctness:#${pr.number}`, phase: 'Review', schema: LENS_SCHEMA, model: 'sonnet' }),
      () => agent(lensPrompt('ns-lens-architecture.md', 'Flag layer violations, boundary breaches, duplication, and convention deviations named in CLAUDE.md.'), { label: `lens-arch:#${pr.number}`, phase: 'Review', schema: LENS_SCHEMA, model: 'sonnet' }),
      () => agent(lensPrompt('ns-lens-security.md', 'Trust boundaries, authz, secrets, data exposure, supply chain. A BLOCK here is a hard veto. Fires UNCONDITIONALLY.'), { label: `lens-security:#${pr.number}`, phase: 'Review', schema: SEC_SCHEMA }),
    ])

    const lenses = [correctness, architecture].filter(Boolean)
    const secVerdict = security ? security.verdict : 'NEEDS-FIX'

    const judge = await agent(
      [
        `You are the judge for PR #${pr.number} ("${pr.title}"). Read \`.claude/skills/ns-judge.md\` and synthesize ONE verdict.`,
        `STICKY, UN-OVERRIDABLE INPUTS (if any is failing, the verdict is REQUEST_CHANGES):`,
        `  mechanicalPass=${mech.mechanicalPass}; mergeStateStatus=${mech.mergeStateStatus}; buildTest=${mech.buildTest}; exclusionHit=${mech.exclusionHit}; uiLintPass=${mech.uiLintPass};`,
        `  security=${secVerdict} (a NEEDS-FIX from the security lens is a hard veto).`,
        `Lens reports: ${JSON.stringify(lenses)}`,
        `APPROVE only if all sticky inputs pass and no should-fix/blocker survives. mustFix non-empty ONLY for REQUEST_CHANGES.`,
      ].join('\n'),
      { label: `judge:#${pr.number}`, phase: 'Review', schema: VERDICT_SCHEMA },
    )

    const shippable = !!(mech.mechanicalPass && judge && judge.verdict !== 'REQUEST_CHANGES' && secVerdict === 'PASS' && !mech.exclusionHit)
    return { pr, mech, security: secVerdict, verdict: judge ? judge.verdict : 'REQUEST_CHANGES', mustFix: judge ? judge.mustFix : ['no judge'], rationale: judge ? judge.rationale : '', shippable, reason: shippable ? 'shippable' : 'verdict-or-security' }
  },
)

// Skipped PRs (unchanged or blocked) reported for the digest, never merged.
const skipped = all
  .filter(c => !trioBatch.some(t => t.number === c.number))
  .map(c => ({ number: c.number, title: c.title, reason: c.markerSha === c.headOid ? 'skip-unchanged' : (c.labels.some(l => BLOCKING_LABELS.includes(l)) ? 'blocking-label' : 'over-trio-cap') }))

const reviewed = results.filter(Boolean).map(r => ({
  number: r.pr.number, title: r.pr.title, headOid: r.pr.headOid,
  shippable: !!r.shippable, verdict: r.verdict || null, reason: r.reason,
  security: r.security || null,
  mechanical: r.mech ? { pass: r.mech.mechanicalPass, exclusionHit: r.mech.exclusionHit, buildTest: r.mech.buildTest, mergeStateStatus: r.mech.mergeStateStatus, exclusionDetails: r.mech.exclusionDetails || [] } : null,
  mustFix: r.mustFix || [],
  // Marker the orchestrator should post; merge instruction below.
  marker: `<!-- nightshift:trio sha=${r.pr.headOid} verdict=${r.verdict || 'NONE'} shippable=${!!r.shippable} -->`,
}))

for (const r of reviewed) log(`#${r.number}: ${r.shippable ? 'SHIPPABLE' : 'HOLD'} (${r.reason}) verdict=${r.verdict} security=${r.security}`)

return {
  job: 'nightly-merge-gate',
  mergeEnabled: preflight.mergeEnabled,
  mode: preflight.mergeEnabled ? 'auto-merge' : 'recommend-only',
  caps: { maxTrioRuns: MAX_TRIO_RUNS, maxMergesOrchestratorEnforced: 3 },
  reviewed,
  skipped,
  shippableBranches: reviewed.filter(r => r.shippable).map(r => r.number),
  // Orchestrator (scheduled session) instructions:
  orchestratorActions: [
    'For every reviewed PR: post/replace the advisory verdict comment INCLUDING its `marker` line; if not shippable, add label nightshift:needs-work.',
    'If mergeEnabled is FALSE: stop here (recommend-only). Do NOT merge.',
    'If mergeEnabled is TRUE: for up to 3 shippable PRs, RE-POLL mergeStateStatus (gh pr view --json mergeStateStatus); only if still CLEAN run `gh pr merge <n> --squash --delete-branch`; then verify the merged diff equals the reviewed diff (post-merge integrity) and tear down any mapped worktree via scripts/worktree.sh rm. Halt all merges on the first UNKNOWN/ambiguous state. Never merge a PR whose base is a protected branch.',
    'Open/update the morning digest issue with reviewed/skipped/merged + token spend.',
  ],
}
