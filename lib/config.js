// dsh-issue-panel —— host 配置读取模块（#3 / #4 共用）
// 职责：读 %DSH_HOME%\issue-panel\config.json，解析为 { repo, token }。
// 安全边界：本模块是 token 的唯一入口，token 只被 #4 创建 issue 时在服务端使用；
// 任何对外 API 响应都只能经 toPublicConfig() 组装（不含 token）。

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 配置目录相对 DSH_HOME 的路径。 */
const CONFIG_REL_DIR = 'issue-panel';
const CONFIG_FILE_NAME = 'config.json';

/** 配置读取/校验失败的带码错误。code ∈ { CONFIG_READ, CONFIG_INVALID }。 */
export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

// #9 评审 P0-02：config.json 权限安全提醒（token 泄露防护）。
// Windows：NTFS ACL 无法用纯 JS 的 stat.mode 可靠判定（mode 不含 ACL 信息），
// 因此 win32 分支采用「无法校验即提醒」——进程内首次读取配置时提示用户核对 ACL；
// POSIX：stat.mode 可判定 group/other 可读位，过宽时提醒 chmod 600。
// 一律不阻断加载（评审认可「提醒 + 文档」方案），README 已文档化具体操作。
let permissionWarned = false;

/**
 * 计算配置文件权限警告文案（纯函数，便于单元测试）。
 * @param {number|null} mode stat().mode（stat 失败时为 null）
 * @param {string} platform process.platform（'win32' 等）
 * @returns {string|null} 警告文案；无需警告返回 null
 */
export function permissionWarning(mode, platform) {
  if (platform === 'win32') {
    return '请确保 config.json 仅当前用户可读（NTFS ACL：文件属性→安全→编辑→移除 Users/Everyone 的读取权限），否则 token 有泄露风险';
  }
  // POSIX（#9 评审第 2 轮 P1-01）：mode 为 null（stat 失败，如竞态删除/权限拒绝）时
  // 同样提醒「无法校验建议 chmod 600」，与 win32「无法校验即提醒」策略保持一致——
  // 安全提醒宁可多不可漏，token 泄露风险不应因 stat 暂时失败而静默。
  if (mode === null) {
    return '无法校验 config.json 权限（stat 失败），建议执行 chmod 600 保护 token';
  }
  // group/other 任一可读位即视为过宽（0o077 掩码）。
  if ((mode & 0o077) !== 0) {
    return 'config.json 权限过宽（其他用户可读），建议执行 chmod 600 保护 token';
  }
  return null;
}

/** 进程内一次性权限提醒（配置每次请求实时读取，提醒只需一次，避免刷屏）。 */
async function warnInsecureIfNeeded(file) {
  if (permissionWarned) return;
  let mode = null;
  try {
    mode = (await stat(file)).mode;
  } catch {
    // stat 失败（文件刚被删除等）不影响主流程，仍按「无法校验」提醒一次
  }
  const msg = permissionWarning(mode, process.platform);
  if (msg) {
    permissionWarned = true;
    console.warn('[dsh-issue-panel] ' + msg);
  }
}

/** 展开 ~ 前缀（与 dsh-home-paths 的 expandHomePath 行为一致）。 */
function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 解析 DSH_HOME：优先 $DSH_HOME（空白视为未设置），缺省 ~/.dsh。
 * 与 @deepseek-ai/dsh-home-paths 的 resolveDshHome 语义保持一致。
 * @param {NodeJS.ProcessEnv} [env] 环境变量映射（测试可注入）
 * @returns {string} 归一化的绝对路径
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  const chosen = fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), '.dsh');
  return resolve(expandHomePath(chosen));
}

/**
 * 读取并校验配置。
 * @param {string} [dshHome] 测试可注入 DSH_HOME
 * @returns {Promise<{ repo: string, token: string } | null>}
 *   文件缺失（未配置）返回 null；字段缺失/为空时对应字段为 ''。
 * @throws {ConfigError} 文件损坏（CONFIG_INVALID）或读取失败（CONFIG_READ）
 */
export async function loadIssuePanelConfig(dshHome = resolveDshHome()) {
  const file = join(dshHome, CONFIG_REL_DIR, CONFIG_FILE_NAME);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null; // 未配置 ≠ 错误
    throw new ConfigError('CONFIG_READ', `读取配置文件失败：${error && error.message ? error.message : String(error)}`);
  }

  let data;
  try {
    // 剥掉 UTF-8 BOM：Windows 记事本保存 UTF-8 会带 \uFEFF，JSON.parse 直接失败。
    data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (error) {
    throw new ConfigError('CONFIG_INVALID', `配置文件不是合法 JSON：${error && error.message ? error.message : String(error)}`);
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError('CONFIG_INVALID', '配置文件格式错误：应为 JSON 对象，如 {"repo": "owner/repo", "token": "ghp_xxx"}');
  }

  const repo = typeof data.repo === 'string' ? data.repo.trim() : '';
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  // P0-02（#9 评审）：读取成功后做权限安全提醒（不阻断加载）。
  await warnInsecureIfNeeded(file);
  return { repo, token };
}

/**
 * 对外安全视图：只暴露 repo 与 configured，永不包含 token。
 * @param {{ repo: string, token: string } | null} config loadIssuePanelConfig 的返回值
 * @returns {{ repo: string | null, configured: boolean }}
 */
export function toPublicConfig(config) {
  if (config === null) return { repo: null, configured: false };
  return {
    repo: config.repo !== '' ? config.repo : null,
    configured: config.repo !== '' && config.token !== '', // 推送需要 repo + token 齐备
  };
}
