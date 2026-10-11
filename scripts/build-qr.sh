#!/bin/sh
# Regenerates web/qrcodegen.js from the vendored TypeScript source.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp --suffix=.ts)
{ sed 's/^"use strict";//' third_party/qrcodegen.ts; echo 'export default qrcodegen;'; } > "$tmp"
{ sed -n 1,22p third_party/qrcodegen.ts
  echo '// Transpiled from third_party/qrcodegen.ts (Project Nayuki, MIT) by scripts/build-qr.sh.'
  npx esbuild "$tmp" --format=esm --target=es2020; } > web/qrcodegen.js
rm "$tmp"
