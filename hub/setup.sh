#!/bin/bash
# One-time setup: installs the hub, builds the panel and starts both (now and at every login).
set -e
cd "$(dirname "$0")"

PY=""
for p in python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    PY="$p"; break
  fi
done
if [ -z "$PY" ]; then
  echo "This needs Python 3.11 or newer. Get it from https://www.python.org/downloads/macos/"
  echo "(or: brew install python@3.12), then run ./setup.sh again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if command -v npm >/dev/null 2>&1; then
  echo "Building the panel…"
  npm --prefix ../web ci --silent
  npm --prefix ../web run build --silent
elif [ ! -f ../web/dist/index.html ]; then
  echo "The panel needs Node.js to build once: https://nodejs.org (or: brew install node), then run ./setup.sh again."
  exit 1
fi

echo "Installing the hub…"
"$PY" -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements.txt
mkdir -p "$HOME/.house-hub"
[ -f "$HOME/.house-hub/devices.json" ] || cp devices.example.json "$HOME/.house-hub/devices.json"
./.venv/bin/python house.py install
