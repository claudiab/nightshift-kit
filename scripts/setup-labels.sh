#!/usr/bin/env bash
# setup-labels.sh — one-time, idempotent setup for Night Shift.
#
# Creates + verifies the labels the kill-switch and routing depend on, creates the
# tracked ops/ dir, and asserts the capability flags are ABSENT (recommend-only).
#
# A missing label is a HARD FAILURE. Without it, the pause switch is a silent no-op:
# `gh issue list --label nightshift:pause` on a label that doesn't exist returns
# empty, which reads as "not paused". That exact bug was found in design review.
#
# Usage:  scripts/setup-labels.sh            (reads repo + label names from nightshift.config.json)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required (to read nightshift.config.json)" >&2; exit 1; }
[ -f nightshift.config.json ] || { echo "nightshift.config.json not found at repo root" >&2; exit 1; }

cfg() { node -e "const c=require('./nightshift.config.json'); const v=$1; if(v==null){process.exit(3)}; console.log(v)"; }

REPO="$(cfg 'c.repo')"
if [ "$REPO" = "OWNER/REPO" ]; then
  echo "Edit nightshift.config.json → \"repo\" before running setup." >&2
  exit 1
fi

L_PAUSE="$(cfg 'c.labels.pause')"
L_HOLD="$(cfg 'c.labels.hold')"
L_BLOCKED="$(cfg 'c.labels.blocked')"
L_NEEDS_WORK="$(cfg 'c.labels.needs_work')"
L_DNM="$(cfg 'c.labels.do_not_merge')"
L_NEEDS_INFO="$(cfg 'c.labels.needs_info')"
L_READY_AGENT="$(cfg 'c.labels.ready_for_agent')"
L_READY_HUMAN="$(cfg 'c.labels.ready_for_human')"

echo "Night Shift setup → repo ${REPO}, root ${ROOT}"

# name|color|description  (color = hex without '#')
labels=(
  "${L_PAUSE}|B60205|Emergency stop — halts BOTH Night Shift jobs while any issue carries this label"
  "${L_HOLD}|D93F0B|Do not let Night Shift merge this PR"
  "${L_BLOCKED}|E99695|Night Shift could not process (conflict / failing checks / ambiguous state)"
  "${L_NEEDS_WORK}|FBCA04|Night Shift held this PR — see the verdict comment"
  "${L_DNM}|000000|Never auto-merge this PR"
  "${L_NEEDS_INFO}|D4C5F9|Blocked on missing information — not autonomous-ready"
  "${L_READY_AGENT}|0E8A16|An agent may pick this up"
  "${L_READY_HUMAN}|5319E7|Night Shift routed this to a human — see the comment"
)

echo "── Ensuring labels exist ──"
for entry in "${labels[@]}"; do
  IFS='|' read -r name color desc <<< "$entry"
  if gh label create "$name" --color "$color" --description "$desc" --repo "$REPO" 2>/dev/null; then
    echo "  created  $name"
  else
    gh label edit "$name" --color "$color" --description "$desc" --repo "$REPO" >/dev/null
    echo "  exists   $name"
  fi
done

echo "── Asserting required labels ──"
required=("$L_PAUSE" "$L_HOLD" "$L_BLOCKED" "$L_NEEDS_WORK" "$L_DNM" "$L_NEEDS_INFO")
existing="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
missing=()
for r in "${required[@]}"; do
  grep -qxF "$r" <<< "$existing" || missing+=("$r")
done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "FATAL: required labels missing after setup: ${missing[*]}" >&2
  echo "The kill-switch would be a silent no-op. Aborting." >&2
  exit 1
fi
echo "  ✓ all ${#required[@]} required labels present"

echo "── Ensuring tracked ops/ dir ──"
mkdir -p ops
[ -f ops/.gitkeep ] || { touch ops/.gitkeep; echo "  created ops/.gitkeep"; }

echo "── Ensuring .agents/ is gitignored ──"
if ! grep -qxF '.agents/' .gitignore 2>/dev/null; then
  echo '.agents/' >> .gitignore
  echo "  added .agents/ to .gitignore"
fi
if ! grep -qxF '.claude/worktrees/' .gitignore 2>/dev/null; then
  echo '.claude/worktrees/' >> .gitignore
  echo "  added .claude/worktrees/ to .gitignore"
fi

echo "── Capability flags (recommend-only by default) ──"
for flag in ops/nightshift.build-enabled ops/nightshift.merge-enabled; do
  if [ -f "$flag" ]; then
    echo "  ⚠ $flag is PRESENT — that capability is ARMED. Remove it to return to recommend-only."
  else
    echo "  ✓ $flag absent (capability disabled)"
  fi
done
if [ -f ops/nightshift.paused ]; then
  echo "  ⚠ ops/nightshift.paused is PRESENT — both jobs are PAUSED."
else
  echo "  ✓ ops/nightshift.paused absent (not paused)"
fi

echo
echo "Setup complete. Recommend-only until you 'touch ops/nightshift.build-enabled' and,"
echo "later, 'touch ops/nightshift.merge-enabled'. See docs/runbook.md → Go-live."
