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

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveDshHome } from './config.js';

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
    // P0-01（#38 第 2 轮评审）：规则 3 收紧为「纯保留 + 零新增」——此前「可以提取补充」
    // 的表述会诱导模型从上下文「发现」issue 号/链接，而 headless 无联网能力、无法验证
    // 其真实性（PRD FR-3 规则 3 的「AI 可自动查询 GitHub」在无联网降级下不可实现）。
    // 因此明令禁止新增任何引用：AI 侧 refs 恒为用户原样（host mergeRefs 的 AI∪用户
    // 去重逻辑保留，但提示词层面不允许 AI 补充新条目）。
    '3. 引用：必须保留用户已填的全部引用条目（不得删除或改写）；不要添加任何新的引用（headless 无联网能力，无法验证 issue 号或链接的有效性，禁止编造）。',
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
 * P2-02（#38 评审）：纯前缀无内容（如「- [x]」/「- [ ] 」）视为空条目返回 ''——
 * 此前会原样返回导致空验收项残留，无法被 filter 剔除。
 * P1-02（#38 第 2 轮评审）：前缀后仅零宽/不可见字符（U+200B、U+FEFF 等）同样视为
 * 空条目——`.`/`\S` 会匹配零宽空格导致「- [x] \u200B」残留空验收项，显式剔除后再判空。
 * @param {unknown} raw
 * @returns {string} 规范化后的条目；空输入/纯前缀/零宽内容返回 ''
 */
export function normalizeAcceptItem(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return '';
  // 提取前缀后的内容：剔除零宽/不可见字符（U+200B-U+200D / U+FEFF / U+2060 / U+180E）后
  // trim 判空——纯前缀、仅空白、仅零宽字符一律按空条目处理（P2-02 + P1-02）。
  const m = /^-\s*\[[ xX]\]\s*([\s\S]*)$/.exec(s);
  if (m) {
    const content = (m[1] || '').replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, '').trim();
    return content === '' ? '' : s;
  }
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

/**
 * 去掉列表行前缀（- / * / 数字序号），返回条目内容。
 * P1-03（#38 第 2 轮评审）：数字序号收紧为 [1-9] 开头——`0)` `00)` `01)` 等前导零
 * 序号与 PRD「数字序号（如 1) 2) 3)）」语义不符，不再剥离（保留原样作为普通内容）。
 */
