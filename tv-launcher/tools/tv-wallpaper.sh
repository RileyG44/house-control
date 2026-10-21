#!/usr/bin/env bash
# Sets the Living Room Home wallpaper from a photo on this Mac.
#   tv-launcher/tools/tv-wallpaper.sh ~/Pictures/photo.jpg     (JPEG, PNG or HEIC)
#   tv-launcher/tools/tv-wallpaper.sh --clear
set -euo pipefail
export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"

url=$(adb shell cat /sdcard/Android/data/com.livingroom.tv/files/pairing.txt 2>/dev/null | tr -d '\r')
[[ -n "$url" ]] || { echo "Can't read the TV's pairing link over ADB. Is the TV connected (adb devices)?" >&2; exit 1; }
base=${url%%/\?k=*}
key=${url##*k=}

if [[ "${1:-}" == "--clear" ]]; then
  curl -fsS -X POST -H "X-LR-Key: $key" "$base/api/wallpaper/clear" >/dev/null && echo "Wallpaper removed."
  exit 0
fi

photo=${1:?Usage: tv-launcher/tools/tv-wallpaper.sh <photo> | --clear}
[[ -f "$photo" ]] || { echo "No such file: $photo" >&2; exit 1; }
reply=$(curl -fsS -X POST -H "X-LR-Key: $key" -H "Content-Type: application/octet-stream" --data-binary @"$photo" "$base/api/wallpaper")
[[ "$reply" == *'"ok":true'* ]] && echo "Wallpaper set." || { echo "The TV couldn't read that image: $reply" >&2; exit 1; }
