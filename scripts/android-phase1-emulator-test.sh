#!/usr/bin/env bash
# Phase 1 Android emulator test.
#
# Full mode (API 34): explicit debug-only start, TUN traffic through Xray,
# no listening TCP sockets, IPv4/IPv6 routes, notification without the node
# name, Home survival and a null-intent (always-on) restart from the encrypted
# bundle.
#
# Smoke mode (API 35/36): install, explicit start, TUN, no listeners,
# notification and stop. It verifies the foreground-service type on the newer
# platform without pretending that a TCG boot proves a real phone.
set -euo pipefail

PKG="ru.kartoshka.vpn"
ACTIVITY="$PKG/.MainActivity"
APK="${KPV_APK:-src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk}"
API_LEVEL="${KPV_API_LEVEL:-34}"
MODE="${KPV_TEST_MODE:-full}"
LOG_8080="/tmp/kpv-http-8080.log"
LOG_8081="/tmp/kpv-http-8081.log"
RESPONSE="/tmp/kpv-response.txt"
CLIENT_ERR="/tmp/kpv-client.err"
LOGCAT="/tmp/kpv-logcat.txt"
NETWORK="/tmp/kpv-network.txt"
CLIENT="/data/local/tmp/kpv-http-client.sh"

test -f "$APK"

PID_8080=""
PID_8081=""
cleanup() {
  timeout 30 adb logcat -d -s KPV_PHASE1:* >"$LOGCAT" 2>&1 || true
  timeout 60 adb logcat -d > /tmp/kpv-full-logcat.txt 2>&1 || true
  timeout 30 adb shell ip addr >"$NETWORK" 2>&1 || true
  timeout 30 adb shell ip route >>"$NETWORK" 2>&1 || true
  timeout 30 adb shell ip -6 route >>"$NETWORK" 2>&1 || true
  timeout 30 adb reverse --remove tcp:8081 >/dev/null 2>&1 || true
  if [ -n "$PID_8080" ]; then kill "$PID_8080" 2>/dev/null || true; fi
  if [ -n "$PID_8081" ]; then kill "$PID_8081" 2>/dev/null || true; fi
}
trap cleanup EXIT

timeout 120 adb wait-for-device
for _ in $(seq 1 60); do
  if timeout 30 adb shell cmd package list packages >/dev/null 2>&1; then break; fi
  sleep 5
done
sleep 20

installed=0
for attempt in 1 2 3; do
  echo "adb install attempt $attempt"
  if timeout 300 adb install --no-streaming -r -g "$APK"; then installed=1; break; fi
  sleep 20
done
if [ "$installed" != 1 ]; then
  echo 'ERROR: adb install failed after retries'
  exit 1
fi
timeout 30 adb shell pm path "$PKG"
timeout 30 adb shell appops set "$PKG" ACTIVATE_VPN allow
timeout 30 adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

CONFIG="$(python3 - <<'PY'
import json
print(json.dumps({
    "log": {"loglevel": "warning"},
    "inbounds": [{
        "tag": "tun-in",
        "protocol": "tun",
        "settings": {"name": "kpv0", "mtu": 1500}
    }],
    "outbounds": [{
        "tag": "test-out",
        "protocol": "freedom",
        "settings": {"redirect": "127.0.0.1:8081"}
    }]
}, separators=(",", ":")))
PY
)"

python3 -u -m http.server 8080 --bind 0.0.0.0 >"$LOG_8080" 2>&1 &
PID_8080=$!
python3 -u -m http.server 8081 --bind 127.0.0.1 >"$LOG_8081" 2>&1 &
PID_8081=$!
timeout 30 adb reverse tcp:8081 tcp:8081
adb push scripts/android-phase0-http-client.sh "$CLIENT" >/dev/null
adb shell chmod 755 "$CLIENT"

timeout 30 adb logcat -c
timeout 60 adb shell am start -n "$ACTIVITY" || true
sleep 8
# The production service is not exported. The debug-only test activity is the
# only way for adb to request an explicit start; it refuses to run in release.
start_test_activity() {
  timeout 60 adb shell "am start -n $PKG/com.plugin.vpn.KpvTestStartActivity --es config '$CONFIG'" || true
}
start_test_activity
sleep 3
# On a clean emulator the system VPN consent dialog may still be shown even
# after `appops set ACTIVATE_VPN allow`. Confirm it and retry the explicit
# start; on images where the appop already authorizes the package this branch
# is not taken.
CONSENT=0
for _ in $(seq 1 10); do
  if timeout 30 adb shell dumpsys window windows 2>/dev/null | grep -q 'com.android.vpndialogs'; then
    CONSENT=1
    break
  fi
  sleep 1
done
if [ "$CONSENT" = 1 ]; then
  echo '--- confirming system VPN consent dialog ---'
  timeout 30 adb shell uiautomator dump /sdcard/kpv-window.xml >/dev/null 2>&1 || true
  timeout 30 adb shell cat /sdcard/kpv-window.xml > /tmp/kpv-window.xml 2>/dev/null || true
  TAP="$(python3 - <<'PY'
import re
import xml.etree.ElementTree as ET
try:
    root = ET.parse('/tmp/kpv-window.xml').getroot()
except Exception:
    raise SystemExit
for node in root.iter('node'):
    text = node.attrib.get('text', '')
    rid = node.attrib.get('resource-id', '')
    if text in ('OK', 'Allow', 'Разрешить', 'Разрешить подключение') or rid.endswith('button1'):
        match = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds', ''))
        if match:
            x = (int(match.group(1)) + int(match.group(3))) // 2
            y = (int(match.group(2)) + int(match.group(4))) // 2
            print(f'{x} {y}')
            break
