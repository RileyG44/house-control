#!/bin/zsh
# Remove Living Room from the TV and put its accessibility and notification settings back.
set -euo pipefail
root=${0:A:h:h}
pkg=com.livingroom.tv
listener=$pkg/$pkg.media.MediaListenerService
a11y=$pkg/$pkg.input.RemoteInputService
state=$root/tools/.tv-state
[[ -n ${ANDROID_SERIAL:-} ]] || { echo "Set ANDROID_SERIAL to the TV’s adb serial/address." >&2; exit 1; }
# Never remove the only usable Home. A failed restore must stop the uninstall.
if [[ -f $state/home.json ]]; then
  python3 "$root/tools/tv-home.py" restore
else
  home=$(adb shell cmd package resolve-activity --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.HOME)
  [[ $home != *com.livingroom.tv/* ]] || { echo "Restore another Home before uninstalling Living Room." >&2; exit 1; }
fi

adb shell cmd notification disallow_listener $listener || true
if [[ -f $state/accessibility_services ]]; then
  before=$(tr -d '\r' < $state/accessibility_services)
  enabled=$(tr -d '\r' < $state/accessibility_enabled)
  if [[ -z $before || $before == null ]]; then
    adb shell settings delete secure enabled_accessibility_services
  else
    adb shell settings put secure enabled_accessibility_services "$before"
  fi
  [[ $enabled == null ]] && adb shell settings delete secure accessibility_enabled || adb shell settings put secure accessibility_enabled "$enabled"
else
  current=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
  adb shell settings put secure enabled_accessibility_services "${${current//:$a11y/}//$a11y/}"
fi
adb uninstall $pkg || true
echo "Living Room removed; TV settings restored."
