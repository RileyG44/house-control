#!/bin/bash
# Install the camera feed: go2rtc on this Mac, served to the tailnet.
#   ./setup.sh              install and start (now and at every login)
#   ./setup.sh uninstall    stop it and take it off the tailnet
set -euo pipefail
cd "$(dirname "$0")"

VERSION="v1.9.14"
LABEL="com.housecontrol.camera"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/HouseControl"
SERVE_PORT="8452"
LOCAL="http://127.0.0.1:1984"

if [ "${1:-install}" = "uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  command -v tailscale >/dev/null 2>&1 && tailscale serve --https="$SERVE_PORT" off 2>/dev/null || true
  echo "Camera feed stopped. It no longer starts at login."
  exit 0
fi

case "$(uname -m)" in
  arm64)  ASSET="go2rtc_mac_arm64.zip" ;;
  x86_64) ASSET="go2rtc_mac_amd64.zip" ;;
  *) echo "This needs an Apple silicon or Intel Mac."; exit 1 ;;
esac

mkdir -p bin "$LOG_DIR"
if [ ! -x bin/go2rtc ]; then
  echo "Downloading go2rtc ${VERSION}…"
  curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/download/$VERSION/$ASSET" -o bin/go2rtc.zip
  unzip -oq bin/go2rtc.zip -d bin
  rm -f bin/go2rtc.zip
  chmod +x bin/go2rtc
fi
bin/go2rtc -version >/dev/null

echo "Installing the camera feed…"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PWD/bin/go2rtc</string>
    <string>-c</string>
    <string>$PWD/go2rtc.yaml</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/camera.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/camera.log</string>
</dict>
</plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

for _ in $(seq 1 30); do
  curl -fsS "$LOCAL/" >/dev/null 2>&1 && break
  sleep 0.4
done
if ! curl -fsS "$LOCAL/" >/dev/null 2>&1; then
  echo "The feed did not come up. The log says why: $LOG_DIR/camera.log"
  exit 1
fi

echo
echo "On this Mac:  $LOCAL"
if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --bg --https="$SERVE_PORT" "$LOCAL" >/dev/null
  TS_HOST=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  if [ -n "$TS_HOST" ]; then
    echo "On the tailnet: https://$TS_HOST:$SERVE_PORT"
    echo "(Tailscale Serve, so tailnet devices only — nothing is on the public internet.)"
  else
    echo "Signed in to Tailscale? Then: tailscale serve --bg --https=$SERVE_PORT $LOCAL"
  fi
else
  echo "Install Tailscale to reach it from other devices: https://tailscale.com/download"
fi
echo
echo "It starts by itself whenever you log in. Log: $LOG_DIR/camera.log"
echo "The camera's address lives in go2rtc.yaml (streams → camera)."
