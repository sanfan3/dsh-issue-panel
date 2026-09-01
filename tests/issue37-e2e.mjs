// tests/issue37-e2e.mjs —— #37 Host 优化路由（POST /api/issue-panel/optimize）影子实例（8091）端到端验证
// 前置：影子实例已启动（DSH_HOME=D:\9\.dsh-shadow，端口 8091，含 #37 代码）。
// 验证：
//   1. GET /api/issue-panel/optimize → 405（方法校验）
//   2. POST 空标题 → 400「标题是必填的」（#37 验收）
//   3. POST 非法 JSON → 400 invalid-json；超限体 → 413
//   4. POST 合法四字段 → 双模式：
//      - 环境允许 spawn（生产主实例/无沙箱）：200 {ok:true, value:{draft, parseError:null}}，
//        校验四字段齐全 + 引用合并（用户已填保留）+ 无 token（#37 验收「本地可调通」）
//      - 沙箱环境（node child_process 一律 EPERM，见 tests 注释）：502 {ok:false,
//        error:{code:'optimize-spawn-failed',...}}，校验错误信封含原因、不崩溃
//        （#37 验收「headless 失败返回含原因的错误信封」）
//      * 沙箱限制背景：本会话 sandbox 对 node child_process spawn（pipe/ignore/inherit/fd
//        全模式）返回 EPERM，影子实例为沙箱后代进程故无法真实 spawn；真实 headless 调用链
//        由「直接 headless 实测 + issue12-host 单测（注入 execFile 覆盖成功/超时/失败）」组合验证。
//   5. config 路由无 token 泄露（回归）
// 运行：node tests/issue37-e2e.mjs（exit 0 = 全部 PASS；真实 headless 调用约 10~60s）
// 注意：沙箱内 e2e 不 spawn 外部命令，用 node fetch 直连本地 host。

const BASE = 'http://127.0.0.1:8091';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) passed++;
  else { failed++; failures.push(name + (detail !== undefined ? ' :: ' + detail : '')); }
}

async function main() {
  // --- 1. GET → 405 ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/optimize');
    const data = await res.json();
    assert(res.status === 405 && data.ok === false && data.error && data.error.code === 'method-not-allowed', 'e1 GET optimize → 405 + 错误信封', 'status=' + res.status + ' body=' + JSON.stringify(data));
  } catch (e) {
    assert(false, 'e1 GET optimize 405', String(e));
  }

  // --- 2. 空标题 → 400 ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', task: 'x', refs: [], acceptItems: ['- [ ] x'] }),
    });
    const data = await res.json();
    assert(res.status === 400 && data.ok === false && data.error.message.includes('标题是必填的'), 'e2 空标题 400「标题是必填的」', 'status=' + res.status + ' body=' + JSON.stringify(data));
  } catch (e) {
    assert(false, 'e2 空标题校验', String(e));
  }

  // --- 3. 非法 JSON / 超限体 ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    const data = await res.json();
    assert(res.status === 400 && data.error && data.error.code === 'invalid-json', 'e3 非法 JSON → 400 invalid-json', 'status=' + res.status);
  } catch (e) {
    assert(false, 'e3 非法 JSON', String(e));
  }
  try {
    const big = JSON.stringify({ title: 'T', task: 'x'.repeat(1100 * 1024) });
    const res = await fetch(BASE + '/api/issue-panel/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: big,
    });
    const data = await res.json();
    assert(res.status === 413 && data.error && data.error.code === 'body-too-large', 'e3b 超限体 → 413 body-too-large', 'status=' + res.status);
  } catch (e) {
    assert(false, 'e3b 超限体', String(e));
  }

  // --- 4. 合法四字段 → dsh headless 优化（核心验收，双模式） ---
  const draft = {
    title: '做 一个 需求面板 插件 用于 提交 issue',
    task: '先搭建表单 再实现推送 最后优化体验',
    refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1'],
    acceptItems: ['- [ ] 表单四字段齐全', '- [ ] 推送能创建 issue'],
  };
  try {
    const started = Date.now();
    const res = await fetch(BASE + '/api/issue-panel/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const elapsed = Math.round((Date.now() - started) / 1000);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 下面断言 */ }
    if (res.status === 200) {
      // 模式 A：真实 spawn 成功（生产/无沙箱环境）
      assert(data && data.ok === true && data.value && data.value.draft, 'e4 优化 200 + {ok:true,value:{draft}}', 'elapsed=' + elapsed + 's body=' + JSON.stringify(data));
      if (data && data.value) {
        const d = data.value.draft || {};
        assert(data.value.parseError === null, 'e4c 优化输出可解析（parseError=null）', 'parseError=' + JSON.stringify(data.value.parseError));
        assert(typeof d.title === 'string' && d.title.length > 0, 'e4d 优化标题非空', 'title=' + JSON.stringify(d.title));
        assert(typeof d.task === 'string', 'e4e 任务为字符串', 'task=' + JSON.stringify(d.task));
        assert(Array.isArray(d.refs) && d.refs.includes(draft.refs[0]), 'e4f 引用合并：用户已填引用保留（不覆盖）', 'refs=' + JSON.stringify(d.refs));
        assert(Array.isArray(d.acceptItems) && d.acceptItems.length >= 1 && d.acceptItems.every((a) => /^-\s*\[[ xX]\]/.test(a)), 'e4g 验收标准 ≥1 条且带「- [ ]」前缀', 'accept=' + JSON.stringify(d.acceptItems));
        const bodyText = JSON.stringify(data);
        assert(!bodyText.includes('ghp_') && !bodyText.includes('token'), 'e4h 优化响应不含 token', 'len=' + bodyText.length);
        console.log('   e4 真实优化耗时 ' + elapsed + 's：title=' + JSON.stringify(d.title) + ' refs=' + JSON.stringify(d.refs));
      }
    } else {
      // 模式 B：沙箱环境 spawn EPERM → 502 错误信封（验证「失败含原因、不崩溃」验收项）
      assert(res.status === 502, 'e4 沙箱环境 → 502 错误信封', 'status=' + res.status + ' elapsed=' + elapsed + 's body=' + JSON.stringify(data));
      assert(data && data.ok === false && data.error && data.error.code === 'optimize-spawn-failed', 'e4b 错误信封 {ok:false,error:{code:optimize-spawn-failed}}', JSON.stringify(data));
      assert(data.error.message.length > 0 && data.error.message.includes('EPERM'), 'e4b2 信封含 spawn 失败原因', 'msg=' + JSON.stringify(data.error.message));
      const bodyText = JSON.stringify(data);
      assert(!bodyText.includes('ghp_') && !bodyText.includes('token'), 'e4h 错误信封不含 token');
      console.log('   e4 沙箱限制：spawn 被拒（EPERM），错误信封验证通过（真实 headless 链由直接实测+单测覆盖）');
    }
  } catch (e) {
    assert(false, 'e4 optimize 调用', String(e));
  }

  // --- 5. config 路由无 token 泄露（回归） ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/config');
    const body = await res.text();
    assert(res.status === 200 && !body.includes('token') && !body.includes('ghp_'), 'e5 config 路由 200 无 token', 'status=' + res.status);
  } catch (e) {
    assert(false, 'e5 config 路由', String(e));
  }

  console.log(`\nissue37-e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
