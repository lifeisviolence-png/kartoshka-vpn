#!/usr/bin/env bash
# Sign a SHA256SUMS file with the KartoshkaVPN Ed25519 release key.
# The private key is supplied only through the KARTOSHKA_UPDATE_SIGNING_KEY
# environment variable (GitHub Actions secret); it is never written to git.
set -euo pipefail
checksum="${1:?usage: sign-checksums.sh <SHA256SUMS file>}"
if [[ -z "${KARTOSHKA_UPDATE_SIGNING_KEY:-}" ]]; then
  echo "::warning::KARTOSHKA_UPDATE_SIGNING_KEY is not configured; checksum signature was not created"
  exit 0
fi
key="$(mktemp "${TMPDIR:-/tmp}/kartoshka-update-key.XXXXXX")"
sig="$(mktemp "${TMPDIR:-/tmp}/kartoshka-update-sig.XXXXXX")"
cleanup() { rm -f "$key" "$sig"; }
trap cleanup EXIT
chmod 600 "$key"
printf '%s\n' "$KARTOSHKA_UPDATE_SIGNING_KEY" > "$key"
openssl pkeyutl -sign -inkey "$key" -rawin -in "$checksum" -out "$sig"
python3 - "$sig" "$checksum.sig" <<'PY'
import pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_bytes()
if len(raw) != 64:
    raise SystemExit(f"expected 64-byte Ed25519 signature, got {len(raw)}")
pathlib.Path(sys.argv[2]).write_text(raw.hex() + "\n", encoding="ascii")
PY
openssl pkeyutl -verify -pubin -inkey "$(dirname "$0")/update-signing-public.pem" \
  -rawin -in "$checksum" -sigfile "$sig" >/dev/null
printf 'Signed %s -> %s.sig\n' "$checksum" "$checksum"
