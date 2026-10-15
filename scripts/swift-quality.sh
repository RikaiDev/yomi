#!/usr/bin/env bash
set -euo pipefail

node scripts/swift-architecture-quality.mjs
node scripts/swift-i18n-harness.mjs

# One source list, owned by the same enumeration the release build uses
# (scripts/build-swift-desktop.sh). A hand-maintained copy of this list drifted
# out of sync and made the typecheck fail on a type it simply could not see.
sources=()
while IFS= read -r source; do
  sources+=("$source")
  lines=$(wc -l < "$source")
  if (( lines > 1000 )); then
    echo "$source exceeds the 1000-line Swift source limit ($lines lines)" >&2
    exit 1
  fi
done < <(find desktop/mac-native -name '*.swift' -type f -not -path '*/Yomi.app/*' | sort)

xcrun swift-format lint --recursive --parallel --strict --no-color-diagnostics --configuration .swift-format desktop/mac-native

swiftc \
  -target "$(uname -m)-apple-macos14.0" \
  -warnings-as-errors \
  -warn-concurrency \
  -strict-concurrency=complete \
  -typecheck \
  -framework Cocoa \
  -framework SwiftUI \
  -framework Security \
  -framework Compression \
  -framework Speech \
  -framework AVFoundation \
  -framework AVKit \
  -framework PhotosUI \
  -framework Vision \
  "${sources[@]}"
