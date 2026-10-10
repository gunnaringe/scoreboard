#!/bin/sh
# Regenerates public/qrcodegen.js from the vendored TypeScript source.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp --suffix=.ts)
{ sed 's/^"use strict";//' vendor/qrcodegen.ts; echo 'export default qrcodegen;'; } > "$tmp"
{ sed -n 1,22p vendor/qrcodegen.ts
  echo '// Transpiled from vendor/qrcodegen.ts (Project Nayuki, MIT) by scripts/build-qr.sh.'
  npx esbuild "$tmp" --format=esm --target=es2020; } > public/qrcodegen.js
rm "$tmp"
