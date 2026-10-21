"""The weather at the plan's site (weather.py), with Open-Meteo faked: no network in tests."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import house  # noqa: E402
import plan  # noqa: E402
import weather  # noqa: E402

SITE = {"address": "2595 Westshore Dr NE, Moses Lake, WA", "lat": 47.16, "lon": -119.33, "planUp": 90,
        "landscape": {"water": "north", "field": "south", "shore": 7, "fieldEdge": 9}}
ROOMS = [{"id": "studio", "name": "Studio", "rect": [0, 0, 6, 5]}]


def answer(code=61, cloud=88, precipitation=0.5, snowfall=0.0, wind=14.4):
    """Open-Meteo's answer for `current=…&daily=sunrise,sunset&timezone=auto`."""
    return {
        "latitude": 47.16, "longitude": -119.33, "utc_offset_seconds": -25200, "timezone": "America/Los_Angeles",
        "current_units": {"precipitation": "mm", "snowfall": "cm"},
        "current": {"time": "2026-10-21T14:15", "interval": 900, "temperature_2m": 11.3, "weather_code": code,
                    "cloud_cover": cloud, "precipitation": precipitation, "rain": precipitation, "showers": 0.0,
                    "snowfall": snowfall, "wind_speed_10m": wind, "wind_direction_10m": 225, "is_day": 1,
                    "visibility": 18000.0, "snow_depth": 0.0},
        "daily": {"time": ["2026-10-21"], "sunrise": ["2026-10-21T07:21"], "sunset": ["2026-10-21T18:02"]},
    }


async def fake_open_meteo(replies: list):
    """Open-Meteo's forecast endpoint: each request takes the next reply (a dict, or a status)."""
    seen: list[dict] = []

    async def forecast(request):
        seen.append(dict(request.query))
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(reply, int):
            return web.Response(status=reply, text="down")
        return web.json_response(reply)

    app = web.Application()
    app.router.add_get("/v1/forecast", forecast)
    server = TestServer(app)
    await server.start_server()
    weather.URL = str(server.make_url("/v1/forecast"))
    return server, seen


def test_kinds_from_weather_codes():
    assert [weather.kind_of(c) for c in (0, 1, 2, 3, 45, 48, 51, 57, 61, 67, 80, 82, 71, 77, 85, 86, 95, 99)] == [
        "clear", "partly", "partly", "overcast", "fog", "fog", "drizzle", "drizzle", "rain", "rain", "rain", "rain",
        "snow", "snow", "snow", "snow", "storm", "storm"]
    assert weather.kind_of(None) == "partly" and weather.kind_of(42) == "partly"


def test_site_needs_a_place():
    assert weather.site_of({"site": SITE}) == {"lat": 47.16, "lon": -119.33}
    assert weather.site_of({}) is None and weather.site_of({"site": {"lat": 47}}) is None
    assert weather.site_of({"site": {"lat": True, "lon": 1}}) is None
    assert weather.site_of({"site": {"lat": 91, "lon": 0}}) is None


def test_reading_is_normalised():
    r = weather.normalise(answer(code=63, precipitation=0.5, snowfall=0.1))
    assert r == {
        "at": "2026-10-21T14:15:00-07:00", "code": 63, "kind": "rain", "cloud": 88,
        "precip": 2.0, "snow": 0.4,  # 15-minute sums as hourly rates
        "wind": 14.4, "windDir": 225, "temp": 11.3, "isDay": True, "visibility": 18000, "snowDepth": 0.0,
        "sunrise": "2026-10-21T07:21:00-07:00", "sunset": "2026-10-21T18:02:00-07:00",
    }
    # Missing fields don't break a reading.
    bare = weather.normalise({"current": {"weather_code": 0}})
    assert bare["kind"] == "clear" and bare["cloud"] == 0 and bare["sunrise"] is None and bare["visibility"] == 24000


