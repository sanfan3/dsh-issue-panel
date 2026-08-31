// dsh-issue-panel —— host 插件（最简版 v0.1.0）
// 路由：
//   #3  GET  /api/issue-panel/config   读配置（repo/configured，永不暴露 token）
//   #4  POST /api/issue-panel/create  调 GitHub REST API 创建 issue
//
// 实现要点：
// - 路由注册用 ctx.effect(...) 包裹：插件卸载时自动注销，避免热重载残留；
// - dsh webServer 无 method 过滤：handler 内自行判断 req.method，非期望返回 405；
// - 配置每次请求实时读取（不缓存）：改 config.json 无需重启即可生效；
// - token 只在服务端用于调用 GitHub API，永不进入任何响应体；
// - 本插件仅支持 dsh web profile（依赖 webServer 服务，见 inject 声明）。

import { ConfigError, loadIssuePanelConfig, toPublicConfig } from './config.js';

export const name = 'dsh-issue-panel';

// 依赖注入声明：需要 webServer 服务（@deepseek-ai/dsh-host-webserver），仅支持 web profile。
export const inject = ['webServer'];

/** 统一 JSON 响应出口。 */
function sendJson(res, status, payload) {
  // 防御（对抗自检视角 2）：客户端中途断开时，底层 socket 错误会以 'error' 事件或同步
  // throw 冒出；无监听/捕获会触发 unhandled 'error' / unhandledRejection 导致进程崩溃。
  // 这里吞掉并留痕，保证「任何情况下不崩溃」。
  // P1-01（#9 评审）：ECONNRESET/EPIPE 是客户端主动断开（刷新页面/关闭标签页）的正常
  // 表现，降级为 debug 避免污染运维日志；其它错误才保留 warn。
  res.on('error', (error) => {
    const code = error && error.code;
    const msg = error && error.message ? error.message : String(error);
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      console.debug('[dsh-issue-panel] client aborted (response write):', msg);
    } else {
      console.warn('[dsh-issue-panel] response write failed (client aborted?):', msg);
    }
  });
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.warn('[dsh-issue-panel] response write failed:', error && error.message ? error.message : String(error));
  }
}

/**
 * 配置读取错误统一出口（#3 / #4 共用，评审 P2-01 去重）：
 * ConfigError 透传 code/message；未知错误记日志并返回通用 500，绝不崩溃。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {string} tag 日志标签（如 'config route'）
 */
function handleConfigError(res, error, tag) {
  if (error instanceof ConfigError) {
    sendJson(res, 500, { error: { code: error.code, message: error.message } });
    return;
  }
  console.error(`[dsh-issue-panel] ${tag} unexpected error:`, error);
  // P2-01（#9 评审）：错误响应携带路由上下文（context），前端/调试可区分 config 与 create 路由。
  sendJson(res, 500, { error: { code: 'config-unexpected', context: tag, message: '读取配置时发生未知错误' } });
}

/**
 * GET /api/issue-panel/config —— 返回 { repo, configured }，永不返回 token。
 * 200：{ repo: string|null, configured: boolean }；文件缺失按未配置处理（configured: false）。
 * 500：{ error: { code, message } } —— 配置文件损坏/读取失败，返回明确错误但不崩溃。
 * 405：非 GET 请求。
 */
async function handleConfig(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { code: 'method-not-allowed', message: '仅支持 GET' } });
    return;
  }
  try {
    const config = await loadIssuePanelConfig();
    sendJson(res, 200, toPublicConfig(config));
  } catch (error) {
    handleConfigError(res, error, 'config route');
  }
}

/** 请求体大小上限（1MB）：防滥用，超出返回 413。 */
const BODY_LIMIT = 1024 * 1024;

/** GitHub API 调用超时（毫秒）：避免上游慢响应挂住请求。 */
const GITHUB_TIMEOUT_MS = 15_000;

