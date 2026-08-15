# File-by-File Analysis

## Electron Shell (in app.asar → electron/)

### main.cjs (~350 lines)
Entire Electron main process. Key responsibilities:
- `resolveOrchestrator()` — packaged: use bundled Bun + orchestrator.js; dev: system bun + source TS
- `startOrchestrator(port)` — spawn Bun, pipe stderr, wait for `/healthz`
- `createWindow()` — BrowserWindow with `contextIsolation: true`, custom title bar on Linux
- Crash-restart logic: 3 attempts, refreshed after 60s uptime
- CDP Bridge startup (cdp-bridge.cjs)
- IPC handlers: file picker, directory picker, clipboard image, reveal file, window controls
- Navigation guard: only app origin allowed, everything else → system browser
- macOS PATH repair at module load (fixPath from shell-path.cjs)

### preload.cjs (~80 lines)
Minimal `contextBridge.exposeInMainWorld('freebuffDesktop', {...})`:
- `platform` — process.platform string
- `customTitleBar` — boolean from argv flag
- `onMenuCommand(handler)` — tab commands (new/reopen/close)
- `getPathForFile(file)` — Electron 32+ File.path replacement
- `pickAttachments()` — native file+folder multi-select dialog
- `pickDirectory()` — native folder chooser
- `saveClipboardImage(bytes, ext)` — paste screenshot to temp file
- `readImage(filePath)` — data URL for attachment preview
- `openTerminal()` — macOS Terminal.app only
- `openExternal(url)` — system browser, http(s) only
- `revealChange(root, relativePath)` — Finder/Explorer reveal
- Window state + minimize/maximize/close

### cdp-bridge.cjs (~300 lines)
Loopback HTTP server for orchestrator → preview webview CDP relay:
- Bearer token auth (random per-boot, passed via env)
- `POST /attach` — attach debugger to a loopback-URL webview
- `POST /detach` — detach debugger
- `POST /command` — relay any CDP command (including screenshot via capturePage)
- `GET /events?since=N` — buffered CDP events (console, network, page load)
- Ring buffer: 512 events max, 8KB per event param cap
- Refuses non-loopback webContents (security)

### Other electron/ files
- `packaged-bun-path.cjs` — resolves bundled Bun binary per platform
- `reveal-path.cjs` — safe path resolution for file reveal
- `shell-path.cjs` — macOS login shell PATH repair
- `signing.cjs` — code signing state detection
- `updater.cjs` — electron-updater lifecycle
- `*.test.ts` — unit tests for each module

## Orchestrator (resources/orchestrator/)

### orchestrator.js (141,780 lines, 7.8MB)
Bun-bundled monolith. Contains:
- HTTP/SSE server (serves UI + API)
- Agent runtime (Claude, Codex harnesses)
- Tool implementations (file read/write, shell exec, search via ripgrep)
- Session/tab management
- SQLite-based persistence (likely via bun:sqlite)
- Tree-sitter integration for code intelligence
- Preview inspector (uses CDP Bridge)

### claude-elevation-hook.js (~80 lines)
Bun-bundled guard. Blocks `sudo`, `doas`, `pkexec`, `runas`, PowerShell
`Start-Process -Verb RunAs`, AppleScript `administrator privileges`.
Runs as stdin→exit-code filter on Bash/PowerShell tool calls.

### tree-sitter-*.scm (9 files)
Tag query files for: C++, C#, Go, Java, JavaScript, Python, Ruby, Rust, TypeScript.
Plain text, fully portable.

### ui/ (315 files, 12MB)
Vite-built React SPA:
- `index.html` loads `assets/index-Cr5TZJle.js`
- ~200 Shiki grammar .js files (syntax highlighting)
- CSS bundle

### vendor/ripgrep/x64-linux/rg
Static-pie ELF, x86-64. Used by orchestrator for code search.

## NPM Package (node_modules/@codebuff/sdk)
Codebuff SDK — the only node_module in app.asar. Workspace dependency.
