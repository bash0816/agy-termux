# @bash0816/agy-termux

Google Antigravity CLI (`agy`) for Termux on Android ARM64.

Termux 向け Google Antigravity CLI (`agy`) wrapper package です。

> **This project is not affiliated with, endorsed by, or sponsored by Google.**
> このプロジェクトは Google と無関係です。Google から承認・提携・保証されたものではありません。

> ⚠️ **Notice: Terms of Service risk / 利用規約リスクについて**
>
> Google Antigravity's terms of service state that accessing Antigravity via third-party
> software, tools, or services is a violation. There have been confirmed cases in early 2026
> of paid Antigravity/Gemini subscribers being suspended for using third-party tools such as
> OpenClaw and OpenCode.
>
> `agy-termux` is a thin, standalone wrapper that runs a single official Google-distributed
> binary on Termux/Android — it does not integrate or bridge multiple third-party AI CLIs the
> way OpenClaw/OpenCode do. Based on this structural difference, the maintainer has decided to
> continue this project for the time being (as of 2026-07-23), while acknowledging that the
> underlying ToS risk has not disappeared. Use at your own risk.
>
> Google Antigravity の利用規約には、サードパーティのソフトウェア・ツール・サービス経由での
> アクセスが規約違反である旨が明記されています。2026年初頭、有料 Antigravity/Gemini
> サブスクリプションユーザーが OpenClaw・OpenCode 等のサードパーティツール利用を理由に
> アカウント停止された事例が確認されています。
>
> `agy-termux` は、Google 公式配布の単一バイナリを Termux/Android 上で動作させるだけの
> 薄い単体ラッパーであり、OpenClaw/OpenCode のように複数のサードパーティ AI CLI を横断統合
> するものではありません。この構造的な違いを踏まえ、開発者は本プロジェクトを当面継続する
> ことを決定しました（2026-07-23時点）。ただし上記の利用規約リスク自体が消えたわけではありません。
> 利用は自己責任でお願いします。

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

**Tested with agy 1.4.10 on Android 12+ (SIGSYS shim + version pin).**

**agy 1.4.10・Android 12+ で動作確認済み（SIGSYS shim + version pin）。**

## Update / 更新

```sh
npm update -g @bash0816/agy-termux
```

This package downloads a specific verified version of the `agy` binary pinned in `config/agy-verified-versions.json`, ensuring compatibility with the SIGSYS workaround.
To force download the latest upstream version instead, set `AGY_TERMUX_FORCE_LATEST=1` (not recommended; compatibility not guaranteed).
Note: When `AGY_TERMUX_FORCE_LATEST=1` is set, the output of `--version` does not reflect the actual upstream version being used — it always displays the wrapper package version as configured in `package.json`.

`agy update` checks the audited version published in this repository. If it is newer than the installed version and matches the npm `latest` tag, it reinstalls that exact version into the prefix this wrapper is installed in. It then fetches the matching Antigravity CLI binary into the cache (`~/.agy-termux`), so the next `agy` start does not have to download anything. You do not need to start `agy` separately to fetch it. If the audited version does not match the npm `latest` tag, the update is skipped and one line says so; the same message is not repeated for the same combination. If you are already on the audited version, `agy update` still fetches the binary when it is missing or outdated. If the binary is already the latest, it prints `バイナリは最新です (X)` and exits.

While the binary is downloaded, `agy update` shows each stage (verification, extraction, compatibility adjustment, saving) as it starts, and the download progress every 2 seconds. If the connection stalls for 60 seconds, the download is stopped and a message gives the cause. At the end, one final line is shown, such as `A → B に更新しました` or `バイナリを X に取得しました`.

The first time, `agy update` asks for your consent to the download and the compatibility adjustment. It asks only when run from a terminal (TTY). If input is not a terminal (for example, a pipe or redirect) and consent has not been given, it does not ask; it prints `同意の入力がありません。端末から agy update または agy を実行してください` and exits with status 1. If you decline, the binary is neither downloaded nor saved, and you are asked again the next time you run it.

If you update from an older wrapper that cannot fetch the binary during the update, the first `agy` start after the update downloads it once.

