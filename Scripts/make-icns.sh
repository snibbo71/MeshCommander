#!/bin/bash
# Generates MeshCommanderMac/AppIcon.icns from a single source PNG.
# Usage: Scripts/make-icns.sh Assets/icon-source.png
#
# Source image should be square, ideally 1024x1024, with no transparency baked
# into corners needed - macOS applies its own rounded-square mask at display time.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-Assets/icon-source.png}"
if [ ! -f "$SRC" ]; then
  echo "error: source icon not found at $SRC" >&2
  echo "       drop a square PNG (1024x1024 recommended) there, or pass a path as an argument." >&2
  exit 1
fi

ICONSET="build/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o MeshCommanderMac/AppIcon.icns
echo "==> Wrote MeshCommanderMac/AppIcon.icns"
