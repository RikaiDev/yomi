#!/usr/bin/env bash
set -euo pipefail

app="desktop/mac-native/Yomi.app"
optimization="${YOMI_SWIFT_OPTIMIZATION:--O}"
case "$optimization" in
  -O|-Onone) ;;
  *)
    echo "Unsupported YOMI_SWIFT_OPTIMIZATION: $optimization" >&2
    exit 2
    ;;
esac
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp desktop/mac-native/Info.plist "$app/Contents/Info.plist"
cp desktop/mac-native/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cp desktop/mac-native/Design/AppliedGlyphs/YomiKomainuLine.svg "$app/Contents/Resources/YomiKomainuLine.svg"
cp desktop/mac-native/Design/AppliedGlyphs/YomiKomainuAgent.svg "$app/Contents/Resources/YomiKomainuAgent.svg"

sources=()
while IFS= read -r source; do sources+=("$source"); done < <(
  find desktop/mac-native -name '*.swift' -type f -not -path '*/Yomi.app/*' | sort
)

echo "[build-swift] compiling with $optimization"
swiftc "$optimization" -target "$(uname -m)-apple-macos14.0" \
  -framework Cocoa -framework SwiftUI -framework Security \
  -framework Speech -framework AVFoundation -framework AVKit -framework PhotosUI -framework Vision \
  "${sources[@]}" -o "$app/Contents/MacOS/Yomi"
cp "$app/Contents/MacOS/Yomi" desktop/mac-native/Yomi
bash scripts/codesign-local-app.sh "$app"
