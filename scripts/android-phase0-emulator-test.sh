#!/usr/bin/env bash
# Phase 0 emulator proof. Run inside ReactiveCircus/android-emulator-runner,
# after the x86_64 debug APK has been built.
#
# The test is deliberately strict:
#   - the official Xray binary must execute from nativeLibraryDir;
#   - VpnService must create a TUN and pass its fd to Xray;
#   - the HTTP request is sent to 10.0.2.2:8080, but Xray's freedom outbound
#     redirects it to 10.0.2.2:8081. A request that bypasses the TUN reaches
#     8080 directly and fails the test;
#   - the service and the Xray process must survive the Activity going Home.
set -euo pipefail

PKG="ru.kartoshka.vpn"
ACTIVITY="$PKG/.MainActivity"
APK="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
LOG_8080="/tmp/kpv-http-8080.log"
LOG_8081="/tmp/kpv-http-8081.log"
RESPONSE="/tmp/kpv-response.txt"

test -f "$APK"

adb install -r "$APK"
adb shell appops set "$PKG" ACTIVATE_VPN allow
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

python3 -m http.server 8080 --bind 0.0.0.0 >"$LOG_8080" 2>&1 &
PID_8080=$!
python3 -m http.server 8081 --bind 0.0.0.0 >"$LOG_8081" 2>&1 &
PID_8081=$!
cleanup() {
  kill "$PID_8080" "$PID_8081" 2>/dev/null || true
}
trap cleanup EXIT

adb logcat -c
adb shell am start -W -n "$ACTIVITY" || true

# TCG is slow. Wait for the service log instead of guessing a fixed delay.
for _ in $(seq 1 90); do
  if adb logcat -d -s KPV_PHASE0:* | grep -q 'tunnel started fd='; then
    break
  fi
  sleep 2
done

echo '--- phase0 logcat ---'
adb logcat -d -s KPV_PHASE0:* | tail -120
adb logcat -d -s KPV_PHASE0:* | grep -q 'xray version:'
adb logcat -d -s KPV_PHASE0:* | grep -q 'tunnel started fd='
adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
adb shell ps -A | grep -E 'libxray|xray' || true

echo '--- traffic through TUN ---'
set +e
adb shell "toybox wget -qO- http://10.0.2.2:8080/ 2>/dev/null || printf 'GET / HTTP/1.0\r\nHost: 10.0.2.2\r\n\r\n' | toybox nc 10.0.2.2 8080" >"$RESPONSE"
CLIENT_RC=$?
set -e
echo "client exit=$CLIENT_RC"
head -20 "$RESPONSE" || true

# The redirected request must reach 8081. If it reaches 8080, the TUN was
# bypassed and the test must fail rather than report a false positive.
grep -q 'GET /' "$LOG_8081"
if grep -q 'GET /' "$LOG_8080"; then
  echo 'ERROR: request reached 8080 directly; TUN/Xray was bypassed'
  exit 1
fi
test -s "$RESPONSE"
grep -q 'Directory listing' "$RESPONSE"

echo '--- activity close check ---'
adb shell input keyevent 3
sleep 5
adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
adb shell ps -A | grep -E 'libxray|xray'
echo 'PHASE0_EMULATOR_OK'
