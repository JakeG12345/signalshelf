#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/signal-shelf-extension-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
out="dist/signal-shelf-extension-${version}.zip"
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*')
echo "$out"
