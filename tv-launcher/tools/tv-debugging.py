#!/usr/bin/env python3
"""Configure optional home-network ADB recovery, without printing the launcher's pairing key."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["enable", "disable", "status"])
    parser.add_argument("--adb", action="store_true", help="Read the installed TV's pairing URL over the explicitly selected ADB connection")
    args = parser.parse_args()
    if args.adb:
        if not os.environ.get("ANDROID_SERIAL"):
            parser.error("Set ANDROID_SERIAL to the TV's ADB address")
        raw = subprocess.check_output(["adb", "shell", "cat", "/sdcard/Android/data/com.livingroom.tv/files/pairing.txt"], text=True).strip()
        parts = urlsplit(raw)
        base = f"{parts.scheme}://{parts.netloc}"
        token = parse_qs(parts.query)["k"][0]
    else:
        config = json.loads((Path.home() / ".house-hub/tv.json").read_text())["launcher"]
        base, token = config["url"], config["token"]
    headers = {"X-LR-Key": token, "Content-Type": "application/json"}
    if args.action != "status":
        body = json.dumps({"type": "debug-recovery", "enabled": args.action == "enable"}).encode()
        with urlopen(Request(base + "/api/cmd", data=body, headers=headers), timeout=8) as response:
            if not json.load(response).get("ok"):
                raise SystemExit("Couldn't configure recovery. It needs the optional WRITE_SECURE_SETTINGS grant and a connected home Wi-Fi network.")
    with urlopen(Request(base + "/api/debugging", headers=headers), timeout=8) as response:
        print(json.dumps(json.load(response), indent=2))


if __name__ == "__main__":
    main()
