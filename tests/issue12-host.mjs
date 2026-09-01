// tests/issue12-host.mjs —— #37 Host 优化路由（POST /api/issue-panel/optimize）单元测试
// 覆盖（runHeadless 注入假 execFile，无需真实 spawn）：
//   成功：exit 0 → { ok:true, stdout }
//   超时：killed/SIGTERM → optimize-timeout 信封
//   非零退出：exit 1 + stderr → optimize-failed（含原因尾部）
//   输出超限：ERR_CHILD_PROCESS_STDIO_MAXBUFFER → optimize-output-too-large
//   spawn 失败：ENOENT → optimize-spawn-failed
//   dsh bin 未定位：resolveDshBin 注入 null → dsh-bin-not-found
//   输入过长：prompt > MAX_PROMPT_CHARS → optimize-input-too-large（不触发 spawn）
//   端到端纯函数流：buildOptimizePrompt → 假 stdout（合法 JSON）→ parseOptimizeOutput → mergeRefs
// 运行：node tests/issue12-host.mjs（exit 0 = 全部 PASS；永不 throw，异常视为失败）

import { buildOptimizePrompt, parseOptimizeOutput, normalizeDraft, mergeRefs, runHeadless, MAX_PROMPT_CHARS } from '../lib/optimize.js';

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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 假 execFile：记录调用参数，按预置行为回调。 */
function makeFakeExecFile(behavior) {
  const calls = [];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    behavior({ file, args, opts, cb });
  };
  impl.calls = calls;
  return impl;
}

// ==================== runHeadless：成功 ====================
console.log('== runHeadless：成功 ==');

{
  const fake = makeFakeExecFile(({ cb }) => cb(null, '{"title":"优化标题"}', ''));
  const r = await runHeadless('随便的提示词', { execFileImpl: fake, dshBin: 'C:/dsh/bin.js', nodePath: 'C:/node.exe' });
  assert(r.ok === true && r.stdout.includes('优化标题'), 'h1 成功：ok:true + stdout', JSON.stringify(r));
  assert(fake.calls.length === 1, 'h1b 仅 spawn 一次');
  const call = fake.calls[0];
  assert(call.file === 'C:/node.exe' && call.args[0] === 'C:/dsh/bin.js' && call.args[1] === '--profile' && call.args[2] === 'headless', 'h1c nodePath/bin/--profile headless 参数正确', JSON.stringify(call.args));
  assert(call.args[3] === '随便的提示词', 'h1d 提示词作为位置参数传入', JSON.stringify(call.args[3]));
  assert(call.opts.timeout === 120000 && call.opts.maxBuffer === 4 * 1024 * 1024, 'h1e 120s 超时 + 4MB maxBuffer', JSON.stringify({ timeout: call.opts.timeout, maxBuffer: call.opts.maxBuffer }));
  assert(typeof call.opts.env.DSH_HOME === 'string' && call.opts.env.DSH_HOME.length > 0, 'h1f env 注入 DSH_HOME', 'DSH_HOME=' + call.opts.env.DSH_HOME);
  assert(call.opts.env.DSH_TELEMETRY_DISABLED === '1', 'h1g 关闭遥测');
  assert(call.opts.windowsHide === true, 'h1h windowsHide（不弹控制台窗口）');
}

// ==================== runHeadless：超时 ====================
console.log('== runHeadless：超时 ==');

{
  const fake = makeFakeExecFile(({ cb }) => {
    const err = new Error('spawn dsh ENOENT'); // 占位
    err.killed = true; // Node execFile 超时强杀的表现
    err.signal = 'SIGTERM';
    err.code = null;
    cb(err, '', '');
  });
  const r = await runHeadless('p', { execFileImpl: fake, dshBin: 'C:/dsh/bin.js' });
  assert(r.ok === false && r.error && r.error.code === 'optimize-timeout', 'h2 超时 → optimize-timeout', JSON.stringify(r));
  assert(typeof r.error.message === 'string' && r.error.message.includes('超时'), 'h2b 超时文案含「超时」');
}

// ==================== runHeadless：非零退出 ====================
console.log('== runHeadless：非零退出 ==');

{
  const fake = makeFakeExecFile(({ cb }) => {
    const err = new Error('Command failed: dsh --profile headless');
    err.code = 1; // 非零退出码
    err.signal = null;
    cb(err, '', 'dsh: NO_ADAPTER: no adapter registered for provider "xxx"\n');
  });
  const r = await runHeadless('p', { execFileImpl: fake, dshBin: 'C:/dsh/bin.js' });
  assert(r.ok === false && r.error.code === 'optimize-failed', 'h3 非零退出 → optimize-failed', JSON.stringify(r));
  assert(r.error.message.includes('NO_ADAPTER'), 'h3b 透传 stderr 原因尾部', r.error.message);
  assert(r.error.message.length <= 400, 'h3c 错误消息有长度上限（截断尾部）', 'len=' + r.error.message.length);
}

// ==================== runHeadless：输出超限 ====================
console.log('== runHeadless：输出超限 ==');

