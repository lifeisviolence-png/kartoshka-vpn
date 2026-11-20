#!/usr/bin/env bash
# Phase 0 spike helper. The generated Tauri Android project is intentionally
# not committed; this script creates it and applies the minimum settings and
# the official Xray Android binary needed by the spike.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_PROJECT="$ROOT/src-tauri/gen/android"
XRAY_VERSION="26.10.31"
XRAY_ABI="${1:-x86_64}"
case "$XRAY_ABI" in
  x86_64)
    XRAY_ASSET="Xray-android-amd64.zip"
    XRAY_ABI_DIR="x86_64"
    ;;
  arm64-v8a)
    XRAY_ASSET="Xray-android-arm64-v8a.zip"
    XRAY_ABI_DIR="arm64-v8a"
    ;;
  *)
    echo "unsupported Xray Android ABI: $XRAY_ABI" >&2
    exit 2
    ;;
esac

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.0.12077973}"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$HOME/.cargo/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ ! -d "$ANDROID_PROJECT" ]; then
  (cd "$ROOT" && pnpm tauri android init --ci)
fi

python3 - "$ANDROID_PROJECT" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
build = root / "app/build.gradle.kts"
text = build.read_text()
text = re.sub(r"compileSdk\s*=\s*\d+", "compileSdk = 37", text)
text = re.sub(r"minSdk\s*=\s*\d+", "minSdk = 26", text)
text = re.sub(r"targetSdk\s*=\s*\d+", "targetSdk = 35", text)
if "jniLibs.useLegacyPackaging" not in text:
    text = text.replace(
        "    buildTypes {",
        "    packaging {\n        jniLibs.useLegacyPackaging = true\n    }\n    buildTypes {",
        1,
    )
build.write_text(text)

manifest = root / "app/src/main/AndroidManifest.xml"
m = manifest.read_text()
m = re.sub(r'\n\s*android:extractNativeLibs="[^"]*"', "", m)
manifest.write_text(m)
PY

JNI_DIR="$ANDROID_PROJECT/app/src/main/jniLibs/$XRAY_ABI_DIR"
mkdir -p "$JNI_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${XRAY_ASSET}"
curl -fsSL "$URL" -o "$TMP/xray.zip"
curl -fsSL "$URL.dgst" -o "$TMP/xray.zip.dgst"
EXPECTED="$(awk -F'= ' '/^SHA2-256=/{print $2}' "$TMP/xray.zip.dgst")"
ACTUAL="$(sha256sum "$TMP/xray.zip" | awk '{print $1}')"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Xray Android archive checksum mismatch: expected=$EXPECTED actual=$ACTUAL" >&2
  exit 3
fi
unzip -p "$TMP/xray.zip" xray > "$JNI_DIR/libxray.so"
chmod 755 "$JNI_DIR/libxray.so"
echo "Xray Android $XRAY_VERSION ($XRAY_ABI_DIR) ready: $ACTUAL"
