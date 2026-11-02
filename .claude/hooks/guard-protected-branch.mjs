#!/usr/bin/env node
// PreToolUse guard: agents may write to agent branches and the base branch, but
// never to a protected branch (main/master by default). `git push` to main is
// already denied in settings.json; this closes the other routes — GitHub MCP
// tools (merge_pull_request, push_files, create_or_update_file, update_pull_request
// base change) and `gh pr merge` from the shell.
//
// Why it exists: a PR silently based on main was once merged via `gh pr merge` and
// started a production deploy. Branch protection wasn't available on that plan.
// This hook was the only technical gate.
//
// Exit 2 = block (stderr is shown to the agent). Fails CLOSED when the base branch
// of a merge cannot be verified.
//
// Wire it in .claude/settings.json → hooks.PreToolUse (see settings.example.json).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let PROTECTED = new Set(['main', 'master']);
try {
  if (existsSync('nightshift.config.json')) {
    const cfg = JSON.parse(readFileSync('nightshift.config.json', 'utf8'));
    if (Array.isArray(cfg.protected_branches) && cfg.protected_branches.length) {
      PROTECTED = new Set(cfg.protected_branches);
    }
  }
} catch {
  /* fall back to the default set */
}

function block(msg) {
  process.stderr.write(`guard-protected-branch: ${msg} Writes to protected branches are human-only.\n`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  block('could not parse hook input; refusing.');
}

const tool = String(payload.tool_name ?? '');
const input = payload.tool_input ?? {};
const isProtected = (ref) => PROTECTED.has(String(ref ?? '').replace(/^refs\/heads\//, ''));

if (/__(push_files|create_or_update_file)$/.test(tool)) {
  if (isProtected(input.branch)) block(`${tool} targets branch "${input.branch}".`);
} else if (/__update_pull_request$/.test(tool)) {
  if (isProtected(input.base)) block(`${tool} would retarget PR #${input.pullNumber} to "${input.base}".`);
} else if (/__merge_pull_request$/.test(tool)) {
  const { owner, repo, pullNumber } = input;
  if (!owner || !repo || !pullNumber) block('merge_pull_request input missing owner/repo/pullNumber; cannot verify base.');
  let base = '';
  try {
    base = execFileSync('gh', ['api', `repos/${owner}/${repo}/pulls/${pullNumber}`, '--jq', '.base.ref'], {
      encoding: 'utf8',
      timeout: 15000,
    }).trim();
  } catch {
    block(`could not verify base branch of PR #${pullNumber} (gh api failed); refusing to merge.`);
  }
  if (!base || isProtected(base)) block(`PR #${pullNumber} targets "${base || 'unknown'}".`);
} else if (tool === 'Bash') {
  const cmd = String(input.command ?? '');
  // Only at the start of a command segment, so a commit message that merely
  // mentions the phrase doesn't trigger a lookup.
  const m = cmd.match(/(?:^|[;&|(\n])\s*gh\s+pr\s+merge\b([^;&|\n)]*)/);
  if (m) {
    const arg = m[1].split(/\s+/).find((a) => a && !a.startsWith('-'));
    let base = '';
    try {
      base = execFileSync('gh', ['pr', 'view', ...(arg ? [arg] : []), '--json', 'baseRefName', '-q', '.baseRefName'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: payload.cwd || process.cwd(),
      }).trim();
    } catch {
      block(`could not verify base branch for "gh pr merge${m[1]}"; refusing.`);
    }
    if (!base || isProtected(base)) block(`"gh pr merge${m[1]}" targets "${base || 'unknown'}".`);
  }
}

process.exit(0);
