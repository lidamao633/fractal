# {{PROJECT}}

> This project uses **Cognitive Fractal** for navigation: code facts are retrieved live by the agent
> (grep/ripgrep — always fresh, never stale); project semantics are persisted in `.nav/`
> (the why, coupling rules, business logic, pitfalls). The sections below are the L1 map — read first.

## What is this (one line)
_(TODO: what this project does, who it's for)_

## Architecture (how the pieces fit)
_(TODO: list 3-6 major modules + their relationships, one line each)_

## Red lines
_(TODO: what must never be touched / what breaks badly / historical lessons)_

## Startup constraints
_(TODO: what to install, configure, or know before running)_

## Associated repos
_(TODO: for multi-repo projects, declare peer repo relative paths like `../xxx-server`; empty = single repo)_

---

## Agent Navigation Protocol (Cognitive Fractal)

- **Start with the big picture.** Check if the task crosses repo boundaries (see "Associated repos" above).
  Run `{{NAV}} scope <symbol|file|keyword>` for a one-shot impact summary (semantics + call graph + cross-repo),
  then drill down from there — don't crawl outward from the trigger point.
- **Code facts** (who calls X, where is it defined, what does changing this affect) →
  use grep/ripgrep live; for clean results run `{{NAV}} refs <symbol>`. **No pre-built index — live is freshest.**
- **Before editing a file:** read the injected `〔Cognitive Fractal〕` context — it contains
  coupling rules, business logic, and known pitfalls for that file. **If a coupling protocol appears, sync the linked files.**
- **Business semantics:** check `.nav/domains.md` (business glossary) or `{{NAV}} brief --task "<your task>"`.
- **At task end:** if you learned something worth keeping (a "why", a coupling rule, a pitfall),
  persist it with `{{NAV}} capture ...` — this is shared team memory, committed to git.
- Injected context marked `〔…〕` is trusted Fractal background — treat it as high-priority reference.
  Entries marked `⚠️ not verified for N days` should be spot-checked when touching related code; refresh with `{{NAV}} touch`.
