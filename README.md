# @bash0816/agy-termux

Google Antigravity CLI (`agy`) for Termux on Android ARM64.

Termux 向け Google Antigravity CLI (`agy`) wrapper package です。

> **This project is not affiliated with, endorsed by, or sponsored by Google.**
> このプロジェクトは Google と無関係です。Google から承認・提携・保証されたものではありません。

## What this does / 仕組み

This package downloads the official `agy` binary from Google's public release source
([google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli))
at the user's explicit request and applies a **local compatibility adjustment** on your device
to enable execution in the Termux/Android ARM64 environment.

このパッケージはユーザーの明示的な操作により、Google の公開 Release
([google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli))
から公式バイナリをダウンロードし、Termux/Android ARM64 で動作させるための
**ローカル互換性調整**をユーザー端末上で行います。

- **No Google binaries or modified binaries are distributed by this package.**
- **このパッケージは Google バイナリや改変済みバイナリを配布しません。**
- The adjustment is intended solely for Termux/Android runtime interoperability.
  It does not bypass authentication, licensing, payment, access controls, or usage restrictions.
- 調整の目的は Termux/Android 実行環境への互換性確保のみです。
  認証・ライセンス・課金・アクセス制御・利用制限の回避を意図するものではありません。

## Prerequisites / 前提条件

```sh
pkg install glibc-repo && pkg install glibc
```

## Install / インストール

```sh
npm install -g @bash0816/agy-termux
```

On first run, you will be prompted to confirm:
1. Downloading the official `agy` binary from Google's public release.
2. Applying a local compatibility adjustment for this device.

Both steps are skipped on subsequent runs if the version has not changed.

初回起動時に以下を確認するプロンプトが表示されます:
1. Google 公式 Release から公式バイナリをダウンロードすること。
2. このデバイスへのローカル互換性調整を適用すること。

バージョンが変わっていない場合、2回目以降は両ステップをスキップします。

## Update / 更新

```sh
npm update -g @bash0816/agy-termux
```

The wrapper downloads a specific, verified version of the official `agy` release (currently 1.0.14), pinned in `config/agy-verified-versions.json`. This ensures compatibility with the Termux/Android SIGSYS workaround bundled in this package. To opt into the latest unverified upstream release instead, set `AGY_TERMUX_FORCE_LATEST=1` (not recommended; compatibility is not guaranteed).

wrapper は `config/agy-verified-versions.json` に固定された、動作検証済みの特定バージョン（現在は 1.0.14）の公式 `agy` Release をダウンロードします。これにより、本パッケージに同梱された Termux/Android 向け SIGSYS 回避策との互換性を保証します。検証されていない最新の upstream バージョンを試したい場合は `AGY_TERMUX_FORCE_LATEST=1` を設定してください（非推奨。互換性は保証されません）。

## Usage / 使い方

```sh
agy [command] [options]
```

For available commands, see the [Antigravity CLI documentation](https://antigravity.google).

利用可能なコマンドは [Antigravity CLI ドキュメント](https://antigravity.google) を参照してください。

## License / ライセンス

This package (`agy-termux`) is licensed under [GPL-3.0-only](./LICENSE).

このパッケージ (`agy-termux`) は [GPL-3.0-only](./LICENSE) ライセンスです。

**The GPL does not apply to the `agy` binary.** The `agy` binary downloaded at runtime
is the property of Google LLC and is subject to Google's terms of service.
This package does not grant any rights to Google's binary.

**GPL は `agy` バイナリには適用されません。** 実行時にダウンロードされる `agy` バイナリは
Google LLC の著作物であり、Google の利用規約に従います。
このパッケージは Google バイナリに対する権利を付与しません。

See [NOTICE.md](./NOTICE.md) for third-party attribution.

サードパーティ帰属については [NOTICE.md](./NOTICE.md) を参照してください。

## Disclaimer / 免責事項

Users are responsible for ensuring that their use of Google Antigravity CLI complies
with [Google's terms of service](https://antigravity.google/terms) and applicable laws.

Google Antigravity CLI の利用条件・適用法令への適合性はユーザー自身が確認してください。
[Google の利用規約](https://antigravity.google/terms) を参照してください。

If a rights holder or platform operator raises a substantiated concern regarding this package,
we will promptly review it and may remove or disable the affected functionality.

権利者またはプラットフォーム運営者から具体的な懸念が示された場合、
内容を確認し、必要に応じて公開停止・機能停止・修正を行います。

## Compatibility / 動作環境

- **Platform / プラットフォーム**: Android (Termux)
- **Architecture / アーキテクチャ**: ARM64 (aarch64)
- Tested with agy 1.0.14 (SIGSYS shim + version pin) on Android 12+ / Android 12+ 上の agy 1.0.14（SIGSYS shim + バージョンpin対応）で実機TUI検証済み

## Known limitations / 既知の制限

- Upstream agy updates may require a compatibility update to this package.
  上流 agy のアップデートにより本パッケージの更新が必要になる場合があります。
- If the downloaded binary fails validation, the tool will exit safely.
  ダウンロードしたバイナリが検証に失敗した場合、安全に終了します。
- Google may change their release distribution or terms at any time.
  Google はリリース配布方法や利用規約をいつでも変更する可能性があります。

## Rollback / ロールバック手順

If a critical issue is discovered after promoting a new version to `latest`, you can immediately roll back to the previous version using the following command:

新バージョン昇格後に重大な問題が発見された場合、以下のコマンドで前バージョンにロールバックできます:

```sh
npm dist-tag add @bash0816/agy-termux@1.0.12 latest
```

This reverts the `latest` tag to version 1.0.12 and will restore the previous stable release for all new installations and updates.

これにより `latest` タグを 1.0.12 に戻し、新規インストール・更新時に前のステーブル版を配布します。