If `npm install` fails or is interrupted, `agy update` checks the actual installed state. If the original version is intact, it keeps that version and tells you so. If the package is incomplete, it reinstalls the original version once automatically; if that also fails, it prints the cause and the next command to run. If you are on a local test build and want to force-reinstall the published `latest` version regardless of version numbers, run `npm install -g @bash0816/agy-termux@latest` manually.

- Cache files are named per version (`agy-<version>.bin` or `agy-<version>.va39r2`). Cache files in the old format are deleted automatically, and so are cache files of older versions other than the newest older one. Files modified within the last 10 minutes are not deleted. The deletion is reported only when something was deleted, as `古いキャッシュを削除しました: N 件、M MB`. You do not need to delete them manually. After a successful update, the current version and the newest older version are kept; older ones are removed. Leftover temporary files are removed once they are more than 24 hours old.
- In rare cases, starting an older version while `agy update` is cleaning up can fail once. This can happen when an older wrapper without this fix is used elsewhere at the same time. Run it again.
- To force a fresh download of the current binary, run `AGY_TERMUX_REFRESH=1 agy`.

このパッケージは `config/agy-verified-versions.json` に固定された検証済みバージョンをダウンロードします。SIGSYS対応の互換性が保証されます。
最新 upstream バージョンを試す場合は `AGY_TERMUX_FORCE_LATEST=1` を設定してください（非推奨。互換性の保証なし）。
注記: `AGY_TERMUX_FORCE_LATEST=1` が設定されている場合、`--version` の表示は実際に取得される upstream バージョンを反映しません — 常に `package.json` で定義されたラッパーパッケージバージョンを表示します。

`agy update` は、このリポジトリで公開している監査済みバージョンを確認し、インストール済みより新しく、かつ npm の `latest` タグと一致する場合のみ、このラッパーがインストールされている prefix にその版を固定して再インストールします。続けて、対応する Antigravity CLI のバイナリをキャッシュ(`~/.agy-termux`)に取得します。そのため、次回の `agy` 起動で取得処理は走りません。`agy` を別途起動して取得する必要はありません。監査済みの版と npm の `latest` タグが一致しない場合は更新を見送り、その事実を 1 行で伝えます(同じ組合せでは繰り返し表示しません)。すでに監査済みの版を使っている場合でも、`agy update` はバイナリが無い・古いときに取得します。バイナリが最新なら `バイナリは最新です (X)` と表示して終了します。

バイナリの取得中は、各段階(検証・展開・互換調整・保存)を処理の切り替わりごとに表示し、ダウンロードの進捗を 2 秒ごとに表示します。通信が 60 秒止まると中断し、原因を示すメッセージを出します。最後に `A → B に更新しました` や `バイナリを X に取得しました` のような表示が 1 か所にまとめて出ます。

初回は、ダウンロードと互換調整についての同意を確認します。質問するのは端末(TTY)から実行したときだけです。パイプやリダイレクトなど端末でない入力で同意がない場合は質問せず、`同意の入力がありません。端末から agy update または agy を実行してください` と表示して終了コード 1 で終わります。同意しなかった場合はバイナリを取得も保存もせず、次に実行したときにもう一度尋ねます。

更新中にバイナリを取得できない古いラッパーから更新した場合は、更新後の最初の `agy` 起動で、バイナリを 1 回取得します。

`npm install` が失敗または中断した場合、`agy update` は実際の配置状態を確認します。元の版が無事なら、元の版のまま案内します。パッケージが不完全なら、元の版を 1 回だけ自動で入れ直し、それも失敗した場合は原因と次に実行するコマンドを案内します。ローカルテストビルドを使用中で、バージョン番号によらず公開済みの `latest` へ強制的に戻したい場合は、`npm install -g @bash0816/agy-termux@latest` を手動で実行してください。

- キャッシュのファイルは版ごとの名前です(`agy-<版>.bin` または `agy-<版>.va39r2`)。旧形式のキャッシュは自動で削除されます。古い版のキャッシュも、最新の 1 つを除いて自動で削除されます。10 分以内に更新されたファイルは削除されません。削除したときだけ `古いキャッシュを削除しました: N 件、M MB` と表示されます。手動で削除する必要はありません。更新が成功すると、現在の版と、それより古い版のうち最新の 1 つを残し、それより古いものは削除します。作業用の一時ファイルは、24 時間以上経ったものだけ削除します。
- まれに、`agy update` が古い版のファイルを整理している最中にその古い版を起動すると、起動に 1 回失敗することがあります。この修正を含まない古い版のラッパーを別の場所で同時に使っている場合に起こります。もう一度実行してください。
- 現在のバイナリを取得し直したいときは、`AGY_TERMUX_REFRESH=1 agy` を実行してください。

