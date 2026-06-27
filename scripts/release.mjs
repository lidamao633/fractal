#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  release — fractal 双端发布管线（机械可复现，治"手搓发布"全家病）
//
//  指导思想（plan §0.5）：源仓是唯一真相源，发行物是可随时重建的机械产物；
//  依赖单向：源仓(git HEAD) → 发行物(稳定路径) → 运行时 cache。
//
//  用法: node scripts/release.mjs [--zip] [--allow-dirty] [--skip-tests]
//  产物: ~/.claude/plugins/local-sources/fractal/        (Claude marketplace 源)
//        ~/.codex/plugins/local-sources/fractal-codex/   (Codex marketplace 源)
//        [--zip] ~/Desktop/fractal-{claude,codex}-plugin-v<version>.zip
//  升级: claude plugin update fractal@fractal && /reload-plugins
//        codex plugin add fractal@personal && 重启 Codex（hook 变更需重新信任）
// ════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const OUT_CLAUDE = path.join(HOME, '.claude', 'plugins', 'local-sources', 'fractal');
const OUT_CODEX = path.join(HOME, '.codex', 'plugins', 'local-sources', 'fractal-codex');

// git archive 白名单（发行物来源，每个路径都必须已提交，否则 git archive 整体 fatal → 空包）。
// packaging/ 与 hooks.codex.json 已 gitignore，故不进白名单；codex 组装时直接从工作区 ROOT 读它们（见下）。
const ARCHIVE_PATHS = [
  'bin', 'scripts/hooks', 'templates', 'references', 'hooks',
  'SKILL.md', 'README.md', 'NOTICE', '.claude-plugin',
];

