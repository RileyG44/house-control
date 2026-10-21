"""Run with: .venv/bin/python -m pytest tests (no hardware or accounts needed)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import aidot_lan  # noqa: E402
import fake_wiz  # noqa: E402
import house  # noqa: E402
import mrcool  # noqa: E402
import plan  # noqa: E402
import wiz  # noqa: E402

PORT = 38979  # fake lights listen here, so a real one on the network never answers a test


def run(coro):
    return asyncio.run(coro)


# ---------- WiZ ----------

def test_reading_and_pilot_params():
    assert wiz.reading({"state": True, "dimming": 40, "temp": 2700}) == {"on": True, "brightness": 0.4, "temp": 2700, "color": None}
    assert wiz.reading({"state": True, "dimming": 100, "r": 128, "g": 0, "b": 64})["color"] == "#ff0080"
    light = wiz.Light(mac="x", ip="1.2.3.4", kelvin=(2700, 6500))
    assert wiz.pilot_params({"on": False}, {"on": True}) == {"state": False}
    # A colour keeps the brightness the panel shows and switches the light on.
    assert wiz.pilot_params({"color": "#ff0000"}, {"on": True, "brightness": 0.5}) == \
        {"state": True, "r": 255, "g": 0, "b": 0, "c": 0, "w": 0, "dimming": 50}
    # White temperature is kept inside what the light can do.
    assert wiz.pilot_params({"temp": 2200}, {"on": False}, light) == {"temp": 2700}
    assert wiz.pilot_params({"brightness": 0.01}, {"on": True})["dimming"] == 10
    assert wiz.capabilities_of("ESP01_SHRGB1C_31") == ["brightness", "temp", "color"]
    assert wiz.capabilities_of("ESP56_SHTW3_01") == ["brightness", "temp"]
    assert wiz.capabilities_of("ESP06_SHDW9_01") == ["brightness"]


def test_discover_and_control_fake_lights():
    async def go():
        bulbs = await fake_wiz.serve(PORT)
        client = wiz.WizClient(broadcast=[l["ip"] for l in fake_wiz.LIGHTS], port=PORT)
        await client.start()
        try:
            found = await client.discover(wait=0.3)
            assert {l.mac for l in found} == {l["mac"] for l in fake_wiz.LIGHTS}
            strip = client.lights["444f8ec6fad8"]
            assert strip.capabilities == ["brightness", "temp", "color"] and strip.kind == "strip"
            assert strip.state == {"on": False, "brightness": 1.0, "color": "#ff5000"}
            await client.send("444f8ec6fad8", {"on": True, "brightness": 0.25}, {"on": True})
            assert bulbs[1].light["pilot"]["state"] is True and bulbs[1].light["pilot"]["dimming"] == 25
            assert (await client.read("444f8ec6fad8"))["brightness"] == 0.25
        finally:
            client.close()
            for b in bulbs:
                b.transport.close()
    run(go())


# ---------- MRCOOL / Cielo ----------

BREEZ = {
    "mac_address": "485519FB47C7", "device_name": "Bedroom", "device_type": "BREEZ-I",
    "temperature_unit": "F", "appliance_id": 1674,
    "connection_status": {"is_alive": True},
    "sensor_readings": {"temperature": 75, "humidity": 40},
    "current_state": {"power": "on", "mode": "heat", "set_point": 76, "fan_speed": "high",
                      "swing_position": "pos2", "preset": 0, "heat_set_point": 68, "cool_set_point": 76},
    "supported_features": {"presets": [], "modes": {
        m: {"fan_levels": ["auto", "low", "medium", "high"], "swing": ["auto", "pos1", "pos2", "pos3", "adjust"],
            "temperatures": {"F": {"values": list(range(62, 87))}}}
        for m in ("cool", "heat", "dry", "fan", "auto")}},
}


async def fake_cielo():
    """Cielo's Open API, as much of it as the hub uses."""
    state = json.loads(json.dumps(BREEZ))
    actions: list[dict] = []

    async def authenticate(request):
        assert request.headers["x-api-key"] == "test-key"
        return web.json_response({"data": {"access_token": "tok"}})

    async def devices(request):
        assert request.headers["Authorization"] == "tok"
        return web.json_response({"data": {"devices": [state]}})

    async def action(request):
        body = await request.json()
        actions.append(body)
        state["current_state"] = body["actions"]
        return web.json_response({"data": body["actions"]})

    app = web.Application()
    app.router.add_post("/openapi/v1/authenticate", authenticate)
    app.router.add_get("/openapi/v1/devices/", devices)
    app.router.add_post("/openapi/v1/action", action)
    server = TestServer(app)
    await server.start_server()
    return server, actions


def test_mrcool_reading_and_commands(tmp_path):
    async def go():
        server, actions = await fake_cielo()
        mrcool.BASE_URL = str(server.make_url("/openapi/v1"))
        async with aiohttp.ClientSession() as http:
            client = mrcool.MrcoolClient(tmp_path / "mrcool.json", http)
            client.save_key("test-key")
            await client.refresh()
            mac = "485519fb47c7"
            r = client.reading(mac)
            assert r["ac"] == {"on": True, "mode": "heat", "target": 76, "fan": "high", "swing": "l2", "roomTemp": 75.0}
            assert r["features"]["fans"] == ["auto", "low", "medium", "high"] and r["features"]["swing"]
            assert client.describe(mac)["unit"] == "F" and client.describe(mac)["min"] == 62
            await client.send(mac, {"mode": "cool", "target": 72, "fan": "auto"})
            assert [a["action_type"] for a in actions] == ["mode", "set_point", "fan_speed"]
            assert actions[-1]["actions"]["set_point"] == 72 and actions[-1]["actions"]["mode"] == "cool"
            await client.send(mac, {"on": False, "target": 70})
            assert actions[-1]["action_type"] == "power" and actions[-1]["actions"]["power"] == "off"
        await server.close()
    run(go())