## Usage / 使い方

```sh
agy [command] [options]
```

For available commands, see the [Antigravity CLI documentation](https://antigravity.google).

利用可能なコマンドは [Antigravity CLI ドキュメント](https://antigravity.google) を参照してください。

## Version and Caching / バージョンとキャッシュ

**Version check:** `agy --version` (or `-v`, `-V`, `version`) prints the wrapper package version in a single line without triggering any network access, consent prompts, or binary downloads.

バージョン確認: `agy --version` (または `-v`, `-V`, `version`) はラッパーパッケージバージョンを1行で表示します。ネットワーク接続・同意プロンプト・バイナリダウンロードは一切発生しません。

**Caching:** The downloaded binary is persisted locally in `~/.agy-termux`, in a file named for its version (`agy-<version>.va39r2` on patch-needed devices, `agy-<version>.bin` on other devices). It is only downloaded again when the version of your installed package changes, when the file is missing or damaged, or when you force a refresh. `agy update` fetches it ahead of time when it is missing, so the next `agy` start does not have to download it (this does not apply if the download consent was not given yet, or if the compatibility step is declined). If another process's cleanup removes the cache just before `agy` starts, `agy` fetches it once automatically and then starts.

キャッシング: ダウンロード済みバイナリは `~/.agy-termux` に、版を含むファイル名(パッチが必要なデバイスは `agy-<版>.va39r2`、その他は `agy-<版>.bin`)でローカル保持されます。インストール済みパッケージの版が変わったとき、ファイルが無い/壊れているとき、強制更新したときにだけ再ダウンロードされます。`agy update` はファイルが無ければ事前に取得するため、次回の `agy` 起動で取得処理は走りません(ダウンロードの同意がまだの場合や、互換調整を拒否した場合を除きます)。別のプロセスの整理処理が `agy` の起動直前にキャッシュを削除した場合は、`agy` が自動で 1 回取得してから起動します。

**Force refresh:** Set `AGY_TERMUX_REFRESH=1` to force a clean re-download and re-verification of the binary, even if the cached version matches the upstream tag.

```sh
AGY_TERMUX_REFRESH=1 agy [command]
```

強制リフレッシュ: `AGY_TERMUX_REFRESH=1` を設定することで、キャッシュされたバージョンが upstream タグと一致していても、強制的にバイナリの再ダウンロード・再検証を行います。

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

## Known limitations / 既知の制限

- Upstream agy updates may require a compatibility update to this package.
  上流 agy のアップデートにより本パッケージの更新が必要になる場合があります。
- If the downloaded binary fails validation, the tool will exit safely.
  ダウンロードしたバイナリが検証に失敗した場合、安全に終了します。
- Google may change their release distribution or terms at any time.
  Google はリリース配布方法や利用規約をいつでも変更する可能性があります。
- Heavy steps (verification, extraction, compatibility adjustment, saving) may freeze the display for a few seconds on some devices. In the measurement on one device, each step took under 5 seconds. Slower devices may take longer.
  重い処理(検証・展開・互換調整・保存)は、機種によっては表示が数秒止まることがあります。ある 1 台での計測では、各処理は 5 秒未満でした。低速な機種ではさらに時間がかかることがあります。
- In rare cases, startup can fail once when cleanup, self-recovery, and another cleanup overlap in a specific order. Running it again recovers.
  まれに、整理処理・自己回復・別の整理処理が特定の順序で重なると、起動が 1 回失敗することがあります。もう一度実行すると回復します。

## Rollback / ロールバック手順

If a critical issue is discovered after promoting a new version to `latest`, you can immediately roll back to the previous version using the following command:

新バージョン昇格後に重大な問題が発見された場合、以下のコマンドで前バージョンにロールバックできます:

```sh
npm dist-tag add @bash0816/agy-termux@<previous known-good version> latest
```

This reverts the `latest` tag to a previous known-good version and will restore the previous stable release for all new installations and updates.

これにより `latest` タグを前のステーブル版に戻し、新規インストール・更新時に前のステーブル版を配布します。
