"""What the TV is playing, and seeking: run with .venv/bin/python -m pytest tests (no TV needed).

A pretend Cast link (the snapshot()/refresh()/seek() of nowplaying.CastLink, answering with
what Riley's TV said over Cast) stands in for pychromecast, which the tests never load."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import house  # noqa: E402
import nowplaying  # noqa: E402
import tv  # noqa: E402
from test_tv import TV_ID, fake_tv_remote, next_event, run  # noqa: E402

YOUTUBE = {"id": "youtube", "name": "YouTube", "package": "com.google.android.youtube.tv"}
NETFLIX = {"id": "netflix", "name": "Netflix", "package": "com.netflix.ninja"}
# Riley's TV over Cast, 2026-10-20: YouTube, paused.
LIVE = {"app": "YouTube", "standby": False, "activeInput": True,
        "nowPlaying": {"state": "paused", "title": "Episode P - Bretz in the Scablands", "channel": "Nick Zentner",
                       "position": 420, "duration": 9535, "seekable": True}}

DUMPSYS = """MEDIA SESSION SERVICE (dumpsys media_session)
Sessions Stack - have 2 sessions:
  com.plexapp.android/Plex (userId=0)
    ownerPid=4120, ownerUid=10086, userId=0
    package=com.plexapp.android
    launchIntent=null
    active=true
    flags=3
    rating type=0
    controller=android.media.session.ISessionController$Stub$Proxy@3c9a3a1
    state=PlaybackState {state=PLAYING(3), position=754312, buffered position=0, speed=1.0, updated=101734, actions=3669, custom actions=[], active item id=-1, error=null}
    audioAttrs=AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_MOVIE flags=0x800 tags= bundle=null
    volumeType=1, controlType=2, max=0, current=0
    metadata: size=6, description=The Grand Budapest Hotel, 2014, null
    queueTitle=null, size=0
  com.google.android.youtube.tv/YouTube (userId=0)
    package=com.google.android.youtube.tv
    active=false
    state=PlaybackState {state=2, position=-1, buffered position=0, speed=0.0, updated=99000, actions=0}
    metadata: size=0, description=null
