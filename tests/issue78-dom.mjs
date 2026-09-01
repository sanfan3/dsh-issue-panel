// #7 校验与错误提示联动 + #8 成功反馈 —— DOM 行为测试
// 无浏览器/无 jsdom 环境下，用轻量 DOM stub + vm 加载真实 lib/client.js，验证：
//   #7：空标题本地拦截（不发请求）、后端错误可读提示、错误样式类、提示后可重试
//   #8：成功提示含 issue 号 + 可点击链接（新窗口）、成功后清空表单、描述高度复位
//   回归：按钮禁用/恢复、防重入、热重载竞态、面板开关状态留存（P2-02 通知留存）
// 运行：node tests/issue78-dom.mjs（exit 0 = 全部 PASS）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

// ==================== 轻量 DOM stub（基于 issue6 实现；textContent 语义贴近真实 DOM） ====================

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

class El {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.parentNode = null;
    this.children = [];
    this.attrs = new Map();
    this.listeners = {};
    this.type = '';
    this.className = '';
    this._text = undefined;
    this.hidden = false;
    this.style = {};
    this._datasetProxy = null;
    // P1-03（#7 评审）：scrollHeight 改为动态计算——真实 DOM 中它是只读属性，
    // 由内容（value）决定；value 变化时旧的手动覆盖值失效，滚动高度自动跟随。
    this._value = undefined;
    this._scrollHeightOverride = undefined;
    this.disabled = false;
    // P1-02（#9 评审）：真实 DOM 的 isConnected（是否在文档中）；默认 true（挂在 body 下）。
    // 测试可置 false 模拟 detached 节点，验证 focus 静默跳过。
    this.isConnected = true;
  }
  // P1-03：value setter 同步失效 scrollHeight 手动覆盖（内容变了，旧高度模拟作废）。
  set value(v) { this._value = String(v); this._scrollHeightOverride = undefined; }
  get value() { return this._value !== undefined ? this._value : ''; }
  // P1-03：scrollHeight getter 动态计算（40 + 内容长度，模拟多行文本高度）；
  // setter 保留手动覆盖能力（测试可精确指定高度模拟多行布局）。
  set scrollHeight(v) { this._scrollHeightOverride = v; }
  get scrollHeight() {
    if (this._scrollHeightOverride !== undefined) return this._scrollHeightOverride;
    return 40 + (this._value !== undefined ? this._value.length : 0);
  }
  // 真实 DOM：placeholder 属性赋值会反映到 attribute（getAttribute 可读）。
  set placeholder(value) { this.setAttribute('placeholder', String(value)); }
  get placeholder() { return this.getAttribute('placeholder'); }
  // <a> 链接属性：property 赋值同步到 attribute（真实 DOM 行为，测试用 getAttribute 断言）。
  set href(value) { this.setAttribute('href', String(value)); }
  get href() { return this.getAttribute('href'); }
  set target(value) { this.setAttribute('target', String(value)); }
  get target() { return this.getAttribute('target'); }
  set rel(value) { this.setAttribute('rel', String(value)); }
  get rel() { return this.getAttribute('rel'); }
  get parentElement() { return this.parentNode; }
  // textContent：赋值 = 清空子节点并替换为单个文本节点（真实 DOM 语义）；
  // 读取 = 拼接全部子节点文本（若本节点自身是文本节点则返回自身文本）。
  get textContent() {
    if (this.tagName === '#text') return this._text !== undefined ? this._text : '';
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    if (this.tagName === '#text') { this._text = String(value); return; }
    this.children.length = 0;
    const tn = new El('#text');
    tn._text = String(value);
    this.appendChild(tn);
  }
  get dataset() {
    if (!this._datasetProxy) {
      const el = this;
      this._datasetProxy = new Proxy({}, {
        get(_, key) { return el.getAttribute('data-' + kebab(key)); },
        set(_, key, value) { el.setAttribute('data-' + kebab(key), String(value)); return true; },
      });
    }
    return this._datasetProxy;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; }
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentElement(position, el) {
    if (position !== 'afterend') throw new Error('stub only supports afterend, got ' + position);
    if (el.parentNode) el.parentNode.removeChild(el);
    const parent = this.parentNode;
    if (!parent) throw new Error('anchor has no parent');
    const i = parent.children.indexOf(this);
    parent.children.splice(i + 1, 0, el);
    el.parentNode = parent;
    return el;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] : null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 && i < this.parentNode.children.length - 1 ? this.parentNode.children[i + 1] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    for (const fn of (this.listeners[event.type] || []).slice()) fn(event);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  // P2-05（#7 评审）：stub 补 focus（真实 DOM 焦点行为）；空标题拦截后焦点回标题框。
  focus() { this._focused = true; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// 解析并匹配选择器：tag? + ( .class | [attr] | [attr="v"] | [attr*="v"] )*
function parseSelector(sel) {
  let rest = sel.trim();
  let tag = null;
  const mTag = rest.match(/^[a-zA-Z][\w-]*/);
  if (mTag) { tag = mTag[0]; rest = rest.slice(mTag[0].length); }
  const attrs = [];
  while (rest.length) {
    const mClass = rest.match(/^\.([\w-]+)/);
    if (mClass) {
      attrs.push({ name: 'class', op: '~', value: mClass[1] });
      rest = rest.slice(mClass[0].length);
      continue;
    }
    const m = rest.match(/^\[([^\]]+)\]/);
    if (!m) throw new Error('unsupported selector: ' + sel);
    const inner = m[1];
    const mm = inner.match(/^([\w-]+)(\*?)=?"?([^"]*)"?$/);
    if (!mm) throw new Error('unsupported attribute selector: ' + inner);
    attrs.push({ name: mm[1], op: mm[2], value: mm[3] });
    rest = rest.slice(m[0].length);
  }
  return { tag, attrs };
}

