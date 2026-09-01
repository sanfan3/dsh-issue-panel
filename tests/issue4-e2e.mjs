// tests/issue4-e2e.mjs —— #4 推送路由（POST /api/issue-panel/create）端到端测试
//   （#40 起 payload 为四字段 draft，正文分节拼装由 host buildIssueBody 完成）
//
// 前置：影子实例 8091 已启动且加载最新插件（见 docs/autonomous-state.md「经验教训」：
//       每轮把 boot + 测试放同一条命令，避免实例被外部回收）。
// 用法：
//   $env:TEST_TOKEN = gh auth token   # 真实 token（阶段 5 真实创建 issue 用）
//   node tests/issue4-e2e.mjs
//
// 环境变量：
//   TEST_BASE    影子实例地址，默认 http://127.0.0.1:8091
//   SHADOW_HOME  影子 DSH_HOME，默认 <工作区>\.dsh-shadow（可用环境变量覆盖）
//   TEST_TOKEN   GitHub token（必填，阶段 3/4/5 用）
//
// 测试阶段：
//   1 未配置（无 config.json）      → 400 title-required / acceptance-required / config-not-configured / invalid-json / 405 / 413
//   2 损坏 config.json              → 500 CONFIG_INVALID
//   3 无效 token                   → 401（透传 GitHub 状态码 + 可读提示）
//   4 不存在的 repo                → 404（透传 + 可读提示）
//   5 有效配置真实创建              → 201 { number, html_url }；响应不含 token；
//                                     #40：真实创建后拉取 GitHub issue 验证正文分节拼装
//                                     （仅标题+验收标准 → 只含「## 验收标准」；全字段 → 三段齐全）
//   回归 /config 路由               → 阶段 1/5 各冒烟一次（评审 P1-03：新路由不得破坏旧功能）
//
// 说明：阶段 5 会真实创建 issue（标题带 [验收测试] 前缀），测试后需外部用 gh 关闭。

import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8091';
const SHADOW_HOME = process.env.SHADOW_HOME || join(process.cwd(), '.dsh-shadow');
const CONFIG_DIR = join(SHADOW_HOME, 'issue-panel');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const TOKEN = process.env.TEST_TOKEN || '';
const REPO = 'sanfan3/dsh-issue-panel';

