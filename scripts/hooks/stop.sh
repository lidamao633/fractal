#!/usr/bin/env bash
# Cognitive Fractal — Stop hook
# 1) Reconcile semantic entries (stale anchors / outdated entries)
# 2) If files changed, require agent to declare capture decision
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAV="$SKILL_ROOT/bin/nav.mjs"
command -v node >/dev/null 2>&1 || exit 0
[ -f "$NAV" ] || exit 0

node "$NAV" hook Stop

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CHANGED=$(git diff --name-only HEAD 2>/dev/null | grep -v '^\.nav/' || true)
  STAGED=$(git diff --cached --name-only 2>/dev/null | grep -v '^\.nav/' || true)
  UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | grep -v '^\.nav/' || true)
  ALL_CHANGES="${CHANGED}${STAGED}${UNTRACKED}"
  if [ -n "$ALL_CHANGES" ]; then
    echo ""
    echo "⚠️ [nav capture gate] Files changed this turn. You MUST declare one of:"
    echo "  ✅ Captured: briefly describe what was updated in .nav/"
    echo "  ⏭️ No capture needed: briefly explain why no new semantic knowledge was produced"
    echo "(Omitting this declaration will be flagged by the user.)"
  fi
fi
