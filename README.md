# Freebuff Desktop — Analysis & Android Native Port Plan

Full reverse-engineering analysis of **Freebuff Desktop v0.0.42** (AppImage, Electron)
plus a concrete plan to port it to a **100% native Android APK** on ARM64.

## Constraints (non-negotiable)

- ✅ ARM64/aarch64 real
- ✅ ELF executável nativo para Android
- ✅ Compilação nativa no próprio Termux
- ✅ Sem root, sem chroot, sem proot, sem proot-distro
- ✅ Sem Wine, Box64/86, QEMU, VM, container Linux
- ✅ Sem emulação de CPU

## Contents

| File | What |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Complete architecture map |
| [FILE-BY-FILE.md](FILE-BY-FILE.md) | Every component analyzed |
| [DEPENDENCIES.md](DEPENDENCIES.md) | All dependencies + portability verdict |
| [BLOCKERS.md](BLOCKERS.md) | Hard/medium blockers for Android |
| [ANDROID-PORT-PLAN.md](ANDROID-PORT-PLAN.md) | 6-phase implementation plan |
| [LICENSING.md](LICENSING.md) | What's open source, what's closed |

## TL;DR

Freebuff Desktop = Electron shell spawning a Bun process running a 141K-line
bundled JS orchestrator that talks to Claude/Codex SDKs. The UI is React 19
served over localhost HTTP/SSE.

Android port strategy: replace Electron with Android WebView + replace Bun
with Node.js (Termux-native) + re-bundle orchestrator removing Bun-only APIs.

## Source

- Official repo: [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff) (Apache-2.0)
- Desktop source: **closed-source** (not in public repo)
- This analysis: extracted from AppImage v0.0.42

## License

This analysis document is provided for educational and open-source research purposes.
Freebuff is a trademark of Freebuff, Inc. The analysis does not redistribute any
proprietary code.