def test_reads_publishes_changes_and_keeps_the_last_good_one(tmp_path):
    async def go():
        server, seen = await fake_open_meteo([answer(), answer(), 503, answer(code=71, snowfall=0.3)])
        sent: list[dict] = []
        site_plan = {"rooms": ROOMS, "site": SITE}
        w = weather.Weather(lambda: site_plan, sent.append)
        assert w.current() == {"kind": None}
        async with aiohttp.ClientSession() as http:
            w.http = http
            assert await w.read()
            q = seen[-1]
            assert q["latitude"] == "47.1600" and q["longitude"] == "-119.3300" and q["timezone"] == "auto"
            assert set(q["current"].split(",")) >= {"weather_code", "cloud_cover", "wind_speed_10m", "snow_depth", "visibility"}
            assert q["daily"] == "sunrise,sunset"
            assert sent == [{"weather": {**w.last, "stale": False}}] and w.current()["kind"] == "rain"
            # The same weather again is no news.
            assert await w.read() and len(sent) == 1
            # Open-Meteo down: the last reading stays.
            assert not await w.read() and w.current()["kind"] == "rain" and len(sent) == 1
            assert await w.read() and sent[-1]["weather"]["kind"] == "snow" and sent[-1]["weather"]["snow"] == 1.2
            # Over 40 minutes old: stale.
            w._read_at = time.time() - 41 * 60
            assert w.current()["stale"] is True
            # The site taken out of the plan: the reading is forgotten.
            del site_plan["site"]
            assert not await w.read() and w.current() == {"kind": None}
        await server.close()
    asyncio.run(go())


def test_run_retries_sooner_after_a_failure(monkeypatch):
    async def go():
        server, seen = await fake_open_meteo([500, answer()])
        monkeypatch.setattr(weather, "RETRY", 0.05)
        monkeypatch.setattr(weather, "EVERY", 60)
        w = weather.Weather(lambda: {"site": SITE}, lambda m: None)
        async with aiohttp.ClientSession() as http:
            w.http = http
            task = asyncio.create_task(w.run())
            for _ in range(100):
                await asyncio.sleep(0.02)
                if w.last:
                    break
            task.cancel()
            assert w.last and w.last["kind"] == "rain" and len(seen) == 2
        await server.close()
    asyncio.run(go())


def test_hub_serves_the_weather_and_sends_it_as_an_event(tmp_path, monkeypatch):
    async def go():
        server, _ = await fake_open_meteo([answer(code=3, precipitation=0)])
        monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
        (tmp_path / "plan.json").write_text(json.dumps({"name": "Home", "rooms": ROOMS, "site": SITE}))
        hub = house.Hub(tmp_path)
        hub._rebuild_plan()
        app = house.make_app(hub)
        app.on_startup.clear()
        app.on_cleanup.clear()
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            assert await (await client.get("/api/weather")).json() == {"kind": None}
            heard: asyncio.Queue = asyncio.Queue()
            hub.listeners.add(heard)
            hub.weather.http = hub.http = aiohttp.ClientSession()
            assert await hub.weather.read()
            event = heard.get_nowait()
            assert event["weather"]["kind"] == "overcast" and event["weather"]["stale"] is False
            body = await (await client.get("/api/weather")).json()
            assert body["kind"] == "overcast" and body["cloud"] == 88 and body["sunset"].startswith("2026-10-21T18:02")
            # A panel that connects now hears it straight away, after the devices' state.
            hub.listeners.discard(heard)
            resp = await client.get("/api/events")
            first = json.loads((await resp.content.readline()).decode()[6:])
            await resp.content.readline()
            second = json.loads((await resp.content.readline()).decode()[6:])
            assert "lights" in first and second["weather"]["kind"] == "overcast"
            resp.close()
            # The plan the hub serves still has its site.
            assert (await (await client.get("/api/plan")).json())["site"] == SITE
        finally:
            await client.close()
            if hub.http:
                await hub.http.close()
            await server.close()
    asyncio.run(go())


def test_site_survives_saves_and_plans_the_hub_makes(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    # A plan the hub makes from devices.json, given a site at deploy: kept when it is made again.
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den"]}))
    made = plan.build({"rooms": ["Den"]}, [], [])
    (tmp_path / "plan.json").write_text(json.dumps({**made, "site": SITE}))
    hub = house.Hub(tmp_path)
    hub._rebuild_plan()
    assert hub.plan["generatedBy"] == "hub" and hub.plan["site"] == SITE
    # Saved from the editor: the site goes along.
    assert hub.save_plan({**hub.plan, "name": "Mine"})["ok"]
    assert json.loads((tmp_path / "plan.json").read_text())["site"] == SITE


def test_rileys_studio_has_its_site(tmp_path):
    base = plan.template(tmp_path / "no-web")
    assert base["site"]["planUp"] == 90 and base["site"]["landscape"]["water"] == "north"
