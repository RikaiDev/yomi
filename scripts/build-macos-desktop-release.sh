#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
ARCH=${YOMI_DESKTOP_ARCH:-$(uname -m)}
OUTPUT=${YOMI_DESKTOP_OUTPUT:-"$ROOT/build/desktop-release/macos-$ARCH"}
CORE="$ROOT/build/desktop-core-macos"
APP="$OUTPUT/Yomi.app"
NODE_BINARY=${YOMI_NODE_BINARY:-$(command -v node)}
NODE_LICENSE=${YOMI_NODE_LICENSE:-$(dirname "$NODE_BINARY")/NODE-LICENSE}

npm run desktop:swift-quality
npm run desktop:build
node scripts/package-desktop-core.mjs \
  --platform macos \
  --output "$CORE" \
  --semantic full \
  --node-binary "$NODE_BINARY" \
  --node-license "$NODE_LICENSE"

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"
ditto desktop/mac-native/Yomi.app "$APP"
ditto "$CORE/YomiCore" "$APP/Contents/Resources/YomiCore"
ditto "$CORE/runtime" "$APP/Contents/Resources/runtime"
cp "$CORE/desktop-bundle.json" "$APP/Contents/Resources/desktop-bundle.json"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/bin/strip -x "$APP/Contents/MacOS/Yomi"

if [[ -n "${MACOS_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp \
    --entitlements desktop/mac-native/Node.entitlements \
    --sign "$MACOS_SIGNING_IDENTITY" "$APP/Contents/Resources/runtime/node"
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$APP"
else
  if [[ "${YOMI_ALLOW_UNSIGNED_PREVIEW:-0}" != "1" ]]; then
    echo "MACOS_SIGNING_IDENTITY is required (or set YOMI_ALLOW_UNSIGNED_PREVIEW=1 for local packaging only)" >&2
    exit 1
  fi
  codesign --force --sign - "$APP/Contents/Resources/runtime/node"
  codesign --force --sign - "$APP"
fi

codesign --verify --deep --strict --verbose=2 "$APP"

if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" ]]; then
  NOTARY_ZIP="$OUTPUT/Yomi-notary.zip"
  ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
  xcrun notarytool submit "$NOTARY_ZIP" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --wait
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=4 "$APP"
  rm "$NOTARY_ZIP"
elif [[ "${YOMI_ALLOW_UNSIGNED_PREVIEW:-0}" != "1" ]]; then
  echo "APPLE_API_KEY_PATH, APPLE_API_KEY_ID, and APPLE_API_ISSUER_ID are required for notarization" >&2
  exit 1
fi

DMG_ROOT="$OUTPUT/dmg"
DMG="$OUTPUT/Yomi-Desktop-macOS-$ARCH-$VERSION.dmg"
mkdir -p "$DMG_ROOT"
ditto "$APP" "$DMG_ROOT/Yomi.app"
ln -s /Applications "$DMG_ROOT/Applications"
hdiutil create -volname "Yomi Desktop" -srcfolder "$DMG_ROOT" -ov -format UDZO "$DMG"
rm -rf "$DMG_ROOT"

MOUNT_POINT=$(mktemp -d "${RUNNER_TEMP:-/tmp}/yomi-dmg.XXXXXX")
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT"
"$MOUNT_POINT/Yomi.app/Contents/Resources/runtime/node" \
  "$MOUNT_POINT/Yomi.app/Contents/Resources/YomiCore/run.mjs" version | grep -qx "$VERSION"
hdiutil detach "$MOUNT_POINT"
rmdir "$MOUNT_POINT"

if [[ -n "${MACOS_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$DMG"
fi

shasum -a 256 "$DMG" > "$DMG.sha256"
SIZE_MB=$(du -m "$DMG" | awk '{print $1}')
if (( SIZE_MB > ${YOMI_MACOS_DMG_MAX_MB:-120} )); then
  echo "DMG is ${SIZE_MB} MB, above size budget" >&2
  exit 1
fi

echo "[desktop:macos-release] $DMG (${SIZE_MB} MB)"
