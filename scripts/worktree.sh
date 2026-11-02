#!/usr/bin/env bash
# worktree.sh — isolated worktree per agent. One agent, one branch, one checkout.
#
# Usage:
#   scripts/worktree.sh new <name>     # branch <prefix><name> off origin/<base> + worktree + install
#   scripts/worktree.sh rm  <name>     # remove worktree + delete branch (refuses if ahead of base)
#   scripts/worktree.sh ls             # list worktrees
#   scripts/worktree.sh gc [--prune]   # sweep ALL worktrees; report stale ones.
#                                      #   default = dry run (report only)
#                                      #   --prune = remove only the provably-safe ones
#                                      #            (clean + 0 commits ahead of origin/<base>)
#
# Reads base_branch and branch_prefix from nightshift.config.json. Hook your own
# per-worktree setup (DB, ports, env) into the `post_new` function below.
set -euo pipefail

CMD="${1:-}"
NAME="${2:-}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(git rev-parse --git-common-dir)"
MAIN_ROOT="$(cd "$(dirname "$COMMON_DIR")" && pwd)"
WORKTREE_DIR="${MAIN_ROOT}/.claude/worktrees"

cfg() { node -e "const c=require('${MAIN_ROOT}/nightshift.config.json'); console.log($1 ?? '')" 2>/dev/null || echo ""; }
BASE="$(cfg 'c.base_branch')";      BASE="${BASE:-development}"
PREFIX="$(cfg 'c.branch_prefix')";  PREFIX="${PREFIX:-claude/}"

usage() { sed -n '2,11p' "$0"; exit 1; }

# ── Customize: runs inside a freshly created worktree ─────────────────────────
post_new() {
  local path="$1"
  if [[ -f "${path}/package.json" ]]; then
    echo "→ npm install"
    (cd "$path" && npm install --no-audit --no-fund --silent)
  fi
  # Add your own: copy .env.example, create a per-worktree DB, assign ports, etc.
}

cmd_new() {
  [[ -n "$NAME" ]] || usage
  local branch="${PREFIX}${NAME}"
  local path="${WORKTREE_DIR}/${NAME}"
  mkdir -p "$WORKTREE_DIR"
  git -C "$MAIN_ROOT" fetch origin "$BASE" --quiet
  echo "→ Creating worktree at $path on branch $branch (off origin/${BASE})"
  git -C "$MAIN_ROOT" worktree add -b "$branch" "$path" "origin/${BASE}"
  post_new "$path"
  echo "✓ ready: cd $path"
}

cmd_rm() {
  [[ -n "$NAME" ]] || usage
  local branch="${PREFIX}${NAME}"
  local path="${WORKTREE_DIR}/${NAME}"
  if [[ -d "$path" ]]; then
    if [[ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]]; then
      echo "✗ $path has uncommitted changes — commit or discard them first." >&2; exit 1
    fi
    git -C "$MAIN_ROOT" worktree remove "$path"
    echo "✓ removed worktree $path"
  fi
  if git -C "$MAIN_ROOT" rev-parse --verify "$branch" >/dev/null 2>&1; then
    local ahead; ahead="$(git -C "$MAIN_ROOT" rev-list --count "origin/${BASE}..${branch}" 2>/dev/null || echo '?')"
    if [[ "$ahead" == "0" ]]; then
      git -C "$MAIN_ROOT" branch -d "$branch" && echo "✓ deleted branch $branch"
    else
      echo "  branch $branch is ${ahead} commit(s) ahead of origin/${BASE} — left in place (delete manually if merged)."
    fi
  fi
}

cmd_ls() { git -C "$MAIN_ROOT" worktree list; }

