#!/bin/zsh
# Build Living Room, grant remote permissions, and make it the Chromecast Home.
# Recovery: tv-home.py restore. Use --keep-stock-home for a regular-app test install.
#   ANDROID_SERIAL=<TV> tv-launcher/tools/tv-install.sh [--no-build] [--keep-stock-home]
set -euo pipefail
root=${0:A:h:h}
pkg=com.livingroom.tv
listener=$pkg/$pkg.media.MediaListenerService
a11y=$pkg/$pkg.input.RemoteInputService
state=$root/tools/.tv-state
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}

[[ -n ${ANDROID_SERIAL:-} ]] || { echo "Set ANDROID_SERIAL to the TV’s adb serial/address." >&2; exit 1; }
no_build=0
keep_stock=0
keep_adb=0
for arg in "$@"; do
  case $arg in
    --no-build) no_build=1 ;;
    --keep-stock-home) keep_stock=1 ;;
    --keep-adb) keep_adb=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if (( ! no_build )); then
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
if (( keep_adb )); then
  echo "Allowing wireless debugging recovery on the current home Wi-Fi network…"
  adb shell pm grant "$pkg" android.permission.WRITE_SECURE_SETTINGS
  python3 "$root/tools/tv-debugging.py" enable --adb
fi
if (( keep_stock )); then
  echo "Installed as a regular app; existing Home settings were left as they were."
else
  python3 "$root/tools/tv-home.py" enable
fi
if [[ -n $url ]]; then
  host=${${url#http://}%%:*}
  echo "Launcher API: ${url%%/\?k=*}"
  echo "Pair House Control's hub with it: python hub/house.py --pair-tv $host"
fi
