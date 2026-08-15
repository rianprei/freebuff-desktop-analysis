# Dependencies & Portability

## Runtime Dependencies

| Dependency | Type | ARM64 Android? | Notes |
|---|---|---|---|
| Electron 32+ | Native binary | ❌ NO | No Android build exists. Must replace with WebView. |
| Bun runtime | Native binary (89MB) | ⚠️ PARTIAL | ARM64-linux build exists but is glibc. Needs glibc-runner on Termux or replace with Node.js. |
| ripgrep (rg) | Native binary | ✅ YES | Official ARM64-linux release. Also `pkg install ripgrep` in Termux. |
| Node.js | Runtime | ✅ YES | Termux has native ARM64 Node.js (`pkg install nodejs-lts`). |

## JS Dependencies (from package.json)

| Package | Version | Pure JS? | Portable? |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | ^0.3.195 | ✅ | ✅ HTTP-only, no native modules |
| `@codebuff/sdk` | workspace:* | ✅ | ✅ |
| `@dnd-kit/core` | ^6.3.1 | ✅ | ✅ React drag-and-drop |
| `@dnd-kit/sortable` | ^10.0.0 | ✅ | ✅ |
| `@dnd-kit/utilities` | ^3.2.2 | ✅ | ✅ |
| `@openai/codex-sdk` | ^0.144.1 | ⚠️ | ⚠️ References platform-specific binaries (codex-linux-x64 etc.) |
| `@xterm/addon-fit` | ^0.11.0 | ✅ | ✅ |
| `@xterm/xterm` | ^6.0.0 | ✅ | ✅ Canvas-based terminal |
| `diff` | 8.0.3 | ✅ | ✅ |
| `effect` | ^3.22.0 | ✅ | ✅ Functional effects library |
| `electron-updater` | 6.8.9 | ❌ | ❌ Electron-only, must remove |
| `react` | ^19.0.0 | ✅ | ✅ |
| `react-dom` | ^19.0.0 | ✅ | ✅ |
| `react-markdown` | ^10.1.0 | ✅ | ✅ |
| `remark-gfm` | ^4.0.1 | ✅ | ✅ |
| `zod` | ^4.2.1 | ✅ | ✅ |
| `zustand` | ^5.0.8 | ✅ | ✅ |
| `@pierre/diffs` | ^1.2.12 | ✅ | ✅ |

## Bundled in orchestrator.js (detected via grep)

| Library | Notes |
|---|---|
| lodash 4.17.23 | Pure JS, portable |
| tree-sitter (WASM) | Portable — WASM runs anywhere |
| Likely: better-sqlite3 or bun:sqlite | ⚠️ If bun:sqlite, needs Bun. If better-sqlite3, needs native rebuild. |

## Summary

- **14/17 JS deps are pure JS** — fully portable
- **1 Electron-only** (electron-updater) — drop
- **1 partial** (@openai/codex-sdk) — needs ARM64 binary or fallback
- **2 native binaries** (Electron, Bun) — must replace/rebuild
- **1 native binary** (ripgrep) — easy ARM64 replacement
