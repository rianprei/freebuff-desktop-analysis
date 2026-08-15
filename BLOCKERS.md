# Blockers — Android Native Port

## 🔴 HARD BLOCKERS

### B1: Electron → No Android Build
**What**: Electron (Chromium embedded) has no Android target. Period.
**Impact**: Entire shell layer (main.cjs, preload.cjs, all IPC) must be rewritten.
**Solution**: Android `WebView` component. The UI already loads from
`http://127.0.0.1:PORT` — WebView can do the same. Replace Electron IPC
with `@JavascriptInterface` bridge.

### B2: Bun Binary x86-64 glibc
**What**: Shipped Bun is x86-64, linked against glibc. Android uses Bionic libc.
**Impact**: orchestrator.js cannot run.
**Solution options**:
- (a) Bun ARM64-linux + glibc-runner in Termux (proven path, see freebuff-termux project)
- (b) Re-bundle orchestrator for Node.js (Termux-native, no glibc shim)
- (c) Wait for Bun Android-native build (not available as of 2026-08)

### B3: orchestrator.js is Bun-only Bundle
**What**: `// @bun` header, uses `import.meta.require`, possibly `bun:sqlite`.
**Impact**: Won't run on Node.js without modifications.
**Solution**: Re-bundle from source (CodebuffAI/freebuff, Apache-2.0) targeting
Node.js, or patch the bundle to replace Bun-only APIs.

### B4: Desktop Source is Closed
**What**: `freebuff-desktop/` (electron shell + orchestrator source) is NOT in
the public GitHub repo. Only CLI + SDK + agents are open source.
**Impact**: Can't do a clean rebuild from TS source. Must either:
- Reverse-engineer the 141K-line bundle, or
- Reimplement over the open-source SDK (legal clean room)

## 🟡 MEDIUM BLOCKERS

### B5: CDP Bridge (Preview Tab)
**What**: Uses `webContents.debugger` — Electron-only API.
**Impact**: Agent preview/screenshot tool won't work.
**Solution**: Android WebView has `WebView.setWebContentsDebuggingEnabled(true)` +
Chrome DevTools Protocol over ADB. Or use `evaluateJavascript()` for basic
inspection. Full CDP parity is hard.

### B6: @openai/codex-sdk Platform Binaries
**What**: References `codex-linux-x64`, `codex-darwin-arm64`, etc.
**Impact**: Codex agent won't work without ARM64 binary.
**Solution**: Check if `codex-linux-arm64` exists. If not, disable Codex
and use Claude-only mode.

### B7: Native Dialogs
**What**: `showOpenDialog`, `showSaveDialog` via Electron.
**Impact**: File/folder picking broken.
**Solution**: Android Storage Access Framework (SAF) via `@JavascriptInterface`.

### B8: Auto-Updater
**What**: electron-updater checks GitHub releases.
**Impact**: No auto-update mechanism.
**Solution**: In-app HTTP check + download APK + `ACTION_INSTALL_PACKAGE` intent,
or distribute via F-Droid/sideload.

## 🟢 NO BLOCKERS

- **UI (React SPA)** — serves over HTTP, WebView loads it identically
- **Agent SDKs** (@anthropic-ai/claude-agent-sdk, @codebuff/sdk) — pure JS HTTP
- **tree-sitter queries** — plain text files
- **ripgrep** — ARM64 build readily available
- **All React deps** (zustand, dnd-kit, xterm, markdown) — pure JS