"""


class FakeCast:
    """nowplaying.CastLink as the hub uses it, showing whatever `snap` says."""

    def __init__(self, snap=None):
        self.snap = json.loads(json.dumps(snap if snap is not None else LIVE))
        self.seeks: list[float] = []
        self.refreshed = 0
        self.fail = False
        self.closed = False

    def snapshot(self):
        return self.snap

    def refresh(self):
        self.refreshed += 1

    def seek(self, seconds):
        if self.fail:
            raise RuntimeError("no session")
        self.seeks.append(seconds)
        self.snap["nowPlaying"]["position"] = seconds

    def close(self):
        self.closed = True


# ---------- reading ----------

def test_cast_snapshot_as_the_panel_sees_it():
    at = 1760990000.0
    np = nowplaying.from_cast(LIVE, YOUTUBE, at)
    assert np == {"title": "Episode P - Bretz in the Scablands", "subtitle": "Nick Zentner", "state": "paused",
                  "position": 420.0, "duration": 9535.0, "seekable": True, "artwork": None, "app": "youtube", "at": at}
    # A Cast session outlives its app: only the app on the screen counts.
    assert nowplaying.from_cast(LIVE, NETFLIX, at) is None
    assert nowplaying.from_cast(LIVE, {"id": "home", "name": "Google TV", "package": "com.google.android.apps.tv.launcherx"}, at) is None
    # An unknown package still matches its Cast app by name.
    assert nowplaying.from_cast(LIVE, {"id": "other", "name": "com.google.android.youtube.tvkids", "package": "com.google.android.youtube.tvkids"}, at)
    assert nowplaying.from_cast(None, YOUTUBE, at) is None and nowplaying.from_cast({"app": "YouTube"}, YOUTUBE, at) is None
    idle = json.loads(json.dumps(LIVE))
    idle["nowPlaying"]["state"] = "idle"
    assert nowplaying.from_cast(idle, YOUTUBE, at) is None
    # YouTube's video id is its thumbnail; Cast's own images come first.
    yt = json.loads(json.dumps(LIVE))
    yt["nowPlaying"]["contentId"] = "aqz-KE-bpKQ"
    assert nowplaying.from_cast(yt, YOUTUBE, at)["artwork"] == "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg"
    yt["nowPlaying"]["images"] = ["http://insecure.example/a.jpg", "https://img.example/b.jpg"]
    assert nowplaying.from_cast(yt, YOUTUBE, at)["artwork"] == "https://img.example/b.jpg"
    # A show: the episode's title, and its series with season and episode.
    show = {"app": "Netflix", "nowPlaying": {"state": "playing", "title": "Braciole", "series": "The Bear", "season": 2,
                                             "episode": 3, "position": 61.26, "duration": 1800, "seekable": True}}
    np = nowplaying.from_cast(show, NETFLIX, at)
    assert (np["title"], np["subtitle"], np["position"]) == ("Braciole", "The Bear · S2 E3", 61.3)
    # Live: no duration, so nothing to scrub through.
    live = {"app": "YouTube", "nowPlaying": {"state": "playing", "title": "Launch", "position": 30, "seekable": True}}
    np = nowplaying.from_cast(live, YOUTUBE, at)
    assert np["duration"] is None and np["seekable"] is False and np["position"] == 30


def test_subtitles():
    assert nowplaying.subtitle_of({"series": "The Bear", "title": "Fishes", "season": 2, "episode": 6}) == "The Bear · S2 E6"
    assert nowplaying.subtitle_of({"series": "The Bear", "title": "Fishes", "episode": 6}) == "The Bear · E6"
    assert nowplaying.subtitle_of({"series": "The Bear", "title": "Fishes"}) == "The Bear"
    assert nowplaying.subtitle_of({"series": "The Bear", "title": "The Bear", "season": 1, "episode": 1}) == "S1 E1"
    assert nowplaying.subtitle_of({"title": "Clip", "channel": "Nick Zentner"}) == "Nick Zentner"
    assert nowplaying.subtitle_of({"title": "Clip"}) is None


def test_a_playing_position_is_not_news():
    last = nowplaying.from_cast({"app": "YouTube", "nowPlaying": {"state": "playing", "title": "A", "position": 100,
                                                                  "duration": 600, "seekable": True}}, YOUTUBE, 1000.0)
    on_time = {**last, "position": 102.4, "at": 1002.0}
    assert nowplaying.steady(last, on_time) is last  # moved on as it should: the panels already know
    jumped = {**last, "position": 160.0, "at": 1002.0}
    assert nowplaying.steady(last, jumped) is jumped
    paused = {**last, "state": "paused", "position": 102.0, "at": 1002.0}
    assert nowplaying.steady(last, paused) is paused
    assert nowplaying.steady(paused, {**paused, "at": 1009.0}) is paused  # paused and still
    assert nowplaying.steady(last, None) is None and nowplaying.steady(None, last) is last
    assert nowplaying.steady(last, {**last, "title": "B", "at": 1002.0})["title"] == "B"


def test_adb_media_sessions():
    sessions = nowplaying.parse_media_sessions(DUMPSYS)
    assert sessions == [
        {"package": "com.plexapp.android", "active": True, "state": "playing", "position": 754,
         "title": "The Grand Budapest Hotel", "subtitle": "2014"},
        {"package": "com.google.android.youtube.tv", "active": False, "state": "paused", "position": 0},
    ]
    plex = {"id": "plex", "name": "Plex", "package": "com.plexapp.android"}
    np = nowplaying.from_adb(sessions, plex, 5.0)
    assert np == {"title": "The Grand Budapest Hotel", "subtitle": "2014", "state": "playing", "position": 754.0,
                  "duration": None, "seekable": False, "artwork": None, "app": "plex", "at": 5.0}
    # A session without a title, or of another app, is nothing to show.
    assert nowplaying.from_adb(sessions, YOUTUBE, 5.0) is None
    assert nowplaying.from_adb(sessions, NETFLIX, 5.0) is None
    assert nowplaying.parse_media_sessions("") == [] and nowplaying.from_adb(None, plex, 5.0) is None


def test_adb_finds_the_tv_by_its_address(tmp_path):
    adb = tmp_path / "adb"
    adb.write_text("""#!/bin/sh
