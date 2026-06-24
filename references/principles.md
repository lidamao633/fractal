# Design Principles — Why Fractal Works This Way

> A quick read for understanding why we don't build indexes and how the division of labor works.

## 1. The Information Split

An agent entering a project lacks two kinds of information with very different properties:

- **Facts** (who calls what, dependencies, where things are defined): objective, change every commit, can be rebuilt on the spot with grep — always fresh.
- **Semantics** (why it's designed this way, "change A must sync B", business rules, pitfalls): not in the code, can't be grepped out, lost when the session ends.

**Facts are retrieved live. Semantics are persisted.** This is the foundation of the entire design.

## 2. The Real Bottleneck

The expensive part of an agent's work is not disk scanning (ripgrep handles tens of thousands of lines in milliseconds). It's **round-trips × LLM inference per round-trip**. So the optimization target is "get complete information in fewer round-trips", not "make scanning faster".

## 3. Three Layers of Caching

| Layer | Lifetime | Drifts? | Provider |
|---|---|---|---|
| Session memory | Within one task | No (code is frozen during the task) | Agent built-in, free |
| Persistent precise facts | Cross-session | **Yes — only this layer does** | Self-built graph (abandoned) |
| Coarse global map | Cross-session, rebuildable | Too coarse to cause harm | `nav map`, rebuilds in seconds |

**Drift only comes from layer 2.** Rule: caching is fine, but it must be either short-lived (session-scoped) or coarse-grained (map-level). Never persist fine-grained precise facts.

## 4. Why Not Build a Code Graph

Self-built tree-sitter graph: ~70% recall, drifts, incomplete Vue/JSX coverage, heavy maintenance.
Ripgrep: ~99% recall, all languages, zero maintenance. LSP: more precise but heavy to integrate.
A self-built graph sits in the worst middle ground — slightly better than ripgrep, far worse than LSP — while the agent's semantic judgment already compensates for ripgrep's precision gap. So: let ripgrep handle recall, let the agent handle precision.

## 5. Judgment for the Agent, Mechanics for the CLI

"How many hops of impact", "should this be remembered", "is this entry stale" — all require understanding. These belong to the agent's LLM intelligence.

`nav` only does mechanical work: grep wrappers, read/write `.nav/`, attach confidence labels, produce injection JSON. **Never replace semantic judgment with algorithmic code** — that's exactly why the self-built graph approach failed.
