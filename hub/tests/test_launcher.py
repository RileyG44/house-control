"""The TV through its launcher (tv-launcher/): run with .venv/bin/python -m pytest tests (no TV needed).

A pretend launcher (fake_launcher.py: the long-polled /api/state, /api/cmd, the pictures and
pairing) stands in for the real one, and the pretend tv-remote of test_tv.py for the fallback."""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time
from pathlib import Path

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import house  # noqa: E402
import launcher as launchers  # noqa: E402
import tv  # noqa: E402
from fake_launcher import ART, BANNER, CODE, TOKEN, FakeLauncher, youtube_paused  # noqa: E402
from test_nowplaying import FakeCast  # noqa: E402
from test_tv import TV_ID, fake_tv_remote, next_event, run  # noqa: E402

YOUTUBE = {"id": "youtube", "name": "YouTube", "package": "com.google.android.youtube.tv"}


def paired(url: str) -> tv.Launcher:
    return tv.Launcher(url, TOKEN, device=TV_ID, name="Living Room TV")


# ---------- the state the panel sees ----------

def test_launcher_state_as_the_panel_sees_it():
    st = youtube_paused()
    at = time.time()
    st["serverTime"] = st["now"]["measuredAt"] + 1500  # measured 1.5 s before it was sent
    s = tv.from_launcher(st, paired("http://192.168.0.225:8686"), at)
    assert s == {"available": True, "error": "", "devices": [{
        "id": TV_ID, "name": "Living Room TV", "online": True, "on": True, "app": YOUTUBE,
        "volume": 8, "volumeMax": 15, "muted": False, "caps": ["apps", "volume", "keys", "text", "search", "media"],
        "nowPlaying": {"title": "Episode P - Bretz in the Scablands", "subtitle": "Nick Zentner", "state": "paused",
                       "position": 420.0, "duration": 9535.0, "seekable": True,
                       "artwork": "/api/tv/art/now?v=1a2b3c", "app": "youtube", "at": round(at - 1.5, 3)}}]}
    # Its own Home screen is the TV's home; asleep, nothing is on.
    st["tv"].update(screen="home", foreground={"pkg": "com.livingroom.tv", "label": ""})
    home = tv.from_launcher(st, paired("http://x:8686"), at)["devices"][0]
    assert home["app"] == {"id": "home", "name": "Living Room", "package": "com.livingroom.tv"}
    # A paused session of an app that isn't on the screen any more isn't what's on…
    assert home["nowPlaying"] is None
    # …but one that plays (music behind the Home screen) is.
    st["now"]["state"] = "playing"
    assert tv.from_launcher(st, paired("http://x:8686"), at)["devices"][0]["nowPlaying"]["state"] == "playing"
    st["tv"]["awake"] = False
    asleep = tv.from_launcher(st, paired("http://x:8686"), at)["devices"][0]
    assert (asleep["on"], asleep["app"], asleep["volume"], asleep["nowPlaying"]) == (False, None, None, None)
    # No picture of its own (the app's banner instead): the hub looks for one by the title, as for Cast.
    st = youtube_paused()
    st["now"].update(art="banner/com.google.android.youtube.tv", canSeek=False, durationMs=0)
    np = tv.from_launcher(st, paired("http://x:8686"), at)["devices"][0]["nowPlaying"]
    assert (np["artwork"], np["seekable"], np["duration"]) == (None, False, None)
    # Stopped is not playing; keys without the accessibility service aren't offered.
    st["now"]["state"] = "stopped"
    st["caps"] = {"keys": False, "media": True}
    d = tv.from_launcher(st, paired("http://x:8686"), at)["devices"][0]
    assert d["nowPlaying"] is None and d["caps"] == ["apps", "volume", "media"]


def test_fixed_volume_comes_from_tv_remote():
    st = youtube_paused()
    st["tv"].update(volume=15, volumeMax=15, volumeFixed=True)
    lr = paired("http://x:8686")
    d = tv.from_launcher(st, lr, time.time(), {"volume": 5, "volumeMax": 25, "muted": True})["devices"][0]
    assert (d["volume"], d["volumeMax"], d["muted"]) == (5, 25, True)
    # Not fixed: Android's own level is the TV's.
    st["tv"]["volumeFixed"] = False
    d = tv.from_launcher(st, lr, time.time(), {"volume": 5, "volumeMax": 25, "muted": True})["devices"][0]
    assert (d["volume"], d["volumeMax"], d["muted"]) == (15, 15, False)


