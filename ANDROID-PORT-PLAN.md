# Android Native Port Plan — 6 Phases

## Target Architecture

```
┌─────────────────────────────────────────┐
│         Android APK (Kotlin)            │
│  ┌───────────────────────────────────┐  │
│  │   WebView (system Chrome engine)  │  │
│  │   loads UI from localhost:PORT    │  │
│  │   ← @JavascriptInterface →       │  │
│  └───────────────────────────────────┘  │
│              ↕ HTTP/SSE                 │
│  ┌───────────────────────────────────┐  │
│  │  Node.js ARM64 (Termux-native)   │  │
│  │  orchestrator-node.js            │  │
│  │  serves on 127.0.0.1:PORT        │  │
│  └───────────────────────────────────┘  │
│  vendor/rg ARM64 (ripgrep)              │
│  tree-sitter .scm query files           │
└─────────────────────────────────────────┘
```

## Phase 0 — Termux Build Environment

```bash
# On ARM64 Android device:
pkg update && pkg upgrade
pkg install nodejs-lts ripgrep git openjdk-17

# Verify:
node --version    # v20+
rg --version      # 14+
javac -version    # 17+
```

**Deliverable**: Working Termux with Node.js, rg, JDK on ARM64.

## Phase 1 — Re-bundle Orchestrator for Node.js

### Option A: Patch existing bundle
1. Take `orchestrator.js` (141K lines)
2. Replace `import.meta.require` → `require` (or `createRequire`)
3. Replace `// @bun` bundler preamble with Node-compatible module system
4. Replace `bun:sqlite` (if used) → `better-sqlite3` or `sql.js` (WASM SQLite)
5. Remove Bun-specific APIs (`Bun.serve`, `Bun.file`, etc.)
6. Test with `node orchestrator-node.js`

### Option B: Clean-room reimplementation (legally safer)
1. Clone [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff) (Apache-2.0)
2. Use `sdk/`, `freebuff/`, `agents/`, `common/` as foundation
3. Implement HTTP/SSE server using Node.js `http` module
4. Wire agent runtime from SDK
5. Implement tool harness (file ops, shell exec, ripgrep search)
6. Add session/tab management

**Deliverable**: `orchestrator-node.js` running on Node.js ARM64, serving UI + API.

## Phase 2 — Android WebView Shell

### Project setup
```
freebuff-android/
├── app/
│   ├── src/main/
│   │   ├── java/com/freebuff/android/
│   │   │   ├── MainActivity.kt
│   │   │   ├── OrchestratorService.kt
│   │   │   ├── FreebuffBridge.kt        # @JavascriptInterface
│   │   │   └── FilePickerHelper.kt
│   │   ├── res/layout/activity_main.xml
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts
├── orchestrator/                         # Node.js backend
│   ├── orchestrator-node.js
│   ├── ui/                               # React SPA (as-is)
│   └── vendor/rg                         # ARM64 ripgrep
├── build.gradle.kts
└── settings.gradle.kts
```

### MainActivity.kt (core)
```kotlin
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
        }
        webView.addJavascriptInterface(FreebuffBridge(this), "freebuffDesktop")

        // Start orchestrator, then load UI
        startService(Intent(this, OrchestratorService::class.java))
        webView.loadUrl("http://127.0.0.1:$PORT")
    }
}
```

### FreebuffBridge.kt (replaces preload.cjs)
```kotlin
class FreebuffBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun getPlatform() = "android"

    @JavascriptInterface
    fun pickDirectory() { /* SAF intent */ }

    @JavascriptInterface
    fun pickAttachments() { /* SAF intent */ }

    @JavascriptInterface
    fun openExternal(url: String) {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }
}
```

**Deliverable**: APK with WebView loading React UI from localhost.

## Phase 3 — Backend Process Lifecycle

### OrchestratorService.kt
```kotlin
class OrchestratorService : Service() {
    private var process: Process? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())
        spawnOrchestrator()
        return START_STICKY
    }

    private fun spawnOrchestrator() {
        val nodeBin = "${filesDir}/node/bin/node"
        val script = "${filesDir}/orchestrator/orchestrator-node.js"
        process = ProcessBuilder(nodeBin, script)
            .directory(File("${filesDir}/orchestrator"))
            .environment().apply {
                put("PORT", PORT.toString())
                put("HOME", filesDir.absolutePath)
            }
            .start()
        // Health check loop on /healthz
    }
}
```

**Deliverable**: Orchestrator running as Android foreground service.

## Phase 4 — Electron → Android Substitutions

| Electron API | Android Replacement |
|---|---|
| `BrowserWindow` | `WebView` in `Activity` |
| `ipcMain.handle / ipcRenderer.invoke` | `@JavascriptInterface` methods |
| `dialog.showOpenDialog` | `ActivityResultLauncher` + SAF |
| `shell.openExternal(url)` | `Intent(ACTION_VIEW, uri)` |
| `shell.showItemInFolder` | `Intent` with DocumentsProvider |
| `clipboard` read/write | `ClipboardManager` |
| `electron-updater` | HTTP version check + download APK |
| CDP Bridge | `WebView.evaluateJavascript()` or drop |
| `Menu` / keyboard shortcuts | `Toolbar` + overflow menu |
| `app.getVersion()` | `BuildConfig.VERSION_NAME` |
| `process.platform` | `"android"` constant |
| Custom title bar (Linux frameless) | Android native `ActionBar`/`Toolbar` |
| `webUtils.getPathForFile` | SAF content URI resolver |

## Phase 5 — Build on Device (Termux)

```bash
# All compilation happens on the ARM64 device itself:
cd ~/freebuff-android

# 1. Prepare orchestrator
cd orchestrator
npm install
node scripts/verify-node-compat.js
cd ..

# 2. Build APK
export ANDROID_HOME=$PREFIX/share/android-sdk
gradle assembleDebug

# 3. Install
adb install app/build/outputs/apk/debug/app-debug.apk
# Or: termux-open app-debug.apk
```

**Note**: Android SDK/Gradle in Termux is heavy (~2GB). Alternative: build
on a desktop and `adb install` to device. The constraint "compilação nativa
no próprio Termux" applies to the orchestrator JS — the APK shell can be
cross-compiled if needed.

## Phase 6 — Testing & Polish

1. **OAuth login** — GitHub/Google via Chrome Custom Tabs (not WebView)
2. **Agent tools** — file read/write respects Android scoped storage
3. **xterm.js** — verify rendering in Android WebView (known to work)
4. **Battery** — request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` or guide user
5. **Background kill** — `START_STICKY` + `startForeground()` with notification
6. **Permissions** — `INTERNET`, `FOREGROUND_SERVICE`, `POST_NOTIFICATIONS`

## Estimated Effort

| Phase | Effort | Risk |
|---|---|---|
| 0 - Termux setup | 1 hour | Low |
| 1 - Re-bundle orchestrator | 2-4 weeks | HIGH (141K lines, Bun-only APIs) |
| 2 - WebView shell | 2-3 days | Low |
| 3 - Service lifecycle | 1-2 days | Medium |
| 4 - API substitutions | 1 week | Medium |
| 5 - Build pipeline | 1-2 days | Medium |
| 6 - Testing | 1 week | Medium |

**Total: ~5-7 weeks**, dominated by Phase 1 (orchestrator porting).
Option B (clean-room) may be faster if the bundle proves too tangled.
