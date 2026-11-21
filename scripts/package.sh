#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension needs.
set -e
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/three-inspector-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json LICENSE icons src vendor -x '*.DS_Store'
echo "$out"