function matches(el, sel) {
  const { tag, attrs } = parseSelector(sel);
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  for (const a of attrs) {
    if (a.name === 'class') {
      const classes = (el.className || '').split(/\s+/).filter(Boolean);
      if (a.op === '~') {
        if (!classes.includes(a.value)) return false;
      } else if (a.op === '*') {
        if (!(el.className || '').includes(a.value)) return false;
      }
      continue;
    }
    if (!el.hasAttribute(a.name)) return false;
    if (a.op === '*') {
      if (!el.getAttribute(a.name).includes(a.value)) return false;
    } else if (a.op === '') {
      if (el.getAttribute(a.name) !== a.value) return false;
    }
  }
  return true;
}

class MockMutationObserver {
  static instances = [];
  constructor(cb) { this._cb = cb; this._active = false; MockMutationObserver.instances.push(this); }
  observe(target, opts) { this._target = target; this._opts = opts; this._active = true; }
  disconnect() { this._active = false; }
  _trigger() { if (this._active) this._cb([], this); }
}

// ==================== 测试骨架 ====================

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (detail !== undefined ? ' :: ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDoc() {
  const doc = {};
  const body = new El('body');
  const head = new El('head');
  doc.body = body;
  doc.head = head;
  doc.createElement = (tag) => new El(tag);
  doc.createTextNode = (text) => { const e = new El('#text'); e.textContent = text; return e; };
  doc.querySelectorAll = (sel) => {
    const out = [];
    for (const root of [head, body]) out.push(...root.querySelectorAll(sel));
    return out;
  };
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  return doc;
}

function makeSidebar(doc) {
  const root = new El('div');
  root.className = 'hHd-Xa_root';
  const btn = new El('button');
  btn.setAttribute('aria-label', '新建会话');
  btn.className = 'hHd-Xa_newSession';
  root.appendChild(btn);
  doc.body.appendChild(root);
  return { root, btn };
}

/**
 * 加载 client.js 到 stub 环境。
 * @param {object} doc 文档 stub
 * @param {Function|null} fetchImpl fetch mock
 * @param {Function|null} MutationObserverCtor
 */
