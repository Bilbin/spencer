#!/usr/bin/env bash
# Downloads the pinned croc release into ./.bin/croc and verifies its sha256.
set -euo pipefail
VERSION="v10.3.1"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="croc_${VERSION}_Linux-64bit.tar.gz"; SHA="52e6c2c510915c92c436f0098c8ce75d7e4660f74f0eeb9f9fd2cea5b9ff2e26" ;;
  *) echo "No pinned checksum for $(uname -s)-$(uname -m); install croc ${VERSION} yourself and set croc.path" >&2; exit 1 ;;
esac
DEST="${1:-$(cd "$(dirname "$0")/.." && pwd)/.bin}"
mkdir -p "$DEST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ASSET" "https://github.com/schollz/croc/releases/download/${VERSION}/${ASSET}"
echo "${SHA}  $TMP/$ASSET" | sha256sum -c - >/dev/null
tar -xzf "$TMP/$ASSET" -C "$TMP" croc
install -m 0755 "$TMP/croc" "$DEST/croc"
"$DEST/croc" --version
