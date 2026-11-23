#!/bin/sh
# Install Spencer from GitHub Releases (with SHA-256 verification).
#
#   curl -fsSL https://raw.githubusercontent.com/PJalv/spencer/main/install.sh | sh
#
# Environment overrides:
#   SPENCER_VERSION      Release tag to install (default: latest)
#   SPENCER_INSTALL_DIR  Destination directory (default: ~/.local/bin, or /usr/local/bin as root)
set -eu

REPO="PJalv/spencer"
VERSION="${SPENCER_VERSION:-latest}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'spencer install: missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

need curl
need uname

OS_RAW=$(uname -s)
ARCH_RAW=$(uname -m)

case "$OS_RAW" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    printf 'spencer install: unsupported OS "%s" (supported: Linux, macOS)\n' "$OS_RAW" >&2
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)   ARCH="x64" ;;
  arm64|aarch64)  ARCH="arm64" ;;
  *)
    printf 'spencer install: unsupported architecture "%s" (supported: x86_64, arm64)\n' "$ARCH_RAW" >&2
    exit 1
    ;;
esac

ASSET="spencer-${OS}-${ARCH}"

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *)  TAG="v${VERSION}" ;;
  esac
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
fi

if [ -n "${SPENCER_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$SPENCER_INSTALL_DIR"
elif [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spencer-install.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

printf 'Downloading %s (%s)...\n' "$ASSET" "$VERSION"
curl -fsSL "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
curl -fsSL "${BASE_URL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS"

EXPECTED=$(awk -v a="$ASSET" '$2 == a { print $1; exit }' "${TMP_DIR}/SHA256SUMS")
if [ -z "$EXPECTED" ]; then
  printf 'spencer install: %s not found in SHA256SUMS\n' "$ASSET" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')
else
  printf 'spencer install: need sha256sum or shasum to verify download\n' >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  printf 'spencer install: checksum mismatch for %s\n  expected: %s\n  actual:   %s\n' "$ASSET" "$EXPECTED" "$ACTUAL" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 0755 "${TMP_DIR}/${ASSET}"
mv -f "${TMP_DIR}/${ASSET}" "${INSTALL_DIR}/spencer"

printf 'Installed %s\n' "${INSTALL_DIR}/spencer"
"${INSTALL_DIR}/spencer" --version || true

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf '\nAdd %s to your PATH:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR"
    ;;
esac

printf '\nNext steps:\n'
printf '  spencer                   # start Spencer and open the web UI\n'
printf '  spencer service install   # optional: start automatically at login\n'