{
  const fake = makeFakeExecFile(({ cb }) => {
    const err = new Error('maxBuffer length exceeded');
    err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    cb(err, '', '');
  });
  const r = await runHeadless('p', { execFileImpl: fake, dshBin: 'C:/dsh/bin.js' });
  assert(r.ok === false && r.error.code === 'optimize-output-too-large', 'h4 maxBuffer 超限 → optimize-output-too-large', JSON.stringify(r));
}

// ==================== runHeadless：spawn 失败 ====================
console.log('== runHeadless：spawn 失败 ==');

{
  const fake = makeFakeExecFile(({ cb }) => {
    const err = new Error('spawn node.exe ENOENT');
    err.code = 'ENOENT';
    err.signal = null;
    cb(err, '', '');
  });
  const r = await runHeadless('p', { execFileImpl: fake, dshBin: 'C:/dsh/bin.js' });
  assert(r.ok === false && r.error.code === 'optimize-spawn-failed', 'h5 spawn ENOENT → optimize-spawn-failed', JSON.stringify(r));
  assert(r.error.message.includes('ENOENT'), 'h5b 透传 spawn 错误信息');
}

// ==================== runHeadless：dsh bin 未定位 ====================
console.log('== runHeadless：dsh bin 未定位 ==');

{
  const r = await runHeadless('p', { execFileImpl: makeFakeExecFile(() => {}), dshBin: null });
  assert(r.ok === false && r.error.code === 'dsh-bin-not-found', 'h6 dshBin=null → dsh-bin-not-found', JSON.stringify(r));
  const r2 = await runHeadless('p', { execFileImpl: makeFakeExecFile(() => {}), dshBin: '' });
  assert(r2.ok === false && r2.error.code === 'dsh-bin-not-found', 'h6b dshBin 空串 → dsh-bin-not-found');
}

// ==================== runHeadless：输入过长 ====================
console.log('== runHeadless：输入过长 ==');

{
  const fake = makeFakeExecFile(() => {});
  const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS + 1);
  const r = await runHeadless(longPrompt, { execFileImpl: fake, dshBin: 'C:/dsh/bin.js' });
  assert(r.ok === false && r.error.code === 'optimize-input-too-large', 'h7 提示词超长 → optimize-input-too-large（不 spawn）', JSON.stringify(r.error));
  assert(fake.calls.length === 0, 'h7b 超长时不触发 spawn（Windows 命令行上限防御）');
}

// ==================== 端到端纯函数流（模拟 route 第 3/4 步） ====================
console.log('== 端到端纯函数流 ==');

{
  // 用户 draft → 提示词 → 假 headless 输出合法 JSON → 解析 → 引用合并
  const userDraft = normalizeDraft({
    title: '做个需求面板',
    task: '先做表单\n再做推送',
    refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1'],
    acceptItems: ['- [ ] 表单齐全'],
  });
  const prompt = buildOptimizePrompt(userDraft);
  assert(prompt.includes(userDraft.title) && prompt.includes('issues/1'), 'e0 提示词含用户标题与引用');

  const aiStdout = JSON.stringify({
    title: '实现需求面板插件',
    task: '1) 搭建表单\n2) 接入推送',
    refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/2', 'https://github.com/sanfan3/dsh-issue-panel/issues/1'],
    acceptItems: ['- [ ] 表单四字段齐全', '- [ ] 推送成功'],
  });
  const parsed = parseOptimizeOutput(aiStdout);
  assert(parsed.error === null, 'e1 假 headless 输出解析成功', JSON.stringify(parsed));
  const optimized = { ...parsed.draft, refs: mergeRefs(userDraft.refs, parsed.draft.refs) };
  assert(optimized.title === '实现需求面板插件' && optimized.task.includes('1) 搭建表单'), 'e2 优化标题/任务生效', JSON.stringify(optimized));
  assert(deepEqual(optimized.refs, [
    'https://github.com/sanfan3/dsh-issue-panel/issues/1',
    'https://github.com/sanfan3/dsh-issue-panel/issues/2',
  ]), 'e3 引用合并：用户已填 ∪ AI 补充，去重不覆盖（用户条目在前）', JSON.stringify(optimized.refs));
  assert(optimized.acceptItems.length === 2 && optimized.acceptItems[0].startsWith('- [ ] '), 'e4 验收标准保留', JSON.stringify(optimized.acceptItems));

  // 假 headless 输出无法解析 → parseError 非 null + 空 draft（route 据此返回提示，客户端不替换表单）
  const garbage = parseOptimizeOutput('模型说了一堆废话没有结构');
  assert(garbage.error !== null && deepEqual(garbage.draft, { title: '', task: '', refs: [], acceptItems: [] }), 'e5 无法解析 → parseError + 空 draft');
  const mergedGarbage = { ...garbage.draft, refs: mergeRefs(userDraft.refs, garbage.draft.refs) };
  assert(deepEqual(mergedGarbage.refs, userDraft.refs), 'e5b 解析失败时引用保持用户已填（不丢数据）', JSON.stringify(mergedGarbage.refs));
}

// ==================== 汇总 ====================
console.log('----------------------------------------');
console.log(`issue12-host: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
