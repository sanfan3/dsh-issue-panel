# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**dsh-issue-panel** is a minimal dsh (DeepSeek Harness) Web GUI plugin that provides a button-driven GitHub issue creation workflow. It follows the vibe coding pattern where GitHub issues serve as requirement documents.

Current status: **WIP v0.1.0** — minimal version: sidebar entry + title/description form + push button. Spec phase complete.

## Plugin Architecture

This is a dual-layer dsh plugin:

| Layer | File | Role |
|---|---|---|
| Host | `lib/index.js` | Registers `/api/issue-panel/*` routes, calls GitHub REST API, reads config file |
| Client | `lib/client.js` | Injects sidebar entry via MutationObserver, renders panel UI (pure DOM, no React), calls host routes via `fetch` |

**Key constraints:**
- Pure JavaScript — no TypeScript, no build step, no compilation dependencies
- Client side uses pure DOM (no React dependency), loaded via `window.__ModuleLoader__.load({id, factory})`
- Plugin mounted via `cordis.patch.yml` into the web profile roster
- Sidebar injection uses MutationObserver self-healing (dsh sidebar has no export slot; React re-renders trigger automatic re-injection)

## API Routes (Host)

```
POST /api/issue-panel/create     → assemble request → POST to GitHub REST API
GET  /api/issue-panel/config     → read config.json, return repo (never expose token)
```

## Configuration

Config file: `%DSH_HOME%\issue-panel\config.json` (Windows default: `%USERPROFILE%\.dsh\issue-panel\config.json`)

```json
{
  "repo": "owner/repo",
  "token": "ghp_xxxx"
}
```

**Security:** Token is only read by the host process server-side. Never expose it to the browser or return it from any API route.

## Installation / Development

Install plugin into a dsh profile:
```bash
dsh plugin --profile web add link:/path/to/dsh-issue-panel   # local dev (recommended)
dsh plugin --profile web add dsh-issue-panel                  # from npm
```

**Shadow instance development** (Windows constraint): The main dsh runs on port 3080. For development, use a shadow instance with `DSH_HOME` pointing to a workspace-local shadow directory (e.g. `<workspace>\.dsh-shadow`) on port 8091 to avoid affecting the main environment.

## GitHub Issue Creation

When pushing, create the issue with `title` = form title field, `body` = form description field (omit body if empty). The user may write markdown (including acceptance criteria) in the description.

## Key Design Decisions

- **No delete/close operations** — GitHub issue deletion is irreversible; deliberately excluded from scope
- **Minimal scope (v0.1.0)** — no AI optimization, no comparison modal, no reference list; candidates for later versions
- **Token security boundary** — token lives only in host config file (NTFS ACL, current-user-only); never touches the browser

## Windows Environment Notes

- No admin rights; all tools in the user directory (npm global under `%APPDATA%\npm`)
- pnpm is in PATH
- External network: `gh` CLI direct connection works (verified); PowerShell `Invoke-WebRequest` / `curl.exe` may fail with `SEC_E_NO_CREDENTIALS` (Schannel cert issue) — prefer `gh` for GitHub operations
- Use NTFS ACL instead of Linux `chmod 0600` for config file permissions

## Development Roadmap

Development is tracked as GitHub issues (each with individual acceptance criteria, progress checked off and the issue closed when done). Internal planning docs (PRD, issue list, autonomous state file) are kept out of this public repository.

Future versions: v0.2.0 (settings UI), v1.0.0 (AI optimization with comparison modal, acceptance/verification feature).
