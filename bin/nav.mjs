#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  nav — Cognitive Fractal CLI
//
//  Design philosophy (see references/principles.md):
//    · No indexes, grow memory. Facts are retrieved live (ripgrep, never stale),
//      semantics are progressively disclosed along the agent's cognitive journey.
//    · Judgment belongs to the agent, mechanics belong to the CLI. This file only
//      does mechanical work: read/write .nav/ fragments, wrap ripgrep, tag confidence,
//      produce hook injection JSON. "Should this be recorded / how many hops /
//      is it stale" — all left to the agent.
//    · Zero runtime dependencies (pure node + system ripgrep).
//
//  Commands: init / brief / refs / map / capture / verify / touch / doctor / install
// ════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SKILL_ROOT = path.resolve(path.dirname(__filename), '..');
const TEMPLATES = path.join(SKILL_ROOT, 'templates');

const NAV_DIR = '.nav';
const SEMANTIC_FILES = ['domains.md', 'protocols.md']; // single file, multiple entries
const NOTES_DIR = 'notes';                              // one file per entry
const INJECT_CAP = 2400;                                // injection char cap (~600 tokens)
const SRC_HINTS = ['src', 'app', 'lib', 'server', 'backend', 'frontend', 'apps', 'packages', 'internal', 'cmd', 'pkg', 'modules', 'services', 'wwwroot'];

// ─────────────────────────── Utilities ───────────────────────────

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Deep-find a key in a nested object (used by doctor for installed_plugins/settings). */
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

