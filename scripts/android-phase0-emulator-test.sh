#!/usr/bin/env bash
# Phase 0 emulator proof. Run inside ReactiveCircus/android-emulator-runner,
# after the x86_64 debug APK has been built.
#
# The test is deliberately strict:
#   - the official XTLS/libXray Android library must load and report its version;
#   - VpnService must create a TUN and pass its fd to the in-process Xray core;
#   - the HTTP request is sent to 10.0.2.2:8080, but Xray's freedom outbound
#     redirects it to 10.0.2.2:8081. A request that bypasses the TUN reaches
#     8080 directly and fails the test;
#   - the service and the in-process Xray state must survive the Activity
#     going Home.
set -euo pipefail

PKG="ru.kartoshka.vpn"
ACTIVITY="$PKG/.MainActivity"
APK="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
LOG_8080="/tmp/kpv-http-8080.log"
LOG_8081="/tmp/kpv-http-8081.log"
RESPONSE="/tmp/kpv-response.txt"
CLIENT_ERR="/tmp/kpv-client.err"
LOGCAT="/tmp/kpv-logcat.txt"
NETWORK="/tmp/kpv-network.txt"
ACCESS="/tmp/kpv-xray-access.log"
CLIENT="/data/local/tmp/kpv-http-client.sh"

test -f "$APK"

PID_8080=""
PID_8081=""
cleanup() {
  timeout 30 adb logcat -d -s KPV_PHASE0:* >"$LOGCAT" 2>&1 || true
  timeout 30 adb shell ip addr >"$NETWORK" 2>&1 || true
  timeout 30 adb shell ip route >>"$NETWORK" 2>&1 || true
  timeout 30 adb shell run-as "$PKG" cat files/access.log >"$ACCESS" 2>&1 || true
  if [ -n "$PID_8080" ]; then kill "$PID_8080" 2>/dev/null || true; fi
  if [ -n "$PID_8081" ]; then kill "$PID_8081" 2>/dev/null || true; fi
}
trap cleanup EXIT

timeout 120 adb wait-for-device
# TCG can report boot_completed before PackageManager is ready. Wait for a
# real package-manager round trip, then give the emulator a short settle.
for _ in $(seq 1 60); do
  if timeout 30 adb shell cmd package list packages >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
sleep 20

installed=0
for attempt in 1 2 3; do
  echo "adb install attempt $attempt"
  if timeout 300 adb install --no-streaming -r -g "$APK"; then
    installed=1
    break
  fi
  echo "adb install attempt $attempt failed; retrying"
  sleep 20
done
if [ "$installed" != 1 ]; then
  echo 'ERROR: adb install failed after retries'
  timeout 30 adb shell df -h || true
  exit 1
fi
timeout 30 adb shell pm path "$PKG"
timeout 30 adb shell appops set "$PKG" ACTIVATE_VPN allow
timeout 30 adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

# -u is required: the test reads these logs while the servers are still
# running. Without it Python block-buffers stdout and a successful request
# would look like an empty log until the process exits.
python3 -u -m http.server 8080 --bind 0.0.0.0 >"$LOG_8080" 2>&1 &
PID_8080=$!
python3 -u -m http.server 8081 --bind 0.0.0.0 >"$LOG_8081" 2>&1 &
PID_8081=$!

adb push scripts/android-phase0-http-client.sh "$CLIENT" >/dev/null
adb shell chmod 755 "$CLIENT"

timeout 30 adb logcat -c
timeout 300 adb shell am start -W -n "$ACTIVITY" || true

# TCG is slow. Wait for the service log instead of guessing a fixed delay.
for _ in $(seq 1 90); do
  if timeout 30 adb logcat -d -s KPV_PHASE0:* | grep -q 'tunnel started fd='; then
    break
  fi
  sleep 2
done

echo '--- phase0 logcat ---'
timeout 30 adb logcat -d -s KPV_PHASE0:* | tail -120
timeout 30 adb logcat -d -s KPV_PHASE0:* | grep -q 'xray version:'
timeout 30 adb logcat -d -s KPV_PHASE0:* | grep -q 'tunnel started fd='
timeout 30 adb logcat -d -s KPV_PHASE0:* | grep -q 'xray state: true'
timeout 60 adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
timeout 30 adb shell ps -A | grep -q "$PKG"

echo '--- network state ---'
timeout 30 adb shell ip addr || true
timeout 30 adb shell ip route || true

echo '--- traffic through TUN ---'
set +e
timeout 90 adb shell sh "$CLIENT" >"$RESPONSE" 2>"$CLIENT_ERR"
CLIENT_RC=$?
set -e
echo "client exit=$CLIENT_RC"
cat "$CLIENT_ERR" || true
head -20 "$RESPONSE" || true

# The redirected request must reach 8081. If it reaches 8080, the TUN was
# bypassed and the test must fail rather than report a false positive.
if ! grep -q 'GET /' "$LOG_8081"; then
  echo 'ERROR: request did not reach 8081 through Xray'
  echo '--- 8081 log ---'
  cat "$LOG_8081" || true
  echo '--- 8080 log ---'
  cat "$LOG_8080" || true
  echo '--- response size ---'
  wc -c "$RESPONSE" || true
  exit 1
fi
if grep -q 'GET /' "$LOG_8080"; then
  echo 'ERROR: request reached 8080 directly; TUN/Xray was bypassed'
  exit 1
fi
test -s "$RESPONSE"
grep -q 'Directory listing' "$RESPONSE"

echo '--- activity close check ---'
timeout 30 adb shell input keyevent 3
sleep 5
timeout 60 adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
timeout 30 adb shell ps -A | grep -q "$PKG"
timeout 30 adb logcat -d -s KPV_PHASE0:* | grep -q 'xray state: true'
echo 'PHASE0_EMULATOR_OK'