PY
)"
  if [ -n "$TAP" ]; then
    timeout 30 adb shell input tap $TAP || true
  else
    timeout 30 adb shell input keyevent 66 || true
  fi
  sleep 3
  start_test_activity
fi

for _ in $(seq 1 120); do
  if timeout 30 adb logcat -d -s KPV_PHASE1:* | grep -q 'tunnel started fd='; then break; fi
  sleep 2
done

echo '--- phase1 logcat ---'
timeout 30 adb logcat -d -s KPV_PHASE1:* | tail -160
timeout 30 adb logcat -d -s KPV_PHASE1:* | grep -q 'tunnel started fd='
timeout 30 adb logcat -d -s KPV_PHASE1:* | grep -q 'xray state: true'

# establish() returns the fd before Android has finished publishing the tun
# interface. Poll briefly so the network assertions below do not race it.
for _ in $(seq 1 20); do
  if timeout 10 adb shell ip addr show tun0 2>/dev/null | grep -q '10.8.0.2'; then break; fi
  sleep 1
done

echo '--- network state ---'
timeout 30 adb shell ip addr || true
timeout 30 adb shell ip route || true
timeout 30 adb shell ip -6 route || true
timeout 30 adb shell ip addr show tun0 | grep -q '10.8.0.2'
timeout 30 adb shell ip -6 addr show tun0 | grep -q 'fd00::2'
# Android installs VPN routes in a separate policy table, so the main table
# intentionally has no default route. Check all tables and, additionally, that
# a real lookup for an internet address selects tun0.
timeout 30 adb shell ip route show table all | grep -qE 'default( via [^ ]+)? dev tun0'
timeout 30 adb shell ip -6 route show table all | grep -qE 'default( via [^ ]+)? dev tun0'
timeout 30 adb shell ip route get 1.1.1.1 | grep -q 'dev tun0'
timeout 30 adb shell ip -6 route get 2606:4700:4700::1111 | grep -q 'dev tun0'

echo '--- no listening TCP sockets owned by the app ---'
APP_UID="$(timeout 30 adb shell cmd package list packages -U "$PKG" 2>/dev/null \
  | tr -d '\r' | sed -n 's/.*uid:\([0-9]*\).*/\1/p' | head -1)"
if [ -z "$APP_UID" ]; then
  APP_UID="$(timeout 30 adb shell dumpsys package "$PKG" 2>/dev/null \
    | tr -d '\r' | sed -n 's/.*userId=\([0-9]*\).*/\1/p' | head -1)"
fi
if [ -z "$APP_UID" ]; then echo 'ERROR: cannot read app uid'; exit 1; fi
LISTENERS="$(timeout 30 adb shell 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' | awk -v uid="$APP_UID" '$8 == uid && $4 == "0A" {print}')"
if [ -n "$LISTENERS" ]; then
  echo "ERROR: app owns a listening TCP socket (uid $APP_UID):"
  echo "$LISTENERS"
  exit 1
fi
echo "no listeners for uid $APP_UID"

echo '--- notification ---'
NOTIF="$(timeout 30 adb shell dumpsys notification --noredact 2>/dev/null || true)"
if ! grep -q 'KartoshkaVPN' <<<"$NOTIF"; then
  echo 'ERROR: VPN notification is missing'
  exit 1
fi
if grep -q 'Secret Node' <<<"$NOTIF"; then
  echo 'ERROR: node name leaked into the notification'
  exit 1
fi

if [ "$MODE" = "full" ]; then
  echo '--- traffic through TUN ---'
  set +e
  timeout 90 adb shell sh "$CLIENT" >"$RESPONSE" 2>"$CLIENT_ERR"
  CLIENT_RC=$?
  set -e
  echo "client exit=$CLIENT_RC"
  cat "$CLIENT_ERR" || true
  head -20 "$RESPONSE" || true
  if ! grep -q 'GET /' "$LOG_8081"; then
    echo 'ERROR: request did not reach 8081 through Xray'
    cat "$LOG_8081" || true
    exit 1
  fi
  if grep -q 'GET /' "$LOG_8080"; then
    echo 'ERROR: request reached 8080 directly; TUN/Xray was bypassed'
    exit 1
  fi
  test -s "$RESPONSE"
  grep -q 'HTTP/1.0 200 OK' "$RESPONSE"

  echo '--- activity close check ---'
  timeout 30 adb shell input keyevent 3
  sleep 5
  timeout 60 adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
  timeout 30 adb shell ps -A | grep -q "$PKG"

  echo '--- always-on null-intent restart from encrypted bundle ---'
  timeout 30 adb shell am force-stop "$PKG"
  sleep 2
  timeout 60 adb shell "am start -n $PKG/com.plugin.vpn.KpvTestStartActivity --ez nullStart true" || true
  for _ in $(seq 1 120); do
    if timeout 30 adb logcat -d -s KPV_PHASE1:* | grep -q 'tunnel started fd='; then break; fi
    sleep 2
  done
  timeout 30 adb logcat -d -s KPV_PHASE1:* | grep -q 'tunnel started fd='
  timeout 30 adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'
fi

echo '--- explicit stop ---'
timeout 30 adb shell "am start -n $PKG/com.plugin.vpn.KpvTestStartActivity --ez stop true" || true
sleep 3
if timeout 30 adb shell dumpsys activity services "$PKG" | grep -q 'KartoshkaVpnService'; then
  echo 'ERROR: service is still running after explicit stop'
  exit 1
fi

if [ "$API_LEVEL" = "34" ] && [ "$MODE" = "full" ]; then
  echo 'PHASE1_EMULATOR_OK'
else
  echo "PHASE1_SMOKE_OK api=$API_LEVEL"
fi
