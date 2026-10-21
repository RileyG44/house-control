#!/bin/zsh
# Build Living Room, install it on the TV as a normal app, and grant the two ADB permissions it needs.
# Does not change the default Home app or disable anything. Undo with tv-launcher/tools/tv-uninstall.sh.
#   tv-launcher/tools/tv-install.sh [--no-build]
set -euo pipefail
root=${0:A:h:h}
pkg=com.livingroom.tv
listener=$pkg/$pkg.media.MediaListenerService
a11y=$pkg/$pkg.input.RemoteInputService
state=$root/tools/.tv-state
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}

if [[ ${1:-} != --no-build ]]; then
  (cd $root && ./gradlew :app:assembleRelease --console=plain -q)
fi
apk=$root/app/build/outputs/apk/release/app-release.apk

adb get-state >/dev/null || { echo "No TV connected over ADB." >&2; exit 1; }

# Remember the TV's accessibility settings once, before we ever touch them.
mkdir -p $state
if [[ ! -f $state/accessibility_services ]]; then
  adb shell settings get secure enabled_accessibility_services > $state/accessibility_services
  adb shell settings get secure accessibility_enabled > $state/accessibility_enabled
fi

echo "Installing…"
adb install -r $apk >/dev/null

echo "Allowing Now Playing access…"
adb shell cmd notification allow_listener $listener

echo "Enabling the remote input service…"
current=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
if [[ $current != *$a11y* ]]; then
  if [[ -z $current || $current == null ]]; then next=$a11y; else next=$current:$a11y; fi
  adb shell settings put secure enabled_accessibility_services "$next"
fi
adb shell settings put secure accessibility_enabled 1

# The services start the app's process; it writes its pairing link once the server is up.
url=""
for i in {1..30}; do
  url=$(adb shell cat /sdcard/Android/data/$pkg/files/pairing.txt 2>/dev/null | tr -d '\r' || true)
  [[ -n $url ]] && break
  sleep 0.5
done
echo
echo "Installed. Open “Living Room” from the TV's app row."
if [[ -n $url ]]; then
  host=${${url#http://}%%:*}
  echo "Launcher API: ${url%%/\?k=*}"
  echo "Pair House Control's hub with it: python hub/house.py --pair-tv $host"
fi
