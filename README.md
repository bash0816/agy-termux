# agy-termux

Google Antigravity CLI (agy) for Termux on Android ARM64.

## Prerequisites

This package requires glibc support and curl for downloading the binary:

```bash
pkg install glibc-repo && pkg install glibc
pkg install curl
```

Optionally, for attestation verification (provenance checking):

```bash
pkg install gh
```

## Installation

```bash
npm install -g @bash0816/agy-termux
```

On first run, the package automatically downloads `agy.va39` (Google Antigravity CLI) from the [wallentx/antigravity-cli-termux](https://github.com/wallentx/antigravity-cli-termux) repository and installs it to `~/.agy-termux`.

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

This package is licensed under the MIT License.

The included `agy.va39` binary is Google Antigravity CLI, licensed under the Apache-2.0 License. See [wallentx/antigravity-cli-termux](https://github.com/wallentx/antigravity-cli-termux) for details.
