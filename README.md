# agy-termux

Google Antigravity CLI (agy) for Termux on Android ARM64.

## Prerequisites

```bash
pkg install glibc-repo && pkg install glibc
pkg install curl
```

For memory-based execution, a C compiler is required (installed automatically in Termux):

```bash
pkg install clang
```

## Installation

```bash
npm install -g @bash0816/agy-termux
```

On first run, the package downloads the official `agy` binary from
[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli)
and runs it with device-specific compatibility adjustments.

## Usage

```bash
agy [command] [options]
```

For available commands, see the [Antigravity CLI documentation](https://antigravity.google).

## Updating

```bash
npm update -g @bash0816/agy-termux
```

## License

This package (`agy-termux`) is licensed under the [GPL-3.0-only](./LICENSE) License.

The `agy` binary downloaded at runtime is property of Google LLC.