/** Walk up from startPath to find the project root containing .nav/. */
function findProjectRoot(startPath) {
  let dir = path.resolve(startPath || process.cwd());
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  while (true) {
    if (fs.existsSync(path.join(dir, NAV_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Minimal glob to RegExp. Supports ** (cross-directory) and * (single level). */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Match anchor against relPath. Supports glob, directory prefix, exact, and basename. */
function matchAnchor(anchor, relPath) {
  const a = anchor.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const p = relPath.replace(/^\.?\/+/, '');
  if (!a) return false;
  if (a.includes('*')) return globToRegExp(a).test(p);
  if (p === a) return true;
  if (p.startsWith(a + '/')) return true;        // directory prefix
  if (path.basename(p) === a) return true;       // bare filename
  return false;
}

// ───────────────────── Fragment parsing (unified model) ─────────────────────
//
//  All .nav/*.md and notes/*.md use the same format, split on "## title" blocks:
//
//    ## Auth domain
//    - anchor: src/auth/**, src/middleware/auth.ts
//    - trigger: login, auth, token
//    - doc: docs/auth.md
//    - verified: 2026-05-30
//    Body text ...
//
//  Parsed into fragment: { source, title, anchors[], triggers[], doc, verified, body }

function parseBlocks(text, source) {
  const frags = [];
  const parts = text.split(/^(?=##\s)/m);
  for (const part of parts) {
    const m = /^##\s+(.+?)\s*$/m.exec(part);
    if (!m) continue;
    const title = m[1].trim();
    const frag = { source, title, anchors: [], triggers: [], doc: null, verified: null, body: '' };
    const bodyLines = [];
    let inMeta = true;
    for (const line of part.split(/\r?\n/)) {
      if (/^##\s+/.test(line)) continue;
      const meta = /^[-*]\s*(anchor|trigger|doc|verified)\s*[:：]\s*(.+)$/i.exec(line);
      if (inMeta && meta) {
        const key = meta[1].toLowerCase();
        const val = meta[2].trim();
        if (key === 'anchor') frag.anchors = splitList(val);
        else if (key === 'trigger') frag.triggers = splitList(val);
        else if (key === 'doc') frag.doc = val;
        else if (key === 'verified') frag.verified = val;
      } else {
        if (line.trim() !== '' ) inMeta = false;
        bodyLines.push(line);
      }
    }
    frag.body = bodyLines.join('\n').trim();
    // Skip blocks with no meta — sub-headings inside entry bodies get mis-split into
    // pseudo-entries with no anchor/trigger/verified, polluting counts and recall.
    const hasMeta = frag.anchors.length || frag.triggers.length || frag.doc || frag.verified;
    if (frag.title && hasMeta) frags.push(frag);
  }
  return frags;
}

function splitList(s) {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/** Load all semantic fragments from the project. */
function loadFragments(root) {
  const navDir = path.join(root, NAV_DIR);
  const frags = [];
  for (const f of SEMANTIC_FILES) {
    const p = path.join(navDir, f);
    if (fs.existsSync(p)) frags.push(...parseBlocks(readText(p), f));
  }
  const notesDir = path.join(navDir, NOTES_DIR);
  if (fs.existsSync(notesDir)) {
    for (const name of fs.readdirSync(notesDir)) {
      if (!name.endsWith('.md')) continue;
      frags.push(...parseBlocks(readText(path.join(notesDir, name)), `${NOTES_DIR}/${name}`));
    }
  }
  return frags;
}

// ───────────────────── Confidence tagging ─────────────────────

function semanticTag(verified) {
  const d = daysSince(verified);
  if (d === null) return '【语义·未标注核实时间】';
  if (d > 90) return `【语义·⚠️ ${d} 天未核实，触碰时请顺手确认】`;
  return `【语义·${d} 天前核实】`;
}

function truncate(text, cap = INJECT_CAP) {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

// ───────────────────── ripgrep wrapper (live fact retrieval) ─────────────────────

function hasRg() {
  return spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0;
}

/** Live symbol reference search. Returns [{file,line,text}], recall-first (text match, no semantic filtering). */
function rgRefs(symbol, root, max = 40) {
  const useRg = hasRg();
  const cmd = useRg ? 'rg' : 'grep';
  const args = useRg
    ? ['-n', '--no-heading', '-w', '--', symbol, root]
    : ['-rnw', '--', symbol, root];
  const out = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (out.status !== 0 || !out.stdout) return { hits: [], engine: cmd, total: 0 };
  const lines = out.stdout.split('\n').filter(Boolean);
  const hits = [];
  for (const ln of lines) {
    const m = /^(.*?):(\d+):(.*)$/.exec(ln);
    if (!m) continue;
    hits.push({ file: path.relative(root, m[1]), line: +m[2], text: m[3].trim() });
  }
  return { hits: hits.slice(0, max), engine: cmd, total: hits.length };
}

// ═══════════════════════════ Commands ═══════════════════════════

/** Bootstrap a single repo: create .nav/ skeleton + L1 entry + .gitignore. Skips if exists (unless --force). */
function initOne(root, force) {
  const name = path.basename(root);
  const navDir = path.join(root, NAV_DIR);
  if (fs.existsSync(navDir) && !force) {
    console.log(`[nav] ${name}: ${NAV_DIR}/ 已存在，跳过骨架（不覆盖）。`);
    return { root, existed: true };
  }
  fs.mkdirSync(path.join(navDir, NOTES_DIR), { recursive: true });
  const tplNav = path.join(TEMPLATES, 'nav');
  for (const f of ['domains.md', 'protocols.md', 'README.md']) {
    const src = path.join(tplNav, f);
    const dst = path.join(navDir, f);
    if (fs.existsSync(src) && (!fs.existsSync(dst) || force)) fs.writeFileSync(dst, readText(src));
  }
  // L1 entry: CLAUDE.md is the sole L1. If present, confirm; if absent, create from template.
  const claude = path.join(root, 'CLAUDE.md');
  if (fs.existsSync(claude)) {
    console.log(`[nav] ${name}: CLAUDE.md 已存在 — 确认含「Cognitive Fractal 导航」段落`);
  } else {
    const navCmd = `node ${path.join(SKILL_ROOT, 'bin', 'nav.mjs')}`;
    const tpl = readText(path.join(TEMPLATES, 'entry-CLAUDE.md'))
      .replace(/{{PROJECT}}/g, name).replace(/{{NAV}}/g, navCmd);
    fs.writeFileSync(claude, tpl);
    console.log(`[nav] ${name}: 已创建第 1 层入口 CLAUDE.md`);
  }
  ensureGitignore(root);
  console.log(`[nav] ${name}: 已建立 .nav/ 语义记忆层。`);
  return { root, existed: false };
}

/** Write cross-repo link stubs in protocols.md. Idempotent: skips if protocol already declared. */
function writeClusterLink(root, siblings) {
  if (!siblings.length) return;
  const proto = path.join(root, NAV_DIR, 'protocols.md');
  const existing = readText(proto);
  if (existing.includes('关联仓库协同')) return;
  const rels = siblings.map((s) => path.relative(root, s) || s);
  const names = siblings.map((s) => path.basename(s));
  // Anchors use actually-existing top-level dirs (not hardcoded src/** — Go/PHP repos without src/ get dead anchors);
  // trigger is required: cross-repo protocols are most needed during read-only diagnosis, anchor-only recall misses them.
  const tops = SRC_HINTS.filter((d) => {
    try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
  });
  const block = [
    '## 关联仓库协同（自动）',
    tops.length ? `- anchor: ${tops.map((d) => `${d}/**`).join(', ')}` : null,
    `- trigger: ${[...new Set([...names, '关联仓库', '跨仓', '对端'])].join(', ')}`,
    `- verified: ${today()}`,
    '本仓与以下仓库属同一逻辑项目，契约（API/枚举/状态机）变更须双仓协同 commit、message 互相引用；',
    '改到对端契约时，对端 .nav/ 也应同步沉淀：',
    ...rels.map((r) => `  - ${r}`),
    '',
  ].filter((x) => x !== null).join('\n');
  fs.appendFileSync(proto, (existing.trim() ? '\n' : '') + block);
  console.log(`[nav] ${path.basename(root)}: 已写关联仓库交叉链接（${rels.join(', ')}）`);
}

function cmdInit(args) {
  const root = path.resolve(args._[0] || process.cwd());
  initOne(root, args.force);

  // Cluster init: --associated "../a,../b" → init each repo + bidirectional cross-links
  if (args.associated) {
    const cluster = [root];
    for (const p of String(args.associated).split(',').map((s) => s.trim()).filter(Boolean)) {
      const abs = path.resolve(root, p);
      if (!fs.existsSync(abs)) { console.log(`[nav] 关联仓不存在，跳过：${p}`); continue; }
      initOne(abs, args.force);
      cluster.push(abs);
    }
    for (const repo of cluster) writeClusterLink(repo, cluster.filter((r) => r !== repo));
    console.log(`[nav] 整簇点火完成：${cluster.map((r) => path.basename(r)).join(' ↔ ')}`);
  }

  console.log(`[nav] 下一步：逐仓填 .nav/domains.md（业务词典）—— 真点火的价值核心。`);
  if (process.env.CODEX_HOME || fs.existsSync(path.join(os.homedir(), '.codex'))) {
    console.log(`[nav] 检测到 Codex：建议在 ~/.codex/config.toml 设 project_doc_fallback_filenames=["CLAUDE.md"] 以读同一入口。`);
  }
  return 0;
}

function ensureGitignore(root) {
  const gi = path.join(root, '.gitignore');
  const marks = ['.nav/.cache/', '.nav/*.index.json'];
  let text = readText(gi);
  const missing = marks.filter((m) => !text.includes(m));
  if (missing.length) {
    text += (text && !text.endsWith('\n') ? '\n' : '') + '\n# Cognitive Fractal — rebuildable artifacts\n' + missing.join('\n') + '\n';
    fs.writeFileSync(gi, text);
  }
}

/** Build brief text (path or task matched semantic fragments). Shared by cmdBrief and cmdHook. */
function buildBriefText(root, opts) {
  const frags = loadFragments(root);
  let picked = [];
  if (opts.path) {
    const rel = path.relative(root, path.resolve(root, opts.path));
    picked = frags.filter((f) => f.anchors.some((a) => matchAnchor(a, rel)));
  } else if (opts.task) {
    const kw = String(opts.task).toLowerCase();
    picked = frags.filter((f) => f.triggers.some((t) => kw.includes(t.toLowerCase())));
  } else {
    picked = frags;
  }
  if (!picked.length) return '';
  // Sort: protocols (coupling, most critical) > domains (business) > notes
  const rank = (s) => (s.startsWith('protocols') ? 0 : s.startsWith('domains') ? 1 : 2);
  picked.sort((a, b) => rank(a.source) - rank(b.source));
  const chunks = picked.map((f) => {
    const doc = f.doc ? `\n→ 详见 ${f.doc}` : '';
    return `### ${f.title} ${semanticTag(f.verified)}\n${f.body}${doc}`;
  });
  const { text, truncated } = truncate(chunks.join('\n\n'), opts.full ? Infinity : INJECT_CAP);
  const body = text + (truncated ? `\n\n…还有更多，用 \`nav brief --path <文件>\` 展开。` : '');
  return `〔Cognitive Fractal · 相关项目记忆〕\n${body}`;
}

/** brief: output relevant semantic fragments by path or task (layer 2 on-demand loading). */
function cmdBrief(args) {
  const root = findProjectRoot(args.path || args._[0] || process.cwd());
  if (!root) return output(''); // no .nav → silent
  return output(buildBriefText(root, { path: args.path, task: args.task, full: args.full }));
}

/** refs: live call-site retrieval (fact layer, high recall). */
function cmdRefs(args) {
  const symbol = args._[0];
  if (!symbol) { console.error('用法: nav refs <symbol> [--max N] [--path <root>]'); return 1; }
  const root = findProjectRoot(args.path) || process.cwd();
  const { hits, engine, total } = rgRefs(symbol, root, args.max ? +args.max : 40);
  if (!hits.length) {
    return output(`〔事实·${engine} 现场取·刚验证〕未找到 \`${symbol}\` 的引用。`);
  }
  const lines = hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
  const more = total > hits.length ? `\n  …共 ${total} 处，已截断到 ${hits.length}。` : '';
  const out = `〔事实·${engine} 现场取·刚验证〕\`${symbol}\` 的引用（${total} 处）：\n${lines}${more}\n（文本匹配，高召回；同名/无关项请自行甄别。）`;
  return output(out);
}

// ───────────────────── scope: impact sketch (live synthesis) ─────────────────────
//  Orchestrates existing primitives (refs / semantic recall / import / cross-repo) into
//  an "impact sketch" — gives macro coordinates + drill-down entry points.
//  Iron rule: only orchestrates live grep, never persists, never judges hop count (that's for the agent).

function oneLine(s, n = 90) {
  const t = (s || '').split(/\r?\n/).find((x) => x.trim()) || '';
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Three-way semantic recall: path→anchor / keyword→trigger / symbol/word→title+body (so triggerless notes also recall). */
function scopeSemantics(root, target, sym) {
  const frags = loadFragments(root);
  if (!frags.length) return '';
  const abs = path.resolve(root, String(target));
  let isFile = false;
  try { isFile = fs.existsSync(abs) && !fs.statSync(abs).isDirectory(); } catch { isFile = false; }
  const rel = isFile ? path.relative(root, abs) : null;
  const symL = sym.toLowerCase();
  // For file paths, only use symbol name (don't split path segments like src/admin/views — generic words pollute recall)
  const terms = isFile
    ? (symL.length >= 3 ? [symL] : [])
    : String(target).toLowerCase().split(/[\s,，/、.]+/).filter((w) => w.length >= 2);
  const scored = [];
  for (const f of frags) {
    let how = null;
    if (rel && f.anchors.some((a) => matchAnchor(a, rel))) how = 0;                       // path 1: exact anchor (most relevant)
    else if (f.triggers.some((t) => terms.some((w) => w.includes(t.toLowerCase()) || t.toLowerCase().includes(w)))) how = 1; // path 2: trigger
    else { const hay = (f.title + ' ' + f.body).toLowerCase(); if (terms.some((w) => hay.includes(w))) how = 2; }            // path 3: content (fixes "note not recalled via trigger" bug)
    if (how !== null) scored.push({ f, how });
  }
  if (!scored.length) return '';
  const srank = (s) => (s.startsWith('protocols') ? 0 : s.startsWith('domains') ? 1 : 2);
  scored.sort((a, b) => a.how - b.how || srank(a.f.source) - srank(b.f.source));          // exact anchor > protocols > trigger > content
  const lines = scored.slice(0, 8).map(({ f }) => `  - ${f.title} ${semanticTag(f.verified)}：${oneLine(f.body)}${f.doc ? ` → ${f.doc}` : ''}`);
  return '▎业务域 + 坑/联动（语义·三路召回，含无 trigger 的 note）\n' + lines.join('\n');
}

/** Downstream: read target file and regex-extract import/require modules (intentionally naive, no AST — works for JS/TS/Vue). */
function extractImports(root, target) {
  const abs = path.resolve(root, String(target));
  try { if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return ''; } catch { return ''; }
  const text = readText(abs);
  const mods = new Set();
  const re = /(?:from|import|require\s*\()\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) && mods.size < 24) mods.add(m[1]);
  if (!mods.size) return '';
  const local = [...mods].filter((x) => /^[.@]/.test(x));
  const show = (local.length ? local : [...mods]).slice(0, 12);
  return `▎下游·\`${path.basename(String(target))}\` 依赖谁（事实·现场 import）\n  ` + show.join(' · ');
}

/** Cross-repo: parse L1 (CLAUDE.md/AGENTS.md) "Associated Repos" declarations, return existing peer repo absolute paths. */
function readAssociatedRepos(root) {
  const out = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const text = readText(path.join(root, f));
    const idx = text.indexOf('关联仓库');
    if (idx < 0) continue;
    const section = text.slice(idx, idx + 1000);
    const re = /(\.\.\/[\w.\-/]+|\.\/[\w.\-/]+)/g;
    let m;
    while ((m = re.exec(section))) {
      const abs = path.resolve(root, m[1].replace(/[`|).]+$/, ''));
      try { if (fs.statSync(abs).isDirectory() && !out.includes(abs)) out.push(abs); } catch { /* skip if missing */ }
    }
    if (out.length) break;
  }
  return out;
}

/** scope: orchestrate refs + semantics + imports + cross-repo into an impact sketch (live, not persisted). */
function cmdScope(args) {
  const target = args._[0];
  if (!target) { console.error('用法: nav scope <符号|文件|关键词> [--path <root>]'); return 1; }
  const root = findProjectRoot(args.path) || process.cwd();
  const sym = path.basename(String(target)).replace(/\.[^.]+$/, '');
  const absT = path.resolve(root, String(target));
  let ownRel = null;
  try { if (fs.existsSync(absT) && !fs.statSync(absT).isDirectory()) ownRel = path.relative(root, absT); } catch { /* not a file */ }
  const blocks = [`〔Cognitive Fractal · 影响速写：${target}〕（现场合成·用完即弃·非持久化）`];

  const sem = scopeSemantics(root, target, sym);
  if (sem) blocks.push(sem);

  const { hits, total, engine } = rgRefs(sym, root, 14);
  const up = hits.filter((h) => h.file !== ownRel);
  if (up.length) blocks.push(`▎上游·谁依赖 \`${sym}\`（事实·${engine} 现场取，${total} 处）\n` +
    up.slice(0, 8).map((h) => `  ${h.file}:${h.line}`).join('\n') + '\n  （文本匹配，同名请甄别）');

  if (ownRel) { const imp = extractImports(root, target); if (imp) blocks.push(imp); }

  const sibs = readAssociatedRepos(root);
  if (sibs.length) {
    const xs = sibs.map((sib) => {
      const r = rgRefs(sym, sib, 6);
      const tag = path.basename(sib);
      return r.hits.length
        ? `  关联仓 ${tag}：\`${sym}\` 命中 ${r.total} 处，例如 ` + r.hits.slice(0, 4).map((h) => `${h.file}:${h.line}`).join(' · ')
        : `  关联仓 ${tag}：未直接命中 \`${sym}\`（换业务关键词再搜，或确认是否真不涉及）`;
    });
    blocks.push('▎跨仓对端（⚠️ 头痛医头高发区——数据/文件/状态跨仓流动的功能，根因常在对端仓）\n' + xs.join('\n'));
  } else {
    blocks.push('▎跨仓对端：L1 未声明「关联仓库」（单仓项目，或去 L1 补声明）');
  }

  blocks.push('▎下钻建议：看清上面全局后定向深入——别从触发点局部爬。深挖几跳 / 哪些是真依赖，由你判断。');
  return output(blocks.join('\n\n'));
}

/** Build coarse-grained global map text (layer 3 cache). Shared by cmdMap and cmdHook. */
function buildMapText(root) {
  const useRg = hasRg();
  const dirs = SRC_HINTS.filter((d) => fs.existsSync(path.join(root, d)));
  const report = [];
  for (const d of dirs.length ? dirs : ['.']) {
    const base = path.join(root, d);
    let files = [];
    if (useRg) {
      const out = spawnSync('rg', ['--files', base], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      files = (out.stdout || '').split('\n').filter(Boolean);
    } else {
      files = walkFiles(base);
    }
    const code = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|rb|php|c|cc|cpp|cs|swift)$/.test(f));
    report.push(`- \`${d}/\` — ${code.length} 个源码文件`);
  }
  return `〔地图·现场生成·不落盘〕项目源码骨架（粗粒度，仅供导航；精确依赖请 \`nav refs\` / 影响速写请 \`nav scope\`）：\n${report.join('\n')}`;
}

/** map: coarse-grained global map (layer 3 cache, rebuildable, navigation only). */
function cmdMap(args) {
  const root = findProjectRoot(args.path) || process.cwd();
  return output(buildMapText(root));
}

function walkFiles(dir, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc, depth + 1);
    else acc.push(p);
  }
  return acc;
}

/** capture: persist a new semantic entry. Agent provides content, CLI just writes. */
function cmdCapture(args) {
  const root = findProjectRoot(args.path) || process.cwd();
  const navDir = path.join(root, NAV_DIR);
  if (!fs.existsSync(navDir)) { console.error('[nav] 当前项目无 .nav/，先 nav init'); return 1; }
  const kind = args.kind || 'note';       // note | protocol | domain
  const title = args.title;
  if (!title) {
    console.log(captureTemplate());
    return 0;
  }
  // Strip meta lines from body start and merge into header, preventing agent from
  // putting meta fields in body (which breaks hook keyword recall).
  const meta = { trigger: args.trigger, anchor: args.anchor, doc: args.doc };
  let body = args.body || '';
  if (body) {
    const lines = body.split('\n');
    let i = lines.length && lines[0].trim() === '' ? 1 : 0;
    let consumed = 0;
    for (; i < lines.length; i++) {
      const m = /^[-*]\s*(trigger|anchor|doc|verified)\s*[:：]\s*(.+)$/i.exec(lines[i]);
      if (!m) break;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'verified') { /* ignore verified in body — header uses today() */ }
      else if (meta[key]) {
        console.error(`[nav] warn: body 含 - ${key}: 与 --${key} 重复，已忽略 body 中的值（args 优先）`);
      } else {
        meta[key] = val;
      }
      consumed = i + 1;
    }
    if (consumed) {
      body = lines.slice(consumed).join('\n').replace(/^\n+/, '');
    }
  }
  // protocol/domain without trigger: reverse recall via user keywords won't work
  if ((kind === 'protocol' || kind === 'domain') && !meta.trigger) {
    console.error(`[nav] warn: kind=${kind} 但未提供 --trigger，hook 仅能按 anchor 命中文件路径召回，` +
      '用户口语关键词反查不到本条。建议补一组中文/英文触发词（如 --trigger="登录, 鉴权, auth"）。');
  }
  // Cross-repo notes must have trigger — anchor-only cross-repo notes fail all three recall paths during diagnosis
  if (kind === 'note' && meta.anchor && !meta.trigger && !args.force) {
    const sibNames = readAssociatedRepos(root).map((p) => path.basename(p));
    const crossRepo = /(^|[,，]\s*)\.\.\//.test(meta.anchor) || sibNames.some((n) => n && meta.anchor.includes(n));
    if (crossRepo) {
      console.error('[nav] ✗ 跨仓 anchor 的 note 必须带 --trigger：诊断只读不改、PreToolUse 不触发、任务关键词又匹配不到，' +
        '这条坑会在最需要的排查期召回不到（白沉淀）。补 --trigger="<业务关键词>"，或 --force 越过。');
      return 1;
    }
  }
  // Credential hygiene — .nav/ is git-shared, credentials are sensitive A-class facts
  if (/(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token\s*[:=]\s*\S|Bearer\s+[A-Za-z0-9._-]{10,}|BEGIN [A-Z ]*PRIVATE KEY)/i.test(`${title} ${body}`)) {
    console.error('[nav] warn: 内容疑似含凭据（密码/密钥/token）。确认必要性，或改写为「去哪现场取」的指针。');
  }
  const block = [
    `## ${title}`,
    meta.anchor ? `- anchor: ${meta.anchor}` : null,
    meta.trigger ? `- trigger: ${meta.trigger}` : null,
    meta.doc ? `- doc: ${meta.doc}` : null,
    `- verified: ${today()}`,
    '',
    body || '（待补充）',
    '',
  ].filter((x) => x !== null).join('\n');

  let target;
  if (kind === 'protocol') target = path.join(navDir, 'protocols.md');
  else if (kind === 'domain') target = path.join(navDir, 'domains.md');
  else {
    const slug = (args.slug || title).replace(/[^\w一-龥.-]+/g, '-').slice(0, 60);
    target = path.join(navDir, NOTES_DIR, `${slug}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  // Title dedup — append-only would create duplicate entries; hook injection can't decide which to recall.
  // --update = in-place replacement of same-title block; default rejects append; --force overrides.
  if (fs.existsSync(target)) {
    const existing = readText(target);
    const titleRe = new RegExp(`^##\\s+${escapeRe(title)}\\s*$`, 'm');
    if (titleRe.test(existing)) {
      if (args.update) {
        const parts = existing.split(/^(?=##\s)/m); // same split as parseBlocks
        const idx = parts.findIndex((p) => titleRe.test(p));
        parts[idx] = block.endsWith('\n') ? block : block + '\n';
        fs.writeFileSync(target, parts.join(''));
        console.log(`[nav] 已更新「${title}」→ ${path.relative(root, target)}（原地替换，verified=${today()}）`);
        return 0;
      }
      if (!args.force) {
        console.error(`[nav] 已存在同名条目「${title}」在 ${path.relative(root, target)}。` +
          '更新原条目用 --update（原地替换、刷新 verified）；确需追加多版本用 --force。');
        return 1;
      }
    }
  } else if (args.update) {
    console.error(`[nav] warn: --update 但目标文件不存在，按新增写入。`);
  }
  fs.appendFileSync(target, (fs.existsSync(target) && readText(target).trim() ? '\n' : '') + block);
  console.log(`[nav] 已沉淀「${title}」→ ${path.relative(root, target)}`);
  return 0;
}

function captureTemplate() {
  return [
    '# 沉淀模板 — 把内容填好后用参数调用 nav capture',
    '# 例：',
    '#   nav capture --kind=protocol --title="login.ts ↔ session.ts" \\',
    '#     --anchor="src/auth/login.ts, src/auth/session.ts" \\',
    '#     --body="改 login 签名必须同步 session 的调用"',
    '#   nav capture --kind=domain --title="鉴权域" \\',
    '#     --trigger="登录, 鉴权, token" --anchor="src/auth/**" --doc="docs/auth.md" \\',
    '#     --body="登录发 JWT，2h 过期；刷新 token 7 天"',
    '#   nav capture --kind=note --title="为什么用乐观锁" --anchor="src/order/submit.ts" \\',
    '#     --body="并发下单冲突高，用版本号乐观锁而非行锁，避免死锁"',
  ].join('\n');
}

/** scanStale: mechanical audit core. Returns [{title, source, missing:[anchor...], staleDays|null}].
 *  missing = anchored file no longer exists (hard stale); staleDays = verified >90 days ago (soft stale). */
function scanStale(root) {
  const out = [];
  for (const f of loadFragments(root)) {
    const missing = [];
    for (const a of f.anchors) {
      if (!a.includes('*')) {
        const abs = path.join(root, a.replace(/\/+$/, ''));
        if (!fs.existsSync(abs)) missing.push(a);
      }
    }
    const d = daysSince(f.verified);
    const staleDays = (d !== null && d > 90) ? d : null;
    if (missing.length || staleDays !== null) out.push({ title: f.title, source: f.source, missing, staleDays });
  }
  return out;
}

function staleIssues(s) {
  return [...s.missing.map((a) => `anchor 失效: ${a}`), ...(s.staleDays !== null ? [`${s.staleDays} 天未核实`] : [])];
}

/** verify: semantic audit (mechanical). Check if anchored files still exist and verified freshness. */
function cmdVerify(args) {
  const root = findProjectRoot(args.path) || process.cwd();
  if (!root) return 0;
  const stale = scanStale(root);
  if (!stale.length) { console.log('[nav] 语义对账：未发现失效锚点或陈旧条目 ✅'); return 0; }
  console.log('[nav] 语义对账发现以下条目需 agent 关注（触碰时顺手修正 + nav touch）：');
  for (const s of stale) console.log(`  · [${s.source}] ${s.title} — ${staleIssues(s).join('；')}`);
  return 0;
}

/** touch: refresh a fragment's verified date (mechanical). */
function cmdTouch(args) {
  const root = findProjectRoot(args.path) || process.cwd();
  const title = args._[0];
  if (!title) { console.error('用法: nav touch "<标题>"'); return 1; }
  const navDir = path.join(root, NAV_DIR);
  const targets = [...SEMANTIC_FILES.map((f) => path.join(navDir, f)),
    ...(fs.existsSync(path.join(navDir, NOTES_DIR)) ? fs.readdirSync(path.join(navDir, NOTES_DIR)).map((n) => path.join(navDir, NOTES_DIR, n)) : [])];
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    let text = readText(t);
    const re = new RegExp(`(##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?- verified\\s*[:：]\\s*)([0-9-]+)`);
    if (re.test(text)) {
      text = text.replace(re, `$1${today()}`);
      fs.writeFileSync(t, text);
      console.log(`[nav] 已刷新「${title}」的核实时间为 ${today()}`);
      return 0;
    }
  }
  console.error(`[nav] 未找到标题为「${title}」的条目`);
  return 1;
}

function cmdDoctor() {
  const rg = hasRg();
  console.log(`[nav] doctor`);
  console.log(`  node     : ${process.version}`);
  console.log(`  ripgrep  : ${rg ? spawnSync('rg', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0] : '✗ 未安装（将 fallback 到 grep，召回略降）'}`);
  const root = findProjectRoot(process.cwd());
  console.log(`  项目 .nav: ${root ? path.join(root, NAV_DIR) : '（当前不在分形项目内）'}`);
  if (root) {
    const frags = loadFragments(root);
    console.log(`  语义条目 : ${frags.length}（domains/protocols/notes 合计）`);
  }
  // B5: registration liveness checks (mount state is also a drifting fact)
  const selfPkg = readJSON(path.join(SKILL_ROOT, '.claude-plugin', 'plugin.json')) || {};
  console.log(`  自身     : v${selfPkg.version || '?'} @ ${SKILL_ROOT}`);
  const home = os.homedir();
  // Claude Code: registration + enablement + "am I the registered copy?"
  const reg = deepFind(readJSON(path.join(home, '.claude', 'plugins', 'installed_plugins.json')), 'fractal@fractal');
  const enabled = deepFind(readJSON(path.join(home, '.claude', 'settings.json')), 'fractal@fractal');
  if (Array.isArray(reg) && reg.length) {
    const cur = reg[reg.length - 1];
    console.log(`  Claude   : ${enabled === true ? '✅ 已启用' : '⚠️ 已装未启用'} v${cur.version} @ ${cur.installPath}`);
    if (path.resolve(cur.installPath || '') !== path.resolve(SKILL_ROOT)) {
      console.log(selfPkg.version !== cur.version
        ? `             ⚠️ 当前进程是 v${selfPkg.version}（非运行时副本）——源仓改动需 release + claude plugin update 才生效`
        : '             ℹ️ 当前进程非运行时 cache 副本（同版本，源仓/产物之别，正常）');
    }
  } else {
    console.log('  Claude   : ✗ 未注册（claude plugin install fractal@fractal）');
  }
  // Codex: registration + hooks trust state
  const ctoml = readText(path.join(home, '.codex', 'config.toml'));
  if (/\[plugins\."fractal@[^"]+"\][^[]*?enabled\s*=\s*true/.test(ctoml)) {
    const hs = /\[hooks\.state\]([\s\S]*?)(?=\n\[|\s*$)/.exec(ctoml);
    const trusted = !!(hs && /\S/.test(hs[1] || ''));
    console.log(`  Codex    : ✅ 已注册启用；hooks 信任: ${trusted ? '已有记录' : '⚠️ [hooks.state] 为空——hooks 可能从未执行，需在 Codex 内审查并信任'}`);
  } else {
    console.log('  Codex    : ✗ 未注册（codex plugin add fractal@personal）');
  }
  return 0;
}

function cmdInstall() {
  console.log('# Cognitive Fractal 是 marketplace plugin（双端，本地稳定路径源）');
  console.log('Claude Code: claude plugin install fractal@fractal（升级 claude plugin update fractal@fractal + /reload-plugins）');
  console.log('Codex     : codex plugin add fractal@personal（升级 = bump version 后重跑本命令 + 重启；hooks 变更需重新信任）');
  console.log('发版流程   : bump .claude-plugin/plugin.json version → node scripts/release.mjs → 上面两条升级命令。');
  console.log('自检       : nav doctor（含双端注册与 Codex hooks 信任状态）。');
  return 0;
}

// ───────────────────── Capture gate (end-of-session semantic checkpoint) ─────────────────────
//
//  Goal: turn "check whether anything worth capturing" from a soft convention (easily skipped)
//  into a hard gate. If this session edited "meaningful project files" and hasn't captured yet,
//  block once at Stop, forcing the agent to either capture or explicitly declare nothing to capture.
//  Whether to capture is still the agent's call (iron rule: judgment belongs to the agent).
//  Trigger criteria (language/structure agnostic, no src/ assumption): files touched by Edit/Write
//  that are inside project root, not git-ignored, and not in .nav/. Non-git projects use a
//  built-in exclude list as fallback. At most one nudge per session; if capture already happened
//  (detected via .nav semantic file mtime comparison), the gate passes through.

const GATE_BUILTIN_EXCLUDE = [
  'node_modules/', 'dist/', 'build/', 'out/', 'target/', '.git/', '.nav/',
  'coverage/', '.cache/', 'vendor/', '__pycache__/', '.venv/', '.next/', '.nuxt/',
];

/** git check-ignore: true=ignored, false=not ignored (and is a git repo), null=git unavailable/not a repo */
function gitCheckIgnore(root, relN) {
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relN], { stdio: 'ignore' });
  if (r.error || typeof r.status !== 'number') return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null; // 128 = not a git repo / other error
}

/** Whether this Edit/Write targets a "meaningful project file" (determines whether to arm the gate). */
function isMeaningfulEdit(root, absFile) {
  const rel = path.relative(root, absFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside root
  const relN = rel.split(path.sep).join('/');
  if (relN === NAV_DIR || relN.startsWith(NAV_DIR + '/')) return false;    // .nav itself
  const ig = gitCheckIgnore(root, relN);
  if (ig === true) return false;                                          // git-ignored = generated/dependency
  if (ig === null) {                                                      // non-git → built-in fallback
    if (GATE_BUILTIN_EXCLUDE.some((d) => relN === d.slice(0, -1) || relN.startsWith(d) || relN.includes('/' + d))) return false;
    if (/(^|\/)([^/]*-lock\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*\.lock)$/.test(relN)) return false;
  }
  return true;
}

function gateStatePath(root, sid) {
  const safe = (sid || 'default').replace(/[^\w.-]+/g, '_');
  return path.join(root, NAV_DIR, '.cache', `capture-gate-${safe}.json`);
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJSON(p, o) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); } catch { /* gate is non-fatal */ } }

/** Kill-switch: .nav/config.json {"captureGate": false} disables this gate. */
function captureGateDisabled(root) {
  const cfg = readJSON(path.join(root, NAV_DIR, 'config.json'));
  return !!(cfg && cfg.captureGate === false);
}

/** Whether .nav/ semantic files were written after sinceMs (= capture already happened this session). */
function captureHappenedSince(root, sinceMs) {
  if (!sinceMs) return false;
  const navDir = path.join(root, NAV_DIR);
  const files = SEMANTIC_FILES.map((f) => path.join(navDir, f));
  try { for (const f of fs.readdirSync(path.join(navDir, NOTES_DIR))) if (f.endsWith('.md')) files.push(path.join(navDir, NOTES_DIR, f)); } catch { /* notes dir may not exist */ }
  for (const f of files) { try { if (fs.statSync(f).mtimeMs > sinceMs) return true; } catch { /* file may not exist */ } }
  return false;
}

/** Which existing nav entries are hit by files changed this session (reminder that old entries may be stale). */
function fragmentsForFiles(root, dirtyRel) {
  if (!dirtyRel || !dirtyRel.length) return [];
  const frags = loadFragments(root);
  const hits = [], seen = new Set();
  for (const rel of dirtyRel) {
    for (const f of frags) {
      if (f.anchors.some((a) => matchAnchor(a, rel))) {
        const key = `${f.source}::${f.title}`;
        if (!seen.has(key)) { seen.add(key); hits.push({ title: f.title, source: f.source }); }
      }
    }
  }
  return hits;
}

/** hook: read Claude Code hook payload (stdin JSON) and inject by event.
 *  Zero-disturbance rule: if .nav/ not found, exit 0 immediately — never disturb non-fractal projects. */
function cmdHook(args) {
  const event = args._[0] || '';
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* tolerate empty payload */ }
  const cwd = payload.cwd || process.cwd();
  let file = (payload.tool_input && (payload.tool_input.file_path || payload.tool_input.path)) || null;
  // Codex apply_patch compat: tool_input has no file_path, path is embedded in patch text
  if (!file && payload.tool_input) {
    for (const k of ['patch', 'input', 'changes', 'content']) {
      const v = payload.tool_input[k];
      if (typeof v === 'string') {
        const m = /\*{3}\s*(?:Update|Add|Delete) File:\s*(.+)/.exec(v);
        if (m) { file = m[1].trim(); break; }
      }
    }
  }
  if (file && !path.isAbsolute(file)) file = path.resolve(cwd, file); // resolve relative path against payload.cwd (hook process cwd is unreliable)
  const root = findProjectRoot(file || cwd);
  if (!root) return 0; // not a fractal project → zero disturbance

  if (event === 'PreToolUse') {
    if (!file) return 0;
    const rel = path.relative(root, path.resolve(root, file));
    // Skip injection for .nav/ itself (generic words in domains/protocols trigger vendor noise)
    const relNav = rel.split(path.sep).join('/');
    if (relNav === NAV_DIR || relNav.startsWith(NAV_DIR + '/')) return 0;
    // Arm capture gate: mark if this session edited a meaningful file (enhancement; failure never affects injection)
    try {
      if (isMeaningfulEdit(root, path.resolve(root, file))) {
        const sid = payload.session_id || 'default';
        const sp = gateStatePath(root, sid);
        const st = readJSON(sp) || { armed: false, armedAt: 0, nudged: false, dirty: [] };
        st.armed = true;
        if (!st.armedAt) st.armedAt = Date.now();
        const relN = rel.split(path.sep).join('/');
        if (!st.dirty.includes(relN) && st.dirty.length < 12) st.dirty.push(relN);
        writeJSON(sp, st);
      }
    } catch { /* gate arming is non-fatal */ }
    const parts = [];
    const sem = buildBriefText(root, { path: file });
    if (sem) parts.push(sem);
    // Live call-site hints (fact layer, best-effort): search basename of edited file to show who references it.
    // Skip basenames on the stoplist — these are also common English words whose rg hits are mostly unrelated.
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    const STOP_BASENAMES = new Set([
      'index', 'main', 'app', 'page', 'layout', 'route', 'routes',
      'urls', 'url', 'types', 'type', 'utils', 'util', 'helpers', 'helper',
      'config', 'configs', 'constants', 'consts', 'common', 'shared',
      'client', 'server', 'protocols', 'protocol', 'package', 'schema',
      'db', 'model', 'models', 'component', 'components', 'hooks', 'hook',
      'store', 'stores', 'lib', 'core', 'api',
    ]);
    if (base.length >= 3 && !STOP_BASENAMES.has(base.toLowerCase())) {
      const { hits, total } = rgRefs(base, root, 8);
      const ext = hits.filter((h) => h.file !== rel);
      if (ext.length) {
        parts.push(`〔事实·现场取〕\`${base}\` 被引用约 ${total} 处，例如：\n` +
          ext.slice(0, 6).map((h) => `  ${h.file}:${h.line}`).join('\n') +
          `\n改签名/删除前请确认这些调用方（文本匹配，请甄别同名）。`);
      }
    }
    if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n\n') } }));
    return 0;
  }
  if (event === 'Stop') {
    // Capture gate: session edited meaningful files (armed) && not yet nudged && has pending items → block once.
    // Pending items combine three categories: new semantics to capture, old entries hit by changed files, stale anchors.
    const sid = payload.session_id || 'default';
    const sp = gateStatePath(root, sid);
    const st = readJSON(sp);
    if (!captureGateDisabled(root) && st && st.armed && !st.nudged) {
      const needCapture = !captureHappenedSince(root, st.armedAt);
      const badAnchors = scanStale(root).filter((s) => s.missing.length); // hard stale — must clean
      const touched = fragmentsForFiles(root, st.dirty || []);            // old entries hit by changed files
      if (needCapture || badAnchors.length) {
        st.nudged = true;
        writeJSON(sp, st);
        const navBin = path.join(SKILL_ROOT, 'bin', 'nav.mjs');
        const list = (st.dirty || []).slice(0, 8).map((f) => `  · ${f}`).join('\n') || '  （若干文件）';
        const parts = ['〔Cognitive Fractal · 收尾健康检查（每会话一次硬门禁）〕', '本会话改动了以下项目文件：', list, ''];
        if (needCapture) {
          parts.push(
            '① 沉淀自检：本次是否产生了 grep 找不回、会话结束即丢失的「为什么 / 坑 / 联动 / 业务约定」？',
            `   · 有 → node ${navBin} capture --kind=note|protocol|domain --title="…" --anchor="…" --body="…"`,
            '   · 确无（纯改名/格式/琐碎修复）→ 回复「本次无需沉淀」。', '');
        }
        if (touched.length) {
          parts.push(
            '② 这些改动命中了现有 nav 条目，请核对其描述是否因本次改动已过时（尤其「未做 / 占位 / TODO / 待建」类，做完了要就地订正）：',
            ...touched.slice(0, 8).map((h) => `   · [${h.source}] ${h.title}`), '');
        }
        if (badAnchors.length) {
          parts.push(
            '③ ❌ 以下 nav 条目的 anchor 已失效（指向文件不存在），结束前必须清理——改对路径 / `nav touch` / 删条目：',
            ...badAnchors.slice(0, 8).map((s) => `   · [${s.source}] ${s.title} → ${s.missing.join('、')}`), '');
        }
        parts.push('以上由你（agent）判断处理；本门禁每会话只拦一次，处理完或显式声明后即可结束。');
        process.stdout.write(JSON.stringify({ decision: 'block', reason: parts.join('\n') }));
        return 0;
      }
    }
    cmdVerify({ path: root }); // gate not triggered → run mechanical audit (stdout for user reference)
    return 0;
  }
  return 0;
}

// ───────────────────── Output ─────────────────────

function output(content) {
  if (content) process.stdout.write(content + '\n');
  return 0;
}

// ───────────────────── Arg parsing + dispatch ─────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const COMMANDS = {
  init: cmdInit, brief: cmdBrief, refs: cmdRefs, scope: cmdScope, map: cmdMap,
  capture: cmdCapture, verify: cmdVerify, touch: cmdTouch,
  doctor: cmdDoctor, install: cmdInstall, hook: cmdHook,
};

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || !COMMANDS[cmd]) {
    console.log('nav — Cognitive Fractal CLI\n');
    console.log('命令: ' + Object.keys(COMMANDS).join(' / '));
    console.log('  init [root] [--force]              建 .nav/ 语义记忆层 + 入口 CLAUDE.md');
    console.log('  brief --path <f> | --task "<t>"    按需取相关语义（认知分形第2层）');
    console.log('  refs <symbol> [--max N]            现场取调用点（事实层，ripgrep）');
    console.log('  scope <符号|文件|关键词>           影响速写：语义+上下游+跨仓一次拼出（治头痛医头）');
    console.log('  map [--path <root>]                粗粒度全局地图（第3层缓存）');
    console.log('  capture --kind --title --body ...  沉淀一条语义（--update 原地更新同名条目）');
    console.log('  verify                             语义对账（失效锚点 / 陈旧条目）');
    console.log('  touch "<标题>"                     刷新条目核实时间');
    console.log('  doctor / install                   自检（含双端注册/信任）/ 安装与发版指引');
    return (cmd && cmd !== '--help' && cmd !== '-h' && !COMMANDS[cmd]) ? 1 : 0;
  }
  return COMMANDS[cmd](parseArgs(rest)) || 0;
}

process.exit(main());