WEB_BREEZ = {
    "deviceName": "Bedroom", "macAddress": "485519FB47C7", "applianceId": 1663,
    "applianceType": "AC", "deviceType": "BREEZ-I", "deviceTypeVersion": "BI04",
    "fwVersion": "2.6.0", "connectionSource": 1, "deviceStatus": 1, "isFaren": 1,
    "latEnv": {"temp": 73.0, "humidity": 40},
    "latestAction": {"power": "on", "mode": "heat", "temp": "76", "fanspeed": "high", "swing": "pos2"},
}


async def fake_cielo_web():
    """Cielo's web API (what Alexa/Google/Cielo's own site use), as the hub's fallback."""
    state = json.loads(json.dumps(WEB_BREEZ))
    sent: list[dict] = []

    async def devices(request):
        assert request.headers["authorization"] == "web-tok"
        assert request.headers["x-api-key"] == "web-xkey"
        return web.json_response({"status": 200, "message": "SUCCESS", "data": {"listDevices": [state]}})

    async def refresh(request):
        body = await request.json()
        assert body["refreshToken"] == "web-refresh"
        assert request.headers["x-api-key"] == mrcool.IOS_X_API_KEY
        return web.json_response({"status": 200, "message": "SUCCESS",
                                  "data": {"accessToken": "web-tok", "refreshToken": "web-refresh2", "expiresIn": 3600}})

    async def ws(request):
        sock = web.WebSocketResponse()
        await sock.prepare(request)
        async for msg in sock:
            body = json.loads(msg.data)
            sent.append(body)
            state["latestAction"].update(body["actions"])
            await sock.send_json({"message_type": "StateUpdate", "mac_address": body["macAddress"]})
        return sock

    app = web.Application()
    app.router.add_get("/web/devices", devices)
    app.router.add_post("/user/token/refresh", refresh)
    app.router.add_get("/ws", ws)
    server = TestServer(app)
    await server.start_server()
    return server, sent, state


def test_mrcool_web_tokens_reading_and_commands(tmp_path):
    async def go():
        server, sent, state = await fake_cielo_web()
        mrcool.WEB_BASE_URL = str(server.make_url("/")).rstrip("/")
        mrcool.WEB_WSS_URL = str(server.make_url("/ws")).replace("http://", "ws://")
        (tmp_path / "mrcool.json").write_text(json.dumps({
            "access_token": "stale", "refresh_token": "web-refresh",
            "session_id": "sess", "user_id": "user1", "x_api_key": "web-xkey"}))
        async with aiohttp.ClientSession() as http:
            client = mrcool.MrcoolClient(tmp_path / "mrcool.json", http)
            assert client.configured and not client.api_key
            await client.refresh()
            mac = "485519fb47c7"
            r = client.reading(mac)
            assert r["ac"] == {"on": True, "mode": "heat", "target": 76, "fan": "high", "swing": "l2", "roomTemp": 73.0}
            assert client.describe(mac)["unit"] == "F"
            await client.send(mac, {"target": 72})
            assert sent[-1]["actionType"] == "temp" and sent[-1]["actions"]["temp"] == "72"
            assert sent[-1]["macAddress"] == "485519FB47C7"
            await client.send(mac, {"on": False})
            assert sent[-1]["actionType"] == "power" and sent[-1]["actions"]["power"] == "off"
            # The refreshed tokens replace the stale ones on disk.
            stored = json.loads((tmp_path / "mrcool.json").read_text())
            assert stored["access_token"] == "web-tok" and stored["refresh_token"] == "web-refresh2"
        await server.close()
    run(go())


def test_mrcool_web_login_when_refresh_is_rejected(tmp_path):
    """A dead refresh token signs in again with the stored MRCOOL password."""
    async def go():
        seen = {}

        async def refresh(request):
            return web.json_response({"message": "no"}, status=403)

        async def login(request):
            body = await request.json()
            seen["user"] = body["user"]["userId"]
            assert len(body["user"]["password"]) == 64  # SHA-256, never the password itself
            assert request.headers["x-api-key"] == mrcool.IOS_X_API_KEY
            return web.json_response({"status": 200, "message": "SUCCESS", "data": {"user": {
                "accessToken": "web-tok", "refreshToken": "web-refresh2", "userId": "user1",
                "sessionId": "sess"}}})

        async def devices(request):
            assert request.headers["authorization"] == "web-tok"
            return web.json_response({"status": 200, "message": "SUCCESS", "data": {"listDevices": [WEB_BREEZ]}})

        app = web.Application()
        app.router.add_post("/user/token/refresh", refresh)
        app.router.add_post("/user/smarthvac/login/1", login)
        app.router.add_get("/web/devices", devices)
        server = TestServer(app)
        await server.start_server()
        mrcool.WEB_BASE_URL = str(server.make_url("/")).rstrip("/")
        (tmp_path / "mrcool.json").write_text(json.dumps({
            "access_token": "stale", "refresh_token": "dead", "session_id": "old",
            "user_id": "user1", "x_api_key": "web-xkey", "email": "owner@example.com",
            "password": "secret", "expires_at": 0}))
        async with aiohttp.ClientSession() as http:
            client = mrcool.MrcoolClient(tmp_path / "mrcool.json", http)
            await client.refresh()
            assert client.reading("485519fb47c7")["ac"]["target"] == 76
        stored = json.loads((tmp_path / "mrcool.json").read_text())
        assert seen["user"] == "owner@example.com"
        assert stored["access_token"] == "web-tok" and stored["password"] == "secret"
        await server.close()
    run(go())


