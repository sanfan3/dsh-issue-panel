// dsh-issue-panel —— client 插件（最简版 v0.1.0）
// 加载格式：window.__ModuleLoader__.load({ id, factory })。
// 职责：
//   #5 侧边栏入口注入（MutationObserver 自愈 + 覆盖式面板开关）——已实现
//   #6 面板 UI（表单：标题/描述/推送/关闭按钮 + 自动伸缩）——已实现
//   #7 校验与错误提示联动（空标题本地拦截 + 错误样式）——已实现
//   #8 成功反馈（issue 号 + 可点击链接 + 清空表单）——已实现
//
// 防重策略（P1-01 验证结论，依据 @deepseek-ai/dsh-client-modules/lib/client.js）：
// - ModuleLoader 对重复 id 的 load 会抛错（factories.has → "duplicate factory
//   registration"），因此同页面二次执行 bundle 属异常场景，抛错即快速失败；
// - 浏览器刷新后是新 window、新 ModuleLoader（"double boot?" 检查），正常
//   link: 开发流程（改代码→刷新）不存在重复加载，故不设全局防重标志，
//   避免阻断热重载（刷新即生效）；
// - apply 内部做 DOM 级防重（见 apply 开头），防止同一实例内重复注入。

if (!window.__ModuleLoader__) {
  console.error('[dsh-issue-panel] __ModuleLoader__ not found');
} else {
  window.__ModuleLoader__.load({
    id: 'dsh-issue-panel',
    factory: (require) => {
      'use strict';
      var module = { exports: {} };
      var exports = module.exports;

      exports.name = 'dsh-issue-panel';

      // 依赖注入声明：本插件为纯 DOM 注入，不需要任何 cordis 服务（#5 起）。
      exports.inject = [];

      // ==================== #5 常量 ====================
      // 入口按钮标记（DOM 级防重 + 自愈定位）。
      var ENTRY_SELECTOR = '[data-dsh-issue-panel-entry]';
      // 覆盖式面板容器标记（挂在 document.body 下，见下方「为什么挂 body」注释）。
      var OVERLAY_SELECTOR = '[data-dsh-issue-panel-overlay]';
      // 「新建会话」按钮定位锚点（dsh-client-ui-sidebar 渲染）：
      // - aria-label 是本地化文案（zh/en 双写）；
      // - CSS modules class（hHd-Xa_newSession）是构建期 hash，仅作最后兜底。
      var ANCHOR_SELECTORS = [
        'button[aria-label="新建会话"]',
        'button[aria-label="New session"]',
        'button[aria-label="New Session"]',
        '[class*="newSession"]'
      ];
      // 注入的 <style> 标签标记（防重 + 清理定位）。
      var CSS_TAG_ID = 'dsh-issue-panel/styles';
      // 自愈防抖间隔（ms）：React 重渲染会高频触发 mutation，合并为一次检查。
      var SELF_HEAL_DEBOUNCE_MS = 50;

      // ==================== 面板样式 ====================
      // 尽量复用 dsh 主题变量（--dsw-*），缺省时回退到中性色。
      var STYLES = [
        '.dsh-ip-entry{display:flex;align-items:center;gap:6px;width:100%;margin:6px 0 2px;',
        'padding:7px 12px;box-sizing:border-box;border:none;border-radius:6px;cursor:pointer;',
        'background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:14px;text-align:left;}',
        '.dsh-ip-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
        '.dsh-ip-entry[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
        '.dsh-ip-entry-icon{flex:none;font-size:14px;line-height:1;}',
        '.dsh-ip-entry-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        // 覆盖层：全屏 fixed 遮罩 + 居中面板。挂 body 下（而非侧边栏内）的原因：
        // 侧边栏折叠/展开动画使用 transform（rail-in），transform 祖先会改变 fixed
        // 定位参照系，导致覆盖层错位；body 无 transform，fixed 可靠覆盖对话区。
        '.dsh-ip-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;',
        'justify-content:center;background:rgba(0,0,0,.45);}',
        '.dsh-ip-overlay[hidden]{display:none;}',
        '.dsh-ip-panel{box-sizing:border-box;width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 96px);',
        'overflow:auto;padding:20px;border-radius:12px;',
        'background:var(--dsw-alias-bg-primary,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);',
        'box-shadow:0 12px 40px rgba(0,0,0,.3);}',
        '.dsh-ip-panel-title{margin:0 0 12px;font-size:16px;font-weight:600;}',
        // ---- #6 表单 ----
        '.dsh-ip-form{display:flex;flex-direction:column;gap:12px;}',
        '.dsh-ip-field{display:flex;flex-direction:column;gap:4px;}',
        '.dsh-ip-field-label{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);}',
        '.dsh-ip-title{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid ',
        'var(--dsw-alias-border-default,rgba(31,35,40,.15));border-radius:6px;font-size:14px;',
        'background:var(--dsw-alias-bg-primary,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);}',
        '.dsh-ip-title:focus{outline:none;border-color:var(--dsw-alias-brand,#0969da);}',
        '.dsh-ip-desc{box-sizing:border-box;width:100%;min-height:72px;padding:8px 10px;border:1px solid ',
        'var(--dsw-alias-border-default,rgba(31,35,40,.15));border-radius:6px;font-size:14px;line-height:1.5;',
        'resize:none;overflow:hidden;font-family:inherit;',
        'background:var(--dsw-alias-bg-primary,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);}',
        '.dsh-ip-desc:focus{outline:none;border-color:var(--dsw-alias-brand,#0969da);}',
        '.dsh-ip-actions{display:flex;justify-content:flex-end;gap:8px;}',
        '.dsh-ip-btn{box-sizing:border-box;padding:7px 14px;border:none;border-radius:6px;cursor:pointer;',
        'font-size:14px;font-family:inherit;}',
        '.dsh-ip-btn-primary{background:var(--dsw-alias-brand,#0969da);color:#fff;}',
        '.dsh-ip-btn-primary:disabled{opacity:.55;cursor:not-allowed;}',
        '.dsh-ip-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary,#1f2328);}',
        '.dsh-ip-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}',
        '.dsh-ip-status{margin-top:2px;font-size:13px;line-height:1.5;word-break:break-all;',
        'color:var(--dsw-alias-label-secondary,#57606a);}',
        '.dsh-ip-status[hidden]{display:none;}',
        // #7：错误提示样式——仅换色（红色），不改尺寸/边距，不破坏面板布局。
        '.dsh-ip-status-error{color:var(--dsw-alias-danger,#cf222e);}',
        // #8：成功链接（新窗口打开）。
        '.dsh-ip-status a{color:var(--dsw-alias-brand,#0969da);text-decoration:underline;}'
      ].join('');

      // 面板开关状态（模块级）：自愈重插后恢复，页面刷新自然复位。
      var panelOpen = false;
      var observer = null;
      // 自愈防抖 timer（模块级）：ctx.effect 清理时必须取消，否则排队中的自愈
      // 会在清理后重新注入已移除的节点（热重载残留，对抗自检视角 2）。
      var selfHealTimer = 0;

      // ==================== DOM 工具 ====================
      /** 查找「新建会话」按钮；找不到返回 null（侧边栏可能尚未渲染）。 */
      function findAnchor() {
        for (var i = 0; i < ANCHOR_SELECTORS.length; i++) {
          var el = document.querySelector(ANCHOR_SELECTORS[i]);
          if (el) return el;
        }
        return null;
      }

      /** 注入样式标签（幂等）。 */
      function injectStyles() {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]')) return;
        var tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-issue-panel';
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = STYLES;
        document.head.appendChild(tag);
      }

      /** 创建入口按钮。 */
      function createEntry() {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dsh-ip-entry';
        btn.dataset.dshIssuePanelEntry = '';
        btn.setAttribute('aria-label', '需求面板');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('title', '需求面板');
        var icon = document.createElement('span');
        icon.className = 'dsh-ip-entry-icon';
        icon.textContent = '📋';
        var label = document.createElement('span');
        label.className = 'dsh-ip-entry-label';
        label.textContent = '需求面板';
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', togglePanel);
        return btn;
      }

      /**
       * 创建覆盖式面板容器（挂 body；面板内容由 createForm 填充）。
       * P0-01（#5 评审附注）：本函数创建的 overlay/panel 节点是常驻的，自愈只做
       * 「缺失时重建」；后续 issue（#6 表单、#7 校验、#8 成功反馈）一律在
       * panel 的已有子节点内填充/替换，禁止重建整个 overlay 节点——
       * 重建会重置 panelOpen（由 overlay.hidden 表达）导致面板状态丢失。
       */
      function createOverlay() {
        var overlay = document.createElement('div');
        overlay.className = 'dsh-ip-overlay';
        overlay.dataset.dshIssuePanelOverlay = '';
        overlay.hidden = true;
        // 点击遮罩（overlay 自身背景）关闭面板；点击面板内部不关闭。
        overlay.addEventListener('click', function (event) {
          if (event.target === overlay) setPanelOpen(false);
        });
        var panel = document.createElement('div');
        panel.className = 'dsh-ip-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '需求面板');
        var title = document.createElement('div');
        title.className = 'dsh-ip-panel-title';
        title.textContent = '📋 需求面板';
        // #6：在 panel 子节点内填充表单（禁止重建 overlay 节点，见 P0-01）。
        panel.appendChild(title);
        panel.appendChild(createForm());
        overlay.appendChild(panel);
        return overlay;
      }

      /**
       * #6：创建面板表单（标题/描述 + 推送/关闭按钮 + 状态行）。
       * - 标题：单行输入，placeholder「一句话描述要做的事」，标签「必填」；
       * - 描述：多行输入，高度随内容自动伸缩（输入变高、清空变矮），标签「选填」；
       * - 「必填/选填」标签只显示二字（issue #6 验收）；
       * - 推送按钮 → handlePushClick（#7 本地校验+错误提示、#8 成功反馈已就位）；
       * - 关闭按钮 → 关闭面板（setPanelOpen(false)，仅隐藏不销毁）。
       * 返回 form 根节点（状态行在 form 内，随 form 常驻，不重建 overlay）。
       */
      function createForm() {
        var form = document.createElement('div');
        form.className = 'dsh-ip-form';

        // --- 标题字段（必填） ---
        var titleField = document.createElement('div');
        titleField.className = 'dsh-ip-field';
        var titleLabel = document.createElement('span');
        titleLabel.className = 'dsh-ip-field-label';
        titleLabel.textContent = '必填';
        var titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'dsh-ip-title';
        titleInput.placeholder = '一句话描述要做的事';
        titleInput.setAttribute('aria-label', '标题（必填）');
        titleField.appendChild(titleLabel);
        titleField.appendChild(titleInput);

        // --- 描述字段（选填） ---
        var descField = document.createElement('div');
        descField.className = 'dsh-ip-field';
        var descLabel = document.createElement('span');
        descLabel.className = 'dsh-ip-field-label';
        descLabel.textContent = '选填';
        var descInput = document.createElement('textarea');
        descInput.className = 'dsh-ip-desc';
        descInput.placeholder = '补充细节（可选，支持 Markdown）';
        descInput.setAttribute('aria-label', '描述（选填）');
        descInput.addEventListener('input', function () {
          autoResize(descInput);
        });
        descField.appendChild(descLabel);
        descField.appendChild(descInput);

        // --- 操作区 ---
        var actions = document.createElement('div');
        actions.className = 'dsh-ip-actions';
        var pushBtn = document.createElement('button');
        pushBtn.type = 'button';
        pushBtn.className = 'dsh-ip-btn dsh-ip-btn-primary';
        pushBtn.textContent = '📤 推送';
        pushBtn.addEventListener('click', handlePushClick);
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'dsh-ip-btn dsh-ip-btn-ghost';
        closeBtn.textContent = '✕ 关闭';
        closeBtn.addEventListener('click', function () {
          setPanelOpen(false);
        });
        actions.appendChild(pushBtn);
        actions.appendChild(closeBtn);

        // --- 状态行（#7 错误提示 / #8 成功反馈展示区；初始隐藏） ---
        var status = document.createElement('div');
        status.className = 'dsh-ip-status';
        status.setAttribute('role', 'status');
        status.hidden = true;

        form.appendChild(titleField);
        form.appendChild(descField);
        form.appendChild(actions);
        form.appendChild(status);
        return form;
      }

      /**
       * #6：描述框高度随内容自动伸缩。
       * 原理：先重置 height 为 auto 让浏览器按内容计算 scrollHeight，再设回实际高度；
       * 清空后 scrollHeight 变小 → 高度随之变矮（配合 CSS min-height 保证最小高度）。
       */
      function autoResize(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight || 0) + 'px';
      }

      /**
       * #8 评审 P2-01：console.debug 兼容性封装（老浏览器缺 debug 方法时静默跳过）。
       * 统一一处校验，避免每处调用重复 typeof 检查（DRY）。
       */
      function debugLog() {
        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug.apply(console, arguments);
        }
      }

      /**
       * #6/#7/#8：推送按钮点击 → 调 host 路由 POST /api/issue-panel/create。
       * 流程：本地校验（#7 空标题拦截，不发请求）→ 请求中禁用按钮（防重复提交）
       * → 成功展示「✓ 已创建 issue #N：<链接>」并清空表单（#8）→ 失败展示可读错误。
       */
      function handlePushClick() {
        var form = document.querySelector('.dsh-ip-form');
        if (!form) return;
        var titleInput = form.querySelector('.dsh-ip-title');
        var descInput = form.querySelector('.dsh-ip-desc');
        var status = form.querySelector('.dsh-ip-status');
        var pushBtn = form.querySelector('.dsh-ip-btn-primary');
        if (!titleInput || !descInput || !status || !pushBtn) {
          // P2-04（#6 评审）：DOM 结构异常时静默返回不崩溃，但留开发期可观测信号。
          debugLog('[dsh-issue-panel] push aborted: form nodes missing', {
            title: !!titleInput, desc: !!descInput, status: !!status, btn: !!pushBtn,
          });
          return;
        }
        // 防重入（纵深防御）：disabled 按钮在真实浏览器不触发 click，但 stub/边缘
        // 仍可能重复进入；请求期间直接忽略第二次点击。
        if (pushBtn.disabled) return;

        var title = (titleInput.value || '').trim();
        // #7：空标题本地拦截——不发请求（后端也有必填校验，但本地拦截省一次往返）。
        if (!title) {
          showStatus(status, '⚠️ 标题是必填的', true);
          // P1-02（评审）：focus 调用用 try-catch 包裹——极端竞态下节点可能在校验后、
          // focus 前被移除（已 detached 节点 focus 在部分浏览器会抛错），不因提示聚焦
          // 失败而中断用户操作。
          try {
            if (typeof titleInput.focus === 'function') titleInput.focus();
          } catch (e) {
            debugLog('[dsh-issue-panel] focus failed:', e && e.message ? e.message : String(e));
          }
          return;
        }
        var body = (descInput.value || '').trim();

        pushBtn.disabled = true;
        showStatus(status, '正在推送…', false);

        fetch('/api/issue-panel/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ? { title: title, body: body } : { title: title }),
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { ok: res.ok, data: data };
            });
          })
          .then(function (result) {
            // 热重载竞态防御：请求期间插件可能被卸载（节点已移除），此时 status/pushBtn
            // 为 null，直接访问会抛错（评审 P1-02 同类边界）；重新查询判空。
            var status2 = document.querySelector('.dsh-ip-status');
            var pushBtn2 = document.querySelector('.dsh-ip-btn-primary');
            if (pushBtn2) pushBtn2.disabled = false;
            if (!status2) return;
            if (result.ok && result.data && typeof result.data.number === 'number') {
              // #8：成功 → issue 号 + 可点击链接（新窗口），成功后清空表单。
              renderSuccess(status2, result.data.number, result.data.html_url);
              clearForm();
            } else {
              // #7：后端错误（未配置/校验失败/API 失败）→ 面板内展示可读错误。
              var msg = (result.data && result.data.error && result.data.error.message) || '推送失败，请稍后重试';
              showStatus(status2, '⚠️ ' + msg, true);
            }
          })
          .catch(function (error) {
            var status2 = document.querySelector('.dsh-ip-status');
            var pushBtn2 = document.querySelector('.dsh-ip-btn-primary');
            if (pushBtn2) pushBtn2.disabled = false;
            console.warn('[dsh-issue-panel] push failed:', error && error.message ? error.message : String(error));
            if (status2) showStatus(status2, '⚠️ 无法连接服务，请稍后重试', true);
          });
      }

      /**
       * #7：状态行展示。isError 为 true 时切换错误样式（红色文案，仅换色不改布局）。
       * 纵深防御（P1-01 评审）：调用方已判空，但函数本身也应容忍 null——
       * 热重载竞态下节点可能随时被移除，内部防御避免任何调用路径崩溃。
       */
      function showStatus(status, text, isError) {
        if (!status) return;
        status.textContent = text;
        status.className = 'dsh-ip-status' + (isError ? ' dsh-ip-status-error' : '');
        status.hidden = false;
      }

      /**
       * #8：成功反馈——「✓ 已创建 issue #N：」+ 可点击链接（新窗口打开）。
       * 状态行保留本次结果（P0-01 不重建 overlay，关面板再开仍可见，通知留存）。
       * 纵深防御（P0-01 评审）：status 为 null（热重载竞态节点被移除）时静默返回，
       * 与 clearForm 的防御策略保持一致，不抛「Cannot read property」崩溃。
       * 纵深防御（#8 评审 P1-01）：htmlUrl 来自 GitHub API 响应，即使上游可信也应
       * 校验协议白名单（http/https）——防御深度原则，防止异常数据（如 javascript:）
       * 注入 href 触发 XSS；非白名单协议仅显示 issue 号，不渲染链接。
       */
      function renderSuccess(status, number, htmlUrl) {
        if (!status) return;
        // #8 评审第 2 轮 P1-01：number 类型防御——调用处已校验，但函数本身
        // 也应容忍异常入参（纵深防御），避免拼接出 "#[object Object]" 类输出。
        if (typeof number !== 'number') return;
        status.textContent = '';
        status.className = 'dsh-ip-status';
        status.appendChild(document.createTextNode('✓ 已创建 issue #' + number + '：'));
        if (isSafeHttpUrl(htmlUrl)) {
          var link = document.createElement('a');
          link.href = htmlUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = htmlUrl;
          status.appendChild(link);
        }
        status.hidden = false;
      }

      /**
       * #8 评审 P1-01：URL 协议白名单校验（http/https 开头才算安全可点击链接）。
       * 独立小函数便于测试；非字符串或其它协议一律返回 false（仅显示 issue 号）。
       * #8 评审第 2 轮 P2-02：协议后必须至少有一个字符（空 host 的 "https://" 放行
       * 会点击跳转到补全域名的无效页，纵深防御应覆盖）。
       */
      function isSafeHttpUrl(url) {
        return typeof url === 'string' &&
          ((url.indexOf('https://') === 0 && url.length > 8) ||
           (url.indexOf('http://') === 0 && url.length > 7));
      }

      /**
       * #8：推送成功后清空表单（标题 + 描述，描述高度复位）。
       * 异步回调内重新查询节点（热重载竞态防御：请求期间节点可能已被移除）。
       */
      function clearForm() {
        var form = document.querySelector('.dsh-ip-form');
        if (!form) return;
        var titleInput = form.querySelector('.dsh-ip-title');
        var descInput = form.querySelector('.dsh-ip-desc');
        if (titleInput) titleInput.value = '';
        if (descInput) {
          descInput.value = '';
          autoResize(descInput);
        }
      }

      /**
       * 打开/关闭面板。状态落模块级变量 panelOpen：
       * - 自愈重插入口/容器后恢复 aria-expanded 与 hidden；
       * - 关闭仅隐藏覆盖层，不销毁 DOM（避免反复重建，也便于 #6 后续填充）。
       */
      function setPanelOpen(open) {
        panelOpen = !!open;
        var overlay = document.querySelector(OVERLAY_SELECTOR);
        if (overlay) overlay.hidden = !panelOpen;
        var entry = document.querySelector(ENTRY_SELECTOR);
        if (entry) entry.setAttribute('aria-expanded', String(panelOpen));
      }

      function togglePanel() {
        setPanelOpen(!panelOpen);
      }

      /**
       * 幂等自愈注入：保证「入口紧跟新建会话按钮之后」且「覆盖层在 body 下」。
       * 返回 true 表示注入完成（或已在位）；false 表示锚点缺失（等 observer 下次触发）。
       * 位置校验用「父容器相同」而非「严格紧跟」：React 可能在按钮与入口之间
       * 插入自身节点，此时入口仍在按钮下方区域，无需重插（避免无谓闪烁）。
       */
      function ensureInjected() {
        var anchor = findAnchor();

        // --- 入口按钮 ---
        var entry = document.querySelector(ENTRY_SELECTOR);
        if (entry && (!anchor || entry.parentElement !== anchor.parentElement)) {
          // 位置漂移（锚点没了或被挪出容器）→ 移除重插。
          entry.remove();
          entry = null;
        }
        if (!entry) {
          if (!anchor) return false; // 侧边栏尚未渲染，等 observer
          entry = createEntry();
          anchor.insertAdjacentElement('afterend', entry);
        }

        // --- 覆盖层 ---
        var overlay = document.querySelector(OVERLAY_SELECTOR);
        if (!overlay) {
          overlay = createOverlay();
          document.body.appendChild(overlay);
        }
        // 状态恢复（自愈重插后保持打开/关闭一致）。
        overlay.hidden = !panelOpen;
        entry.setAttribute('aria-expanded', String(panelOpen));
        return true;
      }

      /**
       * MutationObserver 自愈：观察 body 子树，React 重渲染移除/重建我们的节点时
       * 自动重插。防抖合并高频回调；幂等（已在位则无操作，不会触发新 mutation 循环）。
       */
      function startSelfHeal() {
        if (typeof MutationObserver === 'undefined') return;
        observer = new MutationObserver(function () {
          if (selfHealTimer) return; // 已有排队的自愈
          selfHealTimer = window.setTimeout(function () {
            selfHealTimer = 0;
            ensureInjected();
          }, SELF_HEAL_DEBOUNCE_MS);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }

      /**
       * client 插件主体（Cordis client context）。
       * @param {import('cordis').Context} ctx
       */
      exports.apply = function apply(ctx) {
        // DOM 级防重（骨架注释策略）：重复执行直接跳过，不重复注入/监听。
        if (typeof document === 'undefined' || !document.querySelector) return;
        if (document.querySelector(ENTRY_SELECTOR)) return;

        ctx.effect(function () {
          injectStyles();
          ensureInjected(); // 侧边栏可能尚未渲染：由 observer 在 DOM 变化时补注
          startSelfHeal();
          return function () {
            if (observer) {
              observer.disconnect();
              observer = null;
            }
            if (selfHealTimer) {
              window.clearTimeout(selfHealTimer);
              selfHealTimer = 0;
            }
            var entry = document.querySelector(ENTRY_SELECTOR);
            if (entry) entry.remove();
            var overlay = document.querySelector(OVERLAY_SELECTOR);
            if (overlay) overlay.remove();
            var style = document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]');
            if (style) style.remove();
            panelOpen = false;
          };
        }, 'dsh-issue-panel: sidebar entry (self-healing)');
      };

      return module.exports;
    }
  });
}
