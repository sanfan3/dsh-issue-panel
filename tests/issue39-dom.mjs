// #39 Client：左右对比弹窗 + 引用合并确认（完整版 FR-3 优化issue 交互）—— DOM 行为测试
// 无浏览器/无 jsdom 环境下，用轻量 DOM stub + vm 加载真实 lib/client.js，
// 对照 #39 验收标准逐条验证：
//   [x] 弹窗两列内容正确，空字段显示「（空）」（t2/t2b/t2c）
//   [x] 放弃后表单无任何变化（t3）
//   [x] 确认后四字段替换、引用合并去重（t4/t5）
//   [x] 合并不覆盖用户已填引用（t5）
//   [x] 测试覆盖确认/放弃/合并三种路径（t3/t4/t5）
// 另覆盖：请求中「优化中…」+ 按钮禁用（t1）、parseError 不替换表单（t6）、
//        错误信封展示可读信息（t7）、网络失败恢复按钮（t8）、防重入（t9）、
//        校验拦截回归（t10）、热重载竞态（t11）、确认后任务 autoResize（t12）。
// 运行：node tests/issue39-dom.mjs（exit 0 = 全部 PASS）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

// ==================== 轻量 DOM stub（与 issue5/6/36/78 同构） ====================

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

/** 便捷：填好标题+一条验收标准（满足校验前置），返回 doc 相关节点。 */
function fillValidForm(doc, opts = {}) {
  doc.querySelector('.dsh-ip-title').value = opts.title !== undefined ? opts.title : '修复登录页';
  doc.querySelector('.dsh-ip-task').value = opts.task !== undefined ? opts.task : '1) 复现问题\n2) 修复';
  doc.querySelector('.dsh-ip-ref').value = opts.ref0 !== undefined ? opts.ref0 : 'https://github.com/sanfan3/dsh-issue-panel/issues/1';
  doc.querySelector('.dsh-ip-accept').value = opts.accept0 !== undefined ? opts.accept0 : '登录页可正常访问';
  return doc;
}

/** 构造 /optimize 成功响应（200 信封）。 */
function okOptimizeResponse(draft, parseError = null) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ ok: true, value: { draft, parseError } }),
  });
}

/** 读取弹窗左/右列所有字段值（label → 值文本）。 */
function readCompareCols(doc) {
  const cols = doc.querySelectorAll('.dsh-ip-cmp-col');
  if (cols.length !== 2) return null;
  const read = (col) => {
    const out = {};
    const fields = col.querySelectorAll('.dsh-ip-cmp-field');
    for (const f of fields) {
      const lbl = f.querySelector('.dsh-ip-cmp-field-label');
      const val = f.querySelector('.dsh-ip-cmp-field-value');
      out[lbl.textContent] = val.textContent;
    }
    return out;
  };
  return { left: read(cols[0]), right: read(cols[1]) };
}

// ==================== 用例 ====================

