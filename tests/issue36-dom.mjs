// #36 Client：表单扩展（FR-1 四字段：标题/任务/引用/验收标准）—— DOM 行为测试
// 无浏览器/无 jsdom 环境下，用轻量 DOM stub + vm 加载真实 lib/client.js，
// 对照 #36 验收标准逐条验证：
//   [x] 任务框输入变高、清空变矮（t2）
//   [x] 引用可添加/删除多条，内容实时写入状态（t3 + t7）
//   [x] 验收标准可添加/删除，序列化为「- [ ] 条目」换行格式（t4）
//   [x] 验收标准为空时点推送/优化被拦截，提示「⚠️ 验收标准至少写一条」（t5/t6）
//   [x] 四字段标签仅「标题（必填）/任务（选填）/引用（选填）/验收标准（必填）」（t1）
// 另覆盖：四字段结构、draft 收集（refs 过滤空串 / acceptItems 规范化）、
//        推送 payload 四字段、clearForm 四字段重置（引用/验收列表回单行空）。
// 运行：node tests/issue36-dom.mjs（exit 0 = 全部 PASS）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

// ==================== 轻量 DOM stub（与 issue5/6/78 同构） ====================

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
    this._value = undefined;
    this._scrollHeightOverride = undefined;
    this.disabled = false;
  }
  set value(v) { this._value = String(v); this._scrollHeightOverride = undefined; }
  get value() { return this._value !== undefined ? this._value : ''; }
  set scrollHeight(v) { this._scrollHeightOverride = v; }
  get scrollHeight() {
    if (this._scrollHeightOverride !== undefined) return this._scrollHeightOverride;
    return 40 + (this._value !== undefined ? this._value.length : 0);
  }
  set placeholder(value) { this.setAttribute('placeholder', String(value)); }
  get placeholder() { return this.getAttribute('placeholder'); }
  set href(value) { this.setAttribute('href', String(value)); }
  get href() { return this.getAttribute('href'); }
  set target(value) { this.setAttribute('target', String(value)); }
  get target() { return this.getAttribute('target'); }
  set rel(value) { this.setAttribute('rel', String(value)); }
  get rel() { return this.getAttribute('rel'); }
  get parentElement() { return this.parentNode; }
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

// ==================== 用例 ====================

