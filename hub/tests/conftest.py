import pytest


@pytest.fixture(autouse=True)
def no_real_tv(monkeypatch):
    """No test reaches a real tv-remote on the network: nothing listens on port 9."""
    monkeypatch.setenv("HOUSE_TV_URL", "http://127.0.0.1:9")
