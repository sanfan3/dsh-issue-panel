// tests/issue13-host.mjs —— #38 优化提示词与容错解析（FR-3 规则）单元测试
// 覆盖：
//   buildOptimizePrompt：规则关键词齐全 + 用户四字段 JSON 嵌入 + 输出 JSON 要求
//   parseOptimizeOutput：合法 JSON / ```json 包裹 / 前后缀文字 / ## 分节兜底 / 垃圾输入 / 空输入
//   normalizeDraft：类型容错 / 键别名 / acceptItems 前缀规范化（- [x] 保留）
//   normalizeAcceptItem：前缀补全与保留
//   mergeRefs：用户 ∪ AI 去重、顺序、不覆盖、大小写去重、空过滤
// 运行：node tests/issue13-host.mjs（exit 0 = 全部 PASS；永不 throw，异常视为失败）

import {
  buildOptimizePrompt,
  parseOptimizeOutput,
  normalizeDraft,
  normalizeAcceptItem,
  mergeRefs,
  TITLE_MAX_CHARS,
} from '../lib/optimize.js';

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

// ==================== buildOptimizePrompt ====================
console.log('== buildOptimizePrompt ==');

const sampleDraft = {
  title: '做 一个 需求面板',
  task: '先做表单\n再做推送',
  refs: ['https://github.com/sanfan3/dsh-issue-panel/issues/1', '#12'],
  acceptItems: ['- [ ] 表单齐全', '验收可执行'],
};
const prompt = buildOptimizePrompt(sampleDraft);
assert(typeof prompt === 'string' && prompt.length > 100, 'p1 提示词非空且足够长', 'len=' + prompt.length);
assert(prompt.includes('动词开头') && prompt.includes(`不超过 ${TITLE_MAX_CHARS} 字`), 'p2 标题规则（动词开头 ≤25 字）写入', 'TITLE_MAX_CHARS=' + TITLE_MAX_CHARS);
assert(prompt.includes('步骤清单') && prompt.includes('数字序号'), 'p3 任务拆步骤规则写入');
assert(prompt.includes('保留用户已填的全部引用') && prompt.includes('去重'), 'p4 引用保留+合并去重规则写入');
assert(prompt.includes('"- [ ] "') && prompt.includes('不改变验收意图'), 'p5 验收标准规则写入');
assert(prompt.includes('只输出一个 JSON 对象') && prompt.includes('acceptItems'), 'p6 输出 JSON 要求写入');
assert(prompt.includes(JSON.stringify('做 一个 需求面板')), 'p7 用户标题以 JSON 字符串嵌入');
assert(prompt.includes('先做表单\\n再做推送') || prompt.includes(JSON.stringify('先做表单\n再做推送')), 'p8 用户任务 JSON 嵌入（换行转义）');
assert(prompt.includes('"#12"'), 'p9 用户引用 JSON 嵌入');
assert(prompt.includes('"- [ ] 表单齐全"'), 'p10 用户验收标准 JSON 嵌入');

// ==================== parseOptimizeOutput：合法 JSON ====================
console.log('== parseOptimizeOutput：合法 JSON ==');

const legalJson = {
  title: '优化标题',
  task: '1) 步骤一\n2) 步骤二',
  refs: ['https://a.com', '#3'],
  acceptItems: ['- [ ] 标准一', '- [ ] 标准二'],
};
let r = parseOptimizeOutput(JSON.stringify(legalJson));
assert(r.error === null && deepEqual(r.draft, legalJson), 'j1 整段合法 JSON 正确解析', JSON.stringify(r));
assert(parseOptimizeOutput('   \n' + JSON.stringify(legalJson) + '\n  ').error === null, 'j1b 前后空白容忍');

// 键别名（accept/ref）容错
const aliasJson = { title: 'T', task: 'S', ref: ['#1'], accept: ['- [ ] A'] };
r = parseOptimizeOutput(JSON.stringify(aliasJson));
assert(r.error === null && r.draft.title === 'T' && deepEqual(r.draft.refs, ['#1']) && deepEqual(r.draft.acceptItems, ['- [ ] A']), 'j2 键别名（ref/accept）解析', JSON.stringify(r.draft));

