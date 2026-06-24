---
name: fractal
description: "Cognitive Fractal — project navigation + semantic memory for coding agents. Code facts are retrieved live via ripgrep (always fresh); project semantics (why / coupling / business rules / pitfalls) are persisted in .nav/ and auto-injected when agents edit files or finish tasks. Trigger: user says 'set up fractal', 'nav', 'check fractal', 'semantic memory', 'inject context before editing'."
---

# Fractal — Cognitive Fractal

Give your agent the right project context, every time. **No indexes. Just memory.**

```
Code facts  (who calls what / deps / definitions) → agent retrieves live via ripgrep, never stored
Semantics   (why / coupling / business rules / pitfalls) → persisted in .nav/, auto-injected on edit
```

Why this split: facts change every commit — storing them guarantees drift. Agents already have grep,
which has higher recall than any pre-built index. Semantics are what grep can't find and sessions
can't keep — that's what's worth persisting.

---

## Usage Model (important: user never touches the CLI)

- Users trigger this skill via **natural language or `/fractal`** ("set up fractal", "check semantic memory").
- `nav` is **your (agent's) internal tool**, like grep. Invocation varies by host:
  - **Claude Code**: plugin's `bin/` is in PATH → call `nav <cmd>` directly; fallback: `node <skill>/bin/nav.mjs <cmd>`.
  - **Codex**: bin is NOT in PATH → always use `node "${PLUGIN_ROOT}/skills/fractal/bin/nav.mjs" <cmd>`; if the variable is absent, derive the absolute path from this SKILL.md's location. **Never bare `nav` (exits 127); never `2>/dev/null || true`** — nav failures must be visible.
  **The user never types CLI commands. Handing them a command to run is wrong.**
- Setup, capture, and queries are all executed by you; the user sees only conversation and results.
- Hooks are registered globally once; daily injection is fully automatic.

---

## Gate (check first, avoid wasted work)

| Evidence at project root | Action |
|---|---|
| **User explicitly invokes this skill** (`/fractal` or "set up / bootstrap") | = **Authorization to bootstrap. Don't ask again.** Run full bootstrap for this repo + its declared associated repos (see below). |
| `.nav/` exists (no explicit invocation) | Use nav commands; hooks are already auto-injecting |
| No `.nav/`, no explicit request | Not a Fractal project. **Exit silently, zero noise.** |

---

## Cognitive Layers

```
Layer 1 · Read first    CLAUDE.md at project root (≤50 lines): what / architecture / red lines / startup
                        — force-loaded on entry, establishes "where am I, what's off-limits"
Layer 2 · On demand     .nav/ (domains glossary / protocols coupling / notes)
                        — injected by hooks when keywords or file paths match
Layer 3 · Live          Who calls what, precise deps — not stored, agent rebuilds with ripgrep on the spot
```

Each layer gives "just enough" context. Deeper layers expand only when needed.
**Never dump everything at once.**

---

## Auto-Injection (two hard hooks, nothing else)

| When | Hook | What's injected |
|---|---|---|
| Before file edit | PreToolUse(Edit\|Write) | Coupling protocols + nearby notes + live call sites for that file |
| Task end | Stop | Capture gate (force self-check) + `nav verify` reconciliation |

Projects without `.nav/` → hooks exit silently, zero interference.
**Opening context / cross-repo awareness** → handled by L1 (CLAUDE.md); **live impact** → `nav scope` (agent calls proactively).

### Capture Gate (Stop mechanism)

Turns "did I forget to capture?" from a soft habit into a hard gate.

- **Trigger**: this session edited files inside the project root that are git-tracked and outside `.nav/`.
- **Mechanism**: when triggered and no capture has happened yet, Stop outputs a block decision forcing the agent to either `nav capture` or explicitly declare "no capture needed".
- **Whether to capture is still the agent's judgment** (iron rule: judgment for the agent, mechanics for the CLI). The gate only ensures "consider it" isn't skipped.
- **Anti-noise**: fires at most once per session; if `.nav` files were already updated, the gate passes.
- **Kill-switch**: set `{"captureGate": false}` in `.nav/config.json` to disable for a project.

---

## Command Reference (called by you via Bash — not for users to type)

```
nav init [root]                Bootstrap .nav/ + L1 CLAUDE.md
nav brief --path <file>        Get coupling/semantics for a file (anchor match)
nav brief --task "<task>"      Get relevant business rules (trigger match)
nav refs <symbol> [--max N]    Live call sites (ripgrep, high recall)
nav scope <symbol|file|kw>     Impact summary: semantics + call graph + cross-repo
nav map                        Coarse global map (layer 3 cache, rebuildable)
nav capture --kind=<note|protocol|domain> --title "..." --anchor "..." --body "..."
                               Persist a semantic entry
nav verify                     Reconcile: stale anchors / entries not verified >90 days
nav touch "<title>"            Refresh an entry's verified date
nav doctor / nav install       Self-check / print hook setup instructions
```

---

## Agent Working Protocol

> **Cross-repo first** (highest-impact habit for multi-repo projects): before diving in, check if the task
> might cross repo boundaries — read L1's "Associated repos" + consider the feature's nature (any data/state
> flowing across repo boundaries = root cause is often in the other repo). If yes → run `nav scope` first to
> get the full impact picture including the peer repo, then drill down. Don't crawl the current repo end-to-end
> before realizing the fix belongs elsewhere.

1. **Find facts**: use grep/ripgrep live, or `nav refs <symbol>`. No pre-built index — live is freshest.
2. **Read injections**: `〔Cognitive Fractal〕` marked content is trusted background. **If a coupling protocol appears, sync the linked files.** Entries marked "⚠️ not verified for N days" — spot-check when touching related code, then `nav touch`.
3. **Capture** (self-check is mandatory, capturing is a judgment call): at task end, ask "did I learn something non-obvious and valuable for future agents (a why, a pitfall, a coupling rule, a business constraint)?" If yes → `nav capture`. Most small changes have nothing — skip without guilt.
   **Choose the right recall trigger**: cross-module pitfalls (especially cross-repo) → domain/protocol with **trigger** keywords (recalled during planning); file-specific details → note with **anchor** (recalled on edit). Don't bury cross-module knowledge in anchor-only notes — it won't surface during diagnosis when the file isn't being edited.

---

## Bootstrap (triggered by explicit user invocation — agent does everything)

**Invocation = authorization**: the user calling `/fractal` or saying "set up" is explicit consent. **Don't ask "should I set up?" — just do it.**

**Scope = full cluster (declaration-driven, never scan)**:

1. Read CLAUDE.md's "Associated repos" section for declared peer repo paths (e.g., `../xxx-server`). No declaration = no association; bootstrap current repo only.
2. One command for the full cluster:
   `node <skill>/bin/nav.mjs init <root> --associated "../a,../b"`
   — creates `.nav/` skeleton + entry CLAUDE.md per repo, writes bidirectional cross-links in each repo's `protocols.md`. Idempotent (existing `.nav/` not overwritten).
3. **The real value = filling the business glossary per repo**: read code + discuss with user to populate `.nav/domains.md` with real entries (trigger → business rules → anchor/doc), plus repo-specific `protocols.md` couplings.
4. If hooks aren't globally registered yet, run `nav install` to get the config, then **with user consent** write to settings.json (one-time global setup, all projects benefit automatically).

---

## Iron Rules (never break)

- **Judgment for the agent, mechanics for the CLI**: impact analysis, whether to capture — agent's semantic judgment. `nav` only does grep/read/write.
- **Never persist facts**: only store semantics (stable, may age). Facts drift — retrieve them live.
- **Zero noise**: projects without `.nav/` → hooks and nav exit silently with code 0.
- **Zero runtime dependencies**: pure node + system ripgrep (fallback to grep).
- **Semantics in git**: `.nav/*.md` is team-shared; `.cache/` and `*.index.json` are gitignored (rebuildable).
- **Upgrades never migrate data**: `.nav/` format is decoupled from plugin version. Format evolution is handled by backward-compatible reads.
- **Surface area discipline**: the public interface is exactly three things — `nav` CLI, `.nav/` format, 2 hooks. Before adding anything, ask: is this a decision I'm afraid to make, disguised as user-facing flexibility?

---

Design rationale: see `references/principles.md`. For anything not covered above, state your intent first, then decide how to handle it.