async function run() {
  // --- t1: 四字段结构（标题/任务/引用/验收标准）+ 二字标签 + aria-label ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const form = doc.querySelector('.dsh-ip-form');
    assert(!!form, 't1 表单存在');
    const titleInput = form.querySelector('.dsh-ip-title');
    const taskInput = form.querySelector('.dsh-ip-task');
    const refsList = form.querySelector('.dsh-ip-refs');
    const acceptsList = form.querySelector('.dsh-ip-accepts');
    assert(!!titleInput && !!taskInput && !!refsList && !!acceptsList, 't1b 四字段节点齐全');
    // 验收标准第 5 条：四字段标签 = 标题（必填）/任务（选填）/引用（选填）/验收标准（必填）
    assert(titleInput && titleInput.getAttribute('aria-label') === '标题（必填）', 't1c 标题 aria-label', 'got=' + (titleInput && titleInput.getAttribute('aria-label')));
    assert(taskInput && taskInput.getAttribute('aria-label') === '任务（选填）', 't1d 任务 aria-label', 'got=' + (taskInput && taskInput.getAttribute('aria-label')));
    const refsField = form.querySelector('[aria-label="引用（选填）"]');
    const acceptsField = form.querySelector('[aria-label="验收标准（必填）"]');
    assert(!!refsField, 't1e 引用字段 aria-label=引用（选填）');
    assert(!!acceptsField, 't1f 验收标准字段 aria-label=验收标准（必填）');
    // 可见标签只显示二字（PRD FR-1）
    const labels = form.querySelectorAll('.dsh-ip-field-label').map((l) => l.textContent).sort().join(',');
    assert(labels === '必填,必填,选填,选填', 't1g 四字段可见标签仅二字', 'got=' + labels);
    // 初始各一行空输入 + 添加按钮
    assert(form.querySelectorAll('.dsh-ip-ref').length === 1, 't1h 引用初始一行');
    assert(form.querySelectorAll('.dsh-ip-accept').length === 1, 't1i 验收标准初始一行');
    const addBtns = form.querySelectorAll('.dsh-ip-add');
    assert(addBtns.length === 2 && addBtns.map((b) => b.textContent).sort().join(',') === '＋ 添加引用,＋ 添加验收项', 't1j 两个「＋ 添加」按钮', 'got=' + addBtns.map((b) => b.textContent).join(','));
    // 引用行 placeholder 提示 URL 或 #issue 号；验收行 placeholder 提示验收项
    const refInput = form.querySelector('.dsh-ip-ref');
    const acceptInput = form.querySelector('.dsh-ip-accept');
    assert(refInput && refInput.getAttribute('placeholder') === 'URL 或 #issue 号', 't1k 引用 placeholder', 'got=' + (refInput && refInput.getAttribute('placeholder')));
    assert(acceptInput && acceptInput.getAttribute('placeholder') === '验收项，如：修复登录页', 't1l 验收标准 placeholder', 'got=' + (acceptInput && acceptInput.getAttribute('placeholder')));
  }

  // --- t2: 任务框自动伸缩（验收标准 1：输入变高、清空变矮） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const taskInput = doc.querySelector('.dsh-ip-task');
    taskInput.value = '步骤一\n步骤二\n步骤三';
    taskInput.scrollHeight = 96;
    taskInput.dispatchEvent({ type: 'input' });
    assert(taskInput.style.height === '96px', 't2 输入变高：height 跟随 scrollHeight', 'got=' + taskInput.style.height);
    taskInput.value = '';
    taskInput.scrollHeight = 30;
    taskInput.dispatchEvent({ type: 'input' });
    assert(taskInput.style.height === '30px', 't2b 清空变矮', 'got=' + taskInput.style.height);
  }

  // --- t3: 引用可添加/删除多条，内容实时写入状态（draft.refs 实时反映） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const refsList = doc.querySelector('.dsh-ip-refs');
    const addRefBtn = doc.querySelector('.dsh-ip-add-ref');
    // 初始一行，填内容
    let refInputs = doc.querySelectorAll('.dsh-ip-ref');
    refInputs[0].value = 'https://github.com/sanfan3/dsh-issue-panel/issues/1';
    // 添加一行
    addRefBtn.click();
    refInputs = doc.querySelectorAll('.dsh-ip-ref');
    assert(refInputs.length === 2, 't3 点「＋ 添加引用」新增一行', 'count=' + refInputs.length);
    refInputs[1].value = '#12';
    // 再添加一行（空着不填，验证 draft 过滤空串）
    addRefBtn.click();
    refInputs = doc.querySelectorAll('.dsh-ip-ref');
    assert(refInputs.length === 3, 't3b 再添加一行', 'count=' + refInputs.length);
    // 删除第二行（#12 那行）
    const delBtns = refsList.querySelectorAll('.dsh-ip-row-del');
    delBtns[1].click();
    refInputs = doc.querySelectorAll('.dsh-ip-ref');
    assert(refInputs.length === 2, 't3c 删除一行后剩两行', 'count=' + refInputs.length);
    assert(refInputs[0].value === 'https://github.com/sanfan3/dsh-issue-panel/issues/1', 't3d 删除后首行内容保留');
    assert(refInputs[1].value === '', 't3e 删除后第三行（原空行）保留为空');
    // 实时写入状态：draft.refs 只含非空引用（验证方式：点推送看 payload）
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 1, html_url: 'https://x/1' }) });
    };
    const doc2 = makeDoc();
    makeSidebar(doc2);
    const { mod: mod2, ctx: ctx2 } = loadClient(doc2, fetchImpl, MockMutationObserver);
    mod2.apply(ctx2);
    doc2.querySelector('.dsh-ip-title').value = '测试标题';
    doc2.querySelector('.dsh-ip-accept').value = '验收项';
    doc2.querySelector('.dsh-ip-ref').value = 'https://github.com/sanfan3/dsh-issue-panel/issues/1';
    doc2.querySelector('.dsh-ip-add-ref').click();
    doc2.querySelectorAll('.dsh-ip-ref')[1].value = '#12';
    doc2.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const sent = JSON.parse(calls[0].opts.body);
    assert(Array.isArray(sent.refs) && sent.refs.length === 2 && sent.refs[0] === 'https://github.com/sanfan3/dsh-issue-panel/issues/1' && sent.refs[1] === '#12', 't3f draft.refs 实时写入状态（两条非空引用）', 'got=' + JSON.stringify(sent.refs));
  }

  // --- t4: 验收标准可添加/删除，序列化为「- [ ] 条目」换行格式（验收标准 3） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const acceptsList = doc.querySelector('.dsh-ip-accepts');
    const addAcceptBtn = doc.querySelector('.dsh-ip-add-accept');
    // 添加三条：无前缀 / 已有前缀 / 已勾选形态（验证规范化分支）
    addAcceptBtn.click();
    addAcceptBtn.click();
    let acceptInputs = doc.querySelectorAll('.dsh-ip-accept');
    acceptInputs[0].value = '修复登录页';      // 无前缀 → 自动补「- [ ] 」
    acceptInputs[1].value = '- [ ] 已有前缀';    // 有前缀 → 保留
    acceptInputs[2].value = '- [x] 已完成项';    // 已勾选形态 → 保留（不双重加前缀）
    assert(acceptInputs.length === 3, 't4 验收标准可添加多条', 'count=' + acceptInputs.length);
    // 删除第一行
    const delBtns = acceptsList.querySelectorAll('.dsh-ip-row-del');
    delBtns[0].click();
    acceptInputs = doc.querySelectorAll('.dsh-ip-accept');
    assert(acceptInputs.length === 2, 't4b 删除一条后剩两条', 'count=' + acceptInputs.length);
    assert(acceptInputs[0].value === '- [ ] 已有前缀', 't4c 删除后剩余行内容正确');
    // 删除到 0 行（必填字段允许删空，由推送/优化校验拦截）
    const delBtns2 = acceptsList.querySelectorAll('.dsh-ip-row-del');
    delBtns2[0].click();
    delBtns2[1].click();
    assert(doc.querySelectorAll('.dsh-ip-accept').length === 0, 't4d 可删除到 0 行');
    // 序列化：通过推送 payload 的 acceptItems（collectDraft 时规范化）验证
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 2, html_url: 'https://x/2' }) });
    };
    const doc3 = makeDoc();
    makeSidebar(doc3);
    const { mod: mod3, ctx: ctx3 } = loadClient(doc3, fetchImpl, MockMutationObserver);
    mod3.apply(ctx3);
    const ai3 = doc3.querySelectorAll('.dsh-ip-accept');
    ai3[0].value = '修复登录页';
    doc3.querySelector('.dsh-ip-add-accept').click();
    doc3.querySelectorAll('.dsh-ip-accept')[1].value = '- [ ] 已有前缀';
    doc3.querySelector('.dsh-ip-add-accept').click();
    doc3.querySelectorAll('.dsh-ip-accept')[2].value = '- [x] 已完成项'; // 已勾选形态保留
    doc3.querySelector('.dsh-ip-add-accept').click();
    doc3.querySelectorAll('.dsh-ip-accept')[3].value = '  '; // 纯空白 → 过滤
    doc3.querySelector('.dsh-ip-title').value = '测试标题';
    doc3.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const sent = JSON.parse(calls[0].opts.body);
    assert(Array.isArray(sent.acceptItems) && sent.acceptItems.length === 3, 't4e 序列化过滤空条目', 'got=' + JSON.stringify(sent.acceptItems));
    assert(sent.acceptItems[0] === '- [ ] 修复登录页', 't4f 无前缀条目自动补「- [ ] 」', 'got=' + sent.acceptItems[0]);
    assert(sent.acceptItems[1] === '- [ ] 已有前缀', 't4g 已有前缀条目原样保留', 'got=' + sent.acceptItems[1]);
    assert(sent.acceptItems[2] === '- [x] 已完成项', 't4g2 已勾选形态「- [x]」原样保留（不双重加前缀）', 'got=' + sent.acceptItems[2]);
    // 换行格式：条目以 \n 连接（#40 拼装复用的序列化语义）
    assert(sent.acceptItems.join('\n') === '- [ ] 修复登录页\n- [ ] 已有前缀\n- [x] 已完成项', 't4h 序列化为「- [ ] 条目」换行格式');
  }

  // --- t5: 验收标准为空时点推送被拦截（验收标准 4）—— 无 fetch、错误提示精确 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    const fetchImpl = () => { fetchCalls++; return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 3, html_url: 'https://x/3' }) }); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const titleInput = doc.querySelector('.dsh-ip-title');
    const status = doc.querySelector('.dsh-ip-status');
    titleInput.value = '测试标题'; // 标题已填 → 只差验收标准
    // 情形 A：验收标准行存在但内容为空
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(fetchCalls === 0, 't5 验收标准为空不发请求', 'calls=' + fetchCalls);
    assert(status.textContent === '⚠️ 验收标准至少写一条', 't5b 拦截提示文案精确「⚠️ 验收标准至少写一条」', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't5c 拦截提示用错误样式');
    assert(titleInput._focused !== true, 't5d 验收标准拦截不聚焦标题框（与空标题拦截区分）');
    // 情形 B：验收标准行全部删除（0 行）同样拦截
    const delBtns = doc.querySelector('.dsh-ip-accepts').querySelectorAll('.dsh-ip-row-del');
    delBtns[0].click();
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(fetchCalls === 0, 't5e 验收标准 0 行同样拦截', 'calls=' + fetchCalls);
    assert(status.textContent === '⚠️ 验收标准至少写一条', 't5f 0 行时提示同样精确', 'got=' + status.textContent);
    // 情形 C：填写后放行
    doc.querySelector('.dsh-ip-add-accept').click();
    doc.querySelector('.dsh-ip-accept').value = '验收项';
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(fetchCalls === 1, 't5g 填写验收标准后放行发送', 'calls=' + fetchCalls);
  }

  // --- t6: 验收标准为空时点「✨ 优化issue」被拦截（验收标准 4 的「优化」侧） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, null, MockMutationObserver);
    mod.apply(ctx);
    const status = doc.querySelector('.dsh-ip-status');
    const optimizeBtn = doc.querySelector('.dsh-ip-btn-optimize');
    doc.querySelector('.dsh-ip-title').value = '测试标题';
    optimizeBtn.click();
    assert(status.textContent === '⚠️ 验收标准至少写一条', 't6 优化按钮在验收标准为空时同样拦截', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't6b 优化拦截用错误样式');
    // 填写后：优化按钮放行到占位提示（FR-3 开发中；#37 起接 host 路由）
    doc.querySelector('.dsh-ip-accept').value = '验收项';
    optimizeBtn.click();
    assert(status.textContent.includes('优化功能开发中'), 't6c 验收标准已填时优化按钮放行（FR-3 占位提示）', 'got=' + status.textContent);
    assert(!status.className.includes('dsh-ip-status-error'), 't6d 占位提示非错误样式');
    // 标题为空时优化按钮先拦标题
    doc.querySelector('.dsh-ip-title').value = '';
    optimizeBtn.click();
    assert(status.textContent === '⚠️ 标题是必填的', 't6e 优化按钮空标题拦截（标题校验优先）', 'got=' + status.textContent);
  }

  // --- t7: draft 收集（标题 trim / 任务 trim / refs 过滤空串 / acceptItems 规范化） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 4, html_url: 'https://x/4' }) });
    };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '  标题含空格  ';
    doc.querySelector('.dsh-ip-task').value = '  步骤一\n步骤二  ';
    doc.querySelector('.dsh-ip-ref').value = '   https://github.com/sanfan3/dsh-issue-panel/issues/5   ';
    doc.querySelector('.dsh-ip-add-ref').click();
    doc.querySelectorAll('.dsh-ip-ref')[1].value = '   '; // 纯空格 → 过滤
    doc.querySelector('.dsh-ip-accept').value = ' 验收项  ';
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    const sent = JSON.parse(calls[0].opts.body);
    assert(sent.title === '标题含空格', 't7 标题 trim', 'got=' + JSON.stringify(sent.title));
    assert(sent.task === '步骤一\n步骤二', 't7b 任务 trim（保留内部换行）', 'got=' + JSON.stringify(sent.task));
    assert(sent.refs.length === 1 && sent.refs[0] === 'https://github.com/sanfan3/dsh-issue-panel/issues/5', 't7c refs 过滤空串并 trim', 'got=' + JSON.stringify(sent.refs));
    assert(sent.acceptItems.length === 1 && sent.acceptItems[0] === '- [ ] 验收项', 't7d acceptItems 规范化 + trim', 'got=' + JSON.stringify(sent.acceptItems));
  }

  // --- t8: clearForm 重置（推送成功后四字段清空、引用/验收列表回单行空） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 5, html_url: 'https://x/5' }) });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '标题';
    doc.querySelector('.dsh-ip-task').value = '任务';
    doc.querySelector('.dsh-ip-ref').value = '#1';
    doc.querySelector('.dsh-ip-add-ref').click();
    doc.querySelectorAll('.dsh-ip-ref')[1].value = '#2';
    doc.querySelector('.dsh-ip-accept').value = '验收项';
    doc.querySelector('.dsh-ip-add-accept').click();
    doc.querySelectorAll('.dsh-ip-accept')[1].value = '- [ ] 第二项';
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(doc.querySelector('.dsh-ip-title').value === '', 't8 成功后标题清空');
    assert(doc.querySelector('.dsh-ip-task').value === '', 't8b 成功后任务清空');
    assert(doc.querySelectorAll('.dsh-ip-ref').length === 1 && doc.querySelector('.dsh-ip-ref').value === '', 't8c 成功后引用列表重置为单行空');
    assert(doc.querySelectorAll('.dsh-ip-accept').length === 1 && doc.querySelector('.dsh-ip-accept').value === '', 't8d 成功后验收标准列表重置为单行空');
  }

  // --- t9: 推送 payload 四字段完整（title/task/refs/acceptItems，无旧 body 字段） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 6, html_url: 'https://x/6' }) });
    };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    doc.querySelector('.dsh-ip-title').value = '完整测试';
    doc.querySelector('.dsh-ip-task').value = '步骤一';
    doc.querySelector('.dsh-ip-ref').value = '#12';
    doc.querySelector('.dsh-ip-accept').value = '验收';
    doc.querySelector('.dsh-ip-btn-primary').click();
    await sleep(0);
    assert(calls.length === 1 && calls[0].url === '/api/issue-panel/create', 't9 发起一次 create fetch');
    const sent = JSON.parse(calls[0].opts.body);
    assert(sent.title === '完整测试' && sent.task === '步骤一' && sent.refs.length === 1 && sent.refs[0] === '#12' && sent.acceptItems.length === 1 && sent.acceptItems[0] === '- [ ] 验收', 't9b 四字段完整发送', 'got=' + JSON.stringify(sent));
    assert(sent.body === undefined, 't9c payload 无旧 body 字段');
  }

  // --- 汇总 ---
  console.log(`\nissue36-dom: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
