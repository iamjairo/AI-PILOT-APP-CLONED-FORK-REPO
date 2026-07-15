#!/usr/bin/env bash
# Rasterize icons/icon.svg into transparent PNGs at 16/32/48/128 px.
# Prefers rsvg-convert; falls back to ImageMagick, then macOS sips.
set -euo pipefail
cd "$(dirname "$0")/icons"

SRC="icon.svg"
SIZES=(16 32 48 128)

if command -v rsvg-convert >/dev/null 2>&1; then
  for s in "${SIZES[@]}"; do
    rsvg-convert -w "$s" -h "$s" -o "icon${s}.png" "$SRC"
  done
  echo "Icons generated with rsvg-convert."
elif command -v magick >/dev/null 2>&1; then
  for s in "${SIZES[@]}"; do
    magick -background none -density 384 "$SRC" -resize "${s}x${s}" "icon${s}.png"
  done
  echo "Icons generated with ImageMagick."
elif command -v sips >/dev/null 2>&1; then
  # sips can't read SVG directly; requires a pre-rendered large PNG.
  echo "Only sips found — provide a large icon.png first, then resize." >&2
  exit 1
else
  echo "No SVG rasterizer found (need rsvg-convert, ImageMagick, or sips)." >&2
  exit 1
fi
