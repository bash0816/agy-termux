# agy-termux

Google Antigravity CLI (`agy`) for Termux on Android ARM64.

> **This project is not affiliated with, endorsed by, or sponsored by Google.**  
> `agy-termux` is an independent compatibility wrapper.

## What this does

This package downloads the official `agy` binary from Google's public release source
([google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli))
at the user's explicit request and applies a **local compatibility patch** on your device
to enable execution in the Termux/Android ARM64 environment.

- The compatibility patch adjusts TCMalloc memory address calculations for Android's 39-bit VA space.
- **No Google binaries or modified binaries are distributed by this package.**
- The patch is applied on your device only. No modified binary is uploaded or shared.
- The patch is intended solely for Termux/Android runtime interoperability.
  It does not bypass authentication, licensing, payment, access controls, or usage restrictions.

## Prerequisites

```bash
pkg install glibc-repo && pkg install glibc
```

## Installation

```bash
npm install -g @bash0816/agy-termux
```

On first run, you will be prompted to confirm:
1. Downloading the official `agy` binary from Google's public release.
2. Applying a local compatibility adjustment for this device.

Both steps are skipped on subsequent runs if the version has not changed.

## Usage

```bash
agy [command] [options]
```

For available commands, see the [Antigravity CLI documentation](https://antigravity.google).

## Updating

```bash
npm update -g @bash0816/agy-termux
```

The wrapper always fetches the latest official `agy` release on first use of a new version.

## License

This package (`agy-termux`) is licensed under [GPL-3.0-only](./LICENSE).

**The GPL does not apply to the `agy` binary.** The `agy` binary downloaded at runtime
is the property of Google LLC and is subject to Google's terms of service.
This package does not grant any rights to Google's binary.

See [NOTICE.md](./NOTICE.md) for third-party attribution.

## Disclaimer

Users are responsible for ensuring that their use of Google Antigravity CLI complies
with [Google's terms of service](https://antigravity.google/terms) and applicable laws.

If a rights holder or platform operator raises a substantiated concern regarding this package,
we will promptly review it and may remove or disable the affected functionality.

## Compatibility

- **Platform**: Android (Termux)
- **Architecture**: ARM64 (aarch64)
- **Runtime**: Termux glibc loader (`pkg install glibc`)
- Tested with agy 1.0.12 on Android 12+

## Known limitations

- Upstream agy updates may require a new compatibility patch version.
- If the downloaded binary fails basic validation, the tool will exit rather than run a potentially broken binary.
- Google may change their release distribution or terms at any time.
