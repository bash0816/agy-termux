#!/bin/sh
GLIBC_LIB="${PREFIX}/glibc/lib"
LOADER="${GLIBC_LIB}/ld-linux-aarch64.so.1"
BINARY="${HOME}/.agy-termux/agy.va39"

[ -f "$LOADER" ] || {
  echo "[agy-termux] Error: glibc loader not found."
  echo "  Run: pkg install glibc-repo && pkg install glibc"
  exit 1
}

[ -f "$BINARY" ] || {
  echo "[agy-termux] Error: agy.va39 not found. Run: agy (to trigger re-download)"
  exit 1
}

unset LD_PRELOAD

export LD_LIBRARY_PATH="${GLIBC_LIB}"
export SSL_CERT_FILE="${PREFIX}/etc/tls/cert.pem"
export GODEBUG="netdns=cgo"

exec "$LOADER" --library-path "$GLIBC_LIB" "$BINARY" "$@"