/**
 * repo 格式校验（#9 评审 P2-02）：owner/repo，两段各 1~100 字符，仅含 [A-Za-z0-9_.-]，
 * 首尾须为字母数字或下划线，不得含连续点号（..）——拦截明显非法与 URL 注入面。
 * GitHub 的更细规则（如 .git/.atom 结尾、保留名）故意不在此收紧：误拒边缘合法名
 * 比晚一步被 API 422 兜底更伤用户，宽松决策保持（评审 P2-02 认可的方案）。
 * @param {unknown} repo
 * @returns {boolean}
 */
export function isValidRepo(repo) {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  if (parts.length !== 2) return false;
  for (const seg of parts) {
    if (seg.length < 1 || seg.length > 100) return false;
    if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/.test(seg)) return false;
    if (seg.indexOf('..') !== -1) return false;
  }
  return true;
}

/** 读取请求体原始字符串；超限 reject 一个 code='BODY_TOO_LARGE' 的错误。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!tooLarge) {
          tooLarge = true;
          // 评审 P1-02：超大请求体继续被丢弃消费直到流结束（保证能正常回 413 响应），
          // 同时记录警告便于运维察觉；不在此 destroy 连接——那会破坏 413 响应语义
          // （本插件仅服务 localhost 影子实例，DoS 面极小）。
          console.warn(`[dsh-issue-panel] request body exceeds ${BODY_LIMIT} bytes, responding 413 (received ${size} so far)`);
        }
        return; // 继续消费数据（保证连接可正常响应），但不再存储
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        // P2-03（#9 评审）：附加已接收字节数，便于前端/调试判断超出多少。
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE', size }));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 把 GitHub API 错误状态码映射为可读中文提示。 */
function githubErrorText(status, ghMessage) {
  switch (status) {
    case 401:
      return 'GitHub Token 无效或已过期，请检查 config.json 中的 token';
    case 403:
      return 'GitHub 权限不足或触发限流（403），请检查 token 是否勾选 repo scope';
    case 404:
      return '仓库不存在或无访问权限，请检查 config.json 中的 repo（owner/repo）';
    case 422:
      return `GitHub 校验失败：${ghMessage || '请求字段不合法'}`;
    default:
      return `GitHub API 错误（HTTP ${status}）：${ghMessage || '未知错误'}`;
  }
}

/**
 * POST /api/issue-panel/create —— 创建 GitHub issue。
 * 请求体：{ title: string（必填）, body?: string }。
 * 201：{ number, html_url }；body 为空时省略 body 字段（与设计一致）。
 * 400：标题为空（title-required）/ 请求体非法（invalid-json）/ 未配置（config-not-configured）/ repo 格式错误（repo-invalid）。
 * 405：非 POST 请求。413：请求体超限。500：配置损坏（CONFIG_INVALID）等。
 * 401/403/404/422/502：GitHub API 错误（透传状态码 + 可读信息，绝不包含 token）。
 */
