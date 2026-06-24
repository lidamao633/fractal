# Fractal — Cognitive Fractal

> [中文版见下方](#中文版)

**Give your coding agent the right project context, every time.**

Fractal stores stable semantic knowledge (the *why*, coupling rules, business logic) in `.nav/` files that live in your repo. For code facts (who calls what, where things are defined), agents use ripgrep on the spot — always fresh, never stale.

No indexes to build. No databases to maintain. Just memory that grows with your project.

## How It Works

| When | What happens |
|---|---|
| Agent edits a file | **PreToolUse hook** auto-injects relevant coupling rules, business context, and call sites |
| Agent finishes a task | **Stop hook** prompts the agent to capture any new semantic knowledge |
| You start a task | `nav scope <symbol>` gives a one-shot impact summary across files and repos |
| You need references | `nav refs <symbol>` runs ripgrep for live call sites |

## Installation

Fractal is a Claude Code plugin. Install once, works in every project.

```bash
# Install from local source
claude plugin add fractal@skills-dir

# Then in any project:
nav init          # creates .nav/ and a starter CLAUDE.md
```

**Requirements:** Node.js >= 18, ripgrep (optional; falls back to grep)

## Quick Start

```bash
# 1. Set up a project
nav init

# 2. Check impact before changes
nav scope <symbol|file|keyword>

# 3. Find references
nav refs <symbol>

# 4. Capture knowledge
nav capture --kind=protocol --title="A ↔ B" \
  --anchor="src/a.ts, src/b.ts" \
  --body="Changing A requires syncing B"
```

## What Goes in `.nav/`

| File | Purpose |
|---|---|
| `domains.md` | Business glossary — concepts mapped to code anchors |
| `protocols.md` | Coupling rules — "change A, must sync B" |
| `notes/` | Per-topic notes — design decisions, pitfalls |

## Commands

| Command | Description |
|---|---|
| `nav init` | Bootstrap `.nav/` and CLAUDE.md for a project |
| `nav scope <query>` | Impact summary: semantics + call graph + cross-repo |
| `nav refs <symbol>` | Live call sites via ripgrep |
| `nav brief --task "..."` | Pull relevant context for a task |
| `nav capture` | Save a semantic entry (protocol / domain / note) |
| `nav verify` | Check for stale or broken entries |
| `nav touch "<title>"` | Refresh an entry's verified date |
| `nav doctor` | Self-check: registration, hooks, trust status |

## Design Principles

- **Facts are retrieved, not stored.** Code facts change every commit. Ripgrep gets them live.
- **Semantics are stored, not computed.** The "why" and coupling rules can't be grepped — they must be captured.
- **No fine-grained indexes.** They drift silently. Coarse maps + live queries beat precise-but-stale graphs.
- **Judgment belongs to the agent.** The CLI does mechanical work. Semantic decisions stay with the LLM.

See [references/principles.md](references/principles.md) for the full rationale.

## License

MIT. See [LICENSE](LICENSE).

---

# 中文版

**让你的 coding agent 每次都拿到正确的项目背景。**

Fractal 把稳定的语义知识（为什么这样设计、跨文件联动、业务规则）沉淀到仓库内的 `.nav/` 文件。代码事实（谁调用谁、定义在哪）由 agent 用 ripgrep 现场查——永远最新，永不漂移。

不建索引，不维护数据库，只养随项目生长的记忆。

## 工作原理

| 时机 | 发生什么 |
|---|---|
| Agent 编辑文件时 | **PreToolUse hook** 自动注入联动协议、业务规则、调用点 |
| Agent 完成任务时 | **Stop hook** 提示 agent 沉淀本轮新发现的语义知识 |
| 接到任务时 | `nav scope <符号>` 一次拿到跨文件、跨仓的影响速写 |
| 查引用时 | `nav refs <符号>` 用 ripgrep 现场取调用点 |

## 安装

Fractal 是 Claude Code 插件，安装一次，所有项目通用。

```bash
# 从本地源安装
claude plugin add fractal@skills-dir

# 然后在任意项目中：
nav init          # 创建 .nav/ 和入口 CLAUDE.md
```

**依赖：** Node.js >= 18，ripgrep（可选，缺失时回退到 grep）

## 快速上手

```bash
# 1. 接入项目
nav init

# 2. 改动前查影响面
nav scope <符号|文件|关键词>

# 3. 查引用
nav refs <符号>

# 4. 沉淀语义
nav capture --kind=protocol --title="A ↔ B" \
  --anchor="src/a.ts, src/b.ts" \
  --body="改 A 必须同步 B"
```

## `.nav/` 里放什么

| 文件 | 用途 |
|---|---|
| `domains.md` | 业务词典——业务概念映射到代码锚点 |
| `protocols.md` | 联动协议——"改 A 必须同步 B" |
| `notes/` | 主题笔记——设计决策、踩过的坑 |

## 命令一览

| 命令 | 说明 |
|---|---|
| `nav init` | 为项目创建 `.nav/` 骨架和入口 CLAUDE.md |
| `nav scope <查询>` | 影响速写：语义 + 调用图 + 跨仓 |
| `nav refs <符号>` | 用 ripgrep 现场取调用点 |
| `nav brief --task "..."` | 按任务拉取相关语义上下文 |
| `nav capture` | 沉淀一条语义（protocol / domain / note） |
| `nav verify` | 语义对账：失效锚点 / 陈旧条目 |
| `nav touch "<标题>"` | 刷新条目的核实时间 |
| `nav doctor` | 自检：注册状态、hook、信任状态 |

## 设计原则

- **事实现场取，不存盘。** 代码事实每次 commit 都变，ripgrep 现场取最新。
- **语义要存盘，不靠算。** "为什么"和联动规则 grep 搜不出——必须主动沉淀。
- **不建精细索引。** 精细索引会悄悄漂移。粗粒度地图 + 现场查询 > 精确但过时的图。
- **判断归 agent，机械归 CLI。** CLI 只做 grep 和读写，语义决策留给 LLM。

详见 [references/principles.md](references/principles.md)。

## 许可

MIT 开源协议。详见 [LICENSE](LICENSE)。