def test_pictures_are_made_whole_for_each_panel():
    s = tv.from_launcher(youtube_paused(), paired("http://x:8686"), time.time())
    whole = tv.for_client(s, "https://dell.tail1234.ts.net")
    assert whole["devices"][0]["nowPlaying"]["artwork"] == "https://dell.tail1234.ts.net/api/tv/art/now?v=1a2b3c"
    assert s["devices"][0]["nowPlaying"]["artwork"] == "/api/tv/art/now?v=1a2b3c"  # the hub's own copy stays as it was
    cast = {"available": True, "error": "", "devices": [{"id": "x", "nowPlaying": {"artwork": "https://i.ytimg.com/vi/x/hqdefault.jpg"}}]}
    assert tv.for_client(cast, "http://h") == cast


def test_which_way_the_hub_reaches_the_tv(tmp_path, monkeypatch):
    assert tv.launcher_for(tmp_path) is None  # not paired: tv-remote, as before
    (tmp_path / "tv.json").write_text(json.dumps({"url": "http://192.168.0.188:8765"}))
    assert tv.launcher_for(tmp_path) is None
    monkeypatch.setenv("HOUSE_TV_BACKEND", "launcher")
    assert tv.launcher_for(tmp_path) is None  # asked for, but not paired yet
    launchers.save(tmp_path, {"url": "http://192.168.0.225:8686", "token": TOKEN, "device": TV_ID, "name": "Living Room TV"})
    found = tv.launcher_for(tmp_path)
    assert (found.url, found.token, found.device, found.name, found.host) == \
        ("http://192.168.0.225:8686", TOKEN, TV_ID, "Living Room TV", "192.168.0.225")
    monkeypatch.delenv("HOUSE_TV_BACKEND")
    assert tv.launcher_for(tmp_path) is not None  # paired: the launcher by default
    monkeypatch.setenv("HOUSE_TV_BACKEND", "tvremote")
    assert tv.launcher_for(tmp_path) is None
    # tv-remote's address is still where it was.
    monkeypatch.delenv("HOUSE_TV_URL")
    assert tv.default_url(tmp_path, lambda: "10.0.0.1") == "http://192.168.0.188:8765"
    assert launchers.base_url("192.168.0.225") == "http://192.168.0.225:8686"
    assert launchers.base_url("http://192.168.0.225:9000/") == "http://192.168.0.225:9000"


# ---------- the hub, against a pretend launcher ----------

async def hub_with_launcher(tmp_path, monkeypatch, fake: FakeLauncher | None = None, cast=None, token=TOKEN, **remote):
    fake = fake or FakeLauncher(hold=5.0)
    lr = TestServer(fake.app())
    await lr.start_server()
    server, state, sent = await fake_tv_remote(**remote)
    monkeypatch.setenv("HOUSE_TV_URL", str(server.make_url("")).rstrip("/"))
    monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    monkeypatch.setattr(tv, "WAKE_WAIT", 2.0)
    launchers.save(tmp_path, {"url": str(lr.make_url("")).rstrip("/"), "token": token, "device": TV_ID, "name": "Living Room TV"})
    hub = house.Hub(tmp_path)
    hub.tv.cast = lambda host: cast
    client = TestClient(TestServer(house.make_app(hub)))
    await client.start_server()
    return fake, lr, server, state, sent, hub, client