async function handleCreate(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { code: 'method-not-allowed', message: '仅支持 POST' } });
    return;
  }

  // 1. 读取并解析请求体
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error && error.code === 'BODY_TOO_LARGE') {
      sendJson(res, 413, { error: { code: 'body-too-large', message: `请求体过大（已接收 ${error.size || 0} 字节，上限 ${BODY_LIMIT} 字节）` } });
    } else {
      console.error('[dsh-issue-panel] read body failed:', error);
      sendJson(res, 400, { error: { code: 'bad-request', message: '读取请求体失败' } });
    }
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { code: 'invalid-json', message: '请求体必须是合法 JSON，如 {"title": "...", "body": "..."}' } });
    return;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { error: { code: 'invalid-json', message: '请求体应为 JSON 对象' } });
    return;
  }

  // 2. title 必填校验（#7 前端会本地拦截，后端仍强制校验）
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (title === '') {
    sendJson(res, 400, { error: { code: 'title-required', message: '标题是必填的' } });
    return;
  }
  const body = typeof payload.body === 'string' ? payload.body : '';

  // 3. 读取配置：未配置/损坏 → 明确错误，不触发 GitHub 调用
  let config;
  try {
    config = await loadIssuePanelConfig();
  } catch (error) {
    handleConfigError(res, error, 'create route');
    return;
  }
  // 「是否已配置」的唯一语义来源是 toPublicConfig().configured（与 #3 一致，评审 P1-01：
  // 避免 handleCreate 里重复维护 repo/token 空串判断，两处逻辑漂移）。
  const publicCfg = toPublicConfig(config);
  if (!publicCfg.configured) {
    sendJson(res, 400, { error: { code: 'config-not-configured', message: '未配置 GitHub 仓库或 Token，请先编辑 %DSH_HOME%\\issue-panel\\config.json' } });
    return;
  }
  const repo = publicCfg.repo || ''; // configured 为 true 时必为非空字符串（兜底防 null）
  const token = config.token; // token 仅服务端用于 Authorization 头，永不进响应
  if (!isValidRepo(repo)) {
    sendJson(res, 400, { error: { code: 'repo-invalid', message: 'repo 格式应为 owner/repo，请检查 config.json' } });
    return;
  }

  // 4. 调 GitHub REST API 创建 issue（token 仅用于 Authorization 头，不进响应）
  //    统一超时覆盖 fetch 连接 + 响应体读取全段（评审 P2-03）：timer 在读到响应体之后才清除，
  //    若上游在响应体阶段挂起，AbortController 仍有效，超时即中止。
  const ghBody = { title, ...(body !== '' ? { body } : {}) };
  let response;
  let created;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-issue-panel',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ghBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      let ghMessage = '';
      try {
        const ghErr = await response.json();
        if (ghErr && typeof ghErr.message === 'string') ghMessage = ghErr.message;
      } catch (error) {
        if (error && error.name === 'AbortError') throw error; // 超时归外层统一处理
        // 忽略错误体解析失败，用状态码兜底文案
      }
      sendJson(res, response.status, {
        error: { code: 'github-api', status: response.status, message: githubErrorText(response.status, ghMessage) },
      });
      return;
    }

    try {
      created = await response.json();
    } catch (error) {
      if (error && error.name === 'AbortError') throw error; // 超时归外层统一处理
      throw Object.assign(new Error('github body parse failed'), { code: 'GH_BODY_PARSE' });
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      // P1-03（#9 评审）：超时分支显式清理 timer——finally 兜底虽然也会清理（双重保险），
      // 显式清理避免残留 setTimeout 回调在响应已发出后再 abort 已中止的 controller。
      clearTimeout(timer);
      sendJson(res, 502, { error: { code: 'github-network', message: '连接 GitHub API 超时，请稍后重试' } });
    } else if (error && error.code === 'GH_BODY_PARSE') {
      sendJson(res, 502, { error: { code: 'github-api', message: 'GitHub API 返回了无法解析的响应' } });
    } else {
      sendJson(res, 502, { error: { code: 'github-network', message: '无法连接 GitHub API，请检查网络' } });
    }
    return;
  } finally {
    clearTimeout(timer); // 兜底：正常完成/其它异常路径也确保 timer 清理（无泄漏）
  }
  const number = typeof created.number === 'number' ? created.number : null;
  const htmlUrl = typeof created.html_url === 'string' ? created.html_url : null;
  if (number === null || htmlUrl === null) {
    sendJson(res, 502, { error: { code: 'github-api', message: 'GitHub API 响应缺少 number/html_url 字段' } });
    return;
  }

  console.log(`[dsh-issue-panel] issue created: ${repo}#${number}`);
  sendJson(res, 201, { number, html_url: htmlUrl });
}

/**
 * 插件主体。ctx 为 Cordis 上下文。
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  console.log('[dsh-issue-panel] host plugin loaded');

  const server = ctx.webServer;

  // #3：配置读取路由
  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/issue-panel/config',
    handler: handleConfig,
  }), 'dsh-issue-panel: GET /api/issue-panel/config');

  // #4：推送路由（POST /api/issue-panel/create）
  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/issue-panel/create',
    handler: handleCreate,
  }), 'dsh-issue-panel: POST /api/issue-panel/create');
}
