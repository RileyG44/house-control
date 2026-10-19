"""Run with: .venv/bin/python -m pytest tests (no hardware or accounts needed)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
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


def test_hub_routes_aidot_commands(tmp_path):
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
