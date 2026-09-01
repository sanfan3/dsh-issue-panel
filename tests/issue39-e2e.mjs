// tests/issue39-e2e.mjs —— #39 左右对比弹窗 + 引用合并确认 端到端测试（影子实例 8091）
//
// 前置：影子实例 8091 已启动且加载最新插件（boot + 测试放同一条命令，避免实例被回收）。
// 用法：node tests/issue39-e2e.mjs
//
// 测试点：
//   A client.js 服务可达，且包含 #39 对比弹窗代码（样式类 / createCompareModal /
//     放弃（不改动） / ✓ 确认替换 / /api/issue-panel/optimize 调用）
//   B POST /optimize 路由可达（错误信封模式：沙箱下 spawn EPERM → 502 双模式；
//     生产环境 → 200 含 draft；无论哪种都验证信封结构与无 token 泄露）
//   C GET /config 无 token 泄露（回归）
//   D 面板页面路由不 404（client.js 服务）
//
// 说明：对比弹窗的确认/放弃/合并交互属纯客户端 DOM 行为，由 tests/issue39-dom.mjs
// 覆盖（stub 环境 54 用例）；本脚本验证「host 链路 + 插件产物」在真实实例上仍可用。

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8091';

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

// --- A：client.js 服务产物包含 #39 代码 ---
{
  const res = await fetch(BASE + '/plugins/dsh-issue-panel/client.js');
  const text = await res.text();
  check('A1 client.js HTTP 200', res.status === 200, 'status=' + res.status);
  check('A2 含对比弹窗样式类 .dsh-ip-cmp-overlay', text.includes('dsh-ip-cmp-overlay'));
  check('A3 含 createCompareModal 函数', text.includes('function createCompareModal'));
  check('A4 含「放弃（不改动）」按钮文案', text.includes('放弃（不改动）'));
  check('A5 含「✓ 确认替换」按钮文案', text.includes('✓ 确认替换'));
  check('A6 含 /api/issue-panel/optimize 调用', text.includes('/api/issue-panel/optimize'));
  check('A7 含 applyOptimizedDraft（确认替换写回表单）', text.includes('function applyOptimizedDraft'));
  check('A8 含「（空）」空字段占位', text.includes('（空）'));
  check('A9 含「优化中…」请求中提示', text.includes('优化中…'));
}

// --- B：POST /optimize 路由可达（双模式信封） ---
{
  const draft = {
    title: '做 一个 需求面板 插件 用于 提交 issue',
    task: '先搭建表单 再实现推送',
    refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1'],
    acceptItems: ['- [ ] 表单四字段齐全'],
  };
  try {
    const res = await fetch(BASE + '/api/issue-panel/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 下面断言 */ }
    const bodyText = JSON.stringify(data || {});
    check('B1 optimize 路由可达（200 或 502 双模式，非 404/500 裸响应）', res.status === 200 || res.status === 502, 'status=' + res.status + ' body=' + bodyText.slice(0, 200));
    if (res.status === 200) {
      check('B2 成功信封 {ok:true,value:{draft,parseError}}', data && data.ok === true && data.value && data.value.draft, bodyText.slice(0, 200));
      const d = data && data.value && data.value.draft ? data.value.draft : {};
      check('B3 用户已填引用保留（合并不覆盖）', Array.isArray(d.refs) && d.refs.includes(draft.refs[0]), JSON.stringify(d.refs));
      check('B4 响应不含 token', !bodyText.includes('ghp_') && !bodyText.includes('token'));
    } else {
      check('B2 失败信封 {ok:false,error:{code,message}}', data && data.ok === false && data.error && data.error.code && data.error.message, bodyText.slice(0, 200));
      check('B4 错误信封不含 token', !bodyText.includes('ghp_') && !bodyText.includes('token'));
      console.log('   （沙箱环境 spawn 受限 → 502 信封，属预期；真实 headless 链由直接实测+单测覆盖）');
    }
  } catch (e) {
    check('B1 optimize 路由可达', false, String(e));
  }
}

// --- C：config 路由无 token 泄露（回归） ---
{
  const res = await fetch(BASE + '/api/issue-panel/config');
  const body = await res.text();
  check('C1 config 路由 200 无 token', res.status === 200 && !body.includes('token') && !body.includes('ghp_'), 'status=' + res.status);
}

// --- D：GET optimize → 405（方法校验回归） ---
{
  const res = await fetch(BASE + '/api/issue-panel/optimize');
  const data = await res.json().catch(() => null);
  check('D1 GET optimize → 405 + 错误信封', res.status === 405 && data && data.ok === false && data.error && data.error.code === 'method-not-allowed', 'status=' + res.status);
}

console.log(`\nissue39-e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
