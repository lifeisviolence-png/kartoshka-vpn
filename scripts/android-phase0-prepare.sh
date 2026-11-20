#!/usr/bin/env bash
# Phase 0 spike helper. The generated Tauri Android project is intentionally
# not committed; this script creates it, applies the minimum Android settings,
# and downloads the official XTLS/libXray Android AAR with a pinned SHA-256.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_PROJECT="$ROOT/src-tauri/gen/android"
LIBXRAY_VERSION="26.10.31"
LIBXRAY_SHA256="fb99f04acf379cc2957c1e1d0ce2b3c0005d3f49974a44c09a11242a0562c1ca"
ANDROID_ABI="${1:-x86_64}"

case "$ANDROID_ABI" in
  x86_64|arm64-v8a)
    ;;
  *)
    echo "unsupported Android ABI: $ANDROID_ABI" >&2
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
text = re.sub(r"compileSdk\s*=\s*\d+", "compileSdk = 36", text)
text = re.sub(r"minSdk\s*=\s*\d+", "minSdk = 26", text)
text = re.sub(r"targetSdk\s*=\s*\d+", "targetSdk = 35", text)
if "jniLibs.useLegacyPackaging" not in text:
    text = text.replace(
        "    buildTypes {",
        "    packaging {\n        jniLibs.useLegacyPackaging = true\n    }\n    buildTypes {",
        1,
    )
if 'libs/libXray.aar' not in text:
    text = text.replace(
        "dependencies {",
        'dependencies {\n    implementation(files("libs/libXray.aar"))',
        1,
    )
build.write_text(text)

manifest = root / "app/src/main/AndroidManifest.xml"
m = manifest.read_text()
m = re.sub(r'\n\s*android:extractNativeLibs="[^"]*"', "", m)
manifest.write_text(m)
PY

APP_LIBS="$ANDROID_PROJECT/app/libs"
PLUGIN_LIBS="$ROOT/plugins/android/libs"
mkdir -p "$APP_LIBS" "$PLUGIN_LIBS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/XTLS/libXray/releases/download/v${LIBXRAY_VERSION}/libxray-android.zip"
curl -fsSL "$URL" -o "$TMP/libxray-android.zip"
ACTUAL="$(sha256sum "$TMP/libxray-android.zip" | awk '{print $1}')"
if [ "$ACTUAL" != "$LIBXRAY_SHA256" ]; then
  echo "libXray Android archive checksum mismatch: expected=$LIBXRAY_SHA256 actual=$ACTUAL" >&2
  exit 3
fi
unzip -p "$TMP/libxray-android.zip" libxray-android/libXray.aar > "$APP_LIBS/libXray.aar"
cp "$APP_LIBS/libXray.aar" "$PLUGIN_LIBS/libXray.aar"
echo "libXray Android $LIBXRAY_VERSION ($ANDROID_ABI) ready: $ACTUAL"
