import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import house  # noqa: E402
import weather  # noqa: E402


@pytest.fixture(autouse=True)
def no_real_tv(monkeypatch, tmp_path):
    """No test reaches a real TV on the network: nothing listens on port 9 for tv-remote, and
    no Cast link or adb is made (a test hands the hub a pretend Cast link instead)."""
    monkeypatch.setenv("HOUSE_TV_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HOUSE_TV_CAST", "off")
    monkeypatch.setenv("HOUSE_TV_ADB", "off")
    # tv-remote unless a test pairs the hub with a pretend launcher (test_launcher.py).
    monkeypatch.delenv("HOUSE_TV_BACKEND", raising=False)
    # Nor another hub: a test that wants one names it.
    monkeypatch.delenv("HOUSE_PEER_URLS", raising=False)
    # Nor Open-Meteo: a hub whose plan has a site reads the weather from a fake (test_weather.py) or nothing.
    monkeypatch.setattr(weather, "URL", "http://127.0.0.1:9/v1/forecast")
    # Nor the Mac app's floor plan, which the hub reads and saves hand-drawn plans into: on a
    # Mac the real one is there. A test that wants one sets its own.
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