// 数组字段容错：非字符串元素过滤、缺失键置空
r = parseOptimizeOutput(JSON.stringify({ title: 'T', refs: ['#1', 42, null, ''], acceptItems: ['x', ''] }));
assert(r.error === null && deepEqual(r.draft.refs, ['#1']) && deepEqual(r.draft.acceptItems, ['- [ ] x']), 'j3 数组元素类型过滤 + 缺失键置空', JSON.stringify(r.draft));

// 非对象 JSON（数组/数字/字符串）
r = parseOptimizeOutput('[1,2,3]');
assert(r.error !== null && r.draft.title === '' && r.draft.acceptItems.length === 0, 'j4 非对象 JSON → 空 draft + 可读提示', JSON.stringify(r));
r = parseOptimizeOutput('"just a string"');
assert(r.error !== null && deepEqual(r.draft, { title: '', task: '', refs: [], acceptItems: [] }), 'j4b JSON 字符串 → 空 draft + 提示');

// ==================== parseOptimizeOutput：```json 包裹 / 前后缀 ====================
console.log('== parseOptimizeOutput：代码块与前后缀 ==');

const fenced = '```json\n' + JSON.stringify(legalJson) + '\n```';
r = parseOptimizeOutput(fenced);
assert(r.error === null && deepEqual(r.draft, legalJson), 'f1 ```json 代码块解析', JSON.stringify(r));
r = parseOptimizeOutput('```\n' + JSON.stringify(legalJson) + '\n```');
assert(r.error === null && deepEqual(r.draft, legalJson), 'f1b 无语言标注代码块解析');

const withPrefix = '优化结果如下：\n' + JSON.stringify(legalJson) + '\n以上为结果。';
r = parseOptimizeOutput(withPrefix);
assert(r.error === null && deepEqual(r.draft, legalJson), 'f2 前后缀文字包裹的 JSON 解析', JSON.stringify(r));

// ==================== parseOptimizeOutput：## 分节兜底 ====================
console.log('== parseOptimizeOutput：## 分节兜底 ==');

const sectioned = [
  '## 标题',
  '优化后的标题',
  '',
  '## 任务',
  '1) 第一步',
  '2) 第二步',
  '',
  '## 引用',
  '- https://api.example.com',
  '- #42',
  '',
  '## 验收标准',
  '- [ ] 能打开面板',
  '- [x] 已勾选的保留',
].join('\n');
r = parseOptimizeOutput(sectioned);
assert(r.error === null, 's1 分节输出可解析（无 error）', JSON.stringify(r));
assert(r.draft.title === '优化后的标题', 's1b 标题节提取', 'title=' + r.draft.title);
assert(r.draft.task === '1) 第一步\n2) 第二步' || r.draft.task === '第一步\n第二步', 's1c 任务节提取（行序保留）', 'task=' + JSON.stringify(r.draft.task));
assert(deepEqual(r.draft.refs, ['https://api.example.com', '#42']), 's1d 引用节逐条提取', JSON.stringify(r.draft.refs));
assert(deepEqual(r.draft.acceptItems, ['- [ ] 能打开面板', '- [ ] 已勾选的保留']), 's1e 验收节统一「- [ ] 」前缀（勾选态内容保留）', JSON.stringify(r.draft.acceptItems));

// 部分提取：只有标题节 → error null，draft 部分填充
r = parseOptimizeOutput('## 标题\n只有标题');
assert(r.error === null && r.draft.title === '只有标题' && r.draft.acceptItems.length === 0, 's2 部分提取（仅标题）不报错', JSON.stringify(r));

// 分节 + 纯文本混排
r = parseOptimizeOutput('随便说点\n## 任务\n- 做A\n- 做B');
assert(r.error === null && r.draft.task === '做A\n做B', 's3 混排文本按分节提取', JSON.stringify(r.draft));

// ==================== parseOptimizeOutput：完全无法解析 ====================
console.log('== parseOptimizeOutput：非法输入 ==');

r = parseOptimizeOutput('今天天气不错，完全没有结构化内容');
assert(r.error !== null && r.error.includes('无法') && deepEqual(r.draft, { title: '', task: '', refs: [], acceptItems: [] }), 'g1 垃圾文本 → 空 draft + 可读提示，不 throw', JSON.stringify(r));
r = parseOptimizeOutput('');
assert(r.error !== null && r.error.includes('空'), 'g2 空输出 → 可读提示', JSON.stringify(r));
r = parseOptimizeOutput(null);
assert(r.error !== null && deepEqual(r.draft, { title: '', task: '', refs: [], acceptItems: [] }), 'g3 null 输入 → 空 draft + 提示（类型容错）');
r = parseOptimizeOutput(undefined);
assert(r.error !== null, 'g4 undefined 输入 → 提示');
r = parseOptimizeOutput(42);
assert(r.error !== null, 'g5 数字输入 → 提示');