const args = new Set(process.argv.slice(2));
const die = (msg) => { console.error(`[release] ✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`[release] ${msg}`);
const sh = (cmd, opts = {}) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: ROOT, ...opts });

// ── 1. 前置校验 ──────────────────────────────────────────────
const dirty = sh('git status --porcelain').stdout.trim();
if (dirty && !args.has('--allow-dirty')) {
  die(`git 工作区不干净（发布必须从已提交状态出包，否则版本指纹失真）:\n${dirty}\n先 commit，或显式 --allow-dirty。`);
}

if (!args.has('--skip-tests')) {
  ok('跑回归测试…');
  const t = spawnSync('node', ['--test', 'tests/nav.test.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (t.status !== 0) die(`测试未通过，拒绝发布。\n${(t.stdout || '').split('\n').filter((l) => l.startsWith('not ok') || l.startsWith('# fail')).join('\n')}`);
  ok('测试全绿 ✅');
}

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
for (const f of ['hooks/hooks.json', 'hooks/hooks.codex.json', 'packaging/codex-plugin.json',
  'packaging/codex-marketplace.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  try { readJSON(path.join(ROOT, f)); } catch (e) { die(`${f} 不是合法 JSON: ${e.message}`); }
}

const semver = readJSON(path.join(ROOT, '.claude-plugin', 'plugin.json')).version;
if (!/^\d+\.\d+\.\d+$/.test(semver)) die(`plugin.json version 非 semver: ${semver}`);
// version 是两端更新检测的唯一钥匙——与上次发布产物相同则拒绝（治"忘 bump 拿不到更新"）
try {
  const prev = readJSON(path.join(OUT_CLAUDE, '.claude-plugin', 'plugin.json')).version;
  if (prev === semver) die(`version ${semver} 与上次发布相同——bump .claude-plugin/plugin.json 后再发（不 bump 两端都拿不到更新）。`);
} catch { /* 首次发布，无上次产物 */ }

// ── 2. 从 git HEAD 导出 staging（不是工作区 copy）──────────────
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-release-'));
// set -o pipefail：否则 git archive 失败时退出码被下游 tar 的 0 掩盖 → 空包却误报成功
const arch = sh(`set -o pipefail; git archive HEAD ${ARCHIVE_PATHS.join(' ')} | tar -x -C "${staging}"`);
if (arch.status !== 0) die(`git archive 失败（白名单路径是否都已提交？）: ${arch.stderr}`);

// ── 3. Claude 包 → 稳定路径 ──────────────────────────────────
fs.rmSync(OUT_CLAUDE, { recursive: true, force: true });
fs.mkdirSync(path.dirname(OUT_CLAUDE), { recursive: true });
fs.cpSync(staging, OUT_CLAUDE, { recursive: true });
fs.rmSync(path.join(OUT_CLAUDE, 'packaging'), { recursive: true, force: true });
fs.rmSync(path.join(OUT_CLAUDE, 'hooks', 'hooks.codex.json'), { force: true });
ok(`Claude 包 v${semver} → ${OUT_CLAUDE}`);

// ── 4. Codex 包 → 稳定路径（version 带 build metadata，每版必变 = 强制刷新 cache）──
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const codexVersion = `${semver}+codex.${ts}`;
const pkgRoot = path.join(OUT_CODEX, 'plugins', 'fractal');
fs.rmSync(OUT_CODEX, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_CODEX, '.agents', 'plugins'), { recursive: true });
fs.mkdirSync(path.join(pkgRoot, '.codex-plugin'), { recursive: true });
fs.mkdirSync(path.join(pkgRoot, 'hooks'), { recursive: true });
fs.cpSync(path.join(ROOT, 'packaging', 'codex-marketplace.json'), path.join(OUT_CODEX, '.agents', 'plugins', 'marketplace.json'));
const codexPlugin = readJSON(path.join(ROOT, 'packaging', 'codex-plugin.json'));
codexPlugin.version = codexVersion;
fs.writeFileSync(path.join(pkgRoot, '.codex-plugin', 'plugin.json'), JSON.stringify(codexPlugin, null, 2) + '\n');
fs.cpSync(path.join(ROOT, 'hooks', 'hooks.codex.json'), path.join(pkgRoot, 'hooks', 'hooks.json'));
// skills/fractal/ = staging 内容，剔除 plugin 层已承载/不相关的部分（hooks 由 plugin 层定义；.claude-plugin/packaging 是别端清单）
const skillDst = path.join(pkgRoot, 'skills', 'fractal');
fs.cpSync(staging, skillDst, { recursive: true });
for (const x of ['.claude-plugin', 'packaging', 'hooks']) fs.rmSync(path.join(skillDst, x), { recursive: true, force: true });
ok(`Codex 包 v${codexVersion} → ${OUT_CODEX}`);

// ── 5. 可选 zip（干净分发件：无 .git、白名单制无私货）─────────
if (args.has('--zip')) {
  for (const [src, name] of [[OUT_CLAUDE, `fractal-claude-plugin-v${semver}.zip`], [OUT_CODEX, `fractal-codex-plugin-v${semver}.zip`]]) {
    const dst = path.join(HOME, 'Desktop', name);
    fs.rmSync(dst, { force: true });
    const z = sh(`cd "${path.dirname(src)}" && zip -qr "${dst}" "${path.basename(src)}"`);
    if (z.status !== 0) die(`zip 失败: ${z.stderr}`);
    ok(`分发件 → ~/Desktop/${name}`);
  }
}

// ── 6. git tag ───────────────────────────────────────────────
const tag = `v${semver}`; // 与 GitHub Release 约定一致（v{semver}）；不用 claude 插件的 {name}--v{semver} 以免双轨
if (sh(`git rev-parse -q --verify refs/tags/${tag}`).status === 0) {
  ok(`tag ${tag} 已存在，跳过`);
} else {
  const tg = sh(`git tag ${tag}`);
  ok(tg.status === 0 ? `已打 tag ${tag}` : `⚠️ 打 tag 失败（不阻塞发布）: ${tg.stderr}`);
}

fs.rmSync(staging, { recursive: true, force: true });

// ── 7. 升级指引 ──────────────────────────────────────────────
console.log(`
[release] ✅ v${semver} 双端产物就绪。升级：
  Claude Code : claude plugin update fractal@fractal （会话内再 /reload-plugins，或新开会话）
  Codex       : codex plugin add fractal@personal （然后重启 Codex；hook 命令有变更时需重新信任）
  自检        : nav doctor（双端注册 + Codex hooks 信任状态）
  回滚        : git checkout v<旧版> -- . && node scripts/release.mjs --allow-dirty + 两端重装`);