function loadClient(doc, fetchImpl, MutationObserverCtor) {
  const sandbox = {
    window: { setTimeout, clearTimeout },
    document: doc,
    console,
    setTimeout,
    clearTimeout,
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  let captured = null;
  sandbox.window.__ModuleLoader__ = {
    load({ id, factory }) { captured = factory; },
  };
  if (MutationObserverCtor) sandbox.MutationObserver = MutationObserverCtor;
  vm.runInNewContext(CLIENT_SRC, sandbox, { filename: 'client.js' });
  if (!captured) throw new Error('ModuleLoader.load was not called');
  const mod = captured(() => { throw new Error('client.js should require nothing'); });
  const cleanups = [];
  const ctx = { effect(fn) { const r = fn(); if (typeof r === 'function') cleanups.push(r); } };
  return { mod, ctx, cleanups, sandbox };
}

const HTML_URL = 'https://github.com/sanfan3/dsh-issue-panel/issues/123';

// ==================== 用例 ====================

async function run() {
  // --- t1: #7 空标题 → 本地拦截，不发请求，错误提示 + 错误样式类 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    const fetchImpl = () => { fetchCalls++; return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 1, html_url: 'https://x/1' }) }); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    const status = doc.querySelector('.dsh-ip-status');
    const titleInput = doc.querySelector('.dsh-ip-title');
    pushBtn.click(); // 标题为空
    await sleep(0);
    assert(fetchCalls === 0, 't1 空标题不发请求（无网络请求）', 'calls=' + fetchCalls);
    assert(status.textContent === '⚠️ 标题是必填的', 't1b 空标题提示文案', 'got=' + status.textContent);
    assert(status.hidden === false, 't1c 错误提示可见');
    assert(status.className.includes('dsh-ip-status-error'), 't1d 错误样式类已加', 'got=' + status.className);
    assert(pushBtn.disabled === false, 't1e 拦截后按钮仍可用（可继续操作）');
    // P2-05（#7 评审）：空标题拦截后焦点回到标题输入框（用户体验）。
    assert(titleInput._focused === true, 't1f 拦截后焦点回到标题输入框');
  }

  // --- t1f: 空标题变体——纯空格也拦截 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    const fetchImpl = () => { fetchCalls++; return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 2, html_url: 'https://x/2' }) }); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const status = doc.querySelector('.dsh-ip-status');
    titleInput.value = '   ';
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(fetchCalls === 0 && status.textContent.includes('标题是必填的'), 't1f 纯空格标题同样本地拦截');
  }

  // --- t1x: #9 评审 P1-02 —— 已 detached（isConnected=false）的标题框不调 focus（静默降级） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 4, html_url: 'https://x/4' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const status = doc.querySelector('.dsh-ip-status');
    titleInput.isConnected = false; // 模拟已从 DOM 分离的节点
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(titleInput._focused !== true, 't1x detached 节点不调 focus（isConnected=false 静默跳过）');
    assert(status.textContent.includes('标题是必填的'), 't1x-b detached 时错误提示仍正常展示');
  }

  // --- t1y: #9 评审第 2 轮 P1-03 —— isConnected=true 但 focus() 抛错 → try-catch 兜底，流程不中断 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 5, html_url: 'https://x/5' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const status = doc.querySelector('.dsh-ip-status');
    let focusThrown = false;
    titleInput.isConnected = true; // 在 DOM 中（isConnected 检查通过）
    titleInput.focus = () => { focusThrown = true; throw new Error('mock focus failure'); }; // focus 抛错
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(focusThrown === true, 't1y focus 确实被调用（isConnected=true 通过检查）');
    assert(status.textContent.includes('标题是必填的'), 't1y-b focus 抛错被 catch 兜住，错误提示仍正常展示（流程不中断）');
  }

  // --- t1z: #10 评审 P1-01 —— isConnected === undefined（IE11/旧 Edge 无该属性）→ 短路求值直接跳过聚焦 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 6, html_url: 'https://x/6' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const status = doc.querySelector('.dsh-ip-status');
    titleInput.isConnected = undefined; // 模拟老浏览器（注释声明的兼容性场景）
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(titleInput._focused !== true, 't1z isConnected=undefined 不调 focus（undefined && … 恒为 false 短路跳过）');
    assert(status.textContent.includes('标题是必填的'), 't1z-b undefined 时错误提示仍正常展示');
  }

  // --- t1g: #7 提示后可继续编辑重试（拦截 → 填标题 → 成功） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    const fetchImpl = () => { fetchCalls++; return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 3, html_url: 'https://x/3' }) }); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    const status = doc.querySelector('.dsh-ip-status');
    pushBtn.click(); // 空标题 → 拦截
    await sleep(0);
    assert(status.textContent.includes('标题是必填的'), 't1g 前置：空标题被拦截');
    titleInput.value = '补充后的标题'; // 继续编辑
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    pushBtn.click(); // 重试
    await sleep(0);
    assert(fetchCalls === 1, 't1g-b 重试后发起请求', 'calls=' + fetchCalls);
    assert(status.textContent.includes('✓ 已创建 issue #3'), 't1g-c 重试成功');
  }

  // --- t2: #7 后端错误（未配置）→ 可读错误 + 错误样式 + 按钮恢复 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { code: 'config-not-configured', message: '未配置 GitHub 仓库，请先编辑配置文件' } }),
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    const status = doc.querySelector('.dsh-ip-status');
    pushBtn.click();
    await sleep(0);
    assert(status.textContent.includes('未配置 GitHub 仓库'), 't2 未配置错误可读提示', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't2b 后端错误也用错误样式');
    assert(pushBtn.disabled === false, 't2c 错误后按钮恢复可用（可重试）');
  }

  // --- t2d: #7 后端 API 失败（401 透传）→ 可读错误 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { code: 'github-api', message: 'GitHub 认证失败（401）' } }),
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent.includes('GitHub 认证失败'), 't2d API 错误透传可读提示', 'got=' + status.textContent);
  }

  // --- t3: #7 网络失败 → 连接失败提示 + 按钮恢复 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.reject(new Error('network down'));
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    const status = doc.querySelector('.dsh-ip-status');
    pushBtn.click();
    await sleep(0);
    assert(status.textContent.includes('无法连接服务'), 't3 网络失败提示', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't3b 网络失败用错误样式');
    assert(pushBtn.disabled === false, 't3c 失败后按钮恢复可用');
  }

  // --- t4: #8 成功 → 状态行含 issue 号 + 可点击链接（新窗口）+ 表单清空 + 描述高度复位 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 123, html_url: HTML_URL }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const taskInput = doc.querySelector('.dsh-ip-task');
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    const status = doc.querySelector('.dsh-ip-status');
    titleInput.value = '  测试标题  ';
    taskInput.value = '多行\n任务';
    taskInput.scrollHeight = 88;
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    pushBtn.click();
    await sleep(0);
    assert(status.textContent.includes('✓ 已创建 issue #123'), 't4 成功文案含 issue 号', 'got=' + status.textContent);
    assert(status.textContent.includes(HTML_URL), 't4b 成功文案含链接地址', 'got=' + status.textContent);
    const link = status.querySelector('a');
    assert(!!link, 't4c 状态行内存在 <a> 链接节点');
    assert(link && link.getAttribute('href') === HTML_URL, 't4d 链接 href 正确');
    assert(link && link.getAttribute('target') === '_blank', 't4e 链接新窗口打开（target=_blank）');
    assert(link && link.getAttribute('rel') === 'noopener noreferrer', 't4f 链接 rel 安全属性');
    assert(status.className === 'dsh-ip-status', 't4g 成功状态无错误样式类', 'got=' + status.className);
    assert(titleInput.value === '', 't4h 成功后标题清空', 'got=' + JSON.stringify(titleInput.value));
    assert(taskInput.value === '', 't4i 成功后任务清空');
    // P1-03（#7 评审）：清空后 scrollHeight 动态回落（value 变化使手动覆盖失效），
    // 高度复位到「空内容基准」而非残留的多行高度——与真实 DOM 语义一致。
    assert(taskInput.style.height === '40px', 't4j 清空后任务高度复位（动态 scrollHeight=40）', 'got=' + taskInput.style.height);
    assert(pushBtn.disabled === false, 't4k 成功后按钮恢复可用');
  }

  // --- t4l: #8 成功但无 html_url（异常响应）→ 只显示 issue 号，不渲染链接 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 456, html_url: null }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent.includes('✓ 已创建 issue #456'), 't4l 无链接时仍显示 issue 号', 'got=' + status.textContent);
    assert(!status.querySelector('a'), 't4m 无 html_url 时不渲染 <a> 节点');
  }

  // --- t4n: #8 评审 P1-01 —— 恶意/非 http(s) 协议 URL 不渲染链接（XSS 纵深防御） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const evil = 'javascript:alert(1)';
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 789, html_url: evil }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent.includes('✓ 已创建 issue #789'), 't4n 恶意 URL 时仍显示 issue 号', 'got=' + status.textContent);
    assert(!status.querySelector('a'), 't4o javascript: 协议 URL 不渲染 <a> 节点（P1-01）');
  }

  // --- t4p: #8 评审第 2 轮 P2-02 —— 空协议 URL（"https://" 无 host）不渲染链接 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 321, html_url: 'https://' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent.includes('✓ 已创建 issue #321'), 't4p 空协议 URL 时仍显示 issue 号', 'got=' + status.textContent);
    assert(!status.querySelector('a'), 't4q 空 host 的 https:// 不渲染 <a> 节点（P2-02）');
  }

  // --- t4r: #8 评审第 2 轮 P1-01 —— number 非数字时不渲染成功反馈（调用处已拦截） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 'not-a-number', html_url: HTML_URL }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent.includes('推送失败'), 't4r number 非数字走错误分支（可读提示，不渲染成功反馈）', 'got=' + JSON.stringify(status.textContent));
    assert(!status.querySelector('a'), 't4s number 非数字时不渲染 <a> 节点');
  }

  // --- t5: 防重入 —— 请求期间按钮禁用，重复点击不重复请求 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    let releaseResolve;
    const gate = new Promise((r) => { releaseResolve = r; });
    const fetchImpl = () => { fetchCalls++; return gate.then(() => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 7, html_url: 'https://x/7' }) })); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    const pushBtn = doc.querySelector('.dsh-ip-btn-primary');
    pushBtn.click();
    assert(pushBtn.disabled === true, 't5 请求进行中按钮禁用');
    pushBtn.click(); // 防重入：应被忽略
    assert(fetchCalls === 1, 't5b 请求期间重复点击未重复发起请求', 'calls=' + fetchCalls);
    releaseResolve();
    await sleep(0);
    assert(pushBtn.disabled === false, 't5c 完成后按钮恢复');
  }

  // --- t6: 热重载竞态 —— 请求期间插件清理后，成功回调不抛错 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let releaseResolve;
    const gate = new Promise((r) => { releaseResolve = r; });
    const fetchImpl = () => gate.then(() => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 8, html_url: 'https://x/8' }) }));
    const { mod, ctx, cleanups } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click(); // 进入请求（pending）
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    const style = doc.querySelector('style[data-plugin-css="dsh-issue-panel/styles"]');
    if (entry) entry.remove();
    if (overlay) overlay.remove();
    if (style) style.remove();
    cleanups.forEach((fn) => fn());
    releaseResolve();
    await sleep(0);
    assert(true, 't6 热重载竞态下成功回调不抛错（节点已移除）');
  }

  // --- t7: P2-02 —— 成功提示留存：关面板再开，状态行仍可见（通知留存，符合 P0-01 不重建） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 9, html_url: 'https://x/9' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    entry.click(); // 打开面板
    assert(overlay.hidden === false, 't7 前置：面板已打开');
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    doc.querySelector('.dsh-ip-accept').value = '验收项'; // #36 起验收标准必填
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const status1 = doc.querySelector('.dsh-ip-status');
    assert(status1.textContent.includes('✓ 已创建 issue #9'), 't7b 前置：成功提示已展示');
    entry.click(); // 关闭面板
    assert(overlay.hidden === true, 't7c 面板已关闭');
    entry.click(); // 重新打开
    assert(overlay.hidden === false, 't7d 面板已重新打开');
    const status2 = doc.querySelector('.dsh-ip-status');
    const overlay2 = doc.querySelector('[data-dsh-issue-panel-overlay]');
    assert(overlay === overlay2, 't7e overlay 未被重建（P0-01）');
    assert(status2 && status2.textContent.includes('✓ 已创建 issue #9'), 't7f 重新打开后成功提示留存', 'got=' + (status2 && status2.textContent));
  }

  // --- t8: 回归 —— #5 入口注入 / #6 表单结构仍正常 ---
  {
    const doc = makeDoc();
    const { btn } = makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    assert(!!entry, 't8 #5 回归：入口注入');
    assert(entry && entry.previousElementSibling === btn, 't8b #5 回归：入口位置');
    const form = doc.querySelector('.dsh-ip-form');
    assert(!!form, 't8c #6 回归：表单存在');
    const labels = form.querySelectorAll('.dsh-ip-field-label').map((l) => l.textContent).sort().join(',');
    assert(labels === '必填,必填,选填,选填', 't8d #6+#36 回归：四字段二字标签', 'got=' + labels);
    assert(!!doc.querySelector('style[data-plugin-css="dsh-issue-panel/styles"]'), 't8e 样式注入');
  }

  // --- t9: #9 评审 P0-01 —— 同 window 重复执行 bundle（id 已注册）→ warn 跳过，不抛未捕获错误 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const warns = [];
    const errors = [];
    const captured = [];
    const sandbox = {
      window: { setTimeout, clearTimeout },
      document: doc,
      console: { ...console, warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) },
      setTimeout,
      clearTimeout,
      MutationObserver: MockMutationObserver,
    };
    let registered = false;
    sandbox.window.__ModuleLoader__ = {
      load({ id, factory }) {
        // 模拟 dsh-client-modules 真实行为：先检查后注册，重复 id 直接抛错（无副作用）。
        if (registered) {
          throw new Error('client-modules: duplicate factory registration for "' + id + '" (bundle executed twice without invalidate?)');
        }
        registered = true;
        captured.push(factory);
      },
    };
    vm.runInNewContext(CLIENT_SRC, sandbox, { filename: 'client.js' }); // 第一次：注册成功
    vm.runInNewContext(CLIENT_SRC, sandbox, { filename: 'client.js' }); // 第二次：重复执行 → 应 warn 跳过
    assert(captured.length === 1, 't9 重复执行时只注册一次 factory', 'registered=' + captured.length);
    assert(warns.length === 1 && warns[0].includes('重复'), 't9b 重复执行时 warn 提示（不崩溃）', 'warns=' + JSON.stringify(warns));
    assert(errors.length === 0, 't9c 重复执行不产生未捕获 error', 'errors=' + JSON.stringify(errors));
    const mod = captured[0](() => { throw new Error('client.js should require nothing'); });
    const cleanups = [];
    const ctx = { effect(fn) { const r = fn(); if (typeof r === 'function') cleanups.push(r); } };
    mod.apply(ctx);
    assert(doc.querySelectorAll('[data-dsh-issue-panel-entry]').length === 1, 't9d 插件仍可正常应用且入口唯一');
  }

  // --- 汇总 ---
  console.log(`\nissue78-dom: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
