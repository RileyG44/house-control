"""What the TV played (history.py), and its routes: run with .venv/bin/python -m pytest tests."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import history  # noqa: E402
import house  # noqa: E402

DAY = 86_400_000
# Noon today, so no test straddles midnight.
NOW = int(time.mktime(time.localtime()[:3] + (12, 0, 0, 0, 0, -1)) * 1000)


def entry(**over) -> dict:
    return {"pkg": "com.netflix.ninja", "app": "Netflix", "title": "Chapter Seven: The Bathtub",
            "subtitle": "Stranger Things · S1 E7", "positionMs": 600_000, "durationMs": 3_000_000,
            "at": NOW - 3600_000, "first": NOW - 4000_000, **over}


def test_one_line_per_title_app_and_day(tmp_path):
    log = history.WatchLog(tmp_path)
    assert log.add([entry(), entry(positionMs=1_200_000, at=NOW - 1800_000)]) == 2
    lines = (tmp_path / history.FILE).read_text().splitlines()
    assert len(lines) == 1
    kept = json.loads(lines[0])
    # The latest position; the first time that day stays.
    assert (kept["positionMs"], kept["progress"], kept["first"]) == (1_200_000, 0.4, NOW - 4000_000)
    # A late report of earlier the same day doesn't take the position back.
    log.add([entry(positionMs=100_000, at=NOW - 3900_000, first=NOW - 5000_000)])
    kept = history.WatchLog(tmp_path).recent()[0]
    assert (kept["positionMs"], kept["first"]) == (1_200_000, NOW - 5000_000)
    # Another day or another app is another line; the same title in capitals is the same line.
    log.add([entry(at=NOW - 3 * DAY, first=NOW - 3 * DAY), entry(pkg="com.hulu.livingroomplus"), entry(title="CHAPTER SEVEN: THE BATHTUB")])
    assert len(history.WatchLog(tmp_path).recent()) == 3
    # Oldest first, and only the days asked for.
    days = [e["day"] for e in history.WatchLog(tmp_path).recent()]
    assert days == sorted(days)
    assert len(history.WatchLog(tmp_path).recent(days=2)) == 2


def test_what_is_not_an_entry_is_left_out(tmp_path):
    log = history.WatchLog(tmp_path)
    bad = [None, "x", {"title": "No app"}, entry(pkg="../etc"), entry(title="   "), entry(pkg=7)]
    assert log.add(bad) == 0 and not (tmp_path / history.FILE).exists()
    e = history.clean(entry(at="soon", positionMs=-5, durationMs=None, jw="../x", subtitle=["?"]), now_ms=NOW)
    assert e["at"] == NOW and (e["positionMs"], e["progress"], e["jw"], e["subtitle"]) == (0, None, None, None)
    assert history.clean(entry(jw="ts20503"))["jw"] == "ts20503"
    # A clock far ahead is "now".
    assert history.clean(entry(at=NOW + 5 * DAY), now_ms=NOW)["at"] == NOW


def test_history_routes(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
        hub = house.Hub(tmp_path)
        client = TestClient(TestServer(house.make_app(hub)))
        await client.start_server()
        try:
            r = await client.post("/api/tv/history", json={"entries": [entry(), {"nope": 1}]})
            assert r.status == 200 and await r.json() == {"ok": True, "kept": 1}
            got = await (await client.get("/api/tv/history")).json()
            assert [e["title"] for e in got["entries"]] == ["Chapter Seven: The Bathtub"]
            assert (await client.post("/api/tv/history", json={"entries": "x"})).status == 400
            assert (await client.post("/api/tv/history", json={"entries": [entry()] * 201})).status == 400
            assert (await client.post("/api/tv/history", data="not json", headers={"Content-Type": "application/json"})).status == 400
            assert (await client.get("/api/tv/history", params={"days": "x"})).status == 400
            # Another site in a browser can't write it.
            r = await client.post("/api/tv/history", json={"entries": [entry()]}, headers={"Origin": "http://evil.example"})
            assert r.status == 403
        finally:
            await client.close()
    asyncio.run(go())