async def until(check, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        await asyncio.sleep(0.02)


def test_hub_reads_the_launcher_and_hears_changes_at_once(tmp_path, monkeypatch):
    async def go():
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        try:
            r = await client.get("/api/tv")
            text = await r.text()
            s = json.loads(text)
            d = s["devices"][0]
            assert s["available"] and d["id"] == TV_ID and d["name"] == "Living Room TV"
            assert d["app"] == YOUTUBE and (d["volume"], d["volumeMax"]) == (8, 15)
            np = d["nowPlaying"]
            assert (np["title"], np["state"], np["position"], np["seekable"]) == ("Episode P - Bretz in the Scablands", "paused", 420.0, True)
            # The picture comes through the hub, at the address the panel used; the token never leaves it.
            assert np["artwork"] == f"http://{client.host}:{client.port}/api/tv/art/now?v=1a2b3c"
            assert TOKEN not in text
            # Through Tailscale Serve: at the hub's public name.
            served = await (await client.get("/api/tv", headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "dell.tail1234.ts.net"})).json()
            assert served["devices"][0]["nowPlaying"]["artwork"] == "https://dell.tail1234.ts.net/api/tv/art/now?v=1a2b3c"
            pic = await client.get("/api/tv/art/now", params={"v": "1a2b3c"})
            assert pic.status == 200 and await pic.read() == ART and pic.content_type == "image/jpeg"
            banner = await client.get("/api/tv/banner/com.netflix.ninja")
            assert banner.status == 200 and await banner.read() == BANNER
            assert (await client.get("/api/tv/banner/com.example.none")).status == 404
            assert (await client.get("/api/tv/banner/..%2Fapi%2Fstate")).status == 404
            assert hub.tv.route == "launcher"

            events = await client.get("/api/events")
            await next_event(events.content)
            assert (await next_event(events.content))["tv"]["devices"][0]["app"]["id"] == "youtube"
            await until(lambda: hub.tv._following)
            # A change on the TV reaches the panels through the long poll, with no kick.
            fake.update(foreground={"pkg": "com.netflix.ninja", "label": "Netflix"}, now=None)
            changed = (await next_event(events.content, timeout=2))["tv"]["devices"][0]
            assert changed["app"]["id"] == "netflix" and changed["nowPlaying"] is None
            fake.update(awake=False)
            off = (await next_event(events.content, timeout=2))["tv"]["devices"][0]
            assert off["on"] is False and off["app"] is None and off["volume"] is None
            events.close()
            # tv-remote isn't asked to do anything while the launcher answers.
            assert sent == []
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_hub_actions_become_launcher_commands(tmp_path, monkeypatch):
    async def go():
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        post = lambda body: client.post(f"/api/tv/{TV_ID}", json=body)  # noqa: E731
        try:
            await client.get("/api/tv")
            cases = [
                ({"action": "up"}, [{"type": "key", "key": "up"}]),
                ({"action": "ok"}, [{"type": "key", "key": "ok"}]),
                ({"action": "home"}, [{"type": "key", "key": "home"}]),
                ({"action": "playpause"}, [{"type": "media", "action": "toggle"}]),
                ({"action": "pause"}, [{"type": "media", "action": "pause"}]),
                ({"action": "forward"}, [{"type": "media", "action": "seekBy", "ms": 10000}]),
                ({"action": "volup"}, [{"type": "volume", "delta": 1}]),
                ({"action": "voldown"}, [{"type": "volume", "delta": -1}]),
                ({"action": "volume", "level": 12}, [{"type": "volume", "level": 12}]),
                ({"action": "mute"}, [{"type": "mute"}]),
                ({"action": "sleep"}, [{"type": "sleep"}]),
                ({"action": "wake"}, [{"type": "wake"}]),
            ]
            for body, cmds in cases:
                n = len(fake.sent)
                r = await post(body)
                assert r.status == 200 and await r.json() == {"ok": True}, body
                assert fake.sent[n:] == cmds, body
            assert fake.state["tv"]["volume"] == 12 and fake.state["tv"]["muted"] is True
            await until(lambda: hub.tv.state["devices"][0]["on"])
            assert (await post({"action": "open", "app": "netflix"})).status == 200
            assert fake.sent[-1] == {"type": "launch", "pkg": "com.netflix.ninja"}
            # A search result plays its https link in its own app, and nowhere else.
            link = "intent://www.netflix.com/title/80057281#Intent;scheme=https;package=com.netflix.ninja;end"
            r = await post({"action": "play", "app": "netflix", "link": link})
            assert r.status == 200
            assert fake.sent[-1] == {"type": "open", "url": "https://www.netflix.com/title/80057281", "pkg": "com.netflix.ninja"}
            n = len(fake.sent)
            for bad in ({"action": "play", "app": "hulu", "link": link}, {"action": "volume", "level": 16},
                        {"action": "reboot"}, {"action": "launch", "url": "com.evil.app"}):
                assert (await post(bad)).status == 400, bad
            assert len(fake.sent) == n
            # Typing, with a text field on the TV; a search is typed and sent.
            fake.state["textField"] = True
            assert (await post({"action": "text", "text": "the bear"})).status == 200
            assert fake.sent[-1] == {"type": "text", "text": "the bear"}
            assert (await post({"action": "search", "text": "the bear"})).status == 200
            assert fake.sent[-2:] == [{"type": "text", "text": "the bear"}, {"type": "submit"}]
            # What only tv-remote has goes there.
            assert (await post({"action": "menu"})).status == 200 and sent == [{"action": "menu"}]
            # The launcher says no (no text field): tv-remote's Google TV search steps in…
            fake.state["textField"] = False
            assert (await post({"action": "search", "text": "dune"})).status == 200
            assert sent[-1] == {"action": "search", "text": "dune"}
            # …and when it isn't there either, the launcher's no is the answer.
            hub.tv.url = "http://127.0.0.1:9"
            r = await post({"action": "text", "text": "dune"})
            assert r.status == 409 and (await r.json())["error"] == "Nothing on the TV takes text right now"
            r = await post({"action": "play", "app": "youtube", "link": "https://www.youtube.com/watch?v=aqz-KE-bpKQ"})
            assert r.status == 200  # YouTube opens its own links
            fake.state.pop("now")
            r = await post({"action": "playpause"})
            assert r.status == 409 and "playing" in (await r.json())["error"]
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_hub_seeks_through_the_launcher(tmp_path, monkeypatch):
    async def go():
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        try:
            await client.get("/api/tv")
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "seek", "position": 1200})
            assert r.status == 200 and (await r.json())["position"] == 1200
            assert fake.sent[-1] == {"type": "seek", "positionMs": 1200000}
            assert hub.tv.state["devices"][0]["nowPlaying"]["position"] == 1200
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "skip", "by": -30})
            assert r.status == 200 and fake.sent[-1] == {"type": "seek", "positionMs": 1170000}
            # Past the end: just before it.
            await client.post(f"/api/tv/{TV_ID}", json={"action": "seek", "position": 99999})
            assert fake.sent[-1] == {"type": "seek", "positionMs": 9534000}
            # Something that can't be moved through (once the jump asked for has settled).
            monkeypatch.setattr(tv, "SEEK_SETTLE", 0.0)
            hub.tv._settle.clear()
            fake.update(now={**fake.state["now"], "canSeek": False})
            await until(lambda: not hub.tv.state["devices"][0]["nowPlaying"]["seekable"])
            n = len(fake.sent)
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "seek", "position": 10})
            assert r.status == 400 and len(fake.sent) == n
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_hub_wakes_the_tv_through_the_launcher_before_opening_an_app(tmp_path, monkeypatch):
    async def go():
        fake = FakeLauncher(hold=5.0)
        fake.state["tv"]["awake"] = False
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch, fake)
        try:
            assert (await (await client.get("/api/tv")).json())["devices"][0]["on"] is False
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "open", "app": "hulu"})
            assert r.status == 200
            assert fake.sent == [{"type": "wake"}, {"type": "launch", "pkg": "com.hulu.livingroomplus"}]
            assert sent == []  # tv-remote wasn't needed
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_hub_falls_back_to_tv_remote_and_comes_back(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setattr(tv, "LAUNCHER_RETRY", 0.3)
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        try:
            await client.get("/api/tv")
            assert hub.tv.route == "launcher"
            events = await client.get("/api/events")
            await next_event(events.content)
            await next_event(events.content)
            # The launcher falls over: tv-remote's view of the same TV, under the same id.
            fake.broken = True
            fake.bump()
            moved = (await next_event(events.content, timeout=3))["tv"]
            assert hub.tv.route == "tvremote"
            d = moved["devices"][0]
            assert moved["available"] and d["id"] == TV_ID and d["app"]["id"] == "netflix" and d["volume"] == 5
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "up"})
            assert r.status == 200 and sent[-1] == {"action": "up"}
            # It answers again: back to the launcher.
            fake.broken = False
            back = (await next_event(events.content, timeout=3))["tv"]["devices"][0]
            assert back["app"]["id"] == "youtube" and hub.tv.route == "launcher"
            n = len(sent)
            assert (await client.post(f"/api/tv/{TV_ID}", json={"action": "up"})).status == 200
            assert len(sent) == n and fake.sent[-1] == {"type": "key", "key": "up"}
            # Neither answers: the panel is told so plainly.
            fake.broken = True
            hub.tv.url = "http://127.0.0.1:9"
            fake.bump()
            gone = (await next_event(events.content, timeout=3))["tv"]
            assert gone == {"available": False, "error": tv.UNREACHABLE_BOTH, "devices": []}
            events.close()
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_hub_with_a_token_the_tv_forgot(tmp_path, monkeypatch):
    async def go():
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch, token="stale")
        try:
            s = await (await client.get("/api/tv")).json()
            assert hub.tv.route == "tvremote" and s["devices"][0]["app"]["id"] == "netflix"
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_cast_still_tells_what_plays_when_the_launcher_sees_no_session(tmp_path, monkeypatch):
    async def go():
        fake = FakeLauncher(hold=5.0)
        fake.state.pop("now")
        cast = FakeCast()
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch, fake, cast=cast)
        try:
            np = (await (await client.get("/api/tv")).json())["devices"][0]["nowPlaying"]
            assert np["title"] == "Episode P - Bretz in the Scablands" and np["state"] == "paused"
            assert hub.tv._np_from[TV_ID] == "cast" and hub.tv._wants_cast
            # Seeking goes the way it came: over Cast.
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "seek", "position": 60})
            assert r.status == 200 and cast.seeks == [60] and not any(c["type"] == "seek" for c in fake.sent)
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_tv_remote_only_when_told(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setenv("HOUSE_TV_BACKEND", "tvremote")
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        try:
            assert hub.tv.launcher is None
            s = await (await client.get("/api/tv")).json()
            assert s["devices"][0]["app"]["id"] == "netflix" and fake.polls == 0
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())


