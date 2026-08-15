# Licensing Analysis

## What's Open Source (Apache-2.0)

From [github.com/CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff):

| Directory | Contents |
|---|---|
| `sdk/` | Codebuff multi-agent SDK |
| `freebuff/` | CLI agent |
| `agents/` | Agent definitions |
| `common/` | Shared utilities |
| `cli/` | CLI tooling |
| `packages/` | Internal packages |
| `scripts/` | Build scripts |
| `evals/` | Evaluation suite |
| `docs/` | Documentation |

All Apache-2.0 licensed. Free to use, modify, redistribute with attribution.

## What's Closed Source

| Component | Status |
|---|---|
| `freebuff-desktop/` electron shell | **NOT in public repo** |
| `orchestrator.js` (bundled) | Compiled from private source |
| UI source (pre-Vite-build React) | **NOT in public repo** |
| `electron/main.cjs` et al | Shipped in AppImage, not published |

The desktop app references `freebuff-private.git` as its upstream repo
(visible in CLI's package.json).

## Legal Implications for Android Port

### ✅ Safe Path (Recommended)
Reimplement over the open-source SDK + CLI:
- Use `@codebuff/sdk` as the agent runtime
- Use `freebuff/` CLI architecture as reference
- Write new Android shell from scratch
- Write new HTTP/SSE server from scratch
- Result: fully Apache-2.0 compliant

### ⚠️ Gray Area
Patching the extracted `orchestrator.js` bundle:
- The bundle is shipped to end users (you have it on disk)
- Modifying for personal use is likely fine
- Redistributing the modified bundle may violate copyright
- No explicit license on the desktop binary

### ❌ Not Recommended
Redistributing extracted Electron shell code (main.cjs, preload.cjs, etc.)
as open source. These are closed-source components.

## Recommendation

Build on the **open-source SDK** (Apache-2.0). The SDK provides:
- Agent orchestration
- Tool definitions
- Model provider abstraction
- Session management primitives

This is enough to build a functional Android client without touching
closed-source code.
