"""Run with: .venv/bin/python -m pytest tests (no hardware or accounts needed)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

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


# ---------- the plan ----------

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


# ---------- the whole hub ----------

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
        finally:
            await client.close()
            await server.close()
            for b in bulbs:
                b.transport.close()
    run(go())
