// tests/readme-links.mjs —— #10 评审 P2-01：README 文档链接有效性自动化校验
// 覆盖：
//   本地相对链接（如 LICENSE、docs/*.md）→ fs/promises access 校验存在性（硬校验，缺失即失败）
//   外部 HTTP(S) 链接 → node fetch HEAD（HEAD 不支持时回退 GET）校验可达性
//   （2xx/3xx 视为有效；网络不可达 / 非 2xx 视为失败，输出具体状态码/原因）
// 跳过：锚点（#...）、空链接、mailto:/javascript:/data: 协议
// 运行：node tests/readme-links.mjs（exit 0 = 全部 PASS）
// 注意：外部链接校验依赖出网能力，本脚本用 node fetch（同 e2e 先例，不依赖 gh）。
// 稳定性：手动 AbortController + clearTimeout（不用 AbortSignal.timeout，避免
// 进程退出时残留计时器触发 libuv 断言崩溃）。

import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const README = join(ROOT, 'README.md');
const TIMEOUT_MS = 15000;

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

/** 校验单个外部链接可达性；返回 null=可达，否则为失败原因。 */
async function checkExternal(link) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS);
  try {
    let res = await fetch(link, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      // HEAD 不被支持 → 回退 GET（不消费 body，取到状态码即断开）
      res = await fetch(link, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      if (res.body) { try { await res.body.cancel(); } catch { /* 忽略取消失败 */ } }
    }
    return res.ok ? null : 'HTTP ' + res.status;
  } catch (error) {
    return 'fetch 失败: ' + (error && error.message ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

// 提取 markdown 链接：支持 [text](url) 与 [text][ref] 两种形式
const md = readFileSync(README, 'utf8');
const inlineLinks = [...md.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1].trim());
const refDefs = new Map(
  [...md.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)].map((m) => [m[1].trim(), m[2].trim()])
);
const refLinks = [...md.matchAll(/\[[^\]]*\]\[([^\]]+)\]/g)].map((m) => refDefs.get(m[1].trim())).filter(Boolean);

const links = [...new Set([...inlineLinks, ...refLinks])];
console.log(`README 链接总数（去重后）：${links.length}`);
for (const link of links) console.log('  - ' + link);

for (const link of links) {
  if (link === '' || link.startsWith('#')) { passed += 1; continue; } // 锚点/空
  if (/^(mailto|javascript|data):/i.test(link)) { passed += 1; continue; } // 非 HTTP 协议

  if (/^https?:\/\//i.test(link)) {
    const reason = await checkExternal(link);
    assert(reason === null, `外部链接可达: ${link}`, reason);
  } else {
    const clean = link.split(/[#?]/)[0]; // 去掉 #anchor 与查询串
    if (clean === '') { passed += 1; continue; }
    const target = resolve(ROOT, clean);
    try {
      await access(target);
      assert(true, `本地链接存在: ${clean}`);
    } catch (error) {
      assert(false, `本地链接存在: ${clean}`, '文件不存在: ' + target + '（' + (error && error.message ? error.message : String(error)) + '）');
    }
  }
}

console.log('----------------------------------------');
console.log(`readme-links: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  // 不调用 process.exit：直接退出会与 undici fetch 连接池产生 libuv 断言竞态
  // （UV_HANDLE_CLOSING，Windows），用 exitCode + 自然退出让连接优雅关闭。
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
