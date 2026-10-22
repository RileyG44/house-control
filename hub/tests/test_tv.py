"""The TV through tv-remote: run with .venv/bin/python -m pytest tests (no TV or network needed).

A pretend tv-remote (the same /api/devices and /action routes as ~/tv-remote) and a canned
JustWatch answer (justwatch_search.json) stand in for the real ones."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import house  # noqa: E402
import tv  # noqa: E402

TV_ID = "79519fff"
CANNED = json.loads((HERE / "justwatch_search.json").read_text())


def run(coro):
    return asyncio.run(coro)


def living_room(**extra) -> dict:
    return {"id": TV_ID, "name": "Living Room TV", "kind": "googletv", "label": "Google TV", "host": "192.168.0.225",
            "online": True, "needsPair": False, "error": None, "caps": ["keys", "volume", "apps"],
            "apps": ["YouTube", "Netflix"], "volume": 5, "muted": False, "volumeMax": 25,
            "isOn": True, "currentApp": "com.netflix.ninja", "inputs": [], **extra}


async def fake_tv_remote(**initial):
    """tv-remote as the hub uses it. A wake turns the TV on a moment later, like the real one."""
    state = living_room(**initial)
    sent: list[dict] = []

    async def devices(_):
        return web.json_response({"devices": [state], "server": {"ip": "127.0.0.1"}})

    async def action(request):
        assert "Origin" not in request.headers  # tv-remote only takes requests without one
        if request.match_info["id"] != TV_ID:
            return web.json_response({"error": "No such device"}, status=404)
        body = await request.json()
        sent.append(body)
        if body["action"] == "wake":
            asyncio.get_running_loop().call_later(0.15, lambda: state.update(isOn=True, volume=5))
        elif body["action"] == "launch":
            state["currentApp"] = body["url"] if not body["url"].startswith("https") else state["currentApp"]
        elif body["action"] == "volume":
            state["volume"] = body["level"]
        elif body["action"] == "text" and body["text"] == "fail":
            return web.json_response({"error": "Nothing on the TV takes text right now"}, status=503)
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/api/devices", devices)
    app.router.add_post("/api/devices/{id}/action", action)
    server = TestServer(app)
    await server.start_server()
    return server, state, sent


@pytest.fixture(autouse=True)
def quick(monkeypatch, tmp_path):
    monkeypatch.setattr(tv, "WAKE_WAIT", 2.0)
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")


# ---------- the state the panel sees ----------

def test_state_normalization():
    s = tv.normalize({"devices": [living_room()]})
    assert s == {"available": True, "error": "", "devices": [{
        "id": TV_ID, "name": "Living Room TV", "online": True, "on": True,
        "app": {"id": "netflix", "name": "Netflix", "package": "com.netflix.ninja"},
        "volume": 5, "volumeMax": 25, "muted": False, "caps": ["keys", "volume", "apps"], "nowPlaying": None}]}
    asleep = tv.normalize({"devices": [living_room(isOn=False, volume=None)]})["devices"][0]
    assert asleep["on"] is False and asleep["app"] is None and asleep["volume"] is None
    # Unreachable is not "on", whatever the last report said.
    assert tv.normalize({"devices": [living_room(online=False)]})["devices"][0]["on"] is False
    assert tv.app_of("com.google.android.apps.tv.launcherx")["id"] == "home"
    assert tv.app_of("com.google.android.tvrecommendations")["name"] == "Google TV"
    assert tv.app_of("com.google.android.backdrop") == {"id": "ambient", "name": "Ambient", "package": "com.google.android.backdrop"}
    assert tv.app_of("com.android.tv.settings")["id"] == "settings"
    assert tv.app_of("com.example.game") == {"id": "other", "name": "com.example.game", "package": "com.example.game"}
    assert tv.app_of("com.disney.disneyplus")["id"] == "disney" and tv.app_of(None) is None


def test_link_validation():
    ok = "intent://www.netflix.com/title/80057281#Intent;scheme=https;package=com.netflix.ninja;end"
    assert tv.validate_link("Netflix", ok) == ok
    assert tv.https_form(ok) == "https://www.netflix.com/title/80057281"
    assert tv.validate_link("Netflix", "https://www.netflix.com/title/1") == "https://www.netflix.com/title/1"
    # Another app's package, two packages, a foreign host, no proper ending.
    assert tv.validate_link("Netflix", ok.replace("com.netflix.ninja", "com.evil.app")) is None
    assert tv.validate_link("Netflix", ok.replace(";end", ";package=com.evil.app;end")) is None
    assert tv.validate_link("Netflix", ok.replace("www.netflix.com", "netflix.com.evil.example")) is None
    assert tv.validate_link("Netflix", ok[:-4]) is None
    # Plain links: https only, the app's own hosts, no user or odd port.
    for bad in ("http://www.netflix.com/title/1", "https://evil.example/www.netflix.com", "https://notnetflix.com/x",
                "https://user@www.netflix.com/x", "https://www.netflix.com:8443/x", "javascript:alert(1)", "", None, 42,
                "https://www.netflix.com/" + "x" * 2100):
        assert tv.validate_link("Netflix", bad) is None, bad
    assert tv.validate_link("Hulu", "https://www.netflix.com/title/1") is None
    assert tv.validate_link("NotAnApp", "https://www.netflix.com/title/1") is None
    assert tv.validate_link("Max", "https://play.max.com/show/1") == "https://play.max.com/show/1"
    # YouTube: every shape comes back as one plain watch link.
    yt = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
    assert tv.validate_link("YouTube", "https://youtu.be/aqz-KE-bpKQ") == yt
    assert tv.validate_link("YouTube", "https://youtu.be/aqz-KE-bpKQ?t=30") == yt + "&t=30"
    assert tv.validate_link("YouTube", "https://m.youtube.com/watch?v=aqz-KE-bpKQ&list=PL123abc&foo=1") == yt + "&list=PL123abc"
    assert tv.validate_link("YouTube", "https://www.youtube.com/shorts/aqz-KE-bpKQ") == yt
    assert tv.validate_link("YouTube", "https://www.youtube.com/embed/aqz-KE-bpKQ?start=12") == yt + "&t=12"
    assert tv.validate_link("YouTube", "https://www.youtube.com/playlist?list=PL123abc") == "https://www.youtube.com/playlist?list=PL123abc"
    assert tv.validate_link("YouTube", "https://www.youtube.com/watch?v=short") is None
    assert tv.validate_link("YouTube", "https://www.youtube.com/channel/UC123") is None


def test_search_parsing_from_a_canned_answer():
    results = tv.parse_search(CANNED)
    assert [r["title"] for r in results] == ["Stranger Things", "The Bear", "Dune: Part Two", "Big Buck Bunny"]
    st = results[0]
    assert st["year"] == 2016 and st["type"] == "show"
    assert st["poster"] == "https://images.justwatch.com/poster/323146457/s166/stranger-things.webp"
    # One offer per app; the Android TV link wins over the web page.
    assert st["offers"] == [{"app": "netflix", "name": "Netflix", "how": "subscription",
                             "link": "intent://www.netflix.com/title/80057281#Intent;scheme=https;package=com.netflix.ninja;end"}]
    bear = results[1]
    assert [o["app"] for o in bear["offers"]] == ["hulu", "disney"]
    # An intent for the wrong app is dropped and the web link is used instead.
    assert bear["offers"][1]["link"] == "https://www.disneyplus.com/series/the-bear/1aNbB0hl5LS9"
    assert bear["rentOrBuy"] == ["Apple TV (buy)"]
    dune = results[2]
    assert dune["type"] == "movie" and dune["offers"] == []
    assert dune["rentOrBuy"] == ["Apple TV (rent)", "Apple TV (buy)", "Amazon Video (rent)"]
    bunny = results[3]
    assert bunny["poster"] is None
    # A foreign host and an app the TV doesn't have are left out; YouTube's link is made plain.
    assert bunny["offers"] == [{"app": "youtube", "name": "YouTube", "how": "free",
                                "link": "https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30"}]
    assert tv.parse_search({}) == [] and tv.parse_search({"data": {"popularTitles": None}}) == []


def test_where_tv_remote_is(tmp_path, monkeypatch):
    monkeypatch.delenv("HOUSE_TV_URL", raising=False)
    assert tv.default_url(tmp_path, lambda: "192.168.0.188") == "http://192.168.0.188:8765"
    (tmp_path / "tv.json").write_text(json.dumps({"url": "http://192.168.0.188:8765/"}))
    assert tv.default_url(tmp_path, lambda: "10.0.0.1") == "http://192.168.0.188:8765"
    monkeypatch.setenv("HOUSE_TV_URL", "http://10.0.0.5:8765")
    assert tv.default_url(tmp_path, lambda: "10.0.0.1") == "http://10.0.0.5:8765"


# ---------- the hub, against a pretend tv-remote ----------

async def hub_with_tv(tmp_path, monkeypatch, **initial):
    server, state, sent = await fake_tv_remote(**initial)
    monkeypatch.setenv("HOUSE_TV_URL", str(server.make_url("")).rstrip("/"))
    monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
    hub = house.Hub(tmp_path)
    client = TestClient(TestServer(house.make_app(hub)))
    await client.start_server()
    return server, state, sent, hub, client


async def next_event(stream, timeout=5.0) -> dict:
    while True:
        line = await asyncio.wait_for(stream.readline(), timeout)
        if line.startswith(b"data:"):
            return json.loads(line[5:])


def test_hub_tv_state_and_sse_broadcast(tmp_path, monkeypatch):
    async def go():
        server, state, sent, hub, client = await hub_with_tv(tmp_path, monkeypatch)
        try:
            r = await client.get("/api/tv")
            s = await r.json()
            assert s["available"] and s["devices"][0]["app"]["id"] == "netflix" and s["devices"][0]["volume"] == 5
            # A new panel gets the devices' state and then the TV's, then every change.
            events = await client.get("/api/events")
            first = await next_event(events.content)
            assert "lights" in first and "tv" not in first
            assert (await next_event(events.content))["tv"]["devices"][0]["on"] is True
            state.update(currentApp="com.hulu.livingroomplus")
            hub.tv.kick()
            changed = await next_event(events.content)
            assert changed["tv"]["devices"][0]["app"] == {"id": "hulu", "name": "Hulu", "package": "com.hulu.livingroomplus"}
            state.update(isOn=False, volume=None)
            hub.tv.kick()
            off = (await next_event(events.content))["tv"]["devices"][0]
            assert off["on"] is False and off["app"] is None
            events.close()
        finally:
            await client.close()
            await server.close()
    run(go())


def test_hub_tv_actions_are_checked(tmp_path, monkeypatch):
    async def go():
        server, state, sent, hub, client = await hub_with_tv(tmp_path, monkeypatch)
        post = lambda body, tv_id=TV_ID, **kw: client.post(f"/api/tv/{tv_id}", json=body, **kw)  # noqa: E731
        try:
            r = await post({"action": "up"})
            assert r.status == 200 and await r.json() == {"ok": True} and sent[-1] == {"action": "up"}
            for body in ({"action": "reboot"}, {"action": "launch", "url": "com.evil.app"}, {"action": "app", "name": "Netflix"},
                         {"action": "volume", "level": 26}, {"action": "volume", "level": "5"}, {"action": "volume", "level": True},
                         {"action": "text", "text": "x" * 201}, {"action": "search", "text": "  "}, {"nothing": 1},
                         {"action": "open", "app": "com.netflix.ninja"}):
                r = await post(body)
                assert r.status == 400 and "error" in await r.json(), body
            assert len(sent) == 1  # nothing refused was passed on
            r = await post({"action": "play"})  # the remote's play key, not a title
            assert r.status == 200 and sent[-1] == {"action": "play"}
            r = await post({"action": "volume", "level": 12})
            assert r.status == 200 and sent[-1] == {"action": "volume", "level": 12}
            r = await post({"action": "search", "text": "The Bear"})
            assert r.status == 200 and sent[-1] == {"action": "search", "text": "The Bear"}
            # tv-remote's own refusal comes back with its words and status.
            r = await post({"action": "text", "text": "fail"})
            assert r.status == 503 and (await r.json())["error"] == "Nothing on the TV takes text right now"
            r = await post({"action": "up"}, tv_id="nope")
            assert r.status == 404
            # Another site may not drive the TV.
            r = await post({"action": "up"}, headers={"Origin": "http://evil.example"})
            assert r.status == 403
            # Opening an app launches its package.
            r = await post({"action": "open", "app": "netflix"})
            assert r.status == 200 and sent[-1] == {"action": "launch", "url": "https://www.netflix.com/title"}
            # A search result plays by its https form, and only in its own app.
            link = "intent://www.netflix.com/title/80057281#Intent;scheme=https;package=com.netflix.ninja;end"
            n = len(sent)
            r = await post({"action": "play", "app": "hulu", "link": link})
            assert r.status == 400 and len(sent) == n
            r = await post({"action": "play", "app": "netflix", "link": "https://evil.example/title/1"})
            assert r.status == 400 and len(sent) == n
            r = await post({"action": "play", "app": "netflix", "link": link})
            assert r.status == 200 and sent[-1] == {"action": "launch", "url": "https://www.netflix.com/title/80057281"}
        finally:
            await client.close()
            await server.close()
    run(go())


def test_hub_tv_open_wakes_a_sleeping_tv_first(tmp_path, monkeypatch):
    async def go():
        server, state, sent, hub, client = await hub_with_tv(tmp_path, monkeypatch, isOn=False, volume=None, currentApp=None)
        try:
            assert (await (await client.get("/api/tv")).json())["devices"][0]["on"] is False
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "open", "app": "youtube"})
            assert r.status == 200
            assert [b["action"] for b in sent] == ["wake", "launch"] and sent[-1]["url"] == "https://www.youtube.com"
            assert state["isOn"] is True
            # Already on: no wake.
            sent.clear()
            await hub.tv.refresh()
            await client.post(f"/api/tv/{TV_ID}", json={"action": "open", "app": "hulu"})
            assert [b["action"] for b in sent] == ["launch"]
        finally:
            await client.close()
            await server.close()
    run(go())


def test_hub_tv_when_tv_remote_is_down(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setenv("HOUSE_TV_URL", "http://127.0.0.1:9")  # nothing listens there
        monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
        hub = house.Hub(tmp_path)
        client = TestClient(TestServer(house.make_app(hub)))
        await client.start_server()
        try:
            s = await (await client.get("/api/tv")).json()
            assert s == {"available": False, "error": tv.UNREACHABLE, "devices": []}
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "up"})
            assert r.status == 503 and (await r.json())["error"] == tv.UNREACHABLE
            # The rest of the hub carries on.
            assert (await client.get("/api/plan")).status == 200
        finally:
            await client.close()
    run(go())


def test_hub_tv_search(tmp_path, monkeypatch):
    async def go():
        asked: list[dict] = []
        broken = {"now": False}

        async def graphql(request):
            asked.append(await request.json())
            assert request.headers["User-Agent"].endswith("HouseControl/1.0")
            if broken["now"]:
                return web.json_response({"errors": [{"message": "down"}]}, status=500)
            return web.json_response(CANNED)

        app = web.Application()
        app.router.add_post("/graphql", graphql)
        jw = TestServer(app)
        await jw.start_server()
        monkeypatch.setattr(tv, "JUSTWATCH_URL", str(jw.make_url("/graphql")))
        server, state, sent, hub, client = await hub_with_tv(tmp_path, monkeypatch)
        try:
            r = await client.get("/api/tv/search", params={"q": "stranger  things"})
            body = await r.json()
            assert r.status == 200 and body["results"][0]["offers"][0]["app"] == "netflix"
            v = asked[0]["variables"]
            assert v == {"filter": {"searchQuery": "stranger things"}, "country": "US", "language": "en", "first": 8}
            assert "posterUrl" in asked[0]["query"]
            # The same question within five minutes is answered from memory.
            await client.get("/api/tv/search", params={"q": "Stranger Things"})
            assert len(asked) == 1
            assert await (await client.get("/api/tv/search", params={"q": " "})).json() == {"results": []}
            broken["now"] = True
            r = await client.get("/api/tv/search", params={"q": "the bear"})
            assert r.status == 502 and await r.json() == {"error": "The streaming catalog didn't answer."}
        finally:
            await client.close()
            await server.close()
            await jw.close()
    run(go())
