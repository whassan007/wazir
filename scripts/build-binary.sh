#!/usr/bin/env bash
# Build a standalone native executable for Wazir using Node.js Single Executable Application (SEA)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Configuring environment files and shell profiles..."
node scripts/setup-env.mjs

echo "==> Building CLI bundle..."
node scripts/bundle.mjs

DIST_DIR="$REPO_ROOT/dist"
mkdir -p "$DIST_DIR"

OUT_BIN="$DIST_DIR/wa"
SEA_CONFIG="$DIST_DIR/sea-config.json"
SEA_BLOB="$DIST_DIR/sea-prep.blob"

cat > "$SEA_CONFIG" <<EOF
{
  "main": "bin/wa.js",
  "output": "dist/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF

echo "==> Generating SEA blob..."
node --experimental-sea-config "$SEA_CONFIG"

echo "==> Packaging standalone binary: $OUT_BIN..."
NODE_EXEC="$(command -v node)"
cp "$NODE_EXEC" "$OUT_BIN"
chmod u+w "$OUT_BIN"

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  # macOS requires removing the existing code signature before injection, then re-signing
  if command -v codesign >/dev/null 2>&1; then
    codesign --remove-signature "$OUT_BIN" || true
  fi
  npx --yes postject "$OUT_BIN" NODE_SEA_BLOB "$SEA_BLOB" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  if command -v codesign >/dev/null 2>&1; then
    codesign --sign - "$OUT_BIN" || true
  fi
else
  # Linux
  npx --yes postject "$OUT_BIN" NODE_SEA_BLOB "$SEA_BLOB" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

chmod +x "$OUT_BIN"
rm -f "$SEA_CONFIG" "$SEA_BLOB"

echo
echo "✓ Standalone binary created at: $OUT_BIN"
echo "  File size: $(du -h "$OUT_BIN" | cut -f1)"
echo "  To install globally: sudo cp $OUT_BIN /usr/local/bin/wa"
echo "  Or user-local:       cp $OUT_BIN ~/.local/bin/wa"