def test_the_phone_is_told_where_the_launcher_is_but_never_its_token(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setattr(tv, "LAUNCHER_RETRY", 0.3)
        # Paired before tv.json kept the launcher's id: the hub asks the TV for it once.
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        url = str(lr.make_url("")).rstrip("/")
        try:
            await client.get("/api/tv")
            await until(lambda: hub.tv.launcher.install_id == "5e1f00aa77bb")
            await until(lambda: hub.tv.snapshot["devices"][0].get("direct", {}).get("id") == "5e1f00aa77bb")
            text = await (await client.get("/api/tv")).text()
            assert json.loads(text)["devices"][0]["direct"] == {"url": url, "id": "5e1f00aa77bb"}
            assert TOKEN not in text
            events = await client.get("/api/events")
            await next_event(events.content)
            first = await next_event(events.content)
            assert first["tv"]["devices"][0]["direct"] == {"url": url, "id": "5e1f00aa77bb"}
            # The hub can't reach the launcher: the phone may still (the Dell's Wi-Fi is the weak
            # one), so tv-remote's view of the same TV says where it is too.
            fake.broken = True
            fake.bump()
            moved = (await next_event(events.content, timeout=3))["tv"]
            assert hub.tv.route == "tvremote"
            assert moved["devices"][0]["direct"] == {"url": url, "id": "5e1f00aa77bb"}
            assert TOKEN not in json.dumps(moved)
            events.close()
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(go())
    # Without a launcher (or told to use tv-remote only), there is nothing to reach directly.
    async def without():
        monkeypatch.setenv("HOUSE_TV_BACKEND", "tvremote")
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch)
        try:
            d = (await (await client.get("/api/tv")).json())["devices"][0]
            assert d["id"] == TV_ID and "direct" not in d
        finally:
            await client.close()
            await server.close()
            await lr.close()
    run(without())


