#!/usr/bin/env python3
"""Select Living Room as Home, disable the two competing Google Home packages, or restore.

ANDROID_SERIAL must identify this Chromecast. Device settings are recorded before changes;
Google packages are disabled for user 0, never removed. No elevated Android privileges needed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

OURS = "com.livingroom.tv/.MainActivity"
PACKAGES = ("com.google.android.apps.tv.launcherx", "com.google.android.tungsten.setupwraith")
HOME_ARGS = ("-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME")
ROOT = Path(__file__).resolve().parent


class HomeSetup:
    def __init__(self, serial: str, state: Path, run=None):
        self.serial, self.state = serial, state
        self.run = run or self._run

    def _run(self, *args):
        return subprocess.check_output(["adb", "-s", self.serial, "shell", *args], text=True, stderr=subprocess.STDOUT, timeout=20).strip()

    def resolved(self):
        lines = self.run("cmd", "package", "resolve-activity", "--brief", "--user", "0", *HOME_ARGS).splitlines()
        return next((line.strip() for line in reversed(lines) if re.fullmatch(r"[\w.]+/[\w.$]+", line.strip())), "")

    def is_ours(self, component):
        return component in (OURS, "com.livingroom.tv/com.livingroom.tv.MainActivity")

    def identity(self):
        serial = self.run("getprop", "ro.serialno")
        if not serial or serial == "unknown":
            raise RuntimeError("The TV did not report its hardware serial; nothing changed.")
        return serial

    def package_state(self, package):
        dump = self.run("dumpsys", "package", package)
        match = re.search(r"User 0: [^\n]*\benabled=([0-4])\b", dump)
        if match is None:
            raise RuntimeError(f"Cannot read user 0's enabled state for {package}; nothing changed.")
        return int(match[1])

    def load(self):
        data = json.loads(self.state.read_text())
        if data.get("device") != self.identity():
            raise RuntimeError("The saved Home settings belong to another TV. Use a different --state file.")
        component = data.get("home", "")
        if not re.fullmatch(r"[\w.]+/[\w.$]+", component) or self.is_ours(component):
            raise RuntimeError("The saved stock Home component is invalid.")
        if set(data.get("packages", {})) != set(PACKAGES) or any(type(v) is not int or v not in range(5) for v in data["packages"].values()):
            raise RuntimeError("The saved package states are invalid.")
        return data

    def remember(self):
        if self.state.exists():
            return self.load()  # Never replace the original recovery settings on an update.
        home = self.resolved()
        if not home or self.is_ours(home) or home.startswith("android/"):
            raise RuntimeError("No stock Home can be recorded. Restore stock Home before the first takeover.")
        data = {"device": self.identity(), "home": home, "packages": {p: self.package_state(p) for p in PACKAGES}}
        self.state.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.state, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(data, out, indent=2)
        return data

    def set_home(self, component):
        reply = self.run("cmd", "package", "set-home-activity", "--user", "0", component)
        if "Success" not in reply:
            raise RuntimeError(f"Android refused to set Home: {reply}")

    def restore(self, data=None):
        data = data or self.load()
        # A working stock Home comes first; only then restore original per-user package states.
        for package in PACKAGES:
            self.run("pm", "enable", "--user", "0", package)
        self.set_home(data["home"])
        if self.resolved() != data["home"]:
            raise RuntimeError("Stock Home did not resolve after restoration; Google packages were left enabled.")
        commands = ("default-state", "enable", "disable", "disable-user", "disable-until-used")
        for package, value in data["packages"].items():
            self.run("pm", commands[value], "--user", "0", package)
        self.run("input", "keyevent", "KEYCODE_HOME")
        print("Restored the recorded Home and Google package settings.")

    def configured(self):
        return self.is_ours(self.resolved()) and all(self.package_state(p) == 3 for p in PACKAGES)

    def enable(self):
        if self.run("getprop", "ro.product.device") != "sabrina":
            raise RuntimeError("This takeover script is for the tested Chromecast 4K (sabrina). No settings changed.")
        for namespace, key in (("global", "device_provisioned"), ("secure", "user_setup_complete")):
            if self.run("settings", "get", namespace, key) != "1":
                raise RuntimeError("Finish Google TV's initial setup before replacing Home.")
        candidates = self.run("cmd", "package", "query-activities", "--brief", "--user", "0", *HOME_ARGS)
        if not any(self.is_ours(line.strip()) for line in candidates.splitlines()):
            raise RuntimeError("Install the Home-capable Living Room APK first; Google Home was not changed.")
        data = self.remember()
        if self.configured():
            print("Living Room is already Home; Google Home and SetupWraith are disabled. Current app left on screen.")
            return
        try:
            self.run("am", "start", "-W", "-n", OURS)
            foreground = self.run("dumpsys", "activity", "activities")
            if not re.search(r"(?:mResumedActivity|topResumedActivity)[^\n]*com\.livingroom\.tv/", foreground):
                raise RuntimeError("Living Room did not open; Google Home will be restored.")
            self.set_home(OURS)
            # Disable the fallback first, so it cannot reclaim Home between the two commands.
            for package in reversed(PACKAGES):
                self.run("pm", "disable-user", "--user", "0", package)
            self.set_home(OURS)
            if not self.configured():
                raise RuntimeError("Android did not keep Living Room as Home.")
            self.run("input", "keyevent", "KEYCODE_HOME")
        except BaseException:
            try:
                self.restore(data)
            except BaseException as error:
                print(f"Recovery needs attention: {error}")
            raise
        print("Living Room is Home. Google TV Home and SetupWraith are disabled for user 0.")
        print(f"Recovery settings: {self.state}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("enable", "restore", "status"))
    parser.add_argument("--state", type=Path, default=ROOT / ".tv-state" / "home.json")
    args = parser.parse_args()
    serial = os.environ.get("ANDROID_SERIAL", "")
    if not serial:
        parser.error("Set ANDROID_SERIAL to this TV's adb serial/address so another Android device cannot be changed.")
    setup = HomeSetup(serial, args.state)
    try:
        if args.action == "enable":
            setup.enable()
        elif args.action == "restore":
            setup.restore()
        else:
            print("Home:", setup.resolved())
            for package in PACKAGES:
                print(package, "user 0 enabled state:", setup.package_state(package))
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))


if __name__ == "__main__":
    main()
