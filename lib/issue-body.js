// dsh-issue-panel —— 推送正文分节拼装纯函数模块（#40，FR-4 推送）
// 职责（无副作用纯函数，便于单元测试）：
//   buildIssueBody(draft)  按「引用→任务→验收标准」分节拼装 markdown 正文（按有无拼接）
//
// PRD FR-4 正文结构：
//   ## 引用          ← 仅当有引用
//   - https://...    ← 逐条
//   - #12
//
//   ## 任务          ← 仅当任务非空
//   1) ...           ← 每行递增序号
//
//   ## 验收标准      ← 永远有
//   - [ ] 第一条
//   - [ ] 第二条
//
// 设计约定：
// - 任务按行拆分（\n）、trim、过滤空行；行已带数字序号（如「1) x」「2. y」）则原样保留
//   （AI 优化产物已合规，buildOptimizePrompt 规则 2 强制「每步一行，用数字序号」），
//   未带序号的行按当前计数补「N) 」前缀（用户手写多行任务 → 递增序号，符合 #40 验收第 4 条）；
// - 引用条目原样输出（用户可能填 URL 或 #issue 号，逐条 `- <ref>`）；
// - 验收标准条目原样输出（#36/#38 normalizeAcceptItem 已保证「- [ ] 」前缀，勾选态保留）；
// - 段间以空行分隔；仅验收标准段时正文从「## 验收标准」开始。

/** 判断行是否已带数字序号前缀（如「1) x」「12. y」），用于避免重复编号。 */
function hasNumberPrefix(line) {
  return /^\d+[.)]\s/.test(line);
}

/**
 * 按 PRD FR-4 分节拼装 issue 正文（markdown）。
 * @param {{ task: string, refs: string[], acceptItems: string[] }} draft
 *   仅使用 task/refs/acceptItems 三字段（title 单独作为 issue 标题，不进入正文）；
 *   缺字段/类型错误按空处理（容错，与 normalizeDraft 语义一致）。
 * @returns {string} 分节正文；acceptItems 为空时仍输出「## 验收标准」段头
 *   （调用方 handleCreate 已强制至少一条，此处保持「永远有」的结构契约）。
 */
export function buildIssueBody(draft) {
  const d = (draft !== null && typeof draft === 'object' && !Array.isArray(draft)) ? draft : {};

  const refs = Array.isArray(d.refs)
    ? d.refs.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
    : [];
  const task = typeof d.task === 'string' ? d.task : '';
  const acceptItems = Array.isArray(d.acceptItems)
    ? d.acceptItems.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
    : [];

  const sections = [];

  // 引用段：仅当非空
  if (refs.length > 0) {
    sections.push('## 引用\n' + refs.map((ref) => `- ${ref}`).join('\n'));
  }

  // 任务段：仅当非空；按行拆分 + 递增序号（已有序号行原样保留）
  const taskLines = task.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (taskLines.length > 0) {
    let n = 0;
    const numbered = taskLines.map((line) => {
      if (hasNumberPrefix(line)) return line; // AI 优化产物已带序号，原样保留
      n += 1;
      return `${n}) ${line}`;
    });
    sections.push('## 任务\n' + numbered.join('\n'));
  }

  // 验收标准段：永远有（PRD FR-4）；条目已带「- [ ] 」前缀（normalizeAcceptItem 保证）。
  // 防御路径（acceptItems 空数组）输出段头即可，不带尾随换行——调用方 handleCreate
  // 已强制至少一条，此处仅保证结构契约（空数组 → 仅「## 验收标准」）。
  sections.push('## 验收标准' + (acceptItems.length > 0 ? '\n' + acceptItems.join('\n') : ''));

  return sections.join('\n\n');
}