def test_direct_carries_the_saved_id_at_once(tmp_path):
    lr = launchers.Launcher("http://192.168.0.225:8686", TOKEN, device=TV_ID, install_id="5e1f00aa77bb")
    remote = tv.TvRemote("http://192.168.0.188:8765", publish=lambda _: None, launcher=lr)
    s = remote._with_direct(tv.from_launcher(youtube_paused(), lr, time.time()))
    assert s["devices"][0]["direct"] == {"url": "http://192.168.0.225:8686", "id": "5e1f00aa77bb"}
    # Another TV that tv-remote knows (not at the launcher's address) gets none.
    remote.raw = {"other": {"id": "other", "host": "192.168.0.50"}}
    two = remote._with_direct({"available": True, "error": "", "devices": [{"id": "other"}, {"id": TV_ID}]})
    assert "direct" not in two["devices"][0] and two["devices"][1]["direct"]["url"] == lr.url
    assert TOKEN not in json.dumps(s)


# ---------- pairing ----------

def test_pairing_saves_the_token_and_keeps_the_rest(tmp_path):
    async def go():
        fake = FakeLauncher()
        lr = TestServer(fake.app())
        await lr.start_server()
        url = str(lr.make_url("")).rstrip("/")
        (tmp_path / "tv.json").write_text(json.dumps({"url": "http://192.168.0.188:8765"}))
        said: list[str] = []
        codes = iter(["1234", f" {CODE} "])

        async def ask(_):
            return next(codes)

        async def known(host):
            return (TV_ID, "Living Room TV") if host == "127.0.0.1" else None

        async with aiohttp.ClientSession() as http:
            entry = await launchers.pair(http, tmp_path, url, ask=ask, say=said.append, known=known)
        assert entry == {"url": url, "token": TOKEN, "device": TV_ID, "name": "Living Room TV", "id": "5e1f00aa77bb"}
        saved = json.loads((tmp_path / "tv.json").read_text())
        assert saved == {"url": "http://192.168.0.188:8765", "launcher": entry}
        assert stat.S_IMODE(os.stat(tmp_path / "tv.json").st_mode) == 0o600
        assert any("isn't the code" in s for s in said)
        # Wrong every time: nothing is saved, and the code goes away.
        (tmp_path / "tv.json").unlink()
        codes = iter(["0000", "1111", "2222"])
        async with aiohttp.ClientSession() as http:
            assert await launchers.pair(http, tmp_path, url, ask=ask, say=said.append) is None
        assert not (tmp_path / "tv.json").exists() and fake.pairing is None
        # Nothing there.
        async with aiohttp.ClientSession() as http:
            assert await launchers.pair(http, tmp_path, "http://127.0.0.1:9", ask=ask, say=said.append) is None
        assert "No launcher answers" in said[-1]
        await lr.close()
    run(go())


