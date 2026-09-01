# dsh-issue-panel 📋

> **需求面板 —— 为 dsh（DeepSeek Harness）Web GUI 打造的纯按钮式 GitHub issue 创建小插件**
> **Issue Panel — a minimal button-driven GitHub issue creator for the DSH Web GUI, built for vibe coding workflows.**

| | |
|---|---|
| 状态 | ✅ **v1.0（完整版）** —— 四字段表单 + AI 优化 + 左右对比 + 分节推送 |
| 形态 | dsh Web GUI 侧边栏插件（client 插件 + host 插件双面结构） |
| 依赖 | dsh ≥ 0.1.0-rc.7（Node.js 环境） |
| 许可证 | MIT |

---

## 为什么做这个（背景）

在 dsh + GitHub 的 vibe coding 工作流中，需求以 **GitHub issue 作为需求文档载体**：

> **issue 开着 = 需求未解决；issue 关闭 = 需求已解决。**

但传统的创建方式依赖命令行（git 指令 + AI 推送），存在三个痛点：

1. **命令行不友好** —— git 的心智模型（暂存区 / HEAD / 索引）是给机器设计的，超出人脑记忆范围；
2. **每次写需求都要对话** —— 想要的是按钮，不是聊天；
3. **需求文档质量不稳定** —— 手写标题冗长、验收标准含糊。

**本插件把"填写需求 → 推送 issue"变成纯按钮操作**，全程无对话、无命令行。

---

## 功能特性

- 🎛️ **纯按钮界面**：dsh 侧边栏「📋 需求面板」入口，点击展开面板，无对话、无命令行
- 📝 **四字段表单**：标题（必填）/ 任务（选填，自动伸缩）/ 引用（选填列表）/ 验收标准（必填列表，markdown 风格）
- ✨ **AI 优化**：点「优化issue」调 dsh headless 优化四字段，弹出**左右对比弹窗**（左=你写的 / 右=优化后），**确认才替换、放弃不动**；引用合并去重、不覆盖用户已填
- 📤 **一键推送**：正文按「引用 → 任务 → 验收标准」分节拼装（按有无拼接，验收标准永远有），调 GitHub API 创建 issue，成功提示 `✓ 已创建 issue #N：<html_url>`
- 🔒 **安全设计**：GitHub token 只存 host 侧配置文件（仅当前用户可读），不进浏览器；**不提供删除/关闭等不可逆操作**

---

## 截图 / 演示

| 面板界面 |
|---|
| _（待补：界面截图）_ |

---

## 安装

### 前置条件

- dsh ≥ 0.1.0-rc.7（含 web profile）
- pnpm（用于 `dsh plugin` 命令）

> ⚠️ 本插件**仅支持 dsh web profile**（host 侧依赖 `webServer` 服务，见 `lib/index.js` 的 `inject` 声明），请勿在非 web profile 下安装。

### 方式一：npm 包（发布后可用）

```bash
dsh plugin --profile web add dsh-issue-panel
```

### 方式二：本地源码 link（开发中推荐）

```bash
# 克隆仓库后
dsh plugin --profile web add link:/path/to/dsh-issue-panel
```

### 方式三：GitHub 源（仓库公开，直接可用）

```bash
dsh plugin --profile web add "github:sanfan3/dsh-issue-panel"
```

安装后**重启 dsh web**，侧边栏即出现「📋 需求面板」入口。

---

## 快速开始

1. 打开 dsh Web GUI，点击侧边栏 **「📋 需求面板」**；
2. 填写表单：
   - **标题**（必填）：一句话描述要做的事；
   - **任务**（选填）：要做的事拆成步骤，多行文本（高度自动伸缩）；
   - **引用**（选填）：相关 issue 号（`#12`）或链接，逐条可加可删；
   - **验收标准**（必填）：逐条以 `- [ ]` 开头，至少一条；
3. （可选）点 **「✨ 优化issue」** → 左右对比 → **✓ 确认替换** 或 **放弃（不改动）**；
4. 点 **「📤 推送」** → 创建 GitHub issue（正文按引用→任务→验收标准分节）。

---

## 配置

