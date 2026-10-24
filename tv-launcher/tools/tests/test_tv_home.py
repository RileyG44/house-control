"""Exercise takeover/recovery against a simulated package manager; never talks to a TV."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("tv_home", Path(__file__).resolve().parents[1] / "tv-home.py")
home = importlib.util.module_from_spec(spec)
spec.loader.exec_module(home)


class FakeTV:
    def __init__(self):
        self.home = "com.google.android.apps.tv.launcherx/.home.HomeActivity"
        self.packages = {home.PACKAGES[0]: 0, home.PACKAGES[1]: 1}
        self.calls = []
        self.serial = "TV-123"
        self.candidate = True
        self.fail_disable = False
        self.device = "sabrina"

    def run(self, *args):
        self.calls.append(args)
        if args[:1] == ("getprop",):
            return self.device if args[1] == "ro.product.device" else self.serial
        if args[:2] == ("settings", "get"): return "1"
        if args[:3] == ("cmd", "package", "resolve-activity"): return self.home
        if args[:3] == ("cmd", "package", "query-activities"): return home.OURS if self.candidate else self.home
        if args[:2] == ("dumpsys", "package"): return f"User 0: installed=true enabled={self.packages[args[2]]}"
        if args[:2] == ("dumpsys", "activity"): return "mResumedActivity: ActivityRecord{com.livingroom.tv/.MainActivity}"
        if args[:3] == ("cmd", "package", "set-home-activity"):
            self.home = args[-1]
            return "Success"
        if args[0] == "pm":
            if args[1] == "disable-user" and self.fail_disable and args[-1] == home.PACKAGES[0]:
                raise subprocess.CalledProcessError(1, args, output="Package manager refused")
            states = {"default-state": 0, "enable": 1, "disable": 2, "disable-user": 3, "disable-until-used": 4}
            self.packages[args[-1]] = states[args[1]]
        return ""

    @property
    def mutations(self):
        return [c for c in self.calls if c[0] in ("pm", "am", "input") or c[:3] == ("cmd", "package", "set-home-activity")]


class HomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "home.json"
        self.tv = FakeTV()
        self.setup = home.HomeSetup("test", self.file, self.tv.run)

    def test_takeover_and_restore_keep_original_package_states(self):
        before = self.tv.home, self.tv.packages.copy()
        self.setup.enable()
        self.assertTrue(self.setup.configured())
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        disabled = [c[-1] for c in self.tv.calls if c[:2] == ("pm", "disable-user")]
        self.assertEqual(disabled, list(reversed(home.PACKAGES)))
        self.setup.restore()
        self.assertEqual((self.tv.home, self.tv.packages), before)
        self.assertFalse(any("uninstall" in c for c in self.tv.calls))

    def test_failed_disable_restores_working_home_and_original_states(self):
        before = self.tv.home, self.tv.packages.copy()
        self.tv.fail_disable = True
        with self.assertRaises(subprocess.CalledProcessError): self.setup.enable()
        self.assertEqual((self.tv.home, self.tv.packages), before)
        self.assertEqual(self.tv.calls[-1], ("input", "keyevent", "KEYCODE_HOME"))

    def test_update_preserves_recovery_snapshot_and_foreground(self):
        self.setup.enable()
        saved = self.file.read_bytes()
        self.tv.calls.clear()
        self.setup.enable()
        self.assertEqual(self.file.read_bytes(), saved)
        self.assertEqual(self.tv.mutations, [])

    def test_replacement_without_home_filter_changes_nothing(self):
        self.tv.candidate = False
        with self.assertRaisesRegex(RuntimeError, "Home-capable"): self.setup.enable()
        self.assertEqual(self.tv.mutations, [])
        self.assertFalse(self.file.exists())

    def test_recovery_for_another_tv_changes_nothing(self):
        self.setup.enable()
        self.tv.calls.clear()
        self.tv.serial = "OTHER-TV"
        with self.assertRaisesRegex(RuntimeError, "another TV"): self.setup.restore()
        self.assertEqual(self.tv.mutations, [])

    def test_another_android_device_cannot_be_modified(self):
        self.tv.device = "tablet"
        with self.assertRaisesRegex(RuntimeError, "Chromecast 4K"): self.setup.enable()
        self.assertEqual(self.tv.mutations, [])


if __name__ == "__main__": unittest.main()
