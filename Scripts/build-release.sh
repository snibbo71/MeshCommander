#!/bin/bash
# Builds, signs, packages, and notarizes a distributable MeshCommanderAS.dmg.
#
# One-time setup before running this:
#   1. Copy Configs/Release.xcconfig.example to Configs/Release.xcconfig and fill in
#      your DEVELOPMENT_TEAM (Apple Developer Team ID) and CODE_SIGN_IDENTITY.
#   2. Install a "Developer ID Application" certificate in your login keychain
#      (Xcode -> Settings -> Accounts -> Manage Certificates -> + -> Developer ID Application).
#   3. Store notarization credentials once, under the profile name below, e.g.:
#        xcrun notarytool store-credentials MeshCommanderNotary \
#          --key /path/to/AuthKey_XXXX.p8 --key-id XXXX --issuer XXXX
#      (or --apple-id/--team-id/--password for an app-specific password instead of an API key)
#   4. `brew install create-dmg` (for the styled DMG background/icon-layout window).
#   5. Optional but recommended: drop a square source image (1024x1024) at
#      Assets/icon-source.png and run Scripts/make-icns.sh to generate the app icon,
#      and/or a background image at Assets/dmg-background.png (660x400, or 1320x800
#      for a retina-sharp version) for the DMG window. Both are picked up
#      automatically if present; the DMG still looks reasonable without them.

set -euo pipefail
cd "$(dirname "$0")/.."

NOTARY_PROFILE="${NOTARY_PROFILE:-MeshCommanderASNotary}"
BUILD_DIR="build"
ARCHIVE_PATH="$BUILD_DIR/MeshCommanderAS.xcarchive"
APP_NAME="MeshCommanderAS.app"
DMG_NAME="MeshCommanderAS.dmg"

if [ ! -f Configs/Release.xcconfig ] || grep -q "YOUR_TEAM_ID" Configs/Release.xcconfig; then
  echo "error: Configs/Release.xcconfig is missing or still has placeholder values." >&2
  echo "       See Configs/Release.xcconfig.example for setup instructions." >&2
  exit 1
fi

if [ -f Assets/icon-source.png ]; then
  echo "==> Generating app icon from Assets/icon-source.png"
  Scripts/make-icns.sh Assets/icon-source.png
fi

echo "==> Generating index-mac.html (Phase 4 feature set)"
node Scripts/build-html.js --features Scripts/features-phase4.json

echo "==> Generating per-language index-mac_XX.html bundles"
for LANG in de es fr it ja ko nl pt ru zh-chs; do
  node Scripts/build-html.js \
    --input "index_${LANG}.html" \
    --output "MeshCommanderMac/Resources/index-mac_${LANG}.html" \
    --features Scripts/features-phase4.json
done

echo "==> Regenerating Xcode project"
xcodegen generate

echo "==> Cleaning previous build output"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Archiving (Release, Developer ID signed, Hardened Runtime)"
xcodebuild -project MeshCommanderMac.xcodeproj \
  -scheme MeshCommanderMac \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  archive

APP_PATH="$ARCHIVE_PATH/Products/Applications/$APP_NAME"

echo "==> Verifying code signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl -a -t exec -vv "$APP_PATH" || echo "note: spctl will reject until after notarization+stapling below"

echo "==> Building styled DMG (sign + notarize + staple via create-dmg)"
# create-dmg's --codesign/--notarize do the DMG-container signing, submission, wait,
# and stapling all in one step - the DMG container needs its own Developer ID
# signature separate from the signed .app inside it (notarization's ticket alone
# doesn't satisfy Gatekeeper's "primary signature" check on the container), and
# create-dmg handles that ordering correctly (sign container -> notarize -> staple).
DMG_SIGN_IDENTITY=$(sed -n 's/^CODE_SIGN_IDENTITY[[:space:]]*=[[:space:]]*//p' Configs/Release.xcconfig)
rm -f "$BUILD_DIR/$DMG_NAME"

CREATE_DMG_ARGS=(
  --volname "MeshCommanderAS"
  --window-pos 200 120
  --window-size 660 400
  --icon-size 128
  --icon "$APP_NAME" 180 170
  --hide-extension "$APP_NAME"
  --app-drop-link 480 170
  --codesign "$DMG_SIGN_IDENTITY"
  --notarize "$NOTARY_PROFILE"
  --overwrite
)
[ -f MeshCommanderMac/AppIcon.icns ] && CREATE_DMG_ARGS+=(--volicon MeshCommanderMac/AppIcon.icns)
[ -f Assets/dmg-background.png ] && CREATE_DMG_ARGS+=(--background Assets/dmg-background.png)

create-dmg "${CREATE_DMG_ARGS[@]}" "$BUILD_DIR/$DMG_NAME" "$(dirname "$APP_PATH")"

echo "==> Final Gatekeeper check"
spctl -a -t open --context context:primary-signature -v "$BUILD_DIR/$DMG_NAME"

echo "==> Done: $BUILD_DIR/$DMG_NAME"
