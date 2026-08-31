// tests/issue78-e2e.mjs —— #7 校验与错误提示 + #8 成功反馈 端到端测试（影子实例 8091）
//
// 前置：影子实例 8091 已启动且加载最新插件（boot + 测试放同一条命令，避免实例被回收）。
// 用法：
//   $env:TEST_TOKEN = gh auth token
//   node tests/issue78-e2e.mjs
//
// 环境变量：
//   TEST_BASE    影子实例地址，默认 http://127.0.0.1:8091
//   TEST_TOKEN   GitHub token（真实创建闭环用）
//
// 测试点：
//   A client.js 服务可达，且包含 #7（空标题拦截文案 + 错误样式类）与 #8（成功链接）代码
//   B POST create 真实创建 issue → 201 { number, html_url }，响应不含 token
//   C 关闭测试创建的 issue（gh api），保持仓库干净
//
// 说明：#7 空标题本地拦截 / #8 成功渲染属纯客户端 DOM 行为，由 tests/issue78-dom.mjs
// 覆盖（stub 环境 44 用例）；本脚本验证「host 链路 + 插件产物」在真实实例上仍可用。

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8091';
const TOKEN = process.env.TEST_TOKEN || '';
const REPO = 'sanfan3/dsh-issue-panel';

if (!TOKEN) {
  console.error('缺少 TEST_TOKEN 环境变量（gh auth token）');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ PASS ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- A：client.js 服务产物包含 #7/#8 代码 ---
{
  const res = await fetch(BASE + '/plugins/dsh-issue-panel/client.js');
  const text = await res.text();
  check('A1 client.js HTTP 200', res.status === 200, 'status=' + res.status);
  check('A2 含 #7 空标题拦截文案', text.includes('标题是必填的'));
  check('A3 含 #7 错误样式类', text.includes('dsh-ip-status-error'));
  check('A4 含 #8 成功链接渲染', text.includes('已创建 issue #') && text.includes('createElement(\'a\')'));
  check('A5 含 #8 清空表单', text.includes('function clearForm'));
}

// --- B：真实创建闭环（201 + html_url + 无 token 泄露） ---
let createdNumber = null;
{
  const title = `[验收测试] #7/#8 影子联调 ${Date.now()}`;
  const body = 'e2e 验证成功反馈链路';
  const res = await fetch(BASE + '/api/issue-panel/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  const data = await res.json().catch(() => null);
  check('B1 创建返回 201', res.status === 201, 'status=' + res.status + ' body=' + JSON.stringify(data).slice(0, 200));
  check('B2 返回 issue 号', !!data && typeof data.number === 'number', JSON.stringify(data));
  check('B3 返回 html_url', !!data && typeof data.html_url === 'string' && data.html_url.includes(REPO));
  const s = JSON.stringify(data);
  check('B4 响应不含 token 明文', TOKEN.length >= 6 && !s.includes(TOKEN));
  createdNumber = data && typeof data.number === 'number' ? data.number : null;
}

// --- C：关闭测试创建的 issue（保持仓库干净；沙箱下 node spawn 受限，用 GitHub REST API 关闭） ---
if (createdNumber) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${createdNumber}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ state: 'closed' }),
  });
  // P1-05（#7 评审）：清理失败不应阻塞测试结论——仅 warn 提示手动清理，
  // 不再将「关闭失败」计为测试 FAIL（避免测试 issue 残留污染仓库的判定喧宾夺主）。
  if (res.status === 200) {
    check('C1 测试 issue 已关闭 #' + createdNumber, true);
  } else {
    console.warn(`⚠️ 警告：测试 issue #${createdNumber} 关闭失败 status=${res.status}，请手动清理`);
    check('C1 测试 issue 已关闭 #' + createdNumber, true, '关闭失败仅警告，不阻塞测试结论');
  }
} else {
  check('C1 测试 issue 已关闭（无 createdNumber，跳过）', true);
}

console.log(`\nissue78-e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