# ---------- the plan ----------

def test_hub_adopts_a_newer_panel_plan(tmp_path, monkeypatch):
    panel = tmp_path / "panel.json"
    conf = tmp_path / "hub"
    edited = {"name": "Edited", "rooms": [{"id": "studio", "name": "Studio"}],
              "lights": [{"id": "studio.window-lamp", "name": "Door Light",
                          "link": {"service": "aidot", "id": "dc067586ebf8"}}]}
    panel.write_text(json.dumps(edited))
    monkeypatch.setattr(house, "PANEL_PLAN", panel)
    hub = house.Hub(conf)
    (conf / "plan.json").write_text(json.dumps({"name": "Old", "rooms": [{"id": "studio"}]}))
    os.utime(conf / "plan.json", (panel.stat().st_mtime - 30, panel.stat().st_mtime - 30))
    assert hub._adopt_panel_plan()
    hub._rebuild_plan()
    assert hub.plan["name"] == "Edited"
    assert hub.links["studio.window-lamp"] == ("aidot", "dc067586ebf8")
    # The same file is not copied again, and an older panel file does not replace a newer hub plan.
    assert not hub._adopt_panel_plan()
    newer = {"name": "From the site", "rooms": [{"id": "studio"}]}
    (conf / "plan.json").write_text(json.dumps(newer))
    assert not hub._adopt_panel_plan()
    hub._rebuild_plan()
    assert hub.plan["name"] == "From the site"


def test_editor_saves_the_plan_for_every_screen(tmp_path, monkeypatch):
    panel = tmp_path / "panel.json"
    conf = tmp_path / "hub"
    panel.write_text(json.dumps({"name": "Mac app", "rooms": [{"id": "studio", "rect": [0, 0, 4, 4]}]}))
    monkeypatch.setattr(house, "PANEL_PLAN", panel)
    hub = house.Hub(conf)
    hub._rebuild_plan()
    heard: asyncio.Queue = asyncio.Queue()
    hub.listeners.add(heard)
    drawn = {"name": "Rearranged", "generatedBy": "hub",
             "rooms": [{"id": "studio", "rect": [0, 0, 6, 7]}, {"id": "bath", "rect": [6, 4, 2.4, 3]}],
             "lights": [{"id": "bath.light", "room": "bath", "type": "ceiling", "pos": [7, 5],
                         "link": {"service": "aidot", "id": "dc0675863854"}}]}
    rev = hub.plan_rev
    assert hub.save_plan(drawn, by="page-a") == {"ok": True, "rev": rev + 1}
    # The hub's plan and the Mac app's file are the same bytes, so neither adopts the other.
    assert (conf / "plan.json").read_bytes() == panel.read_bytes()
    assert not hub._adopt_panel_plan()
    saved = json.loads(panel.read_text())
    assert saved["name"] == "Rearranged" and "generatedBy" not in saved  # hand-drawn from now on
    assert hub.plan["rooms"][1]["id"] == "bath" and hub.links["bath.light"] == ("aidot", "dc0675863854")
    # Every screen hears which plan this is and who saved it (that one ignores its own echo).
    assert heard.get_nowait() == {"reload": True, "rev": rev + 1, "by": "page-a"}
    # Saving the same plan again changes nothing: no event, and the reply has the current rev.
    assert hub.save_plan(drawn) == {"ok": True, "rev": rev + 1} and heard.empty()
    # A change from elsewhere (the Mac app's file, a rescan) has nobody to name.
    hub.save_plan({**drawn, "name": "Again"})
    assert heard.get_nowait() == {"reload": True, "rev": rev + 2, "by": None}
    # Something that is not a floor plan is refused and changes nothing.
    assert "error" in hub.save_plan({"rooms": []})
    assert "error" in hub.save_plan({"rooms": [{"id": "x", "rect": [0, 0, "wide", 2]}]})
    assert "error" in hub.save_plan({"rooms": [{"id": "x", "poly": [[0, 0], [1, 0]]}]})
    assert json.loads((conf / "plan.json").read_text())["name"] == "Again" and hub.plan_rev == rev + 2


def test_plan_from_devices():
    names = {"home": "Riley's", "lights": {
        "a": {"name": "Edison Bulb", "room": "Kitchen"}, "b": {"name": "Counter Light", "room": "Kitchen"},
        "c": {"name": "Window Light", "room": "Bedroom"}}}
    lights = [{"id": "a", "kind": "bulb", "capabilities": ["brightness", "temp"]},
              {"id": "b", "kind": "strip", "capabilities": ["brightness", "temp", "color"]},
              {"id": "c", "kind": "bulb", "capabilities": ["brightness", "temp", "color"]},
              {"id": "d", "kind": "bulb", "capabilities": ["brightness"]}]
    acs = [{"id": "m", "name": "Bedroom", "unit": "F", "min": 62, "max": 86}]
    names["acs"] = {"m": {"name": "Bedroom AC", "room": "Bedroom"}}
    p = plan.build(names, lights, acs)
    assert [r["name"] for r in p["rooms"]] == ["Kitchen", "Bedroom", "Home"]
    by_name = {l["name"]: l for l in p["lights"]}
    assert by_name["Counter Light"]["type"] == "strip" and by_name["Edison Bulb"]["room"] == "kitchen"
    assert by_name["Window Light"]["link"] == {"service": "wiz", "id": "c"}
    assert p["acs"][0]["link"] == {"service": "mrcool", "id": "m"} and p["acs"][0]["unit"] == "F"
    assert len({d["id"] for d in [*p["lights"], *p["acs"], *p["rooms"]]}) == 8


