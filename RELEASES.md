# Releases: @bash0816/agy-termux

---

## 1.0.12 — 2026-06-27 ✅ Current / 現行版

Google Antigravity CLI (agy) v1.0.12 対応。Termux 実機検証済み。

agy v1.0.12 support. Verified on Termux (Android ARM64).

- memexec 廃止・glibc loader 統一方式に変更 / Replaced memexec with glibc loader execution
- ELF magic + size 検証追加（fail-close） / Added ELF header validation (fail-close)
- README / NOTICE.md 整備、npm 公開対応 / Added bilingual README, NOTICE.md, published to npm

```sh
npm install -g @bash0816/agy-termux
```

---

## 1.0.10-1 — 2026-06-23

Google Antigravity CLI (agy) v1.0.10 対応。Initial release。

agy v1.0.10 support. Initial release.

- In-memory VA39 patching 実装 / In-memory VA39 patch implementation
- Termux Android ARM64 対応 / Termux Android ARM64 support

---
