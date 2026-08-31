// tests/issue9-host.mjs —— #9 评审第 1 轮修复的 host 侧单元测试
// 覆盖：
//   P2-02：isValidRepo 边界矩阵（合法/非法 repo 名，含 .. / 首尾连字符 / 超长 / 非字符串）
//   P0-02：permissionWarning 纯函数（win32 提醒 / POSIX mode 判定）+ loadIssuePanelConfig
//          集成（进程内一次性提醒，不阻断加载）
// 运行：node tests/issue9-host.mjs（exit 0 = 全部 PASS）

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { permissionWarning, loadIssuePanelConfig, __TEST_ONLY_resetPermissionWarned } from '../lib/config.js';
import { isValidRepo } from '../lib/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name + (detail !== undefined ? ' :: ' + detail : ''));
  }
}

// ==================== P2-02: isValidRepo ====================
console.log('== P2-02: isValidRepo 边界矩阵 ==');

const VALID = [
  'sanfan3/dsh-issue-panel',
  'a/b',
  'o-r/r2',
  '_x/y_',
  'a.b/c.d',
  'A1/B2',
  'owner/repo-name.2024',
  'a/1',
  'owner/repo.git', // 宽松决策：.git 结尾故意放行，留给 GitHub API 兜底。
  // P2-02（#10 评审）：2026-09-01 实测 `gh api repos/{owner}/{repo}.git` 返回 404（GitHub
  // 不自动剥离 .git 后缀），即 .git 结尾 repo 名在 API 层必然被拒（404/422），
  // 本地放行无害——错误会在推送时以「GitHub 错误透传」可读提示呈现。
];
for (const repo of VALID) {
  assert(isValidRepo(repo) === true, `合法 repo 通过: ${repo}`);
}

const INVALID = [
  ['', '空串'],
  ['owner', '缺仓库段'],
  ['owner/', '仓库段为空'],
  ['/repo', 'owner 段为空'],
  ['owner/repo/extra', '三段'],
  ['owner//repo', '空段'],
  ['owner/re po', '含空格'],
  ['o..wner/repo', 'owner 含连续点号'],
  ['owner/re..po', 'repo 含连续点号'],
  ['-owner/repo', 'owner 以 - 开头'],
  ['owner/-repo', 'repo 以 - 开头'],
  ['owner/repo-', 'repo 以 - 结尾'],
  ['.owner/repo', 'owner 以 . 开头'],
  ['owner/repo.', 'repo 以 . 结尾'],
  ['owner/' + 'x'.repeat(101), 'repo 段超长（101）'],
  ['owner/\u4e2d\u6587', '非 ASCII'],
  ['owner\\repo', '反斜杠分隔'],
  ['https://x/y', 'URL 注入面（含 : 与 //）'],
  [null, 'null'],
  [42, '数字'],
  [undefined, 'undefined'],
];
for (const [repo, label] of INVALID) {
  assert(isValidRepo(repo) === false, `非法 repo 拒绝（${label}）`, 'repo=' + JSON.stringify(repo));
}

// ==================== P0-02: permissionWarning ====================
console.log('== P0-02: permissionWarning 判定 ==');

const winMsg = permissionWarning(0o100644, 'win32');
assert(typeof winMsg === 'string' && winMsg.includes('config.json'), 'win32：无法校验 ACL → 固定提醒（含 config.json 字样）', 'msg=' + winMsg);
assert(typeof permissionWarning(null, 'win32') === 'string', 'win32：stat 失败（mode=null）仍提醒');

const posix644 = permissionWarning(0o100644, 'linux');
assert(typeof posix644 === 'string' && posix644.includes('chmod 600'), 'POSIX 0644（group/other 可读）→ 提醒 chmod 600', 'msg=' + posix644);
assert(permissionWarning(0o100600, 'linux') === null, 'POSIX 0600（仅 owner 读写）→ 不提醒');
assert(typeof permissionWarning(0o100640, 'linux') === 'string', 'POSIX 0640（group 可读）→ 提醒');
assert(permissionWarning(0o100400, 'linux') === null, 'POSIX 0400（仅 owner 读）→ 不提醒');
assert(typeof permissionWarning(0o100444, 'linux') === 'string', 'POSIX 0444（全员可读）→ 提醒');
assert(permissionWarning(0o100600, 'darwin') === null, 'macOS 0600 → 不提醒（POSIX 分支同规则）');
// P1-01（#9 评审第 2 轮）：POSIX 下 stat 失败（mode=null）也要提醒「无法校验建议 chmod 600」，
// 与 win32「无法校验即提醒」策略一致——安全提醒宁可多不可漏。
const posixNull = permissionWarning(null, 'linux');
assert(typeof posixNull === 'string' && posixNull.includes('chmod 600'), 'POSIX stat 失败（mode=null）→ 提醒 chmod 600（安全提醒不静默）', 'msg=' + posixNull);

// ==================== P0-02: loadIssuePanelConfig 集成（一次性提醒，不阻断加载） ====================
console.log('== P0-02: loadIssuePanelConfig 集成 ==');

// P1-03（#10 评审）：模块级 permissionWarned 跨用例残留会污染「首次提醒」断言
// （若其它用例先触发提醒，此处第一次读取就不会再提醒）→ 先重置保证隔离。
__TEST_ONLY_resetPermissionWarned();

const tmpHome = await mkdtemp(join(tmpdir(), 'dsh-ip-test-'));
const cfgDir = join(tmpHome, 'issue-panel');
await mkdir(cfgDir, { recursive: true });
await writeFile(join(cfgDir, 'config.json'), JSON.stringify({ repo: 'sanfan3/dsh-issue-panel', token: 'ghp_test' }), 'utf8');

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
try {
  const cfg = await loadIssuePanelConfig(tmpHome);
  assert(cfg && cfg.repo === 'sanfan3/dsh-issue-panel' && cfg.token === 'ghp_test', '配置读取成功（提醒不阻断加载）');
  assert(warns.length === 1 && warns[0].includes('config.json'), '首次读取发出权限提醒（一次性）', 'warns=' + JSON.stringify(warns));

  // 第二次读取：permissionWarned 标志 → 不再重复提醒
  const cfg2 = await loadIssuePanelConfig(tmpHome);
  assert(cfg2 && cfg2.token === 'ghp_test', '第二次读取仍正常');
  assert(warns.length === 1, '第二次读取不再重复提醒（进程内一次性）', 'warns=' + JSON.stringify(warns));
} finally {
  console.warn = origWarn;
  await rm(tmpHome, { recursive: true, force: true });
}

// ==================== 汇总 ====================
console.log('----------------------------------------');
console.log(`issue9-host: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
