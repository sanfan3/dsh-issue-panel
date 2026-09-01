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
// P0-01（#38 第 2 轮评审）：规则 3 收紧为「纯保留 + 零新增」——不得再含「提取补充」类
// 暗示（headless 无联网能力，禁止编造引用），AI 侧 refs 恒为用户原样。
assert(prompt.includes('保留用户已填的全部引用') && prompt.includes('不要添加任何新的引用'), 'p4 引用纯保留+零新增规则写入');
assert(!prompt.includes('提取补充') && !prompt.includes('查询 GitHub'), 'p4b 规则 3 不含「提取补充/查询 GitHub」编造暗示');
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
// P1-02（#38 评审）：验收节勾选态（- [x]）原样保留，与 normalizeAcceptItem 语义一致
assert(deepEqual(r.draft.acceptItems, ['- [ ] 能打开面板', '- [x] 已勾选的保留']), 's1e 验收节提取（勾选态 - [x] 保留，无前缀补「- [ ] 」）', JSON.stringify(r.draft.acceptItems));

// 部分提取：只有标题节 → error null，draft 部分填充
r = parseOptimizeOutput('## 标题\n只有标题');
assert(r.error === null && r.draft.title === '只有标题' && r.draft.acceptItems.length === 0, 's2 部分提取（仅标题）不报错', JSON.stringify(r));

// 分节 + 纯文本混排
r = parseOptimizeOutput('随便说点\n## 任务\n- 做A\n- 做B');
assert(r.error === null && r.draft.task === '做A\n做B', 's3 混排文本按分节提取', JSON.stringify(r.draft));

// P1-01（#38 评审）：节名误匹配——「## 任务标题」不得因 contains('标题') 误入标题分支
r = parseOptimizeOutput('## 任务标题\n- 子步骤');
assert(r.draft.title === '' && r.draft.task === '', 's4 节名「任务标题」不误入标题/任务（未知节名忽略，字段保持空）', JSON.stringify(r.draft));
// 带冒号后缀的规范节名仍可识别（锚定 + 冒号）
r = parseOptimizeOutput('## 标题：优化标题\n## 验收标准\n- [ ] 标准一');
assert(r.error === null && r.draft.title === '优化标题' && deepEqual(r.draft.acceptItems, ['- [ ] 标准一']), 's4b 节名带冒号后缀仍识别（## 标题：… / ## 验收标准）', JSON.stringify(r.draft));

// P1-03（#38 评审）：验收节勾选态 + 纯 checkbox 前缀无内容
r = parseOptimizeOutput('## 验收标准\n- [x] 已勾选保留\n- [ ]\n- 无前缀条目');
assert(r.error === null && deepEqual(r.draft.acceptItems, ['- [x] 已勾选保留', '- [ ] 无前缀条目']), 's5 验收节勾选态保留 + 纯前缀空条目剔除 + 无前缀补全', JSON.stringify(r.draft.acceptItems));

// P1-01（#38 第 2 轮评审，方案 B）：节名行多冒号内联内容全部作为字段值（s4c 锁定语义）
r = parseOptimizeOutput('## 标题：A：B\n## 验收标准\n- [ ] 标准一');
assert(r.error === null && r.draft.title === 'A：B', 's4c 节名多冒号内联内容全取（## 标题：A：B → title="A：B"）', 'title=' + JSON.stringify(r.draft.title));

// P1-03（#38 第 2 轮评审）：前导零序号（0)/00)）不再被剥前缀，保留原样作为普通内容
r = parseOptimizeOutput('## 任务\n0) 步骤零\n1) 步骤一');
assert(r.error === null && r.draft.task === '0) 步骤零\n步骤一', 's6 前导零序号不剥前缀（0) 保留原样，1) 正常剥离）', 'task=' + JSON.stringify(r.draft.task));

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
// P2-02（#38 评审）：纯 checkbox 前缀无内容 → 空条目（此前原样返回残留空验收项）
assert(normalizeAcceptItem('- [ ]') === '', 'a7 纯前缀「- [ ]」无内容 → 空');
assert(normalizeAcceptItem('- [x]') === '', 'a7b 纯前缀「- [x]」无内容 → 空');
assert(normalizeAcceptItem('- [ ]   ') === '', 'a7c 前缀后仅空白 → 空');
// P1-02（#38 第 2 轮评审）：前缀后仅零宽/不可见字符 → 空条目（`.+`/`\S` 会匹配零宽空格导致残留）
assert(normalizeAcceptItem('- [x] \u200B') === '', 'a8 前缀后仅零宽空格 U+200B → 空');
assert(normalizeAcceptItem('- [ ] \uFEFF') === '', 'a8b 前缀后仅 BOM U+FEFF → 空');
assert(normalizeAcceptItem('- [x] \u200B\u200D\u2060\u180E') === '', 'a8c 前缀后仅多种零宽字符 → 空');
assert(normalizeAcceptItem('- [x] \u200B内容') === '- [x] \u200B内容', 'a8d 零宽字符后有真实内容 → 保留原样（勾选态）');

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
// P2-01（#38 第 2 轮评审）：URL 仅协议+主机名小写、路径大小写敏感——路径不同不算重复
r = mergeRefs(['https://Example.com/Path'], ['https://example.com/path']);
assert(deepEqual(r, ['https://Example.com/Path', 'https://example.com/path']), 'm10 URL 路径大小写敏感（Path ≠ path，都保留）', JSON.stringify(r));
r = mergeRefs(['https://Example.com/Path'], ['HTTPS://example.com/Path']);
assert(deepEqual(r, ['https://Example.com/Path']), 'm10b URL 协议+主机名大小写不敏感（去重，保留用户首个写法）', JSON.stringify(r));
r = mergeRefs(['#ABC'], ['#abc']);
assert(deepEqual(r, ['#ABC']), 'm10c issue 号整串小写去重（非纯数字也小写）', JSON.stringify(r));

// ==================== parseOptimizeOutput：parseError 场景 ====================
console.log('== parseOptimizeOutput：parseError 场景（P2-03）==');

// 完全无法解析 → error 非 null、draft 四字段全空
r = parseOptimizeOutput('垃圾输出');
assert(r.error !== null && deepEqual(r.draft, { title: '', task: '', refs: [], acceptItems: [] }), 'g6 垃圾输出 → error 非 null + 四字段全空', JSON.stringify(r));
// 路由层行为（lib/index.js handleOptimize）：parseError 非 null 时仍执行 mergeRefs，
// 但 parsed.draft.refs 为空 → 合并结果 = 用户原文（不丢失用户已填引用）
const userDraft = { title: 'T', task: '', refs: ['#1'], acceptItems: ['- [ ] A'] };
const mergedRefs = mergeRefs(userDraft.refs, r.draft.refs);
assert(deepEqual(mergedRefs, ['#1']), 'g6b parseError 时合并 refs 保留用户原文（不丢失）', JSON.stringify(mergedRefs));

// ==================== 汇总 ====================
console.log('----------------------------------------');
console.log(`issue13-host: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
