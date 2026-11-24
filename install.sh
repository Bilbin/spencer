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

step() {
  printf '==> %s\n' "$*" >&2
}

die() {
  printf 'spencer install: %s\n' "$*" >&2
  exit 1
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "missing required command: $1"
  fi
}

need curl
need uname
need awk

OS_RAW=$(uname -s)
ARCH_RAW=$(uname -m)

case "$OS_RAW" in
  Linux) OS="linux" ;;
  Darwin)
    printf 'spencer install: prebuilt binaries are currently published for Linux (x86_64, arm64) only.\n' >&2
    printf 'On macOS, run with Nix (`nix run github:%s`) or build from source (`npm ci && npm run build:binary`).\n' "$REPO" >&2
    exit 1
    ;;
  *)
    die "unsupported OS \"${OS_RAW}\" (supported: Linux)"
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)   ARCH="x64" ;;
  arm64|aarch64)  ARCH="arm64" ;;
  *)
    die "unsupported architecture \"${ARCH_RAW}\" (supported: x86_64, arm64)"
    ;;
esac

BIN_NAME="spencer-${OS}-${ARCH}"
TGZ_NAME="${BIN_NAME}.tar.gz"

step "Detected platform: ${OS}/${ARCH}"

if [ "$VERSION" = "latest" ]; then
  step "Resolving latest Spencer release..."
  EFFECTIVE_URL=$(curl -fsSI -L -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest") || die "could not resolve latest release tag"
  TAG="${EFFECTIVE_URL##*/}"
  case "$TAG" in
    v*) ;;
    *) TAG="latest" ;;
  esac
  if [ "$TAG" = "latest" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
  else
    BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  fi
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *)  TAG="v${VERSION}" ;;
  esac
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
fi

step "Target release: Spencer ${TAG}"

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

step "Fetching SHA256SUMS for ${TAG}..."
curl -fsSL "${BASE_URL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS" || die "could not download SHA256SUMS for ${TAG}"

# Prefer compressed .tar.gz archives (v0.1.5+); fall back to raw binary for older tags.
EXPECTED=$(awk -v a="$TGZ_NAME" '$2 == a { print $1; exit }' "${TMP_DIR}/SHA256SUMS")
if [ -n "$EXPECTED" ]; then
  ASSET="$TGZ_NAME"
  IS_ARCHIVE=1
  need tar
else
  EXPECTED=$(awk -v a="$BIN_NAME" '$2 == a { print $1; exit }' "${TMP_DIR}/SHA256SUMS")
  [ -n "$EXPECTED" ] || die "${BIN_NAME} not found in SHA256SUMS for ${TAG}"
  ASSET="$BIN_NAME"
  IS_ARCHIVE=0
fi

step "Downloading ${ASSET} (${TAG})..."
if [ -t 2 ]; then
  curl -fL --progress-bar "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
else
  curl -fsSL "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
fi

step "Verifying SHA-256 checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{ print $1 }')
else
  die "need sha256sum or shasum to verify download"
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  printf 'spencer install: checksum mismatch for %s\n  expected: %s\n  actual:   %s\n' "$ASSET" "$EXPECTED" "$ACTUAL" >&2
  exit 1
fi
printf '    SHA-256 verified (%s...)\n' "$(printf '%s' "$ACTUAL" | cut -c1-16)" >&2

if [ "$IS_ARCHIVE" -eq 1 ]; then
  step "Extracting ${BIN_NAME}..."
  tar -xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}" "$BIN_NAME"
fi

step "Installing to ${INSTALL_DIR}/spencer..."
mkdir -p "$INSTALL_DIR"
chmod 0755 "${TMP_DIR}/${BIN_NAME}"
mv -f "${TMP_DIR}/${BIN_NAME}" "${INSTALL_DIR}/spencer"

step "Installed successfully!"
"${INSTALL_DIR}/spencer" --version || true

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf '\nAdd %s to your PATH:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR"
    ;;
esac

printf '\nNext steps:\n'
printf '  spencer                   # start Spencer and open the web UI\n'
printf '  spencer --version         # check installed version\n'
printf '  spencer service install   # optional: start automatically at login\n'