case "$*" in
  devices) printf 'List of devices attached\\nadb-0B041HFDD1651G-JTdQuk._adb-tls-connect._tcp\\tdevice\\nemulator-5554\\toffline\\n' ;;
  "mdns services") printf 'List of discovered mdns services\\nadb-0B041HFDD1651G-JTdQuk\\t_adb-tls-connect._tcp\\t192.168.0.225:37011\\n' ;;
  *dumpsys*) cat "%s" ;;
esac
""" % (tmp_path / "dumpsys.txt"))
    adb.chmod(0o755)
    (tmp_path / "dumpsys.txt").write_text(DUMPSYS)

    async def go():
        reader = nowplaying.Adb(str(adb))
        assert await reader.serial("192.168.0.225") == "adb-0B041HFDD1651G-JTdQuk._adb-tls-connect._tcp"
        assert await reader.serial("192.168.0.9") is None
        sessions = await reader.sessions("192.168.0.225")
        assert sessions[0]["title"] == "The Grand Budapest Hotel"
    run(go())


def test_no_cast_without_pychromecast(monkeypatch):
    monkeypatch.setenv("HOUSE_TV_CAST", "off")
    assert nowplaying.cast_link("192.168.0.225") is None
    monkeypatch.setenv("HOUSE_TV_ADB", "off")
    assert nowplaying.Adb.find() is None


# ---------- the hub ----------

async def hub_playing(tmp_path, monkeypatch, cast: FakeCast | None, **initial):
    server, state, sent = await fake_tv_remote(currentApp="com.google.android.youtube.tv", **initial)
    monkeypatch.setenv("HOUSE_TV_URL", str(server.make_url("")).rstrip("/"))
    monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    hub = house.Hub(tmp_path)
    made: list[str] = []
    hub.tv.cast = lambda host: made.append(host) or cast
    client = TestClient(TestServer(house.make_app(hub)))
    await client.start_server()
    return server, state, sent, hub, client, made


def test_hub_now_playing_over_cast(tmp_path, monkeypatch):
    async def go():
        cast = FakeCast()
        server, state, sent, hub, client, made = await hub_playing(tmp_path, monkeypatch, cast)
        try:
            s = await (await client.get("/api/tv")).json()
            np = s["devices"][0]["nowPlaying"]
            assert made == ["192.168.0.225"]  # one link, to the TV tv-remote names
            assert np["title"] == "Episode P - Bretz in the Scablands" and np["subtitle"] == "Nick Zentner"
            assert (np["state"], np["position"], np["duration"], np["seekable"], np["app"]) == ("paused", 420, 9535, True, "youtube")
            assert abs(np["at"] - time.time()) < 5 and cast.refreshed >= 1
            events = await client.get("/api/events")
            await next_event(events.content)
            assert (await next_event(events.content))["tv"]["devices"][0]["nowPlaying"]["position"] == 420
            # Playing: the position moving on as it should is not sent again…
            cast.snap["nowPlaying"].update(state="playing")
            hub.tv.kick()
            started = (await next_event(events.content))["tv"]["devices"][0]["nowPlaying"]
            assert started["state"] == "playing"
            await asyncio.sleep(0.05)
            assert hub.tv._interval() == tv.POLL_BURST  # (right after a change)
            hub.tv._burst_until = 0
            assert hub.tv._interval() == tv.POLL_PLAYING  # a panel is watching something play
            cast.snap["nowPlaying"]["position"] = started["position"] + (time.time() - started["at"])
            await hub.tv.refresh()
            assert hub.tv.state["devices"][0]["nowPlaying"] is not None
            assert hub.tv.state["devices"][0]["nowPlaying"]["at"] == started["at"]
            # …but a new title is.
            cast.snap["nowPlaying"].update(title="Episode Q", position=12)
            hub.tv.kick()
            assert (await next_event(events.content))["tv"]["devices"][0]["nowPlaying"]["title"] == "Episode Q"
            # Another app in front: the Cast session that's left over is not what's on.
            state.update(currentApp="com.netflix.ninja")
            hub.tv.kick()
            assert (await next_event(events.content))["tv"]["devices"][0]["nowPlaying"] is None
            # Off: nothing plays.
            state.update(isOn=False, volume=None)
            await hub.tv.refresh()
            assert hub.tv.state["devices"][0]["nowPlaying"] is None
            events.close()
        finally:
            await client.close()
            await server.close()
        assert cast.closed  # the hub closes its Cast links when it stops
    run(go())


def test_hub_seek_and_skip(tmp_path, monkeypatch):
    async def go():
        cast = FakeCast()
        server, state, sent, hub, client, made = await hub_playing(tmp_path, monkeypatch, cast)
        post = lambda body: client.post(f"/api/tv/{TV_ID}", json=body)  # noqa: E731
        try:
            await client.get("/api/tv")
            heard: asyncio.Queue = asyncio.Queue()
            hub.listeners.add(heard)
            r = await post({"action": "seek", "position": 1200})
            assert r.status == 200 and await r.json() == {"ok": True, "position": 1200}
            assert cast.seeks == [1200]
            # Shown to every panel at once, not at the next read.
            moved = heard.get_nowait()["tv"]["devices"][0]["nowPlaying"]
            assert moved["position"] == 1200 and abs(moved["at"] - time.time()) < 2
            # Relative, and kept inside the title.
            r = await post({"action": "skip", "by": -30})
            assert r.status == 200 and cast.seeks[-1] == 1170
            await post({"action": "skip", "by": 100000})
            assert cast.seeks[-1] == 9534
            await post({"action": "seek", "position": -5})
            assert cast.seeks[-1] == 0
            # A position the TV reports late (still the old one) doesn't pull the slider back for a moment.
            cast.snap["nowPlaying"]["position"] = 420
            await hub.tv.refresh()
            assert hub.tv.state["devices"][0]["nowPlaying"]["position"] == 0
            # A pause pressed meanwhile still shows, where the seek put it.
            cast.snap["nowPlaying"]["state"] = "playing"
            await hub.tv.refresh()
            np = hub.tv.state["devices"][0]["nowPlaying"]
            assert np["state"] == "playing" and np["position"] < 2
            cast.snap["nowPlaying"]["state"] = "paused"
            await hub.tv.refresh()
            hub.tv._settle.clear()
            await hub.tv.refresh()
            assert hub.tv.state["devices"][0]["nowPlaying"]["position"] == 420
            # Refused: nonsense, nothing seekable, a TV that says no. Nothing reached tv-remote.
            n = len(cast.seeks)
            for body in ({"action": "seek"}, {"action": "seek", "position": "10"}, {"action": "seek", "position": True},
                         {"action": "skip", "by": None}, {"action": "seek", "position": float("inf")}):
                r = await client.post(f"/api/tv/{TV_ID}", data=json.dumps(body, allow_nan=True),
                                      headers={"Content-Type": "application/json"})
                assert r.status == 400 and "error" in await r.json(), body
            cast.fail = True
            r = await post({"action": "seek", "position": 10})
            assert r.status == 502 and (await r.json())["error"] == "The TV didn't jump there"
            cast.fail = False
            cast.snap["nowPlaying"]["seekable"] = False
            await hub.tv.refresh()
            r = await post({"action": "seek", "position": 10})
            assert r.status == 400 and len(cast.seeks) == n
            assert not [b for b in sent if b["action"] in ("seek", "skip")]
        finally:
            await client.close()
            await server.close()
    run(go())


def test_hub_without_cast(tmp_path, monkeypatch):
    async def go():
        server, state, sent, hub, client, made = await hub_playing(tmp_path, monkeypatch, None)
        try:
            s = await (await client.get("/api/tv")).json()
            assert s["devices"][0]["nowPlaying"] is None and s["devices"][0]["app"]["id"] == "youtube"
            await hub.tv.refresh()
            assert made == ["192.168.0.225"]  # asked once, not at every read
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "seek", "position": 10})
            assert r.status == 400
        finally:
            await client.close()
            await server.close()
    run(go())
