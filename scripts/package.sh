#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node "$ROOT/bin/airbrake" version)
OUT="$ROOT/dist"
ARCHIVE="$OUT/airbrake-$VERSION.tar.gz"
TEMP="$OUT/.airbrake-$VERSION.tar.gz.tmp"

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  printf '%s\n' 'Refusing to package an uncommitted working tree.' >&2
  exit 1
fi

mkdir -p "$OUT"
trap 'rm -f "$TEMP"' EXIT HUP INT TERM
git -C "$ROOT" archive \
  --format=tar \
  --prefix="airbrake-$VERSION/" \
  HEAD |
  gzip -n > "$TEMP"
mv "$TEMP" "$ARCHIVE"
trap - EXIT HUP INT TERM
printf '%s\n' "$ARCHIVE"