def test_pair_tv_command(tmp_path, monkeypatch):
    async def go():
        fake = FakeLauncher()
        lr = TestServer(fake.app())
        await lr.start_server()
        monkeypatch.setattr(house, "CONF", tmp_path)
        monkeypatch.setattr("builtins.input", lambda prompt="": CODE)
        assert await house.pair_tv(f"127.0.0.1:{lr.port}")
        saved = json.loads((tmp_path / "tv.json").read_text())["launcher"]
        # tv-remote didn't answer (port 9), so the TV keeps the launcher's own id and name.
        assert saved == {"url": f"http://127.0.0.1:{lr.port}", "token": TOKEN, "device": "5e1f00aa77bb", "name": "Living Room",
                         "id": "5e1f00aa77bb"}
        assert launchers.from_conf(tmp_path).install_id == "5e1f00aa77bb"
        # The launcher is told where this hub is, for the streaming catalog.
        assert [list(b) for b in fake.settings] == [["hub"]] and fake.settings[0]["hub"].startswith("http://")
        await lr.close()
    run(go())


def test_long_poll_client(tmp_path):
    async def go():
        fake = FakeLauncher(hold=0.3)
        lr = TestServer(fake.app())
        await lr.start_server()
        client = launchers.Launcher(str(lr.make_url("")).rstrip("/"), TOKEN)
        async with aiohttp.ClientSession() as http:
            st = await client.state(http)
            assert st["rev"] == 1
            start = time.monotonic()
            again = await client.state(http, since=1)  # nothing changes: answered when the wait runs out
            assert again["rev"] == 1 and time.monotonic() - start >= 0.25
            asyncio.get_running_loop().call_later(0.05, lambda: fake.update(muted=True))
            changed = await client.state(http, since=1)
            assert changed["rev"] == 2 and changed["tv"]["muted"] is True
            assert await client.cmd(http, {"type": "mute"}) is True
            assert await client.cmd(http, {"type": "nope"}) is False
            assert await client.picture(http, "banner", "../../api/state") is None
            bad = launchers.Launcher(client.url, "wrong")
            try:
                await bad.state(http)
                raise AssertionError("a wrong token was taken")
            except launchers.NotPaired:
                pass
        await lr.close()
    run(go())