配置文件位于 `%DSH_HOME%\issue-panel\config.json`（`DSH_HOME` 默认为 `~/.dsh`，Windows 下即 `%USERPROFILE%\.dsh`），仅当前用户可读（NTFS ACL）：

```json
{
  "repo": "sanfan3/dsh-issue-panel",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxx"
}
```

| 配置项 | 必填 | 说明 |
|---|---|---|
| `repo` | 推送时必填 | `owner/repo` 格式 |
| `token` | 推送时必填 | GitHub Personal Access Token，scope 勾选 `repo` |

> 🔒 token 只被 host 进程读取，用于服务端调用 GitHub API，**不会出现在浏览器中**。

### 配置文件权限（token 安全）

`config.json` 包含 GitHub token，应限制为**仅当前用户可读**：

- **Windows（NTFS ACL）**：右键 `config.json` → 属性 → 安全 → 编辑 → 选中 `Users` / `Everyone` → 移除，仅保留当前用户（若曾用管理员创建，请检查所有者并收紧权限）；
- **macOS / Linux**：`chmod 600 %DSH_HOME%/issue-panel/config.json`。

> 插件每次启动时会在进程内提醒一次核对配置权限（Windows 下纯 JS 无法校验 NTFS ACL，故采用「提醒 + 本文档」策略；若文件权限过宽导致 token 泄露，后果自负）。

---

## 架构

```
┌─────────────────────────────────────────────┐
│ dsh Web GUI（侧边栏 + 中间区域）               │
│  ├─ 入口行「📋 需求面板」（DOM 注入，自愈）     │
│  └─ 面板视图（纯 DOM，fetch 调 host 路由）     │
└──────────────┬──────────────────────────────┘
               │ /api/issue-panel/*
┌──────────────▼──────────────────────────────┐
│ Host 插件（lib/index.js）                     │
│  ├─ POST /api/issue-panel/optimize          │
│  │    └─ spawn dsh --profile headless       │
│  ├─ POST /api/issue-panel/create            │
│  │    └─ fetch GitHub REST API              │
│  └─ GET  /api/issue-panel/config            │
└──────────────────────────────────────────────┘
```

| 面 | 文件 | 职责 |
|---|---|---|
| Host | `lib/index.js` | 注册 `/api/issue-panel/*` 路由、spawn dsh headless 优化、调 GitHub API、读配置 |
| Host | `lib/optimize.js` | 优化提示词构建、headless 调用、输出容错解析、引用合并 |
| Host | `lib/issue-body.js` | 推送正文分节拼装（引用→任务→验收标准） |
| Host | `lib/config.js` | 配置文件读取与 token 剥离 |
| Client | `lib/client.js` | 侧边栏入口注入、四字段面板 UI、对比弹窗、请求 host 路由 |

**技术要点**：

- 纯 JavaScript 实现（零编译依赖，无需 TypeScript 构建）；
- client 端采用**纯 DOM** 方案（不依赖 React），通过 `window.__ModuleLoader__.load()` 加载；
- 侧边栏注入使用 **MutationObserver 自愈**（dsh 侧边栏无对外 slot，React 重渲染后入口自动重插、不闪烁）。

---

## 开发路线

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | 最简版：侧边栏入口 + 表单 + 一键推送 | ✅ 已发布 |
| v1.0.0 | 完整版：四字段表单 + AI 优化 + 左右对比弹窗 + 分节推送 | ✅ 已发布 |
| v1.1.0 | 设置界面（token/仓库 GUI 配置） | 规划中 |
| v2.0.0 | 验收功能：AI 解析验收标准并执行 | 规划中 |

**明确不做的功能**（设计决策）：删除 issue（GitHub 删除不可恢复）、第一版不做 git 代码推送；AI 优化不自动查询 GitHub（dsh headless 无联网能力，2026-09-01 产品决策）。

---

## 参与贡献

项目尚在早期开发阶段。欢迎：

- **提 issue**：报告问题、建议新功能；
- **提 PR**：修复、改进；
- **反馈**：使用体验、界面意见。

开发约定：开发按 GitHub issue 推进，每个 issue 有独立验收标准，完成后关闭。

---

## 致谢

- [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) —— 插件宿主

---

## License

[MIT](LICENSE)