function stripListPrefix(line) {
  const s = line.trim();
  const bullet = /^[-*]\s+(.*)$/.exec(s);
  if (bullet) return bullet[1].trim();
  const numbered = /^[1-9]\d*[.)]\s+(.*)$/.exec(s);
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

  // P1-01（#38 评审）：节名匹配由「contains」收紧为「锚定 + 可选冒号后缀」——原
  // `heading.includes('标题')` 会让「## 任务标题」这类混排节名误入标题分支（if-else 顺序
  // 导致字段错位）。策略：关键词必须以「冒号 / 行尾」收尾，既允许「## 标题：xxx」这类
  // 节名行内联内容，又杜绝「任务标题 / 标题任务」等混排误匹配。
  // P1-01（#38 第 2 轮评审，方案 B 文档化）：节名行「## 标题：A：B」时，冒号后的全部
  // 内容（含多余冒号）作为字段值提取（inline = "A：B"）——这是有意约定而非漏洞，
  // 主循环已按 `##` 切分节，节内再出现 `##` 必然开启新节，不会混入当前节内容；
  // 配套测试 s4c 锁定该语义。若未来需「冒号后必须换行」的严格格式，改用方案 A
  // （`^(标题)[:：]?\s*$`）即可，但会破坏 s4b「## 标题：xxx 内联提取」场景。
  // 关键词顺序：验收标准（4 字）> 标题/任务/引用（2 字），先匹配长的避免「标准」截胡。
  const SECTION_RULES = [
    { re: /^(验收标准)(?:[:：]\s*(.*))?$/, key: 'acceptItems' },
    { re: /^(标题)(?:[:：]\s*(.*))?$/, key: 'title' },
    { re: /^(任务)(?:[:：]\s*(.*))?$/, key: 'task' },
    { re: /^(引用)(?:[:：]\s*(.*))?$/, key: 'refs' },
  ];

  for (const [heading, lines] of sections) {
    const h = heading.trim();
    const rule = SECTION_RULES.find((s) => s.re.test(h));
    if (!rule) continue; // 未知节名（如「## 其他」「## 任务标题」）忽略，不猜字段
    // 节名行内联内容（「## 标题：xxx」→ xxx），优先于下一行正文
    const m = rule.re.exec(h);
    const inline = m && m[2] ? m[2].trim() : '';
    const nonEmpty = lines.map((l) => l.trim()).filter((l) => l !== '');
    const content = inline !== '' ? [inline] : nonEmpty;
    if (rule.key === 'title') {
      draft.title = content.length > 0 ? stripListPrefix(content[0]) : '';
    } else if (rule.key === 'task') {
      draft.task = content.map(stripListPrefix).join('\n');
    } else if (rule.key === 'refs') {
      draft.refs = content.map(stripListPrefix).filter((item) => item !== '');
    } else if (rule.key === 'acceptItems') {
      // P1-02（#38 评审）：与 normalizeAcceptItem 统一——勾选态（- [x]）原样保留，
      // 不强制改写为「- [ ]」；仅对无 checkbox 前缀的列表行（- / 数字）剥前缀后补
      // 「- [ ] 」前缀（行为与 JSON 路径一致，避免同模块双语义）。
      draft.acceptItems = content
        .map((line) => {
          const s = line.trim();
          // 已是 checkbox 条目 → normalizeAcceptItem 原样保留（含勾选态；纯前缀按空处理，P2-02）
          if (/^-\s*\[[ xX]\]/.test(s)) return normalizeAcceptItem(s);
          return normalizeAcceptItem(stripListPrefix(s)); // 普通列表行 → 剥前缀后补「- [ ] 」
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
  // P2-02（#38 第 2 轮评审）：仅提取**首个**代码块——主输出通常在前，模型可能在其后
  // 追加「错误示例/说明」代码块；提取首个是容忍前后解释文字的既定策略，此处文档化
  // （若未来需多块甄别，改 matchAll + 逐个 tryJson 即可）。
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
 * 用户条目保持原顺序在前；AI 补充条目追加在后。
 * P2-01（#38 第 2 轮评审）：去重键分类处理——issue 号（#\d+）整串小写；
 * URL 仅协议+主机名小写、路径保持原样（GitHub 组织名/路径大小写敏感，
 * 全部小写会把 https://Example.com/Path 与 https://example.com/path 误判为重复）。
 * @param {unknown[]} userRefs 用户已填引用
 * @param {unknown[]} aiRefs AI 补充引用
 * @returns {string[]}
 */
function normalizeRefKey(ref) {
  if (/^#\d+$/.test(ref)) return ref.toLowerCase();
  try {
    const url = new URL(ref);
    // protocol/host 恒为小写（URL 规范），pathname/search/hash 保持原样
    return url.protocol + '//' + url.host + url.pathname + url.search + url.hash;
  } catch {
    return ref.toLowerCase(); // 非 URL（相对路径/裸串等）按原样小写去重
  }
}

export function mergeRefs(userRefs, aiRefs) {
  const seen = new Set();
  const out = [];
  for (const ref of [...(Array.isArray(userRefs) ? userRefs : []), ...(Array.isArray(aiRefs) ? aiRefs : [])]) {
    const s = typeof ref === 'string' ? ref.trim() : '';
    if (s === '') continue;
    const key = normalizeRefKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ============================================================================
// #37：spawn `dsh --profile headless`（FR-3 优化issue 的 host 执行侧）
// ============================================================================
// 契约（实测 @deepseek-ai/dsh-headless README + lib/index.js）：
//   dsh --profile headless "<task>" —— 任务经 CLI 位置参数传入（唯一入口，不支持 stdin）；
//   输出：最后一段非空助手文本写 stdout，exit 0 = 完成；错误写 stderr（`dsh: <code>: <msg>`），exit 1。
//   凭据：headless profile 与 web 共用 $DSH_HOME（settings.yaml 选模型 + .credentials.yaml 的 key），
//   即「用 dsh 自带凭据，无需额外 API key」（PRD FR-6 优化引擎）。
// 进程模型：execFile 直启 node.exe + bin.js（不经 shell，规避 cmd/ps1 shim 与注入面）；
//   120s 超时（Node 以 SIGTERM 强杀子进程）、maxBuffer 4MB（输出上限）。

/** headless 调用超时（毫秒）：模型单轮回答通常 10~30s，120s 覆盖重试/工具调用等慢路径。 */
export const HEADLESS_TIMEOUT_MS = 120_000;
/** headless 输出上限：4MB（execFile maxBuffer），超出按错误信封处理。 */
export const HEADLESS_MAX_BUFFER = 4 * 1024 * 1024;
/**
 * 提示词长度上限（字符）。Windows CreateProcess 命令行上限约 32767 字符
 * （node.exe + bin.js 路径 + 参数引号开销后剩余更少），超长会在 spawn 时静默失败，
 * 这里前置拦截为可读错误。24000 字节省约 6 万 token，覆盖绝大多数真实需求。
 */
export const MAX_PROMPT_CHARS = 24_000;

/**
 * 定位 dsh 启动器（lib/bin.js）。
 * 本插件运行在 dsh 进程内，process.argv[1] 即当前进程的启动脚本
 * （`node <...>bin.js --profile web ...` / `dsh web` shim 最终都落到真实 bin.js）。
 * 校验存在性 + basename 防误判（其它 node 脚本以 dsh 方式加载时不会命中）。
 * 找不到时返回 null，由调用方包装为错误信封（dsh-bin-not-found）。
 * @returns {string | null}
 */
export function resolveDshBin() {
  const candidate = process.argv[1];
  if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate) && basename(candidate) === 'bin.js') {
    return resolve(candidate);
  }
  return null;
}

/**
 * 执行一次 dsh headless 优化调用（#37 任务 3/4）。
 * 返回统一信封（永不 throw）：
 *   { ok: true,  stdout: string }                              —— exit 0，stdout 为助手文本
 *   { ok: false, error: { code, message } }                    —— 超时/非零退出/输出超限/无法启动
 * code ∈ { dsh-bin-not-found, optimize-input-too-large, optimize-timeout,
 *          optimize-output-too-large, optimize-failed, optimize-spawn-failed }
 * @param {string} prompt buildOptimizePrompt 的产物
 * @param {object} [options] 测试注入点：execFileImpl / dshBin / nodePath / timeoutMs / maxBuffer / env
 * @returns {Promise<{ ok: boolean, stdout?: string, error?: { code: string, message: string } }>}
 */
export function runHeadless(prompt, options = {}) {
  const {
    execFileImpl = execFile,
    dshBin = resolveDshBin(),
    nodePath = process.execPath,
    timeoutMs = HEADLESS_TIMEOUT_MS,
    maxBuffer = HEADLESS_MAX_BUFFER,
    env = process.env,
  } = options;

  return new Promise((resolvePromise) => {
    if (!dshBin) {
      resolvePromise({ ok: false, error: { code: 'dsh-bin-not-found', message: '无法定位 dsh 启动器（bin.js），请确认以 dsh 方式启动主实例' } });
      return;
    }
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      resolvePromise({ ok: false, error: { code: 'optimize-input-too-large', message: `需求内容过长（上限 ${MAX_PROMPT_CHARS} 字符），请精简后重试` } });
      return;
    }
    // env 注入：显式钉住 DSH_HOME（与宿主实例一致，配置/凭据/headless profile 同源），
    // 并关闭遥测（一次性优化调用无需上报，也避免拖慢退出）。
    const spawnEnv = { ...env, DSH_HOME: resolveDshHome(env), DSH_TELEMETRY_DISABLED: '1' };
    // P1-01（#37 评审）：不接收 execFileImpl 返回值——child 句柄从未被使用
    // （超时由 Node 的 timeout 选项以 SIGTERM 强杀，无需自行 kill），去掉无用变量。
    try {
      execFileImpl(nodePath, [dshBin, '--profile', 'headless', prompt], {
        timeout: timeoutMs,
        maxBuffer,
        env: spawnEnv,
        windowsHide: true, // Windows 下不弹出控制台窗口
      }, (error, stdout, stderr) => {
        if (error) {
          // 超时：Node 以 SIGTERM 强杀子进程（error.killed=true / signal='SIGTERM'）
          if (error.killed || error.signal === 'SIGTERM') {
            resolvePromise({ ok: false, error: { code: 'optimize-timeout', message: `优化超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试或精简需求内容` } });
            return;
          }
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolvePromise({ ok: false, error: { code: 'optimize-output-too-large', message: '优化输出过大（超过 4MB），请简化需求内容后重试' } });
            return;
          }
          // 非零退出：headless 把失败原因写 stderr（如 `dsh: NO_ADAPTER: ...`），透传尾部供排障
          if (typeof error.code === 'number') {
            const detail = String(stderr || '').trim().slice(0, 300);
            resolvePromise({ ok: false, error: { code: 'optimize-failed', message: 'dsh 优化失败' + (detail !== '' ? '：' + detail : '') } });
            return;
          }
          // 其它（ENOENT 等 spawn 层失败）
          // P1-02（#37 评审）：与 stderr 分支一致，spawn 错误消息也截断 300 字符，
          // 防止极端场景下 error.message 过长导致响应体膨胀。
          resolvePromise({ ok: false, error: { code: 'optimize-spawn-failed', message: '无法启动 dsh 优化进程：' + (error && error.message ? error.message : String(error)).slice(0, 300) } });
          return;
        }
        resolvePromise({ ok: true, stdout: String(stdout || '') });
      });
    } catch (error) {
      // 同步 spawn 失败（沙箱/权限 EPERM、参数非法 EINVAL 等）：execFile 同步 throw 而非走
      // 回调。必须转成错误信封而不是让 Promise reject——否则 handler 拒绝会被 dsh webServer
      // 兜底成裸 400 空响应（无 JSON 信封，客户端无法展示原因）。
      // P1-03（#37 评审）：execFile 同步抛错发生在创建子进程之前（参数校验/权限检查阶段），
      // 此时不会产生子进程句柄，无需清理；仅需确认错误已转为信封返回。
      resolvePromise({ ok: false, error: { code: 'optimize-spawn-failed', message: '无法启动 dsh 优化进程：' + (error && error.message ? error.message : String(error)).slice(0, 300) } });
    }
  });
}
