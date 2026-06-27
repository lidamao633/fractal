// nav.mjs 回归测试 — node:test 黑盒子进程测试（零依赖）。
// 每个用例覆盖一个历史真实 bug 或 v0.1.1 补丁的验收点；用例间互不依赖（各自建临时项目）。
// 跑法：node --test tests/   （release.mjs 将其设为发布门禁）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAV = path.resolve(import.meta.dirname, '..', 'bin', 'nav.mjs');

function nav(args, opts = {}) {
  return spawnSync('node', [NAV, ...args], { encoding: 'utf8', ...opts });
}
function hook(event, payload) {
  return spawnSync('node', [NAV, 'hook', event], { encoding: 'utf8', input: JSON.stringify(payload) });
}
function mkProj(t, name = 'p') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `navtest-${name}-`));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function init(dir) {
  const r = nav(['init', dir]);
  assert.equal(r.status, 0, `init 失败: ${r.stderr}`);
  return r;
}

// ── init 与模板 ──────────────────────────────────────────────

test('init 建骨架，模板零占位条目，首次 verify 零报警（B6）', (t) => {
  const dir = mkProj(t, 'init');
  init(dir);
  assert.ok(fs.existsSync(path.join(dir, '.nav', 'domains.md')));
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
  const doctor = nav(['doctor'], { cwd: dir });
  assert.match(doctor.stdout, /语义条目 : 0/, '新项目不该有任何占位条目（开箱报警 bug）');
  const verify = nav(['verify', '--path', dir]);
  assert.match(verify.stdout, /未发现失效锚点|✅/);
});

// ── capture 全家 ─────────────────────────────────────────────

test('capture domain + brief --task 按 trigger 召回', (t) => {
  const dir = mkProj(t, 'brief');
  init(dir);
  const c = nav(['capture', '--path', dir, '--kind=domain', '--title=鉴权域', '--trigger=登录, auth', '--anchor=src/**', '--body=登录发 JWT']);
  assert.equal(c.status, 0, c.stderr);
  const b = nav(['brief', '--task', '用户登录失败了'], { cwd: dir }); // --path 语义是按文件匹配，与 --task 互斥
  assert.match(b.stdout, /鉴权域/);
});

