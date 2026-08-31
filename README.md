# dsh-issue-panel 📋

> **需求面板 —— 为 dsh（DeepSeek Harness）Web GUI 打造的纯按钮式 GitHub issue 创建小插件**
> **Issue Panel — a minimal button-driven GitHub issue creator for the DSH Web GUI, built for vibe coding workflows.**

| | |
|---|---|
| 状态 | 🚧 **开发中（WIP, v0.1.0）** —— 最简版：表单 + 推送 |
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
- 📝 **两字段表单**：标题（必填）/ 描述（选填，支持 markdown）
- 📏 **自适应表单**：描述文本框高度随内容自动伸缩
- 📤 **一键推送**：调 GitHub API 创建 issue，成功提示 `✓ 已创建 issue #N：<html_url>`
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
   - **描述**（选填）：要做什么，支持 markdown（可写任务/验收标准）；
3. 点击 **「📤 推送」** → 创建 GitHub issue。

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
│  ├─ POST /api/issue-panel/create             │
│  │    └─ fetch GitHub REST API               │
│  └─ GET  /api/issue-panel/config             │
└──────────────────────────────────────────────┘
```

| 面 | 文件 | 职责 |
|---|---|---|
| Host | `lib/index.js` | 注册 `/api/issue-panel/*` 路由、调 GitHub API、读配置 |
| Client | `lib/client.js` | 侧边栏入口注入、面板 UI、请求 host 路由 |

**技术要点**：

- 纯 JavaScript 实现（零编译依赖，无需 TypeScript 构建）；
- client 端采用**纯 DOM** 方案（不依赖 React），通过 `window.__ModuleLoader__.load()` 加载；
- 侧边栏注入使用 **MutationObserver 自愈**（dsh 侧边栏无对外 slot，React 重渲染后入口自动重插、不闪烁）。

---

## 开发路线

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | 最简版：侧边栏入口 + 标题/描述表单 + 一键推送 | 🚧 开发中 |
| v0.2.0 | 设置界面（token/仓库 GUI 配置） | 规划中 |
| v1.0.0 | AI 优化（左右对比）、验收功能 | 规划中 |

**明确不做的功能**（设计决策）：AI 优化（最简版不做）、删除 issue（GitHub 删除不可恢复）、第一版不做 git 代码推送。

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
