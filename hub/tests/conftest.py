import pytest


@pytest.fixture(autouse=True)
def no_real_tv(monkeypatch):
    """No test reaches a real TV on the network: nothing listens on port 9 for tv-remote, and
    no Cast link or adb is made (a test hands the hub a pretend Cast link instead)."""
    monkeypatch.setenv("HOUSE_TV_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HOUSE_TV_CAST", "off")
    monkeypatch.setenv("HOUSE_TV_ADB", "off")
    # tv-remote unless a test pairs the hub with a pretend launcher (test_launcher.py).
    monkeypatch.delenv("HOUSE_TV_BACKEND", raising=False)
    # Nor another hub: a test that wants one names it.
    monkeypatch.delenv("HOUSE_PEER_URLS", raising=False)