test('capture 同名默认拒绝，--update 原地替换且不重复（B2）', (t) => {
  const dir = mkProj(t, 'update');
  init(dir);
  nav(['capture', '--path', dir, '--kind=domain', '--title=支付域', '--trigger=支付', '--body=旧正文 v1']);
  const dup = nav(['capture', '--path', dir, '--kind=domain', '--title=支付域', '--trigger=支付', '--body=新正文 v2']);
  assert.equal(dup.status, 1, '同名应拒绝');
  assert.match(dup.stderr, /--update/);
  const upd = nav(['capture', '--path', dir, '--kind=domain', '--title=支付域', '--trigger=支付', '--body=新正文 v2', '--update']);
  assert.equal(upd.status, 0, upd.stderr);
  const text = fs.readFileSync(path.join(dir, '.nav', 'domains.md'), 'utf8');
  assert.equal((text.match(/## 支付域/g) || []).length, 1, '同名条目只能有一份');
  assert.match(text, /新正文 v2/);
  assert.doesNotMatch(text, /旧正文 v1/);
});

test('capture body 内 meta 行剥离进 header（历史 bug：trigger 写进 body 召回失效）', (t) => {
  const dir = mkProj(t, 'meta');
  init(dir);
  nav(['capture', '--path', dir, '--kind=domain', '--title=结算域', '--body=- trigger: 结算, 对账\n结算走 T+1。']);
  const text = fs.readFileSync(path.join(dir, '.nav', 'domains.md'), 'utf8');
  const block = text.slice(text.indexOf('## 结算域'));
  assert.match(block.split('\n').slice(0, 4).join('\n'), /- trigger: 结算, 对账/, 'trigger 应进 header 区');
  const b = nav(['brief', '--task', '对账差额排查'], { cwd: dir });
  assert.match(b.stdout, /结算域/, '剥离后应可按 trigger 召回');
});

test('跨仓 anchor-only note 被硬拦，带 trigger 或 --force 放行（B7·LOGO 教训）', (t) => {
  const dir = mkProj(t, 'cross');
  init(dir);
  const blocked = nav(['capture', '--path', dir, '--kind=note', '--title=后端坑', '--anchor=../other-server/src/**', '--body=坑在对端']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /跨仓/);
  const okTrig = nav(['capture', '--path', dir, '--kind=note', '--title=后端坑', '--anchor=../other-server/src/**', '--trigger=上传, 回显', '--body=坑在对端']);
  assert.equal(okTrig.status, 0, okTrig.stderr);
  const okForce = nav(['capture', '--path', dir, '--kind=note', '--title=后端坑2', '--anchor=../other-server/src/**', '--body=坑在对端', '--force']);
  assert.equal(okForce.status, 0, okForce.stderr);
});

test('capture 含凭据时 stderr 警告但不阻塞（B4）', (t) => {
  const dir = mkProj(t, 'cred');
  init(dir);
  const r = nav(['capture', '--path', dir, '--kind=note', '--title=测试账号', '--anchor=README.md', '--body=password: hunter2 登录用']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /凭据/);
});

// ── 解析层 ───────────────────────────────────────────────────

test('条目正文里的 "## 子标题" 不再被拆成伪条目（B10·gaizhang 污染案例）', (t) => {
  const dir = mkProj(t, 'parse');
  init(dir);
  fs.writeFileSync(path.join(dir, '.nav', 'protocols.md'), [
    '## 云加载协议',
    '- anchor: src/**',
    '- verified: 2026-06-01',
    '正文开始。',
    '## 为什么',
    '因为历史原因。',
    '## 类似场景类推',
    '同上。',
    '',
  ].join('\n'));
  const doctor = nav(['doctor'], { cwd: dir });
  assert.match(doctor.stdout, /语义条目 : 1/, '"## 为什么" 等无 meta 子标题不应算条目');
});

// ── hook：注入 / 排除 / 零打扰 / apply_patch ─────────────────

test('PreToolUse 按 anchor 注入相关记忆 JSON（核心链路）', (t) => {
  const dir = mkProj(t, 'inject');
  init(dir);
  nav(['capture', '--path', dir, '--kind=protocol', '--title=接口联动', '--trigger=接口', '--anchor=src/**', '--body=改 a 必须同步 b']);
  const r = hook('PreToolUse', { cwd: dir, session_id: 's1', tool_input: { file_path: path.join(dir, 'src', 'a.js') } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /接口联动/);
});

test('编辑 .nav/ 自身零注入（B3·vendor COPYING 噪声案例）', (t) => {
  const dir = mkProj(t, 'navself');
  init(dir);
  nav(['capture', '--path', dir, '--kind=domain', '--title=域A', '--trigger=domains', '--anchor=.nav/**', '--body=x']);
  const r = hook('PreToolUse', { cwd: dir, session_id: 's1', tool_input: { file_path: path.join(dir, '.nav', 'domains.md') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', '.nav 内编辑不应有任何注入');
});

test('非分形项目零打扰（铁律）', (t) => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'navtest-bare-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const r = hook('PreToolUse', { cwd: bare, session_id: 's1', tool_input: { file_path: path.join(bare, 'x.js') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('Codex apply_patch payload 提取路径并注入（A7）', (t) => {
  const dir = mkProj(t, 'patch');
  init(dir);
  nav(['capture', '--path', dir, '--kind=protocol', '--title=补丁联动', '--trigger=补丁', '--anchor=src/**', '--body=apply_patch 也要被接住']);
  const patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** End Patch';
  const r = hook('PreToolUse', { cwd: dir, session_id: 's1', tool_input: { patch } });
  assert.equal(r.status, 0);
  assert.ok(r.stdout, 'apply_patch 应解析出 src/a.js 并注入');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /补丁联动/);
});

test('Stop 门禁：武装后 block 一次、第二次放行（状态机）', (t) => {
  const dir = mkProj(t, 'gate');
  init(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'x');
  const arm = hook('PreToolUse', { cwd: dir, session_id: 'gate1', tool_input: { file_path: path.join(dir, 'src', 'a.js') } });
  assert.equal(arm.status, 0);
  const stop1 = hook('Stop', { cwd: dir, session_id: 'gate1' });
  assert.match(stop1.stdout, /"decision":"block"/, '首次 Stop 应被门禁拦截');
  assert.match(stop1.stdout, /收尾健康检查/);
  const stop2 = hook('Stop', { cwd: dir, session_id: 'gate1' });
  assert.doesNotMatch(stop2.stdout, /"decision":"block"/, '每会话最多拦一次');
});

// ── 跨仓协议生成（B1）──────────────────────────────────────

test('整簇点火：协议 anchor 取实存顶层目录、必带 trigger，无 src 仓不写死锚（B1）', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'navtest-cluster-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const a = path.join(parent, 'repo-go');     // 无 src/，有 internal/（Go 风格 → 旧版死锚案例）
  const b = path.join(parent, 'repo-front');  // 有 src/
  fs.mkdirSync(path.join(a, 'internal'), { recursive: true });
  fs.mkdirSync(path.join(b, 'src'), { recursive: true });
  for (const d of [a, b]) spawnSync('git', ['-C', d, 'init', '-q']);
  const r = nav(['init', a, '--associated', '../repo-front']);
  assert.equal(r.status, 0, r.stderr);
  const protoA = fs.readFileSync(path.join(a, '.nav', 'protocols.md'), 'utf8');
  assert.match(protoA, /- anchor: internal\/\*\*/, 'anchor 应取实存目录 internal 而非硬编码 src');
  assert.doesNotMatch(protoA, /- anchor: src\/\*\*/);
  assert.match(protoA, /- trigger: .*repo-front/, '跨仓协议必带含对端仓名的 trigger');
  const protoB = fs.readFileSync(path.join(b, '.nav', 'protocols.md'), 'utf8');
  assert.match(protoB, /- anchor: src\/\*\*/);
  assert.match(protoB, /- trigger: .*repo-go/);
});

// ── 事实层 ───────────────────────────────────────────────────

test('refs 现场取引用', (t) => {
  const dir = mkProj(t, 'refs');
  init(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export function helloNav() {}\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), "import { helloNav } from './a.js'\nhelloNav()\n");
  const r = nav(['refs', 'helloNav', '--path', dir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b\.js/);
});

test('scope 三路召回：无 trigger 的 note 也能按内容召回（LOGO 回放）', (t) => {
  const dir = mkProj(t, 'scope');
  init(dir);
  nav(['capture', '--path', dir, '--kind=note', '--title=LOGO回显坑', '--anchor=src/upload.js', '--body=后端 FileService 用了内网 endpoint，prod 必裂', '--force']);
  const r = nav(['scope', 'FileService', '--path', dir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LOGO回显坑/, '内容路召回应命中无 trigger 的 note');
});
