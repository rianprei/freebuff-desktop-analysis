# Architecture — Freebuff Desktop v0.0.42

## High-Level Diagram

```
Freebuff Desktop (AppImage 152MB, x86-64)
├── Electron shell (Node.js main process)
│   ├── main.cjs — app lifecycle, BrowserWindow, IPC, menu
│   ├── preload.cjs — contextBridge to renderer
│   ├── cdp-bridge.cjs — loopback HTTP, CDP relay for preview webview
│   ├── signing.cjs — code signing detection
│   ├── shell-path.cjs — PATH repair (macOS Homebrew/bun)
│   └── updater.cjs — electron-updater wrapper
│
├── Bun runtime (89MB, x86-64, glibc, shipped in resources/bun/)
│   └── orchestrator.js (141,780 lines, 7.8MB Bun bundle)
│       ├── @anthropic-ai/claude-agent-sdk — Claude agent harness
│       ├── @codebuff/sdk — Codebuff multi-agent framework
│       ├── @openai/codex-sdk — OpenAI Codex integration
│       ├── lodash 4.17.23
│       ├── zod (validation)
│       ├── effect (functional effects)
│       └── HTTP/SSE server on 127.0.0.1:PORT
│
├── UI (React 19 SPA, Vite build, 315 files, 12MB)
│   ├── index.html → assets/index-Cr5TZJle.js + index-CVq93GaR.css
│   ├── xterm.js (terminal emulator)
│   ├── react-markdown + remark-gfm
│   ├── @dnd-kit (draggable tabs)
│   ├── zustand (state management)
│   └── ~200 Shiki syntax highlighting grammars
│
├── vendor/ripgrep/x64-linux/rg (static-pie, x86-64)
├── tree-sitter .scm query files (9 languages)
├── claude-elevation-hook.js (blocks sudo/doas in agent commands)
└── electron-updater config (app-update.yml)
```

## Communication Flow

```
┌──────────────┐    IPC (ipcMain/Renderer)    ┌──────────────┐
│  Electron    │◄────────────────────────────►│  Renderer    │
│  Main Process│                              │  (WebView)   │
└──────┬───────┘                              └──────┬───────┘
       │ spawn + env vars                            │
       ▼                                             │
┌──────────────┐    HTTP/SSE on 127.0.0.1     ┌──────┘
│  Bun Process │◄─────────────────────────────┤
│  orchestrator│                              │
└──────┬───────┘                              │
       │ CDP Bridge (loopback HTTP + token)   │
       ▼                                      │
┌──────────────┐                              │
│  Preview     │  webContents.debugger ◄──────┘
│  <webview>   │  (console, network, a11y)
└──────────────┘
```

## Run Modes

1. **Packaged** (production): Electron spawns bundled `resources/bun/bun` on
   `resources/orchestrator/orchestrator.js`. User needs no system Bun.

2. **Dev**: Electron spawns system `bun` on `src/server/main.ts` with optional
   `--watch` via `FREEBUFF_DEV_WATCH=1`.

## Key Design Decisions

- **Bun, not Node**: orchestrator uses `import.meta.require`, Bun-specific bundling
  (`// @bun` header), and ships a Bun binary. This is the #1 portability blocker.

- **No separate renderer build**: the UI is served by the orchestrator's HTTP
  server. Electron just loads `http://127.0.0.1:PORT`. This is good for porting —
  any WebView can load the same URL.

- **CDP Bridge isolation**: deliberately no `--remote-debugging-port` (would expose
  all webContents). Instead, a scoped loopback bridge with bearer token. Smart
  security, but Electron-dependent.

- **Crash-restart budget**: up to 3 orchestrator respawns within 60s. Same port
  reused so renderer reconnects seamlessly.
