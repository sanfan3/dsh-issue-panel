// tests/issue40-host.mjs —— #40 推送正文分节拼装（FR-4）单元测试
// 覆盖 buildIssueBody 纯函数（lib/issue-body.js）：
//   b1 仅标题+验收标准 → body 只含「## 验收标准」（#40 验收 1）
//   b2 全字段 → 三段齐全且顺序为 引用→任务→验收标准（#40 验收 2）
//   b3 引用含 URL 与 #数字 混合时逐条正确（#40 验收 3）
//   b4 任务多行时 `1) ` 递增序号（#40 验收 4）
//   b5 任务行已带数字序号（AI 优化产物 1) 2)）→ 原样保留不重复编号
//   b6 任务含空行/前后空白 → trim + 过滤空行后编号
//   b7 refs/acceptItems 元素 trim + 过滤空串；非数组/类型错误按空处理（容错）
//   b8 引用与验收标准原样保留用户输入（前缀规范化由 #36/#38 负责，本函数不二次改写）
// 运行：node tests/issue40-host.mjs（exit 0 = 全部 PASS；永不 throw，异常视为失败）

import { buildIssueBody } from '../lib/issue-body.js';

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

// ==================== b1 仅标题+验收标准 ====================
console.log('== b1 仅标题+验收标准 ==');
{
  const body = buildIssueBody({ task: '', refs: [], acceptItems: ['- [ ] 只有一条验收'] });
  assert(body === '## 验收标准\n- [ ] 只有一条验收', 'b1 body 只含「## 验收标准」段', JSON.stringify(body));
}

// ==================== b2 全字段三段齐全 + 顺序 ====================
console.log('== b2 全字段三段齐全 + 顺序 ==');
{
  const body = buildIssueBody({
    task: '第一步\n第二步\n第三步',
    refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1', '#12'],
    acceptItems: ['- [ ] 验收一', '- [ ] 验收二'],
  });
  const expected = [
    '## 引用',
    '- https://github.com/sanfan3/dsh-issue-panel/issues/1',
    '- #12',
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
  assert(body === expected, 'b2 三段齐全且顺序 引用→任务→验收标准', JSON.stringify(body));
}

// ==================== b3 引用 URL 与 #数字 混合 ====================
console.log('== b3 引用 URL 与 #数字 混合 ==');
{
  const body = buildIssueBody({
    task: '',
    refs: ['https://api.example.com/doc', '#12', 'https://github.com/sanfan3/dsh-issue-panel/issues/1'],
    acceptItems: ['- [ ] 验收'],
  });
  const expected = [
    '## 引用',
    '- https://api.example.com/doc',
    '- #12',
    '- https://github.com/sanfan3/dsh-issue-panel/issues/1',
    '',
    '## 验收标准',
    '- [ ] 验收',
  ].join('\n');
  assert(body === expected, 'b3 引用逐条原样（URL + #数字 混合）', JSON.stringify(body));
}

// ==================== b4 任务多行递增序号 ====================
console.log('== b4 任务多行递增序号 ==');
{
  const body = buildIssueBody({
    task: '第一行\n第二行\n第三行',
    refs: [],
    acceptItems: ['- [ ] 验收'],
  });
  const expected = [
    '## 任务',
    '1) 第一行',
    '2) 第二行',
    '3) 第三行',
    '',
    '## 验收标准',
    '- [ ] 验收',
  ].join('\n');
  assert(body === expected, 'b4 任务多行 → 1) 2) 3) 递增序号', JSON.stringify(body));
}

// ==================== b5 任务行已带数字序号 → 原样保留 ====================
console.log('== b5 任务行已带数字序号 → 原样保留 ==');
{
  const body = buildIssueBody({
    task: '1) 第一步\n2) 第二步',
    refs: [],
    acceptItems: ['- [ ] 验收'],
  });
  const expected = [
    '## 任务',
    '1) 第一步',
    '2) 第二步',
    '',
    '## 验收标准',
    '- [ ] 验收',
  ].join('\n');
  assert(body === expected, 'b5 AI 优化产物（已带 1) 序号）不重复编号', JSON.stringify(body));
}

// ==================== b6 任务空行/空白 trim + 过滤 ====================
console.log('== b6 任务空行/空白 trim + 过滤 ==');
{
  const body = buildIssueBody({
    task: '  第一行  \n\n  第二行  \n   ',
    refs: [],
    acceptItems: ['- [ ] 验收'],
  });
  const expected = [
    '## 任务',
    '1) 第一行',
    '2) 第二行',
    '',
    '## 验收标准',
    '- [ ] 验收',
  ].join('\n');
  assert(body === expected, 'b6 任务行 trim + 空行过滤后编号', JSON.stringify(body));
}

// ==================== b7 容错：非数组/元素空串 ====================
console.log('== b7 容错 ==');
{
  const body = buildIssueBody({
    task: 123, // 非字符串 → 按空处理
    refs: 'not-array', // 非数组 → 按空处理
    acceptItems: ['- [ ] 验收', '', '   '], // 空串过滤
  });
  const expected = '## 验收标准\n- [ ] 验收';
  assert(body === expected, 'b7 非数组 refs / 非字符串 task / 空 acceptItems 条目 → 容错为仅验收段', JSON.stringify(body));

  const body2 = buildIssueBody(null);
  assert(body2 === '## 验收标准', 'b7b null draft → 仅「## 验收标准」段头（调用方已强制至少一条）', JSON.stringify(body2));
}

// ==================== b8 引用/验收标准原样保留 ====================
console.log('== b8 引用/验收标准原样保留 ==');
{
  const body = buildIssueBody({
    task: '',
    refs: ['#1 ', '  https://x.dev/a  '], // trim 但内容不改写
    acceptItems: ['- [x] 已勾选保留'], // 勾选态原样（normalize 由 #36/#38 负责）
  });
  const expected = [
    '## 引用',
    '- #1',
    '- https://x.dev/a',
    '',
    '## 验收标准',
    '- [x] 已勾选保留',
  ].join('\n');
  assert(body === expected, 'b8 条目 trim 保留内容原样（前缀/勾选态不二次改写）', JSON.stringify(body));
}

// ==================== b9 空 acceptItems 数组（防御路径） ====================
console.log('== b9 空 acceptItems 数组（防御路径） ==');
{
  // P2-02（#40 评审）：handleCreate 已强制至少一条，但 buildIssueBody 作为纯函数
  // 应独立覆盖防御路径：空数组 → 仅「## 验收标准」段头（无条目行）。
  const body = buildIssueBody({ task: '', refs: [], acceptItems: [] });
  assert(body === '## 验收标准', 'b9 空数组 → 仅段头（无尾随换行/条目）', JSON.stringify(body));

  const body2 = buildIssueBody({ task: '单行任务', refs: [], acceptItems: [] });
  assert(body2 === '## 任务\n1) 单行任务\n\n## 验收标准', 'b9b 空验收数组但任务非空 → 任务段 + 段头', JSON.stringify(body2));
}

// ==================== 汇总 ====================
console.log('----------------------------------------');
console.log(`issue40-host: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
