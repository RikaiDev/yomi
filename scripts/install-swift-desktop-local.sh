#!/usr/bin/env bash
set -euo pipefail

project_app=desktop/mac-native/Yomi.app
project_binary="$project_app/Contents/MacOS/Yomi"
installed_app=/Applications/Yomi.app
dist_sentinel=dist/cli/query.js
local_core_bundle=build/desktop-core-macos-local

swift_changed=false
if [[ ! -x "$project_binary" ]] \
  || [[ scripts/build-swift-desktop.sh -nt "$project_binary" ]] \
  || find desktop/mac-native -type f \( -name '*.swift' -o -name '*.plist' -o -name '*.icns' -o -name '*.svg' \) \
    -not -path '*/Yomi.app/*' -newer "$project_binary" -print -quit | grep -q .
then
  swift_changed=true
fi

if [[ "$swift_changed" == true ]]; then
  echo "[install-local] Swift changed; using fast local build"
  YOMI_SWIFT_OPTIMIZATION=-Onone bash scripts/build-swift-desktop.sh
else
  echo "[install-local] Swift unchanged; reusing local binary"
fi

typescript_changed=false
if [[ ! -f "$dist_sentinel" ]] \
  || [[ package.json -nt "$dist_sentinel" ]] \
  || [[ tsconfig.json -nt "$dist_sentinel" ]] \
  || find src -type f -name '*.ts' -newer "$dist_sentinel" -print -quit | grep -q .
then
  typescript_changed=true
fi

if [[ "$typescript_changed" == true ]]; then
  echo "[install-local] TypeScript changed; rebuilding core"
  npm run build
else
  echo "[install-local] TypeScript unchanged; reusing dist"
fi

bundle_changed=false
if [[ ! -x "$local_core_bundle/runtime/node" ]] \
  || [[ ! -d "$local_core_bundle/YomiCore/node_modules" ]] \
  || [[ package.json -nt "$local_core_bundle/YomiCore/package.json" ]] \
  || [[ run.mjs -nt "$local_core_bundle/YomiCore/run.mjs" ]] \
  || [[ "$dist_sentinel" -nt "$local_core_bundle/YomiCore/$dist_sentinel" ]] \
  || ! "$local_core_bundle/runtime/node" "$local_core_bundle/YomiCore/run.mjs" version >/dev/null 2>&1
then
  bundle_changed=true
fi

if [[ "$bundle_changed" == true ]]; then
  echo "[install-local] Runtime bundle changed; packaging self-contained core"
  portable_node="${YOMI_DESKTOP_NODE_BINARY:-}"
  if [[ -z "$portable_node" ]]; then
    portable_node=$(find "/Users/$(id -un)/.nvm/versions/node" -path '*/bin/node' -type f 2>/dev/null | sort -V | tail -1)
  fi
  if [[ -z "$portable_node" || ! -x "$portable_node" ]]; then
    echo "[install-local] No portable Node runtime found; set YOMI_DESKTOP_NODE_BINARY" >&2
    exit 1
  fi
  node scripts/package-desktop-core.mjs \
    --platform macos \
    --output "$local_core_bundle" \
    --node-binary "$portable_node" \
    --semantic lite \
    --skip-build
else
  echo "[install-local] Runtime bundle unchanged; reusing self-contained core"
fi

node scripts/desktop-qos-harness.mjs --bundle "$local_core_bundle"

osascript -e 'tell application "Yomi" to quit' 2>/dev/null || true
ditto "$project_binary" "$installed_app/Contents/MacOS/Yomi"
ditto "$local_core_bundle/YomiCore" "$installed_app/Contents/Resources/YomiCore"
ditto "$local_core_bundle/runtime" "$installed_app/Contents/Resources/runtime"
bash scripts/codesign-local-app.sh "$installed_app"
open -a "$installed_app"
runtime_pid=$(pgrep -x Yomi | head -1 || true)
if [[ -n "$runtime_pid" ]]; then
  node scripts/desktop-qos-harness.mjs --runtime-pid "$runtime_pid"
fi