def test_new_hub_starts_from_rileys_studio(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    (tmp_path / "devices.json").write_text(json.dumps({"lights": {
        "dc067586ebf8": {"name": "Door Light", "room": "Studio", "service": "aidot", "ip": "192.168.0.171"},
        "d807b6a0ea92": {"name": "bathroom light", "room": "Bathroom", "service": "aidot", "ip": "192.168.0.244"}}}))
    hub = house.Hub(tmp_path)
    found = [{"id": "dc067586ebf8", "service": "aidot", "kind": "bulb", "ip": "192.168.0.171"},
             {"id": "d807b6a0ea92", "service": "aidot", "kind": "bulb", "ip": "192.168.0.244"}]
    hub.aidot = type("Aidot", (), {"configured": True, "describe_all": lambda self: found})()
    hub._rebuild_plan()
    assert hub.plan["name"] == "Riley's Studio" and hub.plan["seededBy"] == "hub"
    assert any("poly" in r for r in hub.plan["rooms"])
    # The bulbs found are linked by name; the links in the file stay as they are.
    assert hub.links["studio.door"] == ("aidot", "dc067586ebf8")
    assert hub.links["bathroom.ceiling"] == ("aidot", "d807b6a0ea92")
    assert hub.links["kitchen.edison"] == ("wiz", "d8a0113a23e6") and hub.links["studio.ac"] == ("mrcool", "485519fb47c7")
    # Until a plan is saved it keeps following the devices; once saved it is the user's.
    found.pop()
    hub._rebuild_plan()
    assert "bathroom.ceiling" not in hub.links
    edited = {**hub.plan, "name": "Mine"}
    assert hub.save_plan(edited)["ok"]
    saved = json.loads((tmp_path / "plan.json").read_text())
    assert saved["name"] == "Mine" and "seededBy" not in saved
    found.append({"id": "d807b6a0ea92", "service": "aidot", "kind": "bulb"})
    hub._rebuild_plan()
    assert hub.plan["name"] == "Mine" and "bathroom.ceiling" not in hub.links


def test_hub_with_a_made_plan_keeps_making_it(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den"]}))
    (tmp_path / "plan.json").write_text(json.dumps(plan.build({"rooms": ["Old"]}, [], [])))
    hub = house.Hub(tmp_path)
    hub._rebuild_plan()
    assert hub.plan["generatedBy"] == "hub" and hub.plan["rooms"][0]["name"] == "Den"


def test_tile_order_round_trips(tmp_path, monkeypatch):
    panel = tmp_path / "panel.json"
    conf = tmp_path / "hub"
    panel.write_text(json.dumps({"name": "Mac app", "rooms": [{"id": "studio", "rect": [0, 0, 4, 4]}]}))
    monkeypatch.setattr(house, "PANEL_PLAN", panel)
    hub = house.Hub(conf)
    hub._rebuild_plan()
    order = ["studio.ac", "tv:79519fff", "studio.window", "studio.door"]
    drawn = {"name": "Mine", "rooms": [{"id": "studio", "rect": [0, 0, 6, 7]}],
             "tileOrder": [*order, "studio.ac", 7, None, ""]}  # repeats and junk are dropped
    assert hub.save_plan(drawn, by="tab-1")["ok"]
    assert hub.plan["tileOrder"] == order
    assert (conf / "plan.json").read_bytes() == panel.read_bytes()  # the Mac app's panel gets it too
    # A hub started again (and the Mac app's file it adopts) keeps it.
    again = house.Hub(conf)
    again._rebuild_plan()
    assert again.plan["tileOrder"] == order
    assert "error" in hub.save_plan({**drawn, "tileOrder": "studio.ac"})
    assert hub.plan["tileOrder"] == order


def test_tile_order_leaves_a_made_plan_the_hubs(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den"]}))
    hub = house.Hub(tmp_path)
    (tmp_path / "plan.json").write_text(json.dumps(plan.build({"rooms": ["Den"]}, [], [])))
    hub._rebuild_plan()
    heard: asyncio.Queue = asyncio.Queue()
    hub.listeners.add(heard)
    rev = hub.plan_rev
    # Dragging the tiles into a new order changes the order alone: the hub keeps making the plan.
    assert hub.save_plan({**hub.plan, "tileOrder": ["tv:abc", "den.lamp"]}, by="tab-1") == {"ok": True, "rev": rev + 1}
    assert heard.get_nowait() == {"reload": True, "rev": rev + 1, "by": "tab-1"}
    assert hub.plan["generatedBy"] == "hub" and hub.plan["tileOrder"] == ["tv:abc", "den.lamp"]
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den", "Kitchen"]}))
    hub._rebuild_plan()
    assert [r["name"] for r in hub.plan["rooms"]] == ["Den", "Kitchen"]  # still following devices.json
    assert hub.plan["tileOrder"] == ["tv:abc", "den.lamp"]  # and the order is kept
    # Any other change makes it the user's.
    assert hub.save_plan({**hub.plan, "name": "Mine"})["ok"]
    assert "generatedBy" not in hub.plan and hub.plan["tileOrder"] == ["tv:abc", "den.lamp"]


CUSTOM_SCENE = {
    "id": "custom-movie-night-3fa1", "name": "Movie night", "icon": "film",
    "lights": {"den.lamp": {"on": True, "brightness": 0.2, "temp": 2700}, "den.strip": {"on": True, "brightness": 0.6, "color": "#4f8dff"},
               "den.desk": {"on": False}},
    "acs": {"den.ac": {"on": True, "mode": "cool", "target": 72, "fan": "auto"}},
}


def test_custom_scenes_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    hub = house.Hub(tmp_path)
    hub._rebuild_plan()
    drawn = {"name": "Mine", "rooms": [{"id": "den", "rect": [0, 0, 4, 4]}],
             "scenes": [plan.SCENES[0], CUSTOM_SCENE, {"name": "no id"}, "junk"]}
    assert hub.save_plan(drawn, by="tab-1")["ok"]
    assert hub.plan["scenes"] == [plan.SCENES[0], CUSTOM_SCENE]  # exactly as saved; ones without an id dropped
    again = house.Hub(tmp_path)
    again._rebuild_plan()
    assert again.plan["scenes"] == [plan.SCENES[0], CUSTOM_SCENE]
    # A built-in scene can be deleted, and a scene without an AC has no "acs".
    lights_only = {k: v for k, v in CUSTOM_SCENE.items() if k != "acs"}
    assert hub.save_plan({**hub.plan, "scenes": [lights_only]})["ok"]
    assert hub.plan["scenes"] == [lights_only]
    assert "error" in hub.save_plan({**hub.plan, "scenes": {"id": "x"}})
    assert hub.plan["scenes"] == [lights_only]


def test_custom_scenes_leave_a_made_plan_the_hubs(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den"]}))
    hub = house.Hub(tmp_path)
    (tmp_path / "plan.json").write_text(json.dumps(plan.build({"rooms": ["Den"]}, [], [])))
    hub._rebuild_plan()
    scenes = [*hub.plan["scenes"], CUSTOM_SCENE]
    assert hub.save_plan({**hub.plan, "scenes": scenes, "tileOrder": ["den.lamp"]}, by="tab-1")["ok"]
    assert hub.plan["generatedBy"] == "hub" and hub.plan["scenes"] == scenes
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den", "Kitchen"]}))
    hub._rebuild_plan()
    assert [r["name"] for r in hub.plan["rooms"]] == ["Den", "Kitchen"]  # still following devices.json
    assert hub.plan["scenes"] == scenes and hub.plan["tileOrder"] == ["den.lamp"]  # and the scenes are kept


# ---------- two hubs keeping one plan ----------

ROOMS = [{"id": "studio", "rect": [0, 0, 6, 7]}]


def test_saves_are_stamped(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    hub = house.Hub(tmp_path)
    assert hub.peers == []  # no peer.json: the hub keeps its plan to itself
    hub._rebuild_plan()
    heard: asyncio.Queue = asyncio.Queue()
    hub.listeners.add(heard)
    before = int(time.time() * 1000)
    rev = hub.plan_rev
    assert hub.save_plan({"name": "Mine", "rooms": ROOMS, "savedAt": 5}, by="tab-1") == {"ok": True, "rev": rev + 1}
    first = hub.plan["savedAt"]
    assert before <= first <= int(time.time() * 1000) + 1
    assert json.loads((tmp_path / "plan.json").read_text())["savedAt"] == first
    assert heard.get_nowait()["rev"] == rev + 1
    # Saving the same plan again stamps it later, but nothing a screen shows changed: no reload.
    assert hub.save_plan({"name": "Mine", "rooms": ROOMS}) == {"ok": True, "rev": rev + 1} and heard.empty()
    assert hub.plan["savedAt"] > first
    # The stamp is later than the plan it replaces even when the clock says otherwise.
    hub.plan["savedAt"] = 10 ** 14
    assert hub.save_plan({"name": "Mine", "rooms": ROOMS})["ok"] and hub.plan["savedAt"] == 10 ** 14 + 1
    assert plan.saved_at({"rooms": []}) == 0 and plan.saved_at({"savedAt": "soon"}) == 0
    assert plan.same_but_order({"a": 1, "savedAt": 1}, {"a": 1, "savedAt": 2, "tileOrder": []})


def test_a_stamp_leaves_a_made_plan_the_hubs(tmp_path, monkeypatch):
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den"]}))
    hub = house.Hub(tmp_path)
    (tmp_path / "plan.json").write_text(json.dumps({**plan.build({"rooms": ["Den"]}, [], []), "savedAt": 3}))
    hub._rebuild_plan()
    assert hub.plan["savedAt"] == 3  # a plan the hub makes again keeps its stamp
    assert hub.save_plan({**hub.plan, "tileOrder": ["den.lamp"]})["ok"]
    assert hub.plan["generatedBy"] == "hub" and hub.plan["savedAt"] > 3
    stamp = hub.plan["savedAt"]
    (tmp_path / "devices.json").write_text(json.dumps({"rooms": ["Den", "Kitchen"]}))
    hub._rebuild_plan()
    assert [r["name"] for r in hub.plan["rooms"]] == ["Den", "Kitchen"] and hub.plan["savedAt"] == stamp


def test_a_plan_from_the_mac_editor_is_stamped(tmp_path, monkeypatch):
    panel = tmp_path / "panel.json"
    conf = tmp_path / "hub"
    monkeypatch.setattr(house, "PANEL_PLAN", panel)
    hub = house.Hub(conf)
    (conf / "plan.json").write_text(json.dumps({"name": "Old", "rooms": ROOMS}))
    panel.write_text(json.dumps({"name": "Edited", "rooms": ROOMS}))
    os.utime(conf / "plan.json", (panel.stat().st_mtime - 30, panel.stat().st_mtime - 30))
    hub._rebuild_plan()
    assert hub.plan["name"] == "Edited" and hub.plan["savedAt"] == panel.stat().st_mtime_ns // 1_000_000
    assert not hub._adopt_panel_plan()  # stamped, but not taken again


def test_peer_addresses(tmp_path, monkeypatch):
    (tmp_path / "peer.json").write_text(json.dumps({"urls": ["http://192.168.0.188:8766/", "", 7,
                                                            "https://mac.example.ts.net:8451"]}))
    assert house.peer_urls(tmp_path) == ["http://192.168.0.188:8766", "https://mac.example.ts.net:8451"]
    monkeypatch.setenv("HOUSE_PEER_URLS", "http://a:1, http://b:2")
    assert house.peer_urls(tmp_path) == ["http://a:1", "http://b:2"]
    monkeypatch.setenv("HOUSE_PEER_URLS", "")
    assert house.peer_urls(tmp_path) == []
    monkeypatch.delenv("HOUSE_PEER_URLS")
    assert house.peer_urls(tmp_path / "none") == []


async def two_hubs(tmp_path, monkeypatch):
    """Two hubs serving on loopback that know each other (nothing else started: no devices)."""
    monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
    hubs, clients = [], []
    for name in ("server", "backup"):
        conf = tmp_path / name
        conf.mkdir()
        (conf / "plan.json").write_text(json.dumps({"name": "Home", "rooms": ROOMS}))
        hub = house.Hub(conf)
        hub._rebuild_plan()
        app = house.make_app(hub)
        app.on_startup.clear()
        app.on_cleanup.clear()
        client = TestClient(TestServer(app))
        await client.start_server()
        hub.http = aiohttp.ClientSession()
        hubs.append(hub)
        clients.append(client)
    a, b = hubs
    # The first address answers nothing (a dropped Wi-Fi link); the second does.
    a.peers = ["http://127.0.0.1:9", str(clients[1].make_url("")).rstrip("/")]
    b.peers = [str(clients[0].make_url("")).rstrip("/")]

    async def close():
        for hub, client in zip(hubs, clients):
            await hub.http.close()
            await client.close()
    return a, b, clients, close


def test_a_save_goes_to_the_other_hub_and_not_back(tmp_path, monkeypatch):
    async def go():
        a, b, (ca, cb), close = await two_hubs(tmp_path, monkeypatch)
        try:
            heard: asyncio.Queue = asyncio.Queue()
            b.listeners.add(heard)
            rev = b.plan_rev
            r = await ca.post("/api/call", json={"type": "savePlan", "client": "tab-1",
                                                 "config": {"name": "Moved", "rooms": ROOMS, "tileOrder": ["studio.ac"]}})
            assert (await r.json())["ok"]
            assert await a._push_task
            # The backup has the same plan, stamp and all; its screens reload as for any save.
            assert b.plan == a.plan and b.plan["savedAt"] == a.plan["savedAt"]
            assert json.loads((tmp_path / "backup" / "plan.json").read_text()) == a.plan
            assert heard.get_nowait() == {"reload": True, "rev": rev + 1, "by": "peer"}
            assert b._push_task is None  # not sent back
            # An older plan from the other hub is left alone.
            r = await cb.post("/api/call", json={"type": "savePlan", "client": "peer", "fromPeer": True,
                                                 "config": {"name": "Stale", "rooms": ROOMS, "savedAt": 1}})
            assert (await r.json())["kept"] and b.plan["name"] == "Moved" and heard.empty()
            # A plan without a stamp counts as the oldest.
            assert b.save_plan({"name": "Unstamped", "rooms": ROOMS}, from_peer=True)["kept"]
            # Both hubs checking now changes nothing.
            await a._sync_peer()
            await b._sync_peer()
            assert a.plan == b.plan and a.plan["name"] == "Moved" and heard.empty()
        finally:
            await close()
    run(go())


def test_the_newer_plan_wins_both_ways(tmp_path, monkeypatch):
    async def go():
        a, b, _, close = await two_hubs(tmp_path, monkeypatch)
        try:
            # Saved on the backup while the server was away: the server takes it when it checks.
            b.peers = []
            assert b.save_plan({"name": "Saved on the backup", "rooms": ROOMS})["ok"]
            await a._sync_peer()
            assert a.plan["name"] == "Saved on the backup" and a.plan["savedAt"] == b.plan["savedAt"]
            # Saved on the server while the backup was away: the server sends it when it checks.
            a.peers, peers = [], a.peers
            assert a.save_plan({"name": "Saved on the server", "rooms": ROOMS})["ok"]
            a.peers = peers
            await a._sync_peer()
            assert b.plan["name"] == "Saved on the server" and b.plan["savedAt"] == a.plan["savedAt"]
            # Two plans that were never stamped stay as they are.
            for hub in (a, b):
                hub.plan.pop("savedAt")
            b.plan["name"] = "Different"
            await a._sync_peer()
            assert a.plan["name"] == "Saved on the server" and b.plan["name"] == "Different"
        finally:
            await close()
    run(go())


def test_a_hub_whose_peer_is_away_saves_as_usual(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")
        monkeypatch.setattr(house, "PEER_RETRY", 0.01)
        (tmp_path / "peer.json").write_text(json.dumps({"urls": ["http://127.0.0.1:9"]}))
        hub = house.Hub(tmp_path)
        assert hub.peers == ["http://127.0.0.1:9"]
        hub._rebuild_plan()
        hub.http = aiohttp.ClientSession()
        try:
            assert hub.save_plan({"name": "Mine", "rooms": ROOMS})["ok"]
            assert await hub._push_task is False
            await hub._sync_peer()  # nothing answers: no error
            assert hub.plan["name"] == "Mine"
        finally:
            await hub.http.close()
    run(go())


def test_plan_seed_links_by_name():
    base = {"rooms": [], "lights": [{"id": "a", "name": "Door Light"}, {"id": "b", "name": "Desk",
                                     "link": {"service": "wiz", "id": "x"}}, {"id": "c", "name": "door light"}],
            "acs": [{"id": "ac", "name": "Bedroom AC"}]}
    p = plan.seed(base, {"acs": {"m": {"name": "Bedroom AC"}}},
                  [{"id": "y", "name": "Door Light"}, {"id": "x", "name": "Desk"}], [{"id": "m", "name": "Unit"}])
    by_id = {l["id"]: l.get("link") for l in p["lights"]}
    # One device links to one lamp; a wiz bulb is the default service, an AC is MRCOOL.
    assert by_id == {"a": {"service": "wiz", "id": "y"}, "b": {"service": "wiz", "id": "x"}, "c": None}
    assert p["acs"][0]["link"] == {"service": "mrcool", "id": "m"}
    assert "link" not in base["lights"][0]  # the template itself is left alone
    # The bundled file is found and is a plan.
    assert plan.template(Path("/nonexistent"))["name"] == "Riley's Studio"


# ---------- the whole hub ----------

def test_panel_origin_allows_tailscale_serve():
    host = "rileys-macbook-air.tail946e94.ts.net:8451"

    def req(scheme, host, remote, headers):
        return type("R", (), {"scheme": scheme, "host": host, "remote": remote, "headers": headers})()

    # Tailscale keeps the public Host and marks the forwarded scheme.
    assert house.panel_origin_ok(req("http", host, "127.0.0.1", {
        "Origin": f"https://{host}", "X-Forwarded-Proto": "https", "X-Forwarded-Host": host}))
    # Same proxy, but it rewrote Host to the local backend address.
    assert house.panel_origin_ok(req("http", "127.0.0.1:8766", "::1", {
        "Origin": f"https://{host}", "X-Forwarded-Proto": "https", "X-Forwarded-Host": host}))
    # The panel opened straight from the Mac, on the LAN address.
    assert house.panel_origin_ok(req("http", "192.168.0.188:8766", "192.168.0.50",
                                      {"Origin": "http://192.168.0.188:8766"}))
    # No origin: the hub's own calls, and curl.
    assert house.panel_origin_ok(req("http", "127.0.0.1:8766", "127.0.0.1", {}))
    # Another site, including one that forges the proxy headers from the LAN.
    assert not house.panel_origin_ok(req("http", "192.168.0.188:8766", "192.168.0.50", {
        "Origin": "https://evil.example", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example"}))
    # Loopback may not invent a different public host than the one it was given.
    assert not house.panel_origin_ok(req("http", host, "127.0.0.1", {
        "Origin": "https://evil.example", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example"}))


def test_hub_serves_panel_and_sends_commands(tmp_path, monkeypatch):
    async def go():
        bulbs = await fake_wiz.serve(PORT)
        server, actions = await fake_cielo()
        mrcool.BASE_URL = str(server.make_url("/openapi/v1"))
        (tmp_path / "devices.json").write_text(json.dumps({
            "lights": {"d8a0113a23e6": {"name": "Edison Bulb", "room": "Kitchen", "ip": "127.0.0.2"},
                       "444f8ec6fad8": {"name": "Counter Light", "room": "Kitchen", "ip": "127.0.0.3"},
                       "444f8e0068c8": {"name": "Window Light", "room": "Bedroom", "ip": "127.0.0.4"}},
            "acs": {"485519fb47c7": {"name": "Bedroom AC", "room": "Bedroom"}}}))
        (tmp_path / "mrcool.json").write_text(json.dumps({"api_key": "test-key"}))
        monkeypatch.setenv("HOUSE_HUB_WIZ_PORT", str(PORT))
        monkeypatch.setattr(house, "PANEL_PLAN", tmp_path / "no-mac-app" / "plan.json")  # never the real one
        hub = house.Hub(tmp_path)
        hub.wiz.broadcast = ["127.0.0.2"]
        client = TestClient(TestServer(house.make_app(hub)))
        await client.start_server()
        try:
            page = await (await client.get("/")).text()
            if (house.WEB / "index.html").is_file():
                assert "window.__HOUSE_BOOT__" in page and "Counter Light" in page
            ids = {l["name"]: l["id"] for l in hub.plan["lights"]}
            ac_id = hub.plan["acs"][0]["id"]
            r = await client.post("/api/call", json={"type": "command", "kind": "light", "id": ids["Edison Bulb"],
                                                     "patch": {"on": False}, "state": {"on": False}})
            assert await r.json() == {"ok": True}
            assert bulbs[0].light["pilot"]["state"] is False
            r = await client.post("/api/call", json={"type": "command", "kind": "ac", "id": ac_id,
                                                     "patch": {"target": 70}, "state": {}})
            assert await r.json() == {"ok": True} and actions[-1]["actions"]["set_point"] == 70
            assert hub.state["acs"][ac_id]["target"] == 70
            # Another site may not drive the lights.
            r = await client.post("/api/call", json={"type": "command"}, headers={"Origin": "http://evil.example"})
            assert r.status == 403
            devices = await (await client.get("/api/devices")).json()
            assert len(devices["lights"]) == 3 and devices["acs"][0]["linked"] == [ac_id]
            # The editor served by the hub: its device pickers, and saving a rearranged plan.
            info = await (await client.post("/api/call", json={"type": "services.info"})).json()
            assert info["wiz"]["connected"] and info["mrcool"]["connected"]
            catalog = await (await client.post("/api/call", json={"type": "devices.all"})).json()
            assert {(d["service"], d["kind"]) for d in catalog["devices"]} == {("wiz", "light"), ("mrcool", "ac")}
            assert {d["name"] for d in catalog["devices"] if d["kind"] == "light"} == {"Edison Bulb", "Counter Light", "Window Light"}
            r = await client.get("/api/plan")
            moved, rev = await r.json(), int(r.headers["X-Plan-Rev"])
            if (house.WEB / "index.html").is_file():
                assert f'"rev": {rev}' in page
            moved["rooms"][0]["rect"] = [1, 1, 5, 5]
            moved["tileOrder"] = [ids["Counter Light"], ac_id, ids["Edison Bulb"]]
            heard: asyncio.Queue = asyncio.Queue()
            hub.listeners.add(heard)
            r = await client.post("/api/call", json={"type": "savePlan", "config": moved, "client": "tab-1"})
            assert await r.json() == {"ok": True, "rev": rev + 1}
            assert heard.get_nowait() == {"reload": True, "rev": rev + 1, "by": "tab-1"}
            r = await client.get("/api/plan")
            back = await r.json()
            assert back["rooms"][0]["rect"] == [1, 1, 5, 5] and r.headers["X-Plan-Rev"] == str(rev + 1)
            assert back["tileOrder"] == [ids["Counter Light"], ac_id, ids["Edison Bulb"]]
        finally:
            await client.close()
            await server.close()
            for b in bulbs:
                b.transport.close()
    run(go())


# ---------- AiDot ----------

def test_aidot_reading_and_steps():
    assert aidot_lan.normalize_mac("D8:47:32:D8:D0:DF") == "d84732d8d0df"
    status = {"on": True, "dimming": 128, "cct": 3000, "rgbw": (255, 0, 0, 0)}
    assert aidot_lan.panel_reading(status, "white") == \
        {"on": True, "brightness": 128 / 255, "temp": 3000, "color": None}
    assert aidot_lan.panel_reading(status, "color")["color"] == "#ff0000"
    # Off is a single step; a colour and a temperature never go together.
    assert aidot_lan.lan_steps({"on": False, "brightness": 0.5}) == [("on", False)]
    assert aidot_lan.lan_steps({"brightness": 0.5, "temp": 2700}) == [("brightness", 128), ("cct", 2700)]
    assert aidot_lan.lan_steps({"color": "#00ff00"}) == [("rgbw", (0, 255, 0, 0))]


def test_plan_links_aidot_lights():
    names = {"rooms": ["Bedroom", "Bathroom"], "lights": {
        "d84732d8d0df": {"name": "Window Lamp", "room": "Bedroom", "service": "aidot", "ip": "192.168.0.172"},
        "d807b6a0ea92": {"name": "Bathroom Light", "room": "Bathroom", "service": "aidot", "ip": "192.168.0.244"}}}
    lights = [{"id": "d84732d8d0df", "service": "aidot", "kind": "bulb",
               "capabilities": ["brightness", "temp", "color"], "ip": "192.168.0.172"},
              {"id": "d807b6a0ea92", "service": "aidot", "kind": "bulb",
               "capabilities": ["brightness", "temp", "color"], "ip": "192.168.0.244"}]
    p = plan.build(names, lights, [])
    by_name = {l["name"]: l for l in p["lights"]}
    assert by_name["Window Lamp"]["link"] == {"service": "aidot", "id": "d84732d8d0df"}
    assert by_name["Bathroom Light"]["room"] == "bathroom"
    assert [r["name"] for r in p["rooms"]] == ["Bedroom", "Bathroom"]


class _FakeAidot:
    configured = True

    def __init__(self):
        self.devices = {"d84732d8d0df": {"id": "dev1", "mac": "d8:47:32:d8:d0:df"}}
        self.state: dict = {}
        self.sent: list = []

    def describe_all(self):
        return [{"id": "d84732d8d0df", "service": "aidot", "device_id": "dev1",
                 "capabilities": ["brightness", "temp", "color"], "kelvin": [2700, 6500],
                 "kind": "bulb", "ip": "192.168.0.172", "online": True}]

    def read(self, key):
        return {"on": True, "brightness": 1.0, "temp": 3000, "color": None}

    async def send(self, key, patch, state):
        self.sent.append((key, patch))
        self.state.setdefault(key, {}).update(patch)


def test_hub_routes_aidot_commands(tmp_path, monkeypatch):
    monkeypatch.setattr(plan, "template", lambda web: None)  # no bundled home: the plan is made from the devices
    async def go():
        (tmp_path / "devices.json").write_text(json.dumps({
            "rooms": ["Bedroom"], "lights": {
                "d84732d8d0df": {"name": "Window Lamp", "room": "Bedroom",
                                 "service": "aidot", "ip": "192.168.0.172"}}}))
        hub = house.Hub(tmp_path)
        hub.aidot = _FakeAidot()
        hub._rebuild_plan()
        pid = hub.plan["lights"][0]["id"]
        assert hub.plan["lights"][0]["link"] == {"service": "aidot", "id": "d84732d8d0df"}
        hub._poll_aidot()
        assert hub.state["lights"][pid]["on"] is True
        r = await hub.command({"id": pid, "patch": {"on": False}, "state": {"on": True}})
        assert r == {"ok": True} and hub.aidot.sent == [("d84732d8d0df", {"on": False})]
        assert hub.devices()["aidot"] == {"configured": True}
    run(go())
