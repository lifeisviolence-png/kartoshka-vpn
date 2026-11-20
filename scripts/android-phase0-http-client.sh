#!/system/bin/sh
# Minimal HTTP client for the Phase 0 emulator proof. It runs inside the
# emulator as the shell UID, so its traffic is routed through the VpnService
# TUN. The request is sent to 10.0.2.2:8080; Xray's test outbound redirects it
# to 10.0.2.2:8081. Keeping stdin open for a few seconds makes toybox nc wait
# for the response instead of closing the socket immediately.
set -u

HOST="10.0.2.2"
PORT="8080"

if command -v nc >/dev/null 2>&1; then
  {
    printf 'GET / HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n' "$HOST"
    sleep 8
  } | nc "$HOST" "$PORT"
  exit $?
fi

echo "no nc client in the emulator system image" >&2
exit 127
