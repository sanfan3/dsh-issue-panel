// #36 Client：表单扩展 —— 影子实例（8091）端到端验证
// 前置：
//   1. 影子实例已启动（DSH_HOME=D:\9\.dsh-shadow，端口 8091，见 boot 说明）；
//   2. $env:TEST_TOKEN = gh auth token（真实创建 + 自清理关闭用）。
// 验证：
//   1. client.js HTTP 200 且包含 #36 四字段代码特征（dsh-ip-task / dsh-ip-accept / dsh-ip-ref）
//   2. GET /api/issue-panel/config 200 且无 token 泄露
//   3. POST /api/issue-panel/create 四字段 payload（title/task/refs/acceptItems）
//      → 真实创建 issue（#36 过渡态：后端正文分节拼装由 #40 实现，body 暂为空）→ 自清理关闭
//   4. POST /create 空标题 → 400 且不触发 GitHub 调用（后端校验）
// 运行：node tests/issue36-e2e.mjs（exit 0 = 全部 PASS；测试 issue 自动关闭，失败时打印待关列表）
// 注意：沙箱内 e2e 不 spawn 外部命令，用 node fetch 直连（含 GitHub REST API 自清理）。

const BASE = 'http://127.0.0.1:8091';
const TOKEN = process.env.TEST_TOKEN || '';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) passed++;
  else { failed++; failures.push(name + (detail !== undefined ? ' :: ' + detail : '')); }
}

async function main() {
  // --- 1. client.js 服务 + #36 代码特征 ---
  let clientOk = false;
  let clientBody = '';
  try {
    const res = await fetch(BASE + '/plugins/dsh-issue-panel/client.js');
    clientOk = res.status === 200;
    clientBody = await res.text();
  } catch (e) { /* 下面统一断言 */ }
  assert(clientOk, 'e1 client.js HTTP 200');
  assert(clientBody.includes('dsh-ip-task') && clientBody.includes('dsh-ip-accept') && clientBody.includes('dsh-ip-ref'), 'e1b client.js 包含 #36 四字段代码（task/accept/ref）');
  assert(clientBody.includes('验收标准至少写一条'), 'e1c client.js 包含 #36 验收标准拦截文案');
  assert(clientBody.includes('✨ 优化issue'), 'e1d client.js 包含 ✨ 优化issue 按钮（FR-2 入口）');
  // 旧字段已移除：不再包含 .dsh-ip-desc 类定义（过渡期仍允许「描述」字样出现在注释）
  assert(!/\.dsh-ip-desc\{/.test(clientBody), 'e1e client.js 不再定义旧 .dsh-ip-desc 样式');

  // --- 2. config 路由无 token 泄露 ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/config');
    const body = await res.text();
    assert(res.status === 200, 'e2 config 路由 200');
    assert(!body.includes('token') && !body.includes('ghp_'), 'e2b config 响应不含 token');
    assert(body.includes('repo'), 'e2c config 响应含 repo');
  } catch (e) {
    assert(false, 'e2 config 路由可访问', String(e));
  }

  // --- 3. 四字段 payload 真实创建 + 自清理 ---
  let createdNumber = null;
  let createUrl = '';
  try {
    const cfgRes = await fetch(BASE + '/api/issue-panel/config');
    const cfg = await cfgRes.json();
    const repo = cfg.repo;
    const draft = {
      title: '[验收测试] #36 表单扩展 ' + Date.now(),
      task: '步骤一：改造表单\n步骤二：补充测试',
      refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1', '#12'],
      acceptItems: ['- [ ] 表单四字段齐全', '验收标准序列化带前缀'],
    };
    const res = await fetch(BASE + '/api/issue-panel/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const data = await res.json();
    assert(res.status === 201, 'e3 四字段 payload 创建成功 201', 'status=' + res.status + ' body=' + JSON.stringify(data));
    assert(data && typeof data.number === 'number' && typeof data.html_url === 'string', 'e3b 返回 number + html_url');
    createdNumber = data && data.number;
    createUrl = data && data.html_url;
    // 过渡态确认：后端 handleCreate 目前只读 title/body（#40 实现分节拼装），
    // 四字段 draft 被忽略 → body 省略 → GitHub 存 null/''——记录为已知过渡，不视为失败。
    if (createdNumber && repo) {
      const ghRes = await fetch('https://api.github.com/repos/' + repo + '/issues/' + createdNumber, {
        headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
      });
      const ghData = ghRes.status === 200 ? await ghRes.json() : null;
      assert(ghData && ghData.title === draft.title, 'e3c GitHub 上 issue 标题一致', 'got=' + (ghData && ghData.title));
      assert(ghData && (ghData.body === null || ghData.body === ''), 'e3d 过渡态 body 为空（#40 分节拼装前，已知行为）', 'got=' + JSON.stringify(ghData && ghData.body));
    }
  } catch (e) {
    assert(false, 'e3 四字段创建流程', String(e));
  }

  // --- 4. 空标题 → 400 不触发 GitHub 调用 ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  ', task: '', refs: [], acceptItems: ['- [ ] x'] }),
    });
    const data = await res.json();
    assert(res.status === 400 && data.error && data.error.message.includes('标题是必填的'), 'e4 空标题 400 + 可读提示', 'status=' + res.status + ' body=' + JSON.stringify(data));
  } catch (e) {
    assert(false, 'e4 空标题校验', String(e));
  }

  // --- 5. GET /create → 405（方法校验回归） ---
  try {
    const res = await fetch(BASE + '/api/issue-panel/create');
    assert(res.status === 405, 'e5 GET create → 405');
  } catch (e) {
    assert(false, 'e5 GET create 405', String(e));
  }

  // --- 自清理：关闭测试 issue（node fetch 直连 GitHub REST API PATCH close） ---
  if (createdNumber) {
    try {
      const cfgRes = await fetch(BASE + '/api/issue-panel/config');
      const cfg = await cfgRes.json();
      const repo = cfg.repo;
      if (TOKEN) {
        const patch = await fetch('https://api.github.com/repos/' + repo + '/issues/' + createdNumber, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Content-Type': 'application/json',
            'User-Agent': 'dsh-issue-panel-e2e',
          },
          body: JSON.stringify({ state: 'closed' }),
        });
        assert(patch.status === 200, 'e6 测试 issue 已自清理关闭 #' + createdNumber, 'status=' + patch.status);
      } else {
        console.log('CLEANUP_NEEDED:' + repo + '#' + createdNumber + ' ' + createUrl + '（缺 TEST_TOKEN，请 gh issue close 补关）');
      }
    } catch (e) {
      console.log('CLEANUP_FAILED:' + String(e));
      if (createdNumber) console.log('CLEANUP_NEEDED:' + createdNumber + ' ' + createUrl);
    }
  }

  console.log(`\nissue36-e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
