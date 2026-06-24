#!/usr/bin/env bash
# Cognitive Fractal — PreToolUse hook (matcher: Edit|Write)
# Injects coupling rules, nearby semantics, and live call sites before file edits.
set -euo pipefail
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAV="$SKILL_ROOT/bin/nav.mjs"
command -v node >/dev/null 2>&1 || exit 0
[ -f "$NAV" ] || exit 0
exec node "$NAV" hook PreToolUse
