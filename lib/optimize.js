// dsh-issue-panel —— 优化功能纯函数模块（#38，FR-3 优化issue）
// 职责（全部为无副作用的纯函数，便于单元测试）：
//   buildOptimizePrompt(draft)   组装 dsh headless 优化提示词（PRD FR-3 四条规则 + 输出 JSON 要求）
//   parseOptimizeOutput(text)    容错解析 headless 输出 → { draft, error }（合法 JSON / ```json 包裹 / ## 分节 兜底）
//   normalizeDraft(raw)          把任意对象规整为四字段 draft { title, task, refs, acceptItems }
//   normalizeAcceptItem(raw)     验收标准条目规范化（保证「- [ ] 」前缀，- [x] 保留）
//   mergeRefs(userRefs, aiRefs)  引用合并：用户已填 ∪ AI 补充，去重、不覆盖用户条目（PRD FR-3 规则 3）
//
// 设计约定（#38 验收「解析失败不抛异常，返回尽力提取的结果（空字段置空）」）：
// - 所有解析函数绝不 throw，输入再脏也只返回尽力提取的 draft + 可读 error 提示；
// - 「完全无法解析」= 四字段全部为空 → error 非 null，draft 为四空字段；
// - 部分可解析（如 ## 分节只提取到标题）→ error 为 null，返回部分 draft（尽力提取）。
//
// 注：spawn dsh headless 的 runHeadless 属 #37 范围，在本模块以独立小节追加（见文件尾部）。

/** 标题规则字数上限（PRD FR-3 规则 1：不超过 25 字）。 */
export const TITLE_MAX_CHARS = 25;

/**
 * 组装 dsh headless 优化提示词。
 * 输入为四字段 draft（normalizeDraft 后的形状）；用户内容以 JSON 嵌入，避免格式/注入干扰。
 * @param {{ title: string, task: string, refs: string[], acceptItems: string[] }} draft
 * @returns {string} headless 任务文本（作为 CLI 位置参数传入）
 */
export function buildOptimizePrompt(draft) {
  const user = JSON.stringify({
    title: draft.title,
    task: draft.task,
    refs: draft.refs,
    acceptItems: draft.acceptItems,
  });
  return [
    '你是 GitHub issue 需求优化助手。请把用户填写的需求四字段优化为更规范的版本，用于创建 GitHub issue。',
    '',
    '优化规则：',
    `1. 标题：动词开头、说结果、去掉冗余词，不超过 ${TITLE_MAX_CHARS} 字（中文字符计 1 字）。`,
    '2. 任务：拆成可执行的步骤清单，每步一行，用数字序号（如 1) 2) 3)）。',
    '3. 引用：必须保留用户已填的全部引用条目（不得删除或改写）；如能发现与需求相关的 GitHub issue（#数字）或 API 文档链接可补充，合并去重。',
    '4. 验收标准：每条以 "- [ ] " 开头，表述规范化、去重、不改变验收意图；至少一条。',
    '',
    '用户填写（JSON）：',
    user,
    '',
    '输出要求：只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块标记。JSON 键固定为：',
    '{"title": "优化后标题", "task": "第1步\\n第2步", "refs": ["https://...", "#12"], "acceptItems": ["- [ ] 验收项1"]}',
    'task 中每一步用换行符 \\n 分隔；refs 与 acceptItems 为字符串数组。',
  ].join('\n');
}

/**
 * 尝试 JSON.parse，失败返回 null（不抛异常）。
 * @param {string} text
 * @returns {unknown | null}
 */
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从任意对象取字符串数组字段（按别名顺序取第一个存在的键）。 */
function pickStringArray(obj, keys) {
  for (const key of keys) {
    if (Array.isArray(obj[key])) {
      return obj[key];
    }
  }
  return null;
}

/**
 * 验收标准条目规范化（与 client 侧 normalizeAcceptItem 同规则）：
 * 已带「- [ ] / - [x] / - [X]」前缀的保留原样（含勾选态），否则补「- [ ] 」前缀。
 * @param {unknown} raw
 * @returns {string} 规范化后的条目；空输入返回 ''
 */
export function normalizeAcceptItem(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return '';
  if (/^-\s*\[[ xX]\]/.test(s)) return s;
  return '- [ ] ' + s;
}

/**
 * 把任意解析结果规整为四字段 draft（#38 容错：键缺失/类型错误一律置空，绝不 throw）。
 * 键支持精确名（title/task/refs/acceptItems）与少量别名（引用类 ref/references/引用，
 * 验收类 accept/acceptance/acceptanceCriteria/验收标准），便于兼容不同模型的输出习惯。
 * @param {unknown} raw
 * @returns {{ title: string, task: string, refs: string[], acceptItems: string[] }}
 */
export function normalizeDraft(raw) {
  const obj = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  const refsRaw = pickStringArray(obj, ['refs', 'ref', 'references', '引用']);
  const refs = refsRaw === null ? [] : refsRaw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '');
  const acceptRaw = pickStringArray(obj, ['acceptItems', 'accept', 'acceptance', 'acceptanceCriteria', '验收标准']);
  const acceptItems = acceptRaw === null ? [] : acceptRaw
    .map(normalizeAcceptItem)
    .filter((item) => item !== '');
  return { title, task, refs, acceptItems };
}