# Sweep EVERY git worktree, classify each as safe-to-remove vs needs-review, and —
# only with --prune — remove the provably-safe ones. "Safe" = clean working tree AND
# zero commits ahead of origin/<base>, i.e. it holds no work you could lose.
cmd_gc() {
  local do_prune=0
  [[ "${NAME:-}" == "--prune" ]] && do_prune=1

  git -C "$MAIN_ROOT" fetch origin "$BASE" --quiet 2>/dev/null || \
    echo "  (warning: could not fetch origin/${BASE}; using local ref)" >&2
  local base; base="$(git -C "$MAIN_ROOT" rev-parse --verify "origin/${BASE}" 2>/dev/null || echo '')"
  [[ -n "$base" ]] || { echo "✗ no origin/${BASE} ref to compare against" >&2; exit 1; }

  git -C "$MAIN_ROOT" worktree prune

  local self; self="$(pwd -P)"
  local main_top; main_top="$(git -C "$MAIN_ROOT" rev-parse --show-toplevel)"
  local safe=() review=()
  local path="" head="" branch="" locked=0

  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "HEAD "*)     head="${line#HEAD }" ;;
      "branch "*)   branch="${line#branch refs/heads/}" ;;
      "detached")   branch="(detached)" ;;
      "locked"*)    locked=1 ;;
      "")
        if [[ -n "${path:-}" ]]; then
          if [[ "$locked" -eq 1 ]]; then
            review+=("LOCKED|${path}|${branch:-(detached)}|locked — skipped")
          else
            _gc_classify "$path" "${head:-}" "${branch:-(detached)}"
          fi
        fi
        path=""; head=""; branch=""; locked=0 ;;
    esac
  done < <(git -C "$MAIN_ROOT" worktree list --porcelain; echo)

  echo
  printf "  %-55s %-22s %s\n" "WORKTREE" "BRANCH" "STATUS"
  printf "  %-55s %-22s %s\n" "--------" "------" "------"
  local rec
  for rec in "${review[@]+"${review[@]}"}"; do _gc_print "$rec"; done
  for rec in "${safe[@]+"${safe[@]}"}";     do _gc_print "$rec"; done
  echo
  echo "  safe to remove: ${#safe[@]}    needs review: ${#review[@]}"

  if [[ "$do_prune" -eq 1 ]]; then
    echo "→ Removing ${#safe[@]} provably-safe worktree(s)…"
    for rec in "${safe[@]+"${safe[@]}"}"; do
      local rpath rbranch
      rpath="$(echo "$rec" | cut -d'|' -f2)"
      rbranch="$(echo "$rec" | cut -d'|' -f3)"
      if git -C "$MAIN_ROOT" worktree remove "$rpath" 2>/dev/null; then
        echo "  ✓ removed $rpath"
        if [[ "$rbranch" != "(detached)" ]] && git -C "$MAIN_ROOT" rev-parse --verify "$rbranch" >/dev/null 2>&1; then
          git -C "$MAIN_ROOT" branch -d "$rbranch" 2>/dev/null && echo "    ✓ deleted branch $rbranch"
        fi
      else
        echo "  ✗ could not remove $rpath (left in place)"
      fi
    done
  else
    echo "  Dry run. Re-run with --prune to remove the ${#safe[@]} safe one(s); the ${#review[@]} review item(s) stay."
  fi
}

_gc_classify() {
  local p="$1" h="$2" b="$3"
  local top; top="$(cd "$p" 2>/dev/null && pwd -P || echo "$p")"
  if [[ "$top" == "$main_top" || "$top" == "$self" ]]; then
    review+=("ACTIVE|${p}|${b}|current/main — skipped"); return
  fi
  if [[ ! -d "$p" ]]; then review+=("GONE|${p}|${b}|dir missing (pruned)"); return; fi
  if [[ -n "$(git -C "$p" status --porcelain 2>/dev/null)" ]]; then
    review+=("DIRTY|${p}|${b}|uncommitted changes"); return
  fi
  local ahead; ahead="$(git -C "$MAIN_ROOT" rev-list --count "${base}..${h}" 2>/dev/null || echo '?')"
  if [[ "$ahead" == "0" ]]; then
    safe+=("SAFE|${p}|${b}|clean, 0 ahead of ${BASE}")
  else
    review+=("AHEAD|${p}|${b}|${ahead} commit(s) ahead — unmerged/squash-merged?")
  fi
}

_gc_print() {
  local rec="$1" tag p b note
  tag="$(echo "$rec" | cut -d'|' -f1)"
  p="$(echo "$rec" | cut -d'|' -f2)"
  b="$(echo "$rec" | cut -d'|' -f3)"
  note="$(echo "$rec" | cut -d'|' -f4)"
  local disp="${p#"${MAIN_ROOT}"/}"
  printf "  %-55s %-22s [%s] %s\n" "${disp:0:55}" "${b:0:22}" "$tag" "$note"
}

case "$CMD" in
  new) cmd_new ;;
  rm)  cmd_rm ;;
  ls)  cmd_ls ;;
  gc)  cmd_gc ;;
  *)   usage ;;
esac
