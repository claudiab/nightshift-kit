#!/usr/bin/env bash
# install.sh — copy the Night Shift kit into a target repo.
#
#   ./install.sh /path/to/your/repo
#
# Copies commands, skills, hooks, scripts and the config template. Never overwrites a
# file that already exists in the target (prints SKIP instead). Then tells you the
# three things you still have to do by hand.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
[[ -n "$TARGET" && -d "$TARGET" ]] || { echo "usage: ./install.sh /path/to/repo" >&2; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"
git -C "$TARGET" rev-parse --show-toplevel >/dev/null 2>&1 || { echo "$TARGET is not a git repo" >&2; exit 1; }

copy() {  # copy <relative path>
  local rel="$1"
  if [[ -e "${TARGET}/${rel}" ]]; then
    echo "  SKIP   ${rel} (exists)"
  else
    mkdir -p "$(dirname "${TARGET}/${rel}")"
    cp -R "${KIT}/${rel}" "${TARGET}/${rel}"
    echo "  copied ${rel}"
  fi
}

echo "Installing Night Shift kit → ${TARGET}"
copy nightshift.config.json
for f in "${KIT}"/.claude/commands/ns-*.md; do copy ".claude/commands/$(basename "$f")"; done
for f in "${KIT}"/.claude/skills/ns-*.md;   do copy ".claude/skills/$(basename "$f")"; done
copy .claude/hooks/guard-protected-branch.mjs
copy .claude/settings.example.json
copy scripts/setup-labels.sh
copy scripts/worktree.sh
copy docs/nightshift-runbook.md
mkdir -p "${TARGET}/ops"; [[ -f "${TARGET}/ops/.gitkeep" ]] || touch "${TARGET}/ops/.gitkeep"
chmod +x "${TARGET}/scripts/setup-labels.sh" "${TARGET}/scripts/worktree.sh" 2>/dev/null || true

cat <<EOF

Done. Three things only you can do:

  1. Edit ${TARGET}/nightshift.config.json
       → repo, base_branch, verify commands, and ADD YOUR OWN exclusions.
  2. Merge .claude/settings.example.json into .claude/settings.json
       → the deny list + the protected-branch hook. Without this, nothing stops a push to main.
  3. Run:  cd ${TARGET} && scripts/setup-labels.sh

Then read docs/nightshift-runbook.md. It starts in recommend-only mode. Keep it there
for a week.
EOF