/** 判断一个 draft 是否四字段全空（「完全无法解析」判据）。 */
function isEmptyDraft(draft) {
  return draft.title === '' && draft.task === '' && draft.refs.length === 0 && draft.acceptItems.length === 0;
}

/** 去掉列表行前缀（- / * / 数字序号），返回条目内容。 */
function stripListPrefix(line) {
  const s = line.trim();
  const bullet = /^[-*]\s+(.*)$/.exec(s);
  if (bullet) return bullet[1].trim();
  const numbered = /^\d+[.)]\s+(.*)$/.exec(s);
  if (numbered) return numbered[1].trim();
  return s;
}

/**
 * 「## 分节」markdown 兜底提取（#38 验收：非 JSON 输出按分节提取）。
 * 识别标题/任务/引用/验收标准四节（节名含关键词即可，容错），逐行解析。
 * @param {string} text
 * @returns {{ title: string, task: string, refs: string[], acceptItems: string[] }}
 */
function extractSections(text) {
  const sections = new Map(); // 节名 → 行数组
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^##\s*(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1].trim();
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  const draft = { title: '', task: '', refs: [], acceptItems: [] };

  for (const [heading, lines] of sections) {
    const nonEmpty = lines.map((l) => l.trim()).filter((l) => l !== '');
    if (heading.includes('标题')) {
      draft.title = nonEmpty.length > 0 ? stripListPrefix(nonEmpty[0]) : '';
    } else if (heading.includes('任务')) {
      draft.task = nonEmpty.map(stripListPrefix).join('\n');
    } else if (heading.includes('引用')) {
      draft.refs = nonEmpty.map(stripListPrefix).filter((item) => item !== '');
    } else if (heading.includes('验收标准')) {
      draft.acceptItems = nonEmpty
        .map((line) => {
          const checked = /^-\s*\[[ xX]\]\s*(.*)$/.exec(line);
          if (checked) return '- [ ] ' + checked[1].trim(); // 统一为「- [ ] 」前缀（勾选态内容保留）
          return normalizeAcceptItem(stripListPrefix(line));
        })
        .filter((item) => item !== '');
    }
  }
  return draft;
}

/**
 * 容错解析 headless 输出为四字段 draft。
 * 策略（优先级从高到低）：
 *   1. 整段文本即合法 JSON；
 *   2. ```json 代码块包裹的 JSON；
 *   3. 文本中第一个 '{' 到最后一个 '}' 的片段（容忍前后解释文字）；
 *   4. 「## 分节」markdown 兜底提取。
 * 永不 throw。
 * @param {unknown} text
 * @returns {{ draft: { title: string, task: string, refs: string[], acceptItems: string[] }, error: string | null }}
 *   error 仅在四字段全空（完全无法解析）时非 null，draft 为四空字段。
 */
/** 解析成功的 JSON → 规整 draft；四字段全空（如数组/字符串/空对象）视为「完全无法解析」。 */
function parsedOrEmpty(parsed) {
  if (parsed === null) return null;
  const draft = normalizeDraft(parsed);
  if (isEmptyDraft(draft)) return { draft, error: '无法从 dsh 优化输出中解析出四字段' };
  return { draft, error: null };
}

export function parseOptimizeOutput(text) {
  const t = (typeof text === 'string' ? text : '').trim();
  if (t === '') {
    return { draft: { title: '', task: '', refs: [], acceptItems: [] }, error: 'dsh 优化输出为空' };
  }

  // 1. 整段 JSON
  let parsed = tryJson(t);
  let out = parsedOrEmpty(parsed);
  if (out !== null) return out;

  // 2. ```json 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    parsed = tryJson(fence[1].trim());
    out = parsedOrEmpty(parsed);
    if (out !== null) return out;
  }

  // 3. 首个 '{' 到末个 '}' 片段（容忍「结果如下：{...}」这类前后缀文字）
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    parsed = tryJson(t.slice(first, last + 1));
    out = parsedOrEmpty(parsed);
    if (out !== null) return out;
  }

  // 4. ## 分节兜底
  const draft = extractSections(t);
  return { draft, error: isEmptyDraft(draft) ? '无法从 dsh 优化输出中解析出四字段' : null };
}

/**
 * 引用合并（PRD FR-3 规则 3：合并去重，不覆盖用户填写）。
 * 用户条目保持原顺序在前；AI 补充条目追加在后；去重比较为 trim + 小写（URL 主机名大小写不敏感）。
 * 不去除尾斜杠等 URL 规范化差异（路径语义可能不同，过度合并比保留重复更伤用户）。
 * @param {unknown[]} userRefs 用户已填引用
 * @param {unknown[]} aiRefs AI 补充引用
 * @returns {string[]}
 */
export function mergeRefs(userRefs, aiRefs) {
  const seen = new Set();
  const out = [];
  for (const ref of [...(Array.isArray(userRefs) ? userRefs : []), ...(Array.isArray(aiRefs) ? aiRefs : [])]) {
    const s = typeof ref === 'string' ? ref.trim() : '';
    if (s === '') continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
