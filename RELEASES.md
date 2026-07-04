## 1.0.16 — 2026-07-04 ✅ Current / 現行版

upstream google-antigravity/antigravity-cli 1.0.16 追従。シングルバージョン方式に移行（verified_version を廃止し tag_name を唯一の版識別子に統一）。

```sh
npm install -g @bash0816/agy-termux
```

---

## 1.0.14 — 2026-07-01

upstream google-antigravity/antigravity-cli 1.0.14 追従。faccessat2 syscall による SIGSYS クラッシュを LD_PRELOAD shim で修正し、バージョンpin化により今後の破壊的変更の即時波及を防止。

---

# Releases: @bash0816/agy-termux

---

## 1.0.12 — 2026-06-27 ✅

Google Antigravity CLI (agy) v1.0.12 対応。Termux 実機検証済み。

agy v1.0.12 support. Verified on Termux (Android ARM64).

- 安定性・互換性の改善 / Stability and compatibility improvements
- README / NOTICE.md 整備、npm 公開 / Added bilingual README, NOTICE.md, published to npm

```sh
npm install -g @bash0816/agy-termux
```

---

## 1.0.10-1 — 2026-06-23 (internal validation / 内部検証版)

Termux Android ARM64 互換性対応。npm 未公開の技術検証版。

Termux Android ARM64 compatibility support. Internal validation only, not published to npm.

---