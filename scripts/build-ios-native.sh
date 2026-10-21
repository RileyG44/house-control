#!/bin/bash
# Builds the native iPhone app (ios-native/, docs/native-ios.md) and installs it on the iPhone
# connected by cable, then launches it.
#
#   scripts/build-ios-native.sh            build, install and launch on the connected iPhone
#   scripts/build-ios-native.sh build      build only (generic iOS device)
#   scripts/build-ios-native.sh sim        build for the simulator (needs an iOS simulator runtime)
#
# The signing team goes in ios-native/Config/Local.xcconfig (DEVELOPMENT_TEAM = …). Set
# HOUSE_DEVICE to a device's UDID or name to pick one when several are connected.
set -euo pipefail
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HERE/ios-native"
DERIVED="$APP_DIR/build"
MODE="${1:-device}"
BUNDLE_ID="dev.riley.HouseControl"

command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen" >&2; exit 1; }
if [ ! -f "$APP_DIR/Config/Local.xcconfig" ]; then
  echo "Put your team in ios-native/Config/Local.xcconfig, e.g. DEVELOPMENT_TEAM = ABCDE12345" >&2
  exit 1
fi

cd "$APP_DIR"
xcodegen generate --quiet

if [ "$MODE" = "sim" ]; then
  if ! xcrun simctl list runtimes | grep -q "iOS"; then
    echo "No iOS simulator runtime is installed (Xcode > Settings > Components)." >&2
    exit 1
  fi
  xcodebuild -project HouseNative.xcodeproj -scheme HouseNative -configuration Debug \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DERIVED" \
    COMPILER_INDEX_STORE_ENABLE=NO build | xcbeautify 2>/dev/null || true
  exit "${PIPESTATUS[0]}"
fi

xcodebuild -project HouseNative.xcodeproj -scheme HouseNative -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
  COMPILER_INDEX_STORE_ENABLE=NO build 2>&1 | grep -E "error:|warning:|BUILD (SUCCEEDED|FAILED)|Signing Identity|Provisioning Profile" || true
APP="$DERIVED/Build/Products/Debug-iphoneos/HouseNative.app"
[ -d "$APP" ] || { echo "The build failed (no HouseNative.app)." >&2; exit 1; }
[ "$MODE" = "build" ] && { echo "Built $APP"; exit 0; }

DEVICE="${HOUSE_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun devicectl list devices 2>/dev/null | awk '/available \(paired\)/ && /iPhone/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/ || $i ~ /^[0-9A-F-]{25,}$/) { print $i; exit } }')"
fi
if [ -z "$DEVICE" ]; then
  echo "Built $APP; no paired iPhone is connected, so nothing was installed."
  exit 0
fi
echo "Installing on $DEVICE…"
xcrun devicectl device install app --device "$DEVICE" "$APP"
echo "Launching…"
xcrun devicectl device process launch --terminate-existing --device "$DEVICE" "$BUNDLE_ID" || {
  echo "Installed, but it didn't launch: unlock the iPhone (and trust the developer under Settings > General > VPN & Device Management) and open House." >&2
}
