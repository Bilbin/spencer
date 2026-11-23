#!/usr/bin/env bash
# Downloads the pinned croc release into ./.bin/croc and verifies its sha256.
set -euo pipefail
VERSION="v10.3.1"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64)   ASSET="croc_${VERSION}_Linux-64bit.tar.gz"; SHA="52e6c2c510915c92c436f0098c8ce75d7e4660f74f0eeb9f9fd2cea5b9ff2e26" ;;
  Linux-aarch64|Linux-arm64)  ASSET="croc_${VERSION}_Linux-ARM64.tar.gz"; SHA="18c71d91547f03bd52f4c13d146aca1df3a8ce5c205c5758a4fb0ad6f0de1821" ;;
  Darwin-arm64)               ASSET="croc_${VERSION}_macOS-ARM64.tar.gz"; SHA="4e8a2fb7e2e5bb5091567dbf7a0a2cb404fb25227d7688c755b8340bd9ead2ef" ;;
  Darwin-x86_64)              ASSET="croc_${VERSION}_macOS-64bit.tar.gz"; SHA="169aec647b8078ceb34d600d4cbff57d93fa849404b9d943a8e6e42b910984a0" ;;
  *) echo "No pinned checksum for $(uname -s)-$(uname -m); install croc ${VERSION} yourself and set croc.path" >&2; exit 1 ;;
esac
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/.bin}"
mkdir -p "$DEST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ASSET" "https://github.com/schollz/croc/releases/download/${VERSION}/${ASSET}"
if command -v sha256sum >/dev/null 2>&1; then
  echo "${SHA}  $TMP/$ASSET" | sha256sum -c - >/dev/null
else
  echo "${SHA}  $TMP/$ASSET" | shasum -a 256 -c - >/dev/null
fi
tar -xzf "$TMP/$ASSET" -C "$TMP" croc
install -m 0755 "$TMP/croc" "$DEST/croc"
"$DEST/croc" --version