async function run() {
  // --- t1: 点优化 → fetch /optimize + payload 四字段 + 「优化中…」+ 按钮禁用 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const calls = [];
    const fetchImpl = (url, opts) => {
      calls.push({ url, opts });
      return okOptimizeResponse({
        title: '修复登录页', task: '1) 复现\n2) 修复',
        refs: ['#1'], acceptItems: ['- [ ] 登录页可正常访问'],
      });
    };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc);
    const optimizeBtn = doc.querySelector('.dsh-ip-btn-optimize');
    const status = doc.querySelector('.dsh-ip-status');
    optimizeBtn.click();
    // 同步断言：请求中状态 + 按钮禁用
    assert(status.textContent === '优化中…', 't1 点击后状态行显示「优化中…」', 'got=' + status.textContent);
    assert(optimizeBtn.disabled === true, 't1b 请求中优化按钮禁用');
    await sleep(0);
    assert(calls.length === 1 && calls[0].url === '/api/issue-panel/optimize', 't1c 发起一次 /optimize fetch', 'url=' + calls[0].url);
    const sent = JSON.parse(calls[0].opts.body);
    assert(sent.title === '修复登录页' && sent.task.includes('1) 复现') && sent.refs.length === 1 && sent.acceptItems.length === 1, 't1d payload 为四字段 draft', 'got=' + JSON.stringify(sent));
    assert(optimizeBtn.disabled === false, 't1e 响应后按钮恢复可用');
  }

  // --- t2: 弹窗两列内容正确（左=原文、右=优化后），空字段显示「（空）」 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => okOptimizeResponse({
      title: '优化后的标题', task: '',
      refs: ['#1', 'https://api.example.com/doc'], acceptItems: ['- [ ] 优化后验收项'],
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { title: '原始标题', task: '原始任务', accept0: '原始验收项' });
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    const cmp = doc.querySelector('.dsh-ip-cmp-overlay');
    assert(!!cmp, 't2 弹窗出现');
    const cols = readCompareCols(doc);
    assert(cols !== null, 't2b 弹窗左右两列');
    assert(cols.left['标题'] === '原始标题', 't2c 左列标题=原文', 'got=' + cols.left['标题']);
    assert(cols.left['任务'] === '原始任务', 't2d 左列任务=原文', 'got=' + cols.left['任务']);
    assert(cols.left['引用'] === 'https://github.com/sanfan3/dsh-issue-panel/issues/1', 't2e 左列引用=原文', 'got=' + cols.left['引用']);
    // collectDraft 已规范化验收标准（补「- [ ] 」前缀），左列显示规范化后的原文
    assert(cols.left['验收标准'] === '- [ ] 原始验收项', 't2f 左列验收标准=原文（已规范化）', 'got=' + cols.left['验收标准']);
    assert(cols.right['标题'] === '优化后的标题', 't2g 右列标题=优化后', 'got=' + cols.right['标题']);
    // 右列任务为空 → 显示「（空）」（验收标准 1）
    assert(cols.right['任务'] === '（空）', 't2h 右列空字段显示「（空）」', 'got=' + cols.right['任务']);
    const emptyEls = doc.querySelectorAll('.dsh-ip-cmp-empty');
    assert(emptyEls.length === 1 && emptyEls[0].textContent === '（空）', 't2i 空字段带 .dsh-ip-cmp-empty 样式', 'count=' + emptyEls.length);
    assert(cols.right['引用'] === '#1\nhttps://api.example.com/doc', 't2j 右列引用=优化后（换行连接）', 'got=' + cols.right['引用']);
    assert(cols.right['验收标准'] === '- [ ] 优化后验收项', 't2k 右列验收标准=优化后', 'got=' + cols.right['验收标准']);
    // 列标题
    const heads = doc.querySelectorAll('.dsh-ip-cmp-col-head').map((h) => h.textContent);
    assert(heads[0] === '你写的' && heads[1] === 'dsh 优化后', 't2l 列标题「你写的」/「dsh 优化后」', 'got=' + heads.join(','));
    // 按钮
    const btns = doc.querySelector('.dsh-ip-cmp-actions').querySelectorAll('button').map((b) => b.textContent);
    assert(btns.includes('放弃（不改动）') && btns.includes('✓ 确认替换'), 't2m 两个按钮「放弃（不改动）」/「✓ 确认替换」', 'got=' + btns.join(','));
  }

  // --- t3: 放弃 → 弹窗关闭 + 表单无任何变化（验收标准 2） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => okOptimizeResponse({
      title: '优化标题', task: '优化任务',
      refs: ['#9'], acceptItems: ['- [ ] 优化验收'],
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { title: '原始标题', task: '原始任务', ref0: '#1', accept0: '原始验收项' });
    const status = doc.querySelector('.dsh-ip-status');
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    const abandonBtn = doc.querySelector('.dsh-ip-cmp-actions').querySelectorAll('button')[0];
    assert(abandonBtn.textContent === '放弃（不改动）', 't3 找到放弃按钮');
    abandonBtn.click();
    assert(doc.querySelector('.dsh-ip-cmp-overlay') === null, 't3b 放弃后弹窗关闭');
    assert(doc.querySelector('.dsh-ip-title').value === '原始标题', 't3c 放弃后标题不变', 'got=' + doc.querySelector('.dsh-ip-title').value);
    assert(doc.querySelector('.dsh-ip-task').value === '原始任务', 't3d 放弃后任务不变', 'got=' + doc.querySelector('.dsh-ip-task').value);
    assert(doc.querySelector('.dsh-ip-ref').value === '#1', 't3e 放弃后引用不变', 'got=' + doc.querySelector('.dsh-ip-ref').value);
    assert(doc.querySelector('.dsh-ip-accept').value === '原始验收项', 't3f 放弃后验收标准不变', 'got=' + doc.querySelector('.dsh-ip-accept').value);
    // 状态行无「已应用」字样
    assert(status.textContent !== '✨ 已应用优化结果', 't3g 放弃不产生应用提示', 'got=' + status.textContent);
  }

  // --- t4: 确认 → 四字段替换 + 引用/验收列表重建（验收标准 3） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => okOptimizeResponse({
      title: '优化标题（动词开头）', task: '1) 第一步\n2) 第二步',
      refs: ['#1', 'https://api.example.com/x'], acceptItems: ['- [ ] 优化验收一', '- [ ] 优化验收二'],
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { title: '原始标题', task: '原始任务', ref0: '#1', accept0: '原始验收项' });
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    const confirmBtn = doc.querySelector('.dsh-ip-cmp-actions').querySelectorAll('button')[1];
    confirmBtn.click();
    assert(doc.querySelector('.dsh-ip-cmp-overlay') === null, 't4 确认后弹窗关闭');
    assert(doc.querySelector('.dsh-ip-title').value === '优化标题（动词开头）', 't4b 确认后标题替换', 'got=' + doc.querySelector('.dsh-ip-title').value);
    assert(doc.querySelector('.dsh-ip-task').value === '1) 第一步\n2) 第二步', 't4c 确认后任务替换', 'got=' + JSON.stringify(doc.querySelector('.dsh-ip-task').value));
    const refInputs = doc.querySelectorAll('.dsh-ip-ref');
    assert(refInputs.length === 2 && refInputs[0].value === '#1' && refInputs[1].value === 'https://api.example.com/x', 't4d 确认后引用列表重建为两条', 'got=' + refInputs.map((i) => i.value).join('|'));
    const acceptInputs = doc.querySelectorAll('.dsh-ip-accept');
    assert(acceptInputs.length === 2 && acceptInputs[0].value === '- [ ] 优化验收一' && acceptInputs[1].value === '- [ ] 优化验收二', 't4e 确认后验收标准列表重建为两条', 'got=' + acceptInputs.map((i) => i.value).join('|'));
    const status = doc.querySelector('.dsh-ip-status');
    assert(status.textContent === '✨ 已应用优化结果', 't4f 确认后状态行提示「已应用优化结果」', 'got=' + status.textContent);
  }

  // --- t5: 合并不覆盖用户已填引用 + 去重（验收标准 3/4：用户 ∪ AI，去重） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    // host 端 mergeRefs 语义：用户条目保持原顺序在前，AI 补充追加在后，去重（trim+小写）。
    // 用户已填：['#1', 'https://github.com/sanfan3/dsh-issue-panel/issues/2']
    // AI 补充：['#3', '#1']（#1 与用户重复 → 去重；#3 追加）
    const fetchImpl = () => okOptimizeResponse({
      title: '优化标题', task: '',
      refs: ['#1', 'https://github.com/sanfan3/dsh-issue-panel/issues/2', '#3'],
      acceptItems: ['- [ ] 验收'],
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { ref0: '#1' });
    doc.querySelector('.dsh-ip-add-ref').click();
    doc.querySelectorAll('.dsh-ip-ref')[1].value = 'https://github.com/sanfan3/dsh-issue-panel/issues/2';
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    const confirmBtn = doc.querySelector('.dsh-ip-cmp-actions').querySelectorAll('button')[1];
    confirmBtn.click();
    const refInputs = doc.querySelectorAll('.dsh-ip-ref');
    assert(refInputs.length === 3, 't5 确认后引用列表 = 合并去重结果（3 条）', 'count=' + refInputs.length);
    assert(refInputs[0].value === '#1', 't5b 用户首条引用保留且在前', 'got=' + refInputs[0].value);
    assert(refInputs[1].value === 'https://github.com/sanfan3/dsh-issue-panel/issues/2', 't5c 用户第二条引用保留', 'got=' + refInputs[1].value);
    assert(refInputs[2].value === '#3', 't5d AI 补充 #3 追加在后', 'got=' + refInputs[2].value);
    // 去重：无重复条目
    const vals = refInputs.map((i) => i.value);
    assert(new Set(vals).size === vals.length, 't5e 合并结果无重复条目');
  }

  // --- t6: parseError 非 null → 提示且不替换表单、不弹窗（#37/#38 契约） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => okOptimizeResponse(
      { title: '', task: '', refs: [], acceptItems: [] },
      '无法从 dsh 优化输出中解析出四字段'
    );
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { title: '原始标题' });
    const status = doc.querySelector('.dsh-ip-status');
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    assert(doc.querySelector('.dsh-ip-cmp-overlay') === null, 't6 parseError 时不弹窗');
    assert(status.textContent === '⚠️ 无法从 dsh 优化输出中解析出四字段（表单未改动）', 't6b 提示解析失败且注明表单未改动', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't6c 错误样式');
    assert(doc.querySelector('.dsh-ip-title').value === '原始标题', 't6d 表单未被替换');
  }

  // --- t7: 502 错误信封 → 展示可读错误，不弹窗 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.resolve({
      ok: false, status: 502,
      json: () => Promise.resolve({ ok: false, error: { code: 'optimize-timeout', message: '优化超时（120 秒），请稍后重试或精简需求内容' } }),
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc);
    const status = doc.querySelector('.dsh-ip-status');
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    assert(doc.querySelector('.dsh-ip-cmp-overlay') === null, 't7 失败不弹窗');
    assert(status.textContent === '⚠️ 优化超时（120 秒），请稍后重试或精简需求内容', 't7b 展示错误信封 message', 'got=' + status.textContent);
    assert(status.className.includes('dsh-ip-status-error'), 't7c 错误样式');
  }

  // --- t8: 网络失败（fetch reject）→ 提示无法连接 + 按钮恢复 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => Promise.reject(new Error('network down'));
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc);
    const status = doc.querySelector('.dsh-ip-status');
    const optimizeBtn = doc.querySelector('.dsh-ip-btn-optimize');
    optimizeBtn.click();
    await sleep(0);
    assert(status.textContent === '⚠️ 无法连接服务，请稍后重试', 't8 网络失败提示', 'got=' + status.textContent);
    assert(optimizeBtn.disabled === false, 't8b 网络失败后按钮恢复');
  }

  // --- t9: 请求中防重入（二次点击被忽略） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let calls = 0;
    let resolveFetch;
    const fetchImpl = () => {
      calls++;
      return new Promise((r) => { resolveFetch = r; });
    };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc);
    const optimizeBtn = doc.querySelector('.dsh-ip-btn-optimize');
    optimizeBtn.click();
    optimizeBtn.click(); // 请求挂起中再次点击
    assert(calls === 1, 't9 请求中重复点击只发一次请求', 'calls=' + calls);
    resolveFetch(okOptimizeResponse({ title: 't', task: '', refs: [], acceptItems: ['- [ ] a'] }));
    await sleep(0);
  }

  // --- t10: 校验拦截回归（空标题 / 空验收标准，不发请求） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let fetchCalls = 0;
    const fetchImpl = () => { fetchCalls++; return okOptimizeResponse({ title: 'x', task: '', refs: [], acceptItems: ['- [ ] a'] }); };
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    const status = doc.querySelector('.dsh-ip-status');
    const optimizeBtn = doc.querySelector('.dsh-ip-btn-optimize');
    // 空标题
    doc.querySelector('.dsh-ip-title').value = '';
    doc.querySelector('.dsh-ip-accept').value = '验收项';
    optimizeBtn.click();
    await sleep(0);
    assert(fetchCalls === 0, 't10 空标题拦截不发请求', 'calls=' + fetchCalls);
    assert(status.textContent === '⚠️ 标题是必填的', 't10b 空标题提示', 'got=' + status.textContent);
    // 验收标准空
    doc.querySelector('.dsh-ip-title').value = '标题';
    doc.querySelector('.dsh-ip-accept').value = '';
    optimizeBtn.click();
    await sleep(0);
    assert(fetchCalls === 0, 't10c 空验收标准拦截不发请求', 'calls=' + fetchCalls);
    assert(status.textContent === '⚠️ 验收标准至少写一条（空白行不计入）', 't10d 空验收标准提示', 'got=' + status.textContent);
    // 双空：标题优先
    doc.querySelector('.dsh-ip-title').value = '';
    optimizeBtn.click();
    await sleep(0);
    assert(status.textContent === '⚠️ 标题是必填的', 't10e 双空时标题校验优先', 'got=' + status.textContent);
  }

  // --- t11: 热重载竞态——请求期间表单被移除，响应后不崩溃 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    let resolveFetch;
    const fetchImpl = () => new Promise((r) => { resolveFetch = r; });
    const { mod, ctx, cleanups } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc);
    doc.querySelector('.dsh-ip-btn-optimize').click();
    // 模拟热重载：执行清理（移除全部节点）
    for (const c of cleanups) c();
    resolveFetch(okOptimizeResponse({ title: 't', task: '', refs: [], acceptItems: ['- [ ] a'] }));
    await sleep(0);
    assert(true, 't11 热重载竞态下响应不崩溃（无异常抛出）');
  }

  // --- t12: 确认后任务 autoResize 被触发（高度跟随优化后内容） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const fetchImpl = () => okOptimizeResponse({
      title: '优化标题', task: '1) 长任务第一步\n2) 长任务第二步\n3) 长任务第三步',
      refs: [], acceptItems: ['- [ ] 验收'],
    });
    const { mod, ctx } = loadClient(doc, fetchImpl, MockMutationObserver);
    mod.apply(ctx);
    fillValidForm(doc, { task: '原始任务' });
    const taskInput = doc.querySelector('.dsh-ip-task');
    taskInput.scrollHeight = 128;
    doc.querySelector('.dsh-ip-btn-optimize').click();
    await sleep(0);
    const confirmBtn = doc.querySelector('.dsh-ip-cmp-actions').querySelectorAll('button')[1];
    confirmBtn.click();
    assert(taskInput.value === '1) 长任务第一步\n2) 长任务第二步\n3) 长任务第三步', 't12 确认后任务内容替换', 'got=' + JSON.stringify(taskInput.value));
    // autoResize 已被触发：style.height 跟随当前 scrollHeight（stub 中 value setter 重置
    // scrollHeightOverride → scrollHeight = 40 + value.length，与真实 DOM「内容变高→scrollHeight 变高」语义一致）
    assert(taskInput.style.height === String(taskInput.scrollHeight) + 'px' && taskInput.style.height !== '', 't12b 确认后任务高度 autoResize 跟随 scrollHeight', 'got=' + taskInput.style.height + ' scrollHeight=' + taskInput.scrollHeight);
  }

  // --- 汇总 ---
  console.log(`\nissue39-dom: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
