// #5 Client：侧边栏入口注入（MutationObserver 自愈）—— DOM 行为测试
// 无浏览器/无 jsdom 环境下，用轻量 DOM stub + vm 加载真实 lib/client.js，
// 验证：注入位置、防重、自愈（重渲染/重建）、点击开/关、遮罩关闭、状态保持、清理。
// 运行：node tests/issue5-dom.mjs（exit 0 = 全部 PASS）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

// ==================== 轻量 DOM stub ====================

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
  }
  get parentElement() { return this.parentNode; }
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) { this._text = String(value); }
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

function loadClient(doc, MutationObserverCtor) {
  const sandbox = {
    window: { setTimeout, clearTimeout },
    document: doc,
    console,
    setTimeout,
    clearTimeout,
  };
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
  // --- t1/t2: 注入位置 ---
  {
    const doc = makeDoc();
    const { root, btn } = makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    assert(!!entry, 't1 入口已注入');
    assert(entry && entry.parentElement === root, 't2a 入口在侧边栏容器内');
    assert(entry && entry.previousElementSibling === btn, 't2b 入口紧跟「新建会话」按钮之后（位置正确）');
    assert(entry && entry.getAttribute('aria-label') === '需求面板', 't2c 入口 aria-label');
    assert(entry && entry.textContent.includes('需求面板'), 't2d 入口文案含「需求面板」');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    assert(!!overlay, 't2e 覆盖层已挂载');
    assert(overlay && overlay.parentNode === doc.body, 't2f 覆盖层挂 body 下（fixed 参照正确）');
    assert(overlay && overlay.hidden === true, 't2g 初始隐藏');
    const style = doc.querySelector('style[data-plugin-css="dsh-issue-panel/styles"]');
    assert(!!style, 't2h 样式标签注入');
  }

  // --- t3: 防重（重复 apply 不重复注入） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    mod.apply(ctx); // 第二次 apply 应被 DOM 级防重拦截
    const entries = doc.querySelectorAll('[data-dsh-issue-panel-entry]');
    assert(entries.length === 1, 't3 重复 apply 不重复注入（DOM 级防重）', 'count=' + entries.length);
  }

  // --- t4: 自愈（React 重渲染移除入口后重插） ---
  {
    const doc = makeDoc();
    const { root, btn } = makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    let entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    entry.remove(); // 模拟 React 重渲染清掉了我们的节点
    MockMutationObserver.instances.at(-1)._trigger();
    await sleep(120); // 等防抖
    entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    assert(!!entry, 't4 重渲染后入口自愈重插');
    assert(entry && entry.previousElementSibling === btn, 't4b 重插位置正确');
  }

  // --- t5: 自愈（React 重建整个侧边栏） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    // 重建：清空 body 并重新渲染 sidebar（新 root / 新按钮节点）
    for (const c of doc.body.children) c.parentNode = null;
    doc.body.children = [];
    const { root: root2, btn: btn2 } = makeSidebar(doc);
    MockMutationObserver.instances.at(-1)._trigger();
    await sleep(120);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    assert(!!entry, 't5 侧边栏整体重建后入口自愈重插');
    assert(entry && entry.parentElement === root2 && entry.previousElementSibling === btn2, 't5b 重建后位置正确');
  }

  // --- t6/t7: 点击开/关 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    entry.click();
    assert(overlay.hidden === false, 't6 点击入口 → 面板打开（hidden=false）');
    assert(entry.getAttribute('aria-expanded') === 'true', 't6b aria-expanded=true');
    entry.click();
    assert(overlay.hidden === true, 't7 再点入口 → 面板关闭（hidden=true）');
    assert(entry.getAttribute('aria-expanded') === 'false', 't7b aria-expanded=false');
  }

  // --- t8/t9: 遮罩点击关闭、面板内部点击不关闭 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    const panel = overlay.querySelector('.dsh-ip-panel');
    entry.click();
    panel.dispatchEvent({ type: 'click', target: panel }); // 面板内部点击
    assert(overlay.hidden === false, 't8 面板内部点击不关闭');
    overlay.dispatchEvent({ type: 'click', target: overlay }); // 遮罩背景点击
    assert(overlay.hidden === true, 't9 遮罩背景点击关闭面板');
  }

  // --- t10: 自愈保持打开状态 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay = doc.querySelector('[data-dsh-issue-panel-overlay]');
    entry.click(); // 打开
    entry.remove();
    overlay.remove(); // React 重渲染清掉两个节点
    MockMutationObserver.instances.at(-1)._trigger();
    await sleep(120);
    const entry2 = doc.querySelector('[data-dsh-issue-panel-entry]');
    const overlay2 = doc.querySelector('[data-dsh-issue-panel-overlay]');
    assert(!!entry2 && !!overlay2, 't10 打开状态下重渲染 → 双节点自愈重插');
    assert(overlay2 && overlay2.hidden === false, 't10b 自愈后保持打开状态');
    assert(entry2 && entry2.getAttribute('aria-expanded') === 'true', 't10c aria-expanded 恢复 true');
  }

  // --- t11: ctx.effect 清理 ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx, cleanups } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    cleanups.forEach((fn) => fn());
    assert(!doc.querySelector('[data-dsh-issue-panel-entry]'), 't11 清理后入口移除');
    assert(!doc.querySelector('[data-dsh-issue-panel-overlay]'), 't11b 清理后覆盖层移除');
    assert(!doc.querySelector('style[data-plugin-css="dsh-issue-panel/styles"]'), 't11c 清理后样式移除');
    const obs = MockMutationObserver.instances.at(-1);
    obs._trigger(); // 清理后 observer 已 disconnect，不应再注入
    await sleep(120);
    assert(!doc.querySelector('[data-dsh-issue-panel-entry]'), 't11d 清理后 observer 已断开，不再自愈注入');
  }

  // --- t12: 侧边栏未渲染（锚点缺失）→ 等 DOM 变化后补注 ---
  {
    const doc = makeDoc();
    const { mod, ctx } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    assert(!doc.querySelector('[data-dsh-issue-panel-entry]'), 't12 侧边栏未渲染时入口不注入');
    // 侧边栏稍后渲染（React 挂载）
    makeSidebar(doc);
    MockMutationObserver.instances.at(-1)._trigger();
    await sleep(120);
    const entry = doc.querySelector('[data-dsh-issue-panel-entry]');
    assert(!!entry, 't12b 侧边栏渲染后（DOM 变化）自动补注入口');
  }

  // --- t13: 清理取消排队的自愈 timer（热重载残留 P1 修复，对抗自检视角 2） ---
  {
    const doc = makeDoc();
    makeSidebar(doc);
    const { mod, ctx, cleanups } = loadClient(doc, MockMutationObserver);
    mod.apply(ctx);
    // 触发 observer 排队一个自愈 timer（尚未执行）
    MockMutationObserver.instances.at(-1)._trigger();
    // 立即清理（模拟插件卸载/热重载）
    cleanups.forEach((fn) => fn());
    await sleep(120); // 等原 timer 到期：若未被取消会重注入已移除的节点
    assert(!doc.querySelector('[data-dsh-issue-panel-entry]'), 't13 清理后排队中的自愈 timer 被取消，不残留重注入');
    assert(!doc.querySelector('[data-dsh-issue-panel-overlay]'), 't13b 覆盖层同样不残留');
  }

  // --- 汇总 ---
  console.log(`\nissue5-dom: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
