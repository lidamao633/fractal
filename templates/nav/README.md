# .nav/ — Cognitive Fractal Semantic Memory

This directory is the project's semantic memory. **Committed to git, shared with the team.**
It only stores what machines can't compute: design rationale, coupling rules, business logic, pitfalls.

Code facts (who calls what, dependencies) are **not stored here** — agents retrieve them
live with ripgrep. Always fresh, never stale.

## Files
- `domains.md`   Business glossary: concepts mapped to code anchors (injected by keyword match)
- `protocols.md` Coupling rules: "change A, must sync B" (injected before file edits)
- `notes/`       Topic notes: the "why" and pitfalls for specific files/modules

## Maintenance
Mostly automatic — agents capture worthwhile semantics via `nav capture` at task end.
You can also edit these markdown files directly; remember to update the `verified:` date.

Each entry carries a confidence label: injected context shows "verified N days ago"
or "⚠️ not verified for N days", prompting agents to re-check when touching related code.
