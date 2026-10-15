#!/usr/bin/env bash
set -euo pipefail

app=${1:?usage: codesign-local-app.sh /path/to/Yomi.app}
identity=${YOMI_LOCAL_CODESIGN_IDENTITY:-}
if [[ -z "$identity" ]]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Apple Development|Developer ID Application/ { print $2; exit }')
fi

if [[ -n "$identity" ]]; then
  codesign --force --deep --timestamp=none --sign "$identity" "$app"
  echo "[codesign-local] signed with stable identity: $identity"
else
  codesign --force --deep --sign - "$app"
  echo "[codesign-local] warning: ad-hoc signature; Keychain trust may prompt after every rebuild" >&2
fi

codesign --verify --deep --strict --verbose=2 "$app"