if (!TOKEN) {
  console.error('缺少 TEST_TOKEN 环境变量（gh auth token）');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
let tokenLeaked = false;

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

/** 任何响应都不得包含 token 明文（安全边界）。 */
function assertNoToken(data) {
  if (!data) return;
  const s = JSON.stringify(data);
  if (TOKEN.length >= 6 && s.includes(TOKEN)) {
    tokenLeaked = true;
    console.log('  ❌ FAIL 响应泄露 token 明文');
  }
}

async function writeConfig(obj) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

async function removeConfig() {
  await rm(CONFIG_FILE, { force: true });
}

async function call(path, { method = 'POST', body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应，保留 null
  }
  assertNoToken(data);
  return { status: res.status, data };
}

const created = []; // 真实创建的 issue number（供外部 gh close 清理）

// ---------- 阶段 1：未配置 ----------
console.log('== 阶段 1：未配置（无 config.json）==');
await removeConfig();
{
  let r = await call('/api/issue-panel/create', { body: { title: '', acceptItems: ['- [ ] x'] } });
  check('空标题 → 400 title-required', r.status === 400 && r.data?.error?.code === 'title-required', `got ${r.status} ${JSON.stringify(r.data)}`);
  check('空标题文案「标题是必填的」', r.data?.error?.message === '标题是必填的', r.data?.error?.message);

  r = await call('/api/issue-panel/create', { body: { title: '有标题无验收' } });
  check('无验收标准 → 400 acceptance-required', r.status === 400 && r.data?.error?.code === 'acceptance-required', `got ${r.status} ${JSON.stringify(r.data)}`);
  check('无验收标准文案「验收标准至少写一条」', r.data?.error?.message === '验收标准至少写一条', r.data?.error?.message);

  r = await call('/api/issue-panel/create', { body: { title: '未配置测试', acceptItems: ['- [ ] x'] } });
  check('未配置 → 400 config-not-configured（不触发 GitHub 调用）', r.status === 400 && r.data?.error?.code === 'config-not-configured', `got ${r.status} ${JSON.stringify(r.data)}`);

  r = await call('/api/issue-panel/create', { raw: '{bad json' });
  check('损坏 JSON → 400 invalid-json', r.status === 400 && r.data?.error?.code === 'invalid-json', `got ${r.status}`);

  r = await call('/api/issue-panel/create', { raw: '[1,2]' });
  check('非对象 JSON → 400 invalid-json', r.status === 400 && r.data?.error?.code === 'invalid-json', `got ${r.status}`);

  r = await call('/api/issue-panel/create', { method: 'GET' });
  check('GET 打到 create 路由 → 405', r.status === 405 && r.data?.error?.code === 'method-not-allowed', `got ${r.status}`);

  r = await call('/api/issue-panel/create', { raw: `{"title":"x","acceptItems":["- [ ] a"],"body":"${'a'.repeat(1024 * 1024 + 100)}"}` });
  check('超大 body（>1MB）→ 413', r.status === 413, `got ${r.status}`);

  // 回归（评审 P1-03）：未配置时 #3 路由仍正常
  r = await call('/api/issue-panel/config', { method: 'GET' });
  check('回归：未配置时 GET /config → 200 {repo:null, configured:false}', r.status === 200 && r.data?.repo === null && r.data?.configured === false, `got ${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 阶段 2：损坏配置 ----------
console.log('== 阶段 2：损坏 config.json ==');
await writeConfig('not json at all');
{
  const r = await call('/api/issue-panel/create', { body: { title: '损坏配置测试', acceptItems: ['- [ ] x'] } });
  check('损坏配置 → 500 CONFIG_INVALID（不崩溃）', r.status === 500 && r.data?.error?.code === 'CONFIG_INVALID', `got ${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 阶段 3：无效 token ----------
console.log('== 阶段 3：无效 token ==');
await writeConfig({ repo: REPO, token: 'ghp_invalid_token_xyz' });
{
  const r = await call('/api/issue-panel/create', { body: { title: '无效token测试', acceptItems: ['- [ ] x'] } });
  check('无效 token → 401 透传 + 可读提示', r.status === 401 && r.data?.error?.code === 'github-api' && /token/i.test(r.data?.error?.message || ''), `got ${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 阶段 4：不存在的 repo ----------
console.log('== 阶段 4：不存在的 repo ==');
await writeConfig({ repo: 'sanfan3/definitely-not-exists-xyz', token: TOKEN });
{
  const r = await call('/api/issue-panel/create', { body: { title: '404测试', acceptItems: ['- [ ] x'] } });
  check('不存在 repo → 404 透传 + 可读提示', r.status === 404 && r.data?.error?.code === 'github-api', `got ${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 阶段 5：有效配置真实创建（含 #40 正文分节验证） ----------
console.log('== 阶段 5：有效配置真实创建 ==');
await writeConfig({ repo: REPO, token: TOKEN });
{
  const ts = Date.now();

  // 5a. 仅标题+验收标准 → body 只含「## 验收标准」（#40 验收 1）
  let r = await call('/api/issue-panel/create', {
    body: { title: `[验收测试] #40 仅验收 ${ts}`, acceptItems: ['- [ ] 只有一条验收'] },
  });
  check('仅标题+验收标准 → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.data)}`);
  check('返回 number（数字）', typeof r.data?.number === 'number' && r.data.number > 0, JSON.stringify(r.data?.number));
  check('返回 html_url（指向 issue）', typeof r.data?.html_url === 'string' && r.data.html_url.includes('/issues/'), r.data?.html_url);
  if (r.status === 201) created.push(r.data.number);

  // 5b. 全字段 → 三段齐全且顺序为 引用→任务→验收标准（#40 验收 2/3/4）
  r = await call('/api/issue-panel/create', {
    body: {
      title: `[验收测试] #40 全字段 ${ts}`,
      task: '第一步\n第二步\n第三步',
      refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1', '#12', 'https://api.example.com/doc'],
      acceptItems: ['- [ ] 验收一', '验收二'],
    },
  });
  check('全字段 → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.data)}`);
  if (r.status === 201) created.push(r.data.number);

  // 5c. 拉取真实创建的 issue 验证正文分节（#40 核心验收：body 结构正确）
  if (created.length >= 2) {
    const ghRes0 = await fetch(`https://api.github.com/repos/${REPO}/issues/${created[0]}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const gh0 = ghRes0.status === 200 ? await ghRes0.json() : null;
    check('仅验收：body 只含「## 验收标准」', gh0 && gh0.body === '## 验收标准\n- [ ] 只有一条验收', 'got=' + JSON.stringify(gh0 && gh0.body));

    const ghRes1 = await fetch(`https://api.github.com/repos/${REPO}/issues/${created[1]}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const gh1 = ghRes1.status === 200 ? await ghRes1.json() : null;
    const expected = [
      '## 引用',
      '- https://github.com/sanfan3/dsh-issue-panel/issues/1',
      '- #12',
      '- https://api.example.com/doc',
      '',
      '## 任务',
      '1) 第一步',
      '2) 第二步',
      '3) 第三步',
      '',
      '## 验收标准',
      '- [ ] 验收一',
      '- [ ] 验收二',
    ].join('\n');
    check('全字段：body 三段齐全顺序 引用→任务→验收标准 + 任务递增序号 + 验收前缀', gh1 && gh1.body === expected, 'got=' + JSON.stringify(gh1 && gh1.body));
  }

  // 回归（评审 P1-03）：有效配置时 #3 路由仍正常（configured 语义与 #4 共用同一来源）
  r = await call('/api/issue-panel/config', { method: 'GET' });
  check('回归：已配置时 GET /config → 200 {repo, configured:true}', r.status === 200 && r.data?.repo === REPO && r.data?.configured === true, `got ${r.status} ${JSON.stringify(r.data)}`);
}

// ---------- 汇总 ----------
console.log('----------------------------------------');
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (tokenLeaked) console.log('!! TOKEN LEAK DETECTED !!');
if (created.length > 0) console.log(`创建的测试 issue：${created.map((n) => `#${n}`).join(', ')}（请用 gh issue close 清理）`);
if (failed > 0 || tokenLeaked) {
  console.error(failures.join('\n'));
  process.exit(1);
}
process.exit(0);