// ==================== normalizeDraft ====================
console.log('== normalizeDraft ==');

assert(deepEqual(normalizeDraft(null), { title: '', task: '', refs: [], acceptItems: [] }), 'n1 null → 全空');
assert(deepEqual(normalizeDraft(42), { title: '', task: '', refs: [], acceptItems: [] }), 'n2 数字 → 全空');
assert(deepEqual(normalizeDraft(['a']), { title: '', task: '', refs: [], acceptItems: [] }), 'n3 数组 → 全空');
r = normalizeDraft({ title: '  T  ', task: '  S\nS2  ', refs: [' #1 ', ''], acceptItems: [' raw ', '- [x] done '] });
assert(r.title === 'T' && r.task === 'S\nS2', 'n4 字符串 trim（标题/任务）', JSON.stringify(r));
assert(deepEqual(r.refs, ['#1']), 'n5 refs 过滤空串', JSON.stringify(r.refs));
assert(deepEqual(r.acceptItems, ['- [ ] raw', '- [x] done']), 'n6 acceptItems 前缀补全 + - [x] 保留', JSON.stringify(r.acceptItems));

// ==================== normalizeAcceptItem ====================
console.log('== normalizeAcceptItem ==');

assert(normalizeAcceptItem('测试') === '- [ ] 测试', 'a1 无前缀 → 补「- [ ] 」');
assert(normalizeAcceptItem('- [ ] 测试') === '- [ ] 测试', 'a2 已带前缀保留');
assert(normalizeAcceptItem('- [x] 测试') === '- [x] 测试', 'a3 - [x] 保留（勾选态）');
assert(normalizeAcceptItem('- [X] 测试') === '- [X] 测试', 'a3b - [X] 大写保留');
assert(normalizeAcceptItem('  - [ ]  测试  ') === '- [ ]  测试', 'a4 前后空白 trim 后保留前缀');
assert(normalizeAcceptItem('') === '', 'a5 空串 → 空');
assert(normalizeAcceptItem(null) === '' && normalizeAcceptItem(42) === '', 'a6 非字符串 → 空');

// ==================== mergeRefs ====================
console.log('== mergeRefs ==');

r = mergeRefs(['#1', 'https://a.com'], ['#2', '#1', 'https://a.com']);
assert(deepEqual(r, ['#1', 'https://a.com', '#2']), 'm1 用户 ∪ AI 去重，用户顺序在前', JSON.stringify(r));
r = mergeRefs(['#1'], ['#2', '#3']);
assert(deepEqual(r, ['#1', '#2', '#3']), 'm2 追加 AI 补充');
r = mergeRefs([], ['#1', '#2']);
assert(deepEqual(r, ['#1', '#2']), 'm3 用户为空 → 全收 AI');
r = mergeRefs(['#1'], []);
assert(deepEqual(r, ['#1']), 'm4 AI 为空 → 全收用户（不覆盖不删除用户条目）');
r = mergeRefs(['HTTPS://A.COM', '#1'], ['https://a.com']);
assert(deepEqual(r, ['HTTPS://A.COM', '#1']), 'm5 大小写不敏感去重（保留用户首个写法）', JSON.stringify(r));
r = mergeRefs(['  #1  ', '#1'], [' #1']);
assert(deepEqual(r, ['#1']), 'm6 trim 后去重');
r = mergeRefs(['', '#1'], ['', '#2', '']);
assert(deepEqual(r, ['#1', '#2']), 'm7 空串过滤');
r = mergeRefs(null, ['#1']);
assert(deepEqual(r, ['#1']), 'm8 非数组输入容错');
r = mergeRefs([42, '#1'], [null, '#2']);
assert(deepEqual(r, ['#1', '#2']), 'm9 非字符串元素过滤');

// ==================== 汇总 ====================
console.log('----------------------------------------');
console.log(`issue13-host: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
