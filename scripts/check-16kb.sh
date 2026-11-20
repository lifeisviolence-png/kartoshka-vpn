#!/usr/bin/env bash
# Fail if any shared library in the APK has a LOAD segment aligned below
# 0x4000 (16 KiB). Android 15+ devices may use 16 KiB pages; a 4 KiB-aligned
# library installs but fails to load there.
set -euo pipefail

APK="${1:?usage: check-16kb.sh <apk>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$APK" 'lib/*/*.so' -d "$TMP" 2>/dev/null || true
mapfile -t LIBS < <(find "$TMP/lib" -type f -name '*.so' | sort)
if [ "${#LIBS[@]}" -eq 0 ]; then
  echo "ERROR: no native libraries found in $APK"
  exit 1
fi
failed=0
for so in "${LIBS[@]}"; do
  aligns="$(readelf -lW "$so" | awk '/LOAD/{print $NF}' | sort -u)"
  echo "== ${so#"$TMP"/}"
  echo "$aligns"
  while read -r align; do
    [ -z "$align" ] && continue
    value=$((align))
    if [ "$value" -lt 16384 ]; then
      echo "ERROR: $so has LOAD alignment $align (< 0x4000)"
      failed=1
    fi
  done <<< "$aligns"
done
if [ "$failed" != 0 ]; then
  exit 1
fi
echo "16KB_ALIGNMENT_OK"
